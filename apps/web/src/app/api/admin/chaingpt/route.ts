import { NextRequest } from "next/server";
import {
  getAuthConfig,
  isSameOriginRequest,
} from "@/lib/auth/config";
import { getAccessRefusal, authenticationGapResponse } from "@/lib/auth/access-gate";
import { requireAdmin } from "@/lib/auth/session-store";
import {
  getChainGPTFeatureSettings,
  saveChainGPTFeatureSettings,
  validateChainGPTFeatureSettings,
} from "@/lib/chaingpt/settings";

const MAX_BODY_BYTES = 4_096;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authErrorResponse(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal ? json({ error: refusal.error }, refusal.status) : null;
}

export async function GET() {
  try {
    await requireAdmin();
    return json(await getChainGPTFeatureSettings());
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "ChainGPT settings are unavailable." }, 503);
  }
}

export async function PUT(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
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

  const validation = validateChainGPTFeatureSettings(body);
  if (!validation.valid) return json({ error: validation.error }, 400);

  try {
    return json(await saveChainGPTFeatureSettings(validation.value, admin.id));
  } catch {
    return json({ error: "ChainGPT settings could not be audited and saved." }, 503);
  }
}