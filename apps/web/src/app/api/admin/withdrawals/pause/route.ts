import { NextRequest } from "next/server";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { getAccessRefusal, authenticationGapResponse } from "@/lib/auth/access-gate";
import { requireAdmin } from "@/lib/auth/session-store";
import { readWithdrawalPolicy } from "@/lib/withdrawals/policy";
import { setWithdrawalsPaused, withdrawalSettingsView } from "@/lib/withdrawals/settings";

/**
 * The owner's stop switch for outbound money.
 *
 * It exists because the permanent absence of an approval gate is not the same thing as
 * the absence of a stop: a custodial deployment needs one control that instantly stops
 * new withdrawals, and it must be a switch on the whole path rather than a review of an
 * individual request. Turning it on refuses every new request and stops the processor
 * sending a reserved one; already-broadcast transfers still confirm and settle.
 *
 * `GET` reports the state with the rest of the withdrawal settings; `POST` flips it and
 * writes an audit event with the actor and the time in the same transaction. The body is
 * deliberately one boolean: there is nothing else here to configure, and no amount of
 * this API can approve a specific withdrawal.
 */

const MAX_BODY_BYTES = 512;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authErrorResponse(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal ? json({ error: refusal.error }, refusal.status) : null;
}

export async function POST(request: NextRequest) {
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

  const rawBody = await request.text().catch(() => null);
  if (rawBody === null) return json({ error: "Invalid request body." }, 400);
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413);

  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Send {\"paused\": true} or {\"paused\": false}." }, 400);
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "paused" || typeof (body as { paused: unknown }).paused !== "boolean") {
    return json({ error: "The only accepted field is \"paused\", as true or false." }, 400);
  }

  try {
    const saved = await setWithdrawalsPaused((body as { paused: boolean }).paused, admin.id);
    return json(withdrawalSettingsView(readWithdrawalPolicy(), saved));
  } catch {
    return json({ error: "The pause could not be audited and saved, so nothing changed." }, 503);
  }
}
