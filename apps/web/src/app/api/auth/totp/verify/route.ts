import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { authenticationGapResponse } from "@/lib/auth/access-gate";
import { requireSessionRecord } from "@/lib/auth/session-store";
import { describeStepUpWindow, isScopeRequired, isSecurityScope, loadSecurityPolicy } from "@/lib/auth/security-policy";
import { verifyCode } from "@/lib/auth/totp-service";
import { totpStore } from "@/lib/auth/totp-store";
import { classifySubmittedCode } from "@/lib/auth/totp";
import { auditCreate } from "@/lib/audit/record";

const MAX_BODY_BYTES = 2_048;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * The one endpoint every gated surface uses to satisfy a step-up.
 *
 * A code accepted here is recorded **on this session's row** — `totpVerifiedAt`
 * and the time step it came from — which is what makes the window per device: a
 * code typed on a phone does not unlock a laptop, and a code cannot be replayed
 * inside its own period because the step it came from is remembered.
 *
 * The request names the scope it is proving, so the sentence the person reads is
 * about the action in front of them ("Trading needs a code before placing an
 * order") rather than about codes in general. A scope that is off answers
 * `required: false` rather than refusing: the client asked a question, and the
 * answer is that nothing is needed.
 */
export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let current;
  try {
    current = await requireSessionRecord();
  } catch {
    return json({ error: "Authentication required." }, 401);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413);

  let body: { code?: unknown; backupCode?: unknown; scope?: unknown };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  if (!isSecurityScope(body.scope)) {
    return json({ error: "A scope is required: sign-in, trading or funding.", code: "SCOPE_REQUIRED" }, 400);
  }

  const { policy } = await loadSecurityPolicy();
  if (!isScopeRequired(policy, body.scope)) {
    return json({
      verified: true,
      required: false,
      scope: body.scope,
      note: "This scope is switched off in the security policy, so no code is needed.",
    });
  }

  const now = new Date();
  try {
    const outcome = await prisma.$transaction(async (transaction) => {
      // One input, two kinds of code: a backup code typed into the code field is
      // still a backup code, which is what makes the recovery path reachable from
      // the same prompt as the everyday one.
      const submitted = classifySubmittedCode(body.code ?? body.backupCode);
      const result = await verifyCode({
        store: totpStore(transaction),
        userId: current.session.userId,
        code: submitted.kind === "totp" ? submitted.normalized : undefined,
        backupCode: submitted.kind === "backup" ? submitted.normalized : undefined,
        now,
        policy: { maxFailedAttempts: policy.maxFailedAttempts, lockoutMinutes: policy.lockoutMinutes },
        purpose: "step-up",
      });
      if (!result.ok) return result;

      // The verification belongs to the session, so it is written there: the
      // credential records that a code was used (and consumes its step), the row
      // records that *this device* proved one, and that is the pair that decides
      // whether the next gated action asks again.
      await transaction.authSession.update({
        where: { id: current.session.id },
        data: { totpVerifiedAt: now, totpLastStep: result.method === "TOTP" ? (result.step ?? null) : null },
      });
      await auditCreate(transaction, {
        data: {
          actorUserId: current.session.userId,
          action: "AUTH_TOTP_STEP_UP_GRANTED",
          objectType: "AuthSession",
          objectId: current.session.id,
          outcome: "SUCCESS",
          redactedJson: JSON.stringify({ scope: body.scope, method: result.method, stepUpMinutes: policy.stepUpMinutes }),
        },
      });
      return result;
    });

    if (!outcome.ok) {
      return json(
        { error: outcome.error, code: outcome.code, failedAttempts: outcome.failedAttempts, lockedUntil: outcome.lockedUntil },
        outcome.status,
      );
    }

    return json({
      verified: true,
      required: true,
      scope: body.scope,
      method: outcome.method,
      backupCodesRemaining: outcome.backupCodesRemaining ?? null,
      stepUpMinutes: policy.stepUpMinutes,
      note: `Verified for the next ${describeStepUpWindow(policy.stepUpMinutes)} on this device.`,
    });
  } catch {
    return json({ error: "The code could not be checked." }, 503);
  }
}
