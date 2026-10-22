import { NextRequest } from "next/server";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { getAccessRefusal, authenticationGapResponse } from "@/lib/auth/access-gate";
import { requireAdmin } from "@/lib/auth/session-store";
import { readWithdrawalPolicy } from "@/lib/withdrawals/policy";
import {
  getWithdrawalOwnerSettings,
  saveWithdrawalOwnerSettings,
  validateWithdrawalOwnerSettings,
  withdrawalSettingsView,
} from "@/lib/withdrawals/settings";

/**
 * The owner's own withdrawal window, as admin data.
 *
 * `GET` reports the number in force, whether it came from this deployment's environment or
 * from the row the owner saved, and what the other candidate is — so a page can show a person
 * exactly which number is holding their own withdrawals.
 *
 * `PUT` saves the number and audits the change. The validation allows zero and says so in its
 * own words, because zero is a complete answer: it holds nothing. Nothing else is accepted
 * here, and nothing else exists to accept: there is no approval flag, no review state and no
 * switch in this table, because a withdrawal the owner asks for has no gate in front of it.
 */

const MAX_BODY_BYTES = 2_048;

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
    const policy = readWithdrawalPolicy();
    const stored = await getWithdrawalOwnerSettings();
    return json(withdrawalSettingsView(policy, stored));
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "Withdrawal settings are unavailable." }, 503);
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

  const validation = validateWithdrawalOwnerSettings(body);
  if (!validation.valid) return json({ error: validation.error }, 400);

  try {
    const saved = await saveWithdrawalOwnerSettings(validation.value, admin.id);
    return json(withdrawalSettingsView(readWithdrawalPolicy(), saved));
  } catch {
    return json({ error: "Withdrawal settings could not be audited and saved." }, 503);
  }
}
