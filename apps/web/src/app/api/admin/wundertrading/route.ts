import { NextRequest } from "next/server";
import { getAuthConfig, getAuthUnavailableReason, isSameOriginRequest } from "@/lib/auth/config";
import {
  AuthenticationRequiredError,
  AuthorizationRequiredError,
  requireAdmin,
} from "@/lib/auth/session-store";
import {
  getWunderTradingFeatureSettings,
  saveWunderTradingFeatureSettings,
  validateWunderTradingFeatureSettings,
} from "@/lib/wundertrading/settings";

const MAX_BODY_BYTES = 4_096;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authErrorResponse(error: unknown) {
  if (error instanceof AuthenticationRequiredError) return json({ error: "Authentication required." }, 401);
  if (error instanceof AuthorizationRequiredError) return json({ error: "Administrator role required." }, 403);
  return null;
}

export async function GET() {
  try {
    await requireAdmin();
    return json(await getWunderTradingFeatureSettings());
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "WunderTrading settings are unavailable." }, 503);
  }
}

export async function PUT(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return json({ error: getAuthUnavailableReason() ?? "Authentication is unavailable." }, 503);
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let admin;
  try {
    admin = await requireAdmin();
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "Administrator authorization is unavailable." }, 503);
  }

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413);

  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const validation = validateWunderTradingFeatureSettings(body);
  if (!validation.valid) return json({ error: validation.error }, 400);

  try {
    return json(await saveWunderTradingFeatureSettings(validation.value, admin.id));
  } catch {
    return json({ error: "WunderTrading settings could not be audited and saved." }, 503);
  }
}