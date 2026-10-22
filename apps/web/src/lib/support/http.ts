import { NextRequest } from "next/server";
import {
  accessRefusalPayload,
  authenticationGapResponse,
  getAccessRefusal,
} from "@/lib/auth/access-gate";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { requireSitePermission } from "@/lib/auth/session-store";
import type { ActiveSitePermissionKey } from "@/lib/auth/access-control";
import { SupportRefusal } from "@/lib/support/repository";

/**
 * The pieces every support route repeats: a no-store JSON answer, the
 * authentication/authorisation refusal in its one wording, a bounded body read,
 * and the same-origin check in front of a mutation. Kept here so a new route
 * cannot answer a permission refusal with half the fields.
 */

export function supportJson(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export type SupportCaller = { id: string };

export async function requireSupportCaller(
  permission: Extract<ActiveSitePermissionKey, "crm.support.read" | "crm.support.manage">,
): Promise<{ ok: true; user: SupportCaller } | { ok: false; response: Response }> {
  try {
    const user = await requireSitePermission(permission);
    return { ok: true, user: { id: user.id } };
  } catch (error) {
    const refusal = getAccessRefusal(error);
    return {
      ok: false,
      response: refusal ? supportJson(accessRefusalPayload(refusal), refusal.status) : authenticationGapResponse(),
    };
  }
}

export async function requireSameOrigin(request: NextRequest): Promise<Response | null> {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return supportJson({ error: "Request origin is not allowed." }, 403);
  return null;
}

export async function readSupportBody(
  request: NextRequest,
  maxBytes = 16_384,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return { ok: false, response: supportJson({ error: "Content-Type must be application/json." }, 415) };
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    return { ok: false, response: supportJson({ error: `A support request is capped at ${maxBytes} bytes.` }, 413) };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, response: supportJson({ error: "Invalid JSON body." }, 400) };
  }
}

/** Turn a repository refusal into its answer; anything else is a named 503. */
export function supportFailure(error: unknown, fallback: string): Response {
  if (error instanceof SupportRefusal) return supportJson({ error: error.message }, error.status);
  return supportJson({ error: fallback }, 503);
}
