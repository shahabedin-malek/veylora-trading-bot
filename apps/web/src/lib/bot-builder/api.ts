import { NextRequest } from "next/server";
import { authenticationGapResponse, getAccessRefusal } from "@/lib/auth/access-gate";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { requireUser } from "@/lib/auth/session-store";

/**
 * Shared plumbing for the bot-builder routes.
 *
 * Three rules are applied here once rather than in each route: a read is scoped by the
 * signed-in account, a write must be same-origin, and every refusal is JSON with
 * `Cache-Control: no-store` so a refusal is never cached into looking like a success.
 */

export const MAX_BODY_BYTES = 16_384;

export function botJson(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function authErrorResponse(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal
    ? botJson(
        {
          error: refusal.error,
          ...(refusal.code ? { code: refusal.code } : {}),
          ...(refusal.scope ? { scope: refusal.scope } : {}),
        },
        refusal.status,
      )
    : null;
}

export async function readJsonBody(
  request: NextRequest,
): Promise<{ body: unknown } | { response: Response }> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return { response: botJson({ error: "Content-Type must be application/json." }, 415) };
  }
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return { response: botJson({ error: "Invalid request body." }, 400) };
  }
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return { response: botJson({ error: "Request is too large." }, 413) };
  }
  try {
    return { body: JSON.parse(rawBody) as unknown };
  } catch {
    return { response: botJson({ error: "Invalid JSON request." }, 400) };
  }
}

export type BotWriteSession = { userId: string };

/**
 * The session a write needs, or the response that refuses it.
 *
 * Origin is checked before the session so a cross-site post gets 403 rather than a hint
 * about whether the caller is signed in.
 */
export async function requireBotWrite(
  request: NextRequest,
): Promise<BotWriteSession | { response: Response }> {
  const config = getAuthConfig();
  if (!config) return { response: authenticationGapResponse() };
  if (!isSameOriginRequest(request, config)) {
    return { response: botJson({ error: "Request origin is not allowed." }, 403) };
  }
  try {
    const user = await requireUser();
    return { userId: user.id };
  } catch (error) {
    return { response: authErrorResponse(error) ?? botJson({ error: "User authorization is unavailable." }, 503) };
  }
}
