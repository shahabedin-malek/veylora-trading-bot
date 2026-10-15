import { NextRequest } from "next/server";
import {
  getAuthConfig,
  getAuthUnavailableReason,
  isSameOriginRequest,
} from "@/lib/auth/config";
import {
  AuthenticationRequiredError,
  AuthorizationRequiredError,
  requireSitePermission,
} from "@/lib/auth/session-store";
import {
  getRiskPolicySettings,
  saveRiskPolicySettings,
  validateRiskPolicyUpdate,
} from "@/lib/risk-controls/settings";

const MAX_BODY_BYTES = 8_192;

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
    await requireSitePermission("risk.policy.manage");
    return json(await getRiskPolicySettings());
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "Risk policy storage is unavailable." }, 503);
  }
}

export async function PUT(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return json({ error: getAuthUnavailableReason() ?? "Authentication is unavailable." }, 503);
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let admin;
  try {
    admin = await requireSitePermission("risk.policy.manage");
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

  const validation = validateRiskPolicyUpdate(body);
  if (!validation.valid) return json({ error: validation.error }, 400);

  try {
    return json(await saveRiskPolicySettings(validation.value, admin.id));
  } catch {
    return json({ error: "Risk policy update could not be audited and saved." }, 503);
  }
}