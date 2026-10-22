import { openTotpSecret, sealTotpSecret } from "@/lib/auth/totp-secret";
import {
  BACKUP_CODE_COUNT,
  createBackupCodes,
  createTotpSecret,
  evaluateTotpAttempt,
  hashBackupCode,
  normalizeBackupCode,
  otpauthUri,
  TOTP_ALGORITHM,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  type TotpAttemptPolicy,
} from "@/lib/auth/totp";

/**
 * The authenticator's lifecycle, as operations rather than as route handlers.
 *
 * Each function takes its store, so the whole flow — enrol, activate, verify,
 * lock out, recover with a backup code, disable — is exercised in tests against
 * an in-memory store, and the routes only own the transaction and the HTTP shape.
 *
 * The rules that are decisions rather than mechanics, all in one place:
 *
 *   * A secret exists in readable form exactly once, when it is issued. From then
 *     on it is sealed, and the only operation that opens it is a code check.
 *   * Enrolment is not security until it is activated: a pending credential
 *     demands nothing and gates nothing, so abandoning it halfway costs the owner
 *     nothing but a new secret next time.
 *   * Failure counting and the lock belong to the credential, and any accepted
 *     code resets both. A lock is stored as the moment it ends, so it lifts by
 *     itself and nothing has to sweep it.
 *   * A backup code works while the account is locked. That is the recovery path
 *     the owner controls, and the reason a lockout is not a lockout out.
 *   * Nothing in here writes a secret or a code into the audit trail. The trail
 *     records that an attempt happened, its outcome and the reason a person
 *     needs; never the material.
 */

export type TotpCredentialRow = {
  id: string;
  userId: string;
  label: string;
  secretCiphertext: string;
  secretIv: string;
  secretAuthTag: string;
  digits: number;
  periodSeconds: number;
  algorithm: string;
  activatedAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedStep: number | null;
  failedAttempts: number;
  lockedUntil: Date | null;
  revokedAt: Date | null;
};

export type TotpServiceStore = {
  findCredential: (userId: string) => Promise<TotpCredentialRow | null>;
  createCredential: (data: {
    userId: string;
    label: string;
    secretCiphertext: string;
    secretIv: string;
    secretAuthTag: string;
    digits: number;
    periodSeconds: number;
    algorithm: string;
  }) => Promise<TotpCredentialRow>;
  updateCredential: (userId: string, data: Partial<TotpCredentialRow>) => Promise<TotpCredentialRow>;
  deleteCredential: (userId: string) => Promise<void>;
  replaceBackupCodes: (credentialId: string, codeHashes: string[]) => Promise<void>;
  findBackupCode: (credentialId: string, codeHash: string) => Promise<{ id: string; usedAt: Date | null } | null>;
  markBackupCodeUsed: (backupCodeId: string, at: Date) => Promise<boolean>;
  countUnusedBackupCodes: (credentialId: string) => Promise<number>;
  recordAudit: (input: {
    actorUserId: string;
    action: string;
    objectType: string;
    objectId: string;
    outcome: string;
    detail: Record<string, unknown>;
  }) => Promise<void>;
};

export type EnrolmentOffer = {
  /** Readable exactly once, here. Sealed from now on. */
  secret: string;
  otpauthUri: string;
  digits: number;
  periodSeconds: number;
  algorithm: string;
  label: string;
};

export type BeginEnrolmentOutcome =
  | { ok: true; offer: EnrolmentOffer }
  | { ok: false; reason: "ALREADY_ACTIVE"; error: string };

/**
 * Start (or restart) enrolment: a fresh secret, sealed, not yet activated.
 *
 * Re-issuing is allowed while the credential is pending — a user who loses the QR
 * before activating needs a new one — and refused while it is active, because
 * silently rotating a working authenticator is how an owner loses access.
 *
 * `allowActiveReplacement` is how an authenticator the owner cannot use is
 * replaced: the caller has already proved wallet control again with a fresh
 * sign-in, which is the factor they still hold. It is not a bypass — it is the
 * recovery path — and the audit entry says the replacement was deliberate.
 */
export async function beginEnrolment(input: {
  store: TotpServiceStore;
  userId: string;
  account: string;
  issuer: string;
  label: string;
  now: Date;
  allowActiveReplacement?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<BeginEnrolmentOutcome> {
  const existing = await input.store.findCredential(input.userId);
  const activeCredential = Boolean(existing?.activatedAt && !existing.revokedAt);
  if (activeCredential && !input.allowActiveReplacement) {
    return {
      ok: false,
      reason: "ALREADY_ACTIVE",
      error: "An authenticator is already active on this account. Disable it first to enrol a new one.",
    };
  }

  const secret = createTotpSecret();
  const sealed = sealTotpSecret(secret, input.env);
  const data = {
    userId: input.userId,
    label: input.label,
    secretCiphertext: sealed.ciphertext,
    secretIv: sealed.iv,
    secretAuthTag: sealed.authTag,
    digits: TOTP_DIGITS,
    periodSeconds: TOTP_PERIOD_SECONDS,
    algorithm: TOTP_ALGORITHM,
  };

  // A pending credential is replaced rather than accumulated: one account has one
  // authenticator, and a half-finished enrolment is not a second one.
  if (existing) await input.store.deleteCredential(input.userId);
  const credential = await input.store.createCredential(data);

  await input.store.recordAudit({
    actorUserId: input.userId,
    action: "AUTH_TOTP_ENROLMENT_STARTED",
    objectType: "TotpCredential",
    objectId: credential.id,
    outcome: "SUCCESS",
    detail: {
      replacedPending: Boolean(existing) && !activeCredential,
      replacedActive: activeCredential,
      digits: data.digits,
      periodSeconds: data.periodSeconds,
    },
  });

  return {
    ok: true,
    offer: {
      secret,
      otpauthUri: otpauthUri({
        secret,
        account: input.account,
        issuer: input.issuer,
        digits: data.digits,
        periodSeconds: data.periodSeconds,
        algorithm: data.algorithm,
      }),
      digits: data.digits,
      periodSeconds: data.periodSeconds,
      algorithm: data.algorithm,
      label: input.label,
    },
  };
}

export type ActivationOutcome =
  | { ok: true; backupCodes: string[]; credentialId: string }
  | { ok: false; status: number; error: string; code?: string; failedAttempts?: number; lockedUntil?: string | null };

/**
 * Activate an enrolment by proving one code, and issue backup codes with it.
 *
 * The codes are returned here and nowhere else: their digests are what is stored,
 * so this response is the only moment they are readable. That is the whole reason
 * a backup code cannot be shown again — it does not exist to show.
 */
export async function activateEnrolment(input: {
  store: TotpServiceStore;
  userId: string;
  code: unknown;
  now: Date;
  policy: TotpAttemptPolicy;
  env?: NodeJS.ProcessEnv;
}): Promise<ActivationOutcome> {
  const credential = await input.store.findCredential(input.userId);
  if (!credential) return { ok: false, status: 409, error: "No enrolment is waiting to be activated. Start enrolment first." };
  if (credential.revokedAt) return { ok: false, status: 409, error: "That enrolment was disabled. Start enrolment again." };
  if (credential.activatedAt) return { ok: false, status: 409, error: "This authenticator is already active." };

  const secret = openTotpSecret(
    { ciphertext: credential.secretCiphertext, iv: credential.secretIv, authTag: credential.secretAuthTag },
    input.env,
  );

  const attempt = evaluateTotpAttempt({
    secret,
    code: input.code,
    at: input.now,
    digits: credential.digits,
    periodSeconds: credential.periodSeconds,
    lastUsedStep: credential.lastUsedStep,
    failedAttempts: credential.failedAttempts,
    lockedUntil: credential.lockedUntil,
    policy: input.policy,
  });

  if (attempt.outcome === "rejected") {
    const updated = await input.store.updateCredential(input.userId, {
      failedAttempts: attempt.failedAttempts,
      lockedUntil: attempt.lockedUntil,
    });
    await input.store.recordAudit({
      actorUserId: input.userId,
      action: "AUTH_TOTP_ACTIVATION_FAILED",
      objectType: "TotpCredential",
      objectId: credential.id,
      outcome: "REJECTED",
      detail: { reason: attempt.reason, failedAttempts: attempt.failedAttempts, locked: attempt.lockedNow, code: null },
    });
    return {
      ok: false,
      status: attempt.reason === "locked" ? 423 : 401,
      error: attempt.message,
      code: attempt.reason === "locked" ? "TOTP_LOCKED" : "TOTP_REJECTED",
      failedAttempts: updated.failedAttempts,
      lockedUntil: attempt.lockedUntil ? attempt.lockedUntil.toISOString() : null,
    };
  }

  const backupCodes = createBackupCodes();
  await input.store.replaceBackupCodes(credential.id, backupCodes.map((code) => hashBackupCode(normalizeBackupCode(code)!)));
  const activated = await input.store.updateCredential(input.userId, {
    activatedAt: input.now,
    lastUsedAt: input.now,
    lastUsedStep: attempt.step,
    failedAttempts: 0,
    lockedUntil: null,
  });

  await input.store.recordAudit({
    actorUserId: input.userId,
    action: "AUTH_TOTP_ACTIVATED",
    objectType: "TotpCredential",
    objectId: credential.id,
    outcome: "SUCCESS",
    // Count and label, never a code: the trail says an authenticator became
    // active and how many recovery codes came with it.
    detail: { label: activated.label, backupCodesIssued: backupCodes.length, digits: activated.digits },
  });

  return { ok: true, backupCodes, credentialId: credential.id };
}

export type VerificationOutcome =
  | { ok: true; method: "TOTP" | "BACKUP_CODE"; step?: number; backupCodesRemaining?: number }
  | { ok: false; status: number; error: string; code: string; failedAttempts?: number; lockedUntil?: string | null };

/**
 * Check one code for a step-up, counting failures and honouring the lock.
 *
 * A backup code is accepted here too, and deliberately while locked: an owner
 * locked out by their own wrong typing must still be able to get in with the
 * recovery codes they printed, or the lockout is a lockout out. Using one is a
 * separate, audited act, and the count that is reported back says how many are
 * left so the panel can warn before the last one goes.
 */
export async function verifyCode(input: {
  store: TotpServiceStore;
  userId: string;
  code?: unknown;
  backupCode?: unknown;
  now: Date;
  policy: TotpAttemptPolicy;
  purpose: "step-up" | "recovery";
  env?: NodeJS.ProcessEnv;
}): Promise<VerificationOutcome> {
  const credential = await input.store.findCredential(input.userId);
  if (!credential || credential.revokedAt) {
    return { ok: false, status: 409, error: "No authenticator is active on this account.", code: "TOTP_NOT_ENROLLED" };
  }
  if (!credential.activatedAt) {
    return { ok: false, status: 409, error: "This authenticator has not been activated yet.", code: "TOTP_NOT_ACTIVATED" };
  }

  const normalizedBackup = normalizeBackupCode(input.backupCode);
  if (input.backupCode !== undefined && !normalizedBackup) {
    return { ok: false, status: 400, error: "That is not a backup code. They are ten characters, in the form ABCDE-FGHJK.", code: "BACKUP_CODE_MALFORMED" };
  }

  if (normalizedBackup) {
    return consumeBackupCode({ ...input, credential, normalizedBackup });
  }

  const secret = openTotpSecret(
    { ciphertext: credential.secretCiphertext, iv: credential.secretIv, authTag: credential.secretAuthTag },
    input.env,
  );
  const attempt = evaluateTotpAttempt({
    secret,
    code: input.code,
    at: input.now,
    digits: credential.digits,
    periodSeconds: credential.periodSeconds,
    lastUsedStep: credential.lastUsedStep,
    failedAttempts: credential.failedAttempts,
    lockedUntil: credential.lockedUntil,
    policy: input.policy,
  });

  if (attempt.outcome === "rejected") {
    await input.store.updateCredential(input.userId, {
      failedAttempts: attempt.failedAttempts,
      lockedUntil: attempt.lockedUntil,
    });
    // Every failure is on the trail with its reason and its count, because "five
    // wrong codes in a minute" is the event the owner needs to be able to see.
    await input.store.recordAudit({
      actorUserId: input.userId,
      action: "AUTH_TOTP_FAILED",
      objectType: "TotpCredential",
      objectId: credential.id,
      outcome: "REJECTED",
      detail: { reason: attempt.reason, failedAttempts: attempt.failedAttempts, locked: attempt.lockedNow, purpose: input.purpose },
    });
    return {
      ok: false,
      status: attempt.reason === "locked" ? 423 : 401,
      error: attempt.message,
      code: attempt.reason === "locked" ? "TOTP_LOCKED" : "TOTP_REJECTED",
      failedAttempts: attempt.failedAttempts,
      lockedUntil: attempt.lockedUntil ? attempt.lockedUntil.toISOString() : null,
    };
  }

  await input.store.updateCredential(input.userId, {
    lastUsedAt: input.now,
    lastUsedStep: attempt.step,
    failedAttempts: 0,
    lockedUntil: null,
  });
  await input.store.recordAudit({
    actorUserId: input.userId,
    action: "AUTH_TOTP_VERIFIED",
    objectType: "TotpCredential",
    objectId: credential.id,
    outcome: "SUCCESS",
    detail: { purpose: input.purpose, failedAttempts: 0 },
  });

  return { ok: true, method: "TOTP", step: attempt.step };
}

async function consumeBackupCode(input: {
  store: TotpServiceStore;
  userId: string;
  now: Date;
  purpose: "step-up" | "recovery";
  credential: TotpCredentialRow;
  normalizedBackup: string;
}): Promise<VerificationOutcome> {
  const { credential, store } = input;
  const codeHash = hashBackupCode(input.normalizedBackup);
  const row = await store.findBackupCode(credential.id, codeHash);
  if (!row) {
    await store.recordAudit({
      actorUserId: input.userId,
      action: "AUTH_TOTP_FAILED",
      objectType: "TotpCredential",
      objectId: credential.id,
      outcome: "REJECTED",
      detail: { reason: "backup-code-not-found", failedAttempts: credential.failedAttempts, locked: false, purpose: input.purpose },
    });
    return { ok: false, status: 401, error: "That backup code is not one of this account's codes.", code: "BACKUP_CODE_INVALID" };
  }

  // Single use is enforced by the conditional UPDATE, not by the read: two
  // requests presenting the same code cannot both win.
  const consumed = await store.markBackupCodeUsed(row.id, input.now);
  if (!consumed) {
    await store.recordAudit({
      actorUserId: input.userId,
      action: "AUTH_TOTP_FAILED",
      objectType: "TotpCredential",
      objectId: credential.id,
      outcome: "REJECTED",
      detail: { reason: "backup-code-already-used", failedAttempts: credential.failedAttempts, locked: false, purpose: input.purpose },
    });
    return { ok: false, status: 401, error: "That backup code has already been used. Each one works once.", code: "BACKUP_CODE_USED" };
  }

  // A backup code proves the account, so it clears the lock and the failure count
  // as an accepted code would — otherwise recovering would still leave the door
  // barred behind it.
  await store.updateCredential(input.userId, { lastUsedAt: input.now, failedAttempts: 0, lockedUntil: null });
  const remaining = await store.countUnusedBackupCodes(credential.id);
  await store.recordAudit({
    actorUserId: input.userId,
    action: "AUTH_TOTP_BACKUP_CODE_USED",
    objectType: "TotpCredential",
    objectId: credential.id,
    outcome: "SUCCESS",
    detail: { purpose: input.purpose, backupCodesRemaining: remaining },
  });
  return { ok: true, method: "BACKUP_CODE", backupCodesRemaining: remaining };
}

export type DisableOutcome = { ok: true; disabled: boolean } | { ok: false; status: number; error: string; code?: string };

/**
 * Turn the authenticator off: the credential is revoked, its backup codes go with
 * it, and every scope that depended on it stops being enforceable — which the
 * admin panel then says out loud rather than leaving a switch on with nothing
 * behind it.
 */
export async function disableTotp(input: {
  store: TotpServiceStore;
  userId: string;
  now: Date;
  reason: string;
}): Promise<DisableOutcome> {
  const credential = await input.store.findCredential(input.userId);
  if (!credential || credential.revokedAt) return { ok: true, disabled: false };

  await input.store.updateCredential(input.userId, { revokedAt: input.now, failedAttempts: 0, lockedUntil: null });
  await input.store.replaceBackupCodes(credential.id, []);
  await input.store.recordAudit({
    actorUserId: input.userId,
    action: "AUTH_TOTP_DISABLED",
    objectType: "TotpCredential",
    objectId: credential.id,
    outcome: "SUCCESS",
    detail: { reason: input.reason, wasActivated: Boolean(credential.activatedAt) },
  });
  return { ok: true, disabled: true };
}

export { BACKUP_CODE_COUNT };
