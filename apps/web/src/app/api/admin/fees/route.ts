import { NextRequest } from "next/server";
import { accessRefusalPayload, getAccessRefusal, authenticationGapResponse } from "@/lib/auth/access-gate";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { requireSitePermission } from "@/lib/auth/session-store";
import { feeSchedulePayload } from "@/lib/fees/admin";
import { readFeeScheduleView, saveFeeSchedule, validateFeeScheduleUpdate } from "@/lib/fees/table";

/**
 * The fee table's admin surface.
 *
 * `GET` is what `/admin/fees` renders: the version in force, any staged versions, the
 * history, and the assets the withdrawal path can actually send (so the form edits the
 * fees that exist rather than a list someone typed twice). `PUT` saves a new version
 * and writes one audit event naming what changed.
 *
 * Two properties are the whole design:
 *
 *  - **A save is an insert.** The route never updates a version, so the "before" the
 *    audit records remains readable and a future-dated change is staged rather than
 *    applied early.
 *  - **A zero is saved, not skipped.** The validator accepts `0` and the table stores
 *    it; the pricing page and the withdrawal panel then render "no fee". Treating zero
 *    as empty is how a free configuration silently becomes the previous price.
 *
 * Validation happens before anything is written, and an invalid save answers 400 with
 * the validator's sentence — a fee table is money, and a refused save must say which
 * value it refused.
 */

const MAX_BODY_BYTES = 32_768;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authErrorResponse(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal ? json(accessRefusalPayload(refusal), refusal.status) : null;
}

export async function GET() {
  try {
    await requireSitePermission("fees.manage");
    return json(feeSchedulePayload(await readFeeScheduleView()));
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "The fee table is unavailable." }, 503);
  }
}

export async function PUT(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let admin;
  try {
    admin = await requireSitePermission("fees.manage");
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

  const validation = validateFeeScheduleUpdate(body);
  if (!validation.valid) return json({ error: validation.error }, 400);

  try {
    return json(feeSchedulePayload(await saveFeeSchedule(validation.value, admin.id)));
  } catch {
    return json({ error: "The fee table could not be saved and audited." }, 503);
  }
}
