import { NextRequest } from "next/server";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { accessRefusalPayload, authenticationGapResponse, getAccessRefusal } from "@/lib/auth/access-gate";
import { requireSitePermission, requireSessionRecord } from "@/lib/auth/session-store";
import {
  loadSecurityPolicy,
  saveSecurityPolicy,
  validateSecurityPolicyUpdate,
} from "@/lib/auth/security-policy";
import { describeUnenforcedScope, hasActivatedTotp } from "@/lib/auth/step-up";

const MAX_BODY_BYTES = 4_096;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authErrorResponse(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal ? json(accessRefusalPayload(refusal), refusal.status) : null;
}

/**
 * The panel's read: the switches, plus whether each one is currently enforceable.
 *
 * The second half is the part that matters. A scope can be *on* and still not be
 * enforced, because there is no activated authenticator behind it, and the owner
 * has to be told that here — where they can enrol one — rather than at a trading
 * page that refuses them for a reason they cannot see.
 */
export async function GET() {
  try {
    const { session } = await requireSessionRecord();
    await requireSitePermission("security.policy.manage");
    const { policy, persisted } = await loadSecurityPolicy();
    const enrolled = await hasActivatedTotp(session.userId);
    return json({
      policy,
      persisted,
      enrolled,
      scopes: (["sign-in", "trading", "funding"] as const).map((scope) => ({
        scope,
        required: scope === "sign-in"
          ? policy.requireTotpForSignIn
          : scope === "trading"
            ? policy.requireTotpForTrading
            : policy.requireTotpForFunding,
        note: describeUnenforcedScope(policy, enrolled, scope),
      })),
    });
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "Security policy storage is unavailable." }, 503);
  }
}

export async function PUT(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let admin;
  try {
    admin = await requireSitePermission("security.policy.manage");
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

  let body: { policy?: unknown; reason?: unknown };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const validation = validateSecurityPolicyUpdate(body.policy);
  if (!validation.valid) return json({ error: validation.error }, 400);

  const reason = typeof body.reason === "string" && body.reason.trim()
    ? body.reason.trim().slice(0, 200)
    : undefined;

  try {
    const policy = await saveSecurityPolicy(validation.value, { actorUserId: admin.id, reason });
    return json({ policy, saved: true });
  } catch {
    return json({ error: "Security policy update could not be audited and saved." }, 503);
  }
}
