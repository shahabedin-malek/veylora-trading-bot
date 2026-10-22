import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { authenticationGapResponse } from "@/lib/auth/access-gate";
import { requireSessionRecord } from "@/lib/auth/session-store";
import { loadSecurityPolicy } from "@/lib/auth/security-policy";
import { activateEnrolment } from "@/lib/auth/totp-service";
import { totpStore } from "@/lib/auth/totp-store";

const MAX_BODY_BYTES = 1_024;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Prove the enrolment, and hand back the backup codes.
 *
 * This response is the only moment those codes are readable: what is stored is a
 * digest per code, so "show them again" is not a missing feature, it is a thing
 * that cannot be done. The response is `no-store`, and the codes are never
 * written to a log line or to the audit trail (which records how many were
 * issued, not what they were).
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

  let body: { code?: unknown };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const { policy } = await loadSecurityPolicy();
  const now = new Date();

  try {
    const outcome = await prisma.$transaction((transaction) => activateEnrolment({
      store: totpStore(transaction),
      userId: current.session.userId,
      code: body.code,
      now,
      // The lockout is the owner's own policy, read here rather than fixed in the
      // service: the same numbers govern activation and every later step-up.
      policy: { maxFailedAttempts: policy.maxFailedAttempts, lockoutMinutes: policy.lockoutMinutes },
    }));

    if (!outcome.ok) {
      return json(
        { error: outcome.error, code: outcome.code ?? "TOTP_REJECTED", failedAttempts: outcome.failedAttempts, lockedUntil: outcome.lockedUntil },
        outcome.status,
      );
    }

    // Activation is a change of factor, so the session that made it is recorded
    // as having proved a code just now — the owner should not be asked for a
    // second one immediately afterwards.
    await prisma.authSession.update({
      where: { id: current.session.id },
      data: { totpVerifiedAt: now, totpLastStep: null },
    });

    return json({
      activated: true,
      backupCodes: outcome.backupCodes,
      backupCodesRemaining: outcome.backupCodes.length,
      note: "Store these somewhere safe. Each code works once, and they cannot be shown again.",
    });
  } catch {
    return json({ error: "Activation could not be recorded." }, 503);
  }
}
