import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { authenticationGapResponse, getAccessRefusal } from "@/lib/auth/access-gate";
import { AuthenticationRequiredError, requireSessionRecord } from "@/lib/auth/session-store";
import { loadSecurityPolicy } from "@/lib/auth/security-policy";
import { beginEnrolment, disableTotp, verifyCode, type TotpServiceStore } from "@/lib/auth/totp-service";
import { totpStore } from "@/lib/auth/totp-store";
import { classifySubmittedCode } from "@/lib/auth/totp";

const MAX_BODY_BYTES = 4_096;

/**
 * How recently this session must have started for the request to count as a fresh
 * sign-in.
 *
 * This is the recovery path the owner controls, and the only one that replaces an
 * authenticator they can no longer use: proving the wallet key again, just now, is
 * the factor that authorises it. An old session does not — otherwise a laptop left
 * signed in overnight could rotate the second factor without the owner present.
 */
const FRESH_SIGN_IN_MS = 5 * 60 * 1000;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  if (!getAuthConfig()) return authenticationGapResponse();

  try {
    const { session } = await requireSessionRecord();
    const credential = await prisma.totpCredential.findUnique({
      where: { userId: session.userId },
      select: { id: true, label: true, activatedAt: true, revokedAt: true, createdAt: true, lockedUntil: true, failedAttempts: true },
    });
    const backupCodesRemaining = credential
      ? await prisma.totpBackupCode.count({ where: { credentialId: credential.id, usedAt: null } })
      : 0;
    const { policy } = await loadSecurityPolicy();

    return json({
      enrolled: Boolean(credential && credential.activatedAt && !credential.revokedAt),
      pending: Boolean(credential && !credential.activatedAt && !credential.revokedAt),
      credential: credential && !credential.revokedAt
        ? {
            label: credential.label,
            createdAt: credential.createdAt.toISOString(),
            activatedAt: credential.activatedAt?.toISOString() ?? null,
            failedAttempts: credential.failedAttempts,
            lockedUntil: credential.lockedUntil?.toISOString() ?? null,
          }
        : null,
      backupCodesRemaining,
      policy,
    });
  } catch (error) {
    const refusal = getAccessRefusal(error);
    return refusal ? json({ error: refusal.error }, refusal.status) : json({ error: "Authenticator state is unavailable." }, 503);
  }
}

/**
 * Begin enrolment. The secret and its `otpauth://` URI are in this response and
 * nowhere else — from the next request on, the column holds a sealed value.
 *
 * `replace` is the answered question "I have an authenticator I cannot use".
 * Without it, an active credential is never rotated: silently issuing a new secret
 * over a working one is how an owner loses access to their own account.
 */
export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let plainBody = "";
  try {
    plainBody = await request.text();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }
  if (Buffer.byteLength(plainBody, "utf8") > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413);
  let body: { replace?: unknown } = {};
  if (plainBody.trim()) {
    try {
      body = JSON.parse(plainBody) as typeof body;
    } catch {
      return json({ error: "Invalid JSON body." }, 400);
    }
  }

  let current;
  try {
    current = await requireSessionRecord();
  } catch (error) {
    return error instanceof AuthenticationRequiredError
      ? json({ error: "Authentication required." }, 401)
      : json({ error: "Authenticator enrolment is unavailable." }, 503);
  }

  const now = new Date();
  if (body.replace === true) {
    const freshSignIn = now.getTime() - current.session.createdAt.getTime() < FRESH_SIGN_IN_MS;
    if (!freshSignIn) {
      return json(
        {
          error: "Replacing an active authenticator needs a fresh sign-in with your wallet, so this session is too old to do it.",
          code: "FRESH_SIGN_IN_REQUIRED",
        },
        403,
      );
    }
  }

  try {
    // The offer is created in a transaction with its audit entry, so a secret that
    // exists is a secret whose issue is on the trail.
    const outcome = await prisma.$transaction((transaction) => beginEnrolment({
      store: totpStore(transaction),
      userId: current.session.userId,
      // What the authenticator app shows as the account name: the wallet the
      // session belongs to, so two accounts in one app are told apart.
      account: current.user.address ?? current.session.userId,
      issuer: "Veylora",
      label: current.user.address ? `Veylora · ${current.user.address}` : "Veylora account",
      now,
      // Only a fresh sign-in reaches here with this set, and the service audits
      // the replacement as the deliberate act it is.
      allowActiveReplacement: body.replace === true,
    }));

    if (!outcome.ok) return json({ error: outcome.error, code: outcome.reason }, 409);
    return json({
      enrolled: false,
      pending: true,
      // Shown once. The response is no-store, and the value is never logged.
      secret: outcome.offer.secret,
      otpauthUri: outcome.offer.otpauthUri,
      label: outcome.offer.label,
      digits: outcome.offer.digits,
      periodSeconds: outcome.offer.periodSeconds,
      algorithm: outcome.offer.algorithm,
      note: "Add this to your authenticator app, then activate it with a code. The secret is shown only this once.",
    });
  } catch {
    return json({ error: "Authenticator enrolment could not be recorded." }, 503);
  }
}

/** Turn the authenticator off, proved with a code the account already holds. */
export async function DELETE(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let current;
  try {
    current = await requireSessionRecord();
  } catch {
    return json({ error: "Authentication required." }, 401);
  }

  let body: { code?: unknown; backupCode?: unknown; reason?: unknown } = {};
  try {
    body = JSON.parse(await request.text()) as typeof body;
  } catch {
    body = {};
  }

  const { policy } = await loadSecurityPolicy();
  try {
    const result = await prisma.$transaction(async (transaction) => {
      const store = totpStore(transaction);
      // Proved first, then disabled: an authenticator can only be removed by
      // someone who can satisfy it, or by a backup code, which is the point of
      // having them. The scopes stay switchable either way, so there is always a
      // path back into an account whose second factor is unreachable.
      const verification = await verifyForDisable({ store, userId: current.session.userId, body, policy });
      if (!verification.ok) return verification;
      const outcome = await disableTotp({
        store,
        userId: current.session.userId,
        now: new Date(),
        reason: typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 200) : "Disabled in the security panel.",
      });
      return outcome.ok ? { ok: true as const, disabled: outcome.disabled } : outcome;
    });

    if (!result.ok) return json({ error: result.error, code: result.code }, result.status);
    return json({ disabled: result.disabled });
  } catch {
    return json({ error: "The authenticator could not be disabled." }, 503);
  }
}

async function verifyForDisable(input: {
  store: TotpServiceStore;
  userId: string;
  body: { code?: unknown; backupCode?: unknown };
  policy: Awaited<ReturnType<typeof loadSecurityPolicy>>["policy"];
}) {
  // One field, either kind of code — the panel labels it "code or backup code"
  // and this is what makes that true rather than a hint.
  const submitted = classifySubmittedCode(input.body.code ?? input.body.backupCode);
  return verifyCode({
    store: input.store,
    userId: input.userId,
    code: submitted.kind === "totp" ? submitted.normalized : undefined,
    backupCode: submitted.kind === "backup" ? submitted.normalized : undefined,
    now: new Date(),
    policy: { maxFailedAttempts: input.policy.maxFailedAttempts, lockoutMinutes: input.policy.lockoutMinutes },
    purpose: "recovery",
  });
}
