import { NextRequest } from "next/server";
import { accessRefusalPayload, authenticationGapResponse, getAccessRefusal } from "@/lib/auth/access-gate";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { requireSitePermission } from "@/lib/auth/session-store";
import { postAdminLedgerCorrection } from "@/lib/admin/actions";
import { validateLedgerCorrection } from "@/lib/admin/views";

/**
 * One balanced correcting entry, written by the owner.
 *
 * The route checks the operate permission and the request origin, validates the
 * whole body before touching money, then posts + audits in one transaction. It
 * does not ask for a confirmation: the button's effect is printed beside it and
 * pressing it is the decision.
 */

const MAX_BODY_BYTES = 8_192;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let admin;
  try {
    admin = await requireSitePermission("admin.console.operate");
  } catch (error) {
    const refusal = getAccessRefusal(error);
    return refusal ? json(accessRefusalPayload(refusal), refusal.status) : authenticationGapResponse();
  }

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415);
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413);

  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const validation = validateLedgerCorrection(body);
  if (!validation.valid) return json({ error: validation.error }, 400);

  const result = await postAdminLedgerCorrection({ actorUserId: admin.id, value: validation.value });
  if (!result.ok) return json({ error: result.error }, result.status);
  return json(result, result.alreadyCompleted ? 200 : 201);
}
