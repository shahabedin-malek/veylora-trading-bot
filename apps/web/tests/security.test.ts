import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  BACKUP_CODE_COUNT,
  base32Decode,
  base32Encode,
  classifySubmittedCode,
  createBackupCodes,
  createTotpSecret,
  currentTimeStep,
  evaluateTotpAttempt,
  hashBackupCode,
  hotp,
  normalizeBackupCode,
  normalizeTotpCode,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  totpCode,
  totpSecretMatches,
} from "../src/lib/auth/totp";
import { openTotpSecret, sealTotpSecret, TOTP_SECRET_AAD } from "../src/lib/auth/totp-secret";
import {
  activateEnrolment,
  beginEnrolment,
  disableTotp,
  verifyCode,
  type TotpCredentialRow,
  type TotpServiceStore,
} from "../src/lib/auth/totp-service";
import {
  createSessionId,
  describeDevice,
  revokeOtherSessions,
  revokeSessionById,
  sessionIsUsable,
  summariseSession,
  type SessionRecordRow,
  type SessionRecordStore,
} from "../src/lib/auth/session-record";
import { createSessionCookieValue, sessionMatchesUser, verifySessionCookieValue } from "../src/lib/auth/session-token";
import {
  decideStepUp,
  defaultSecurityPolicy,
  isScopeRequired,
  readSecurityPolicyRow,
  selectSecurityPolicyFields,
  validateSecurityPolicyUpdate,
  type SecurityPolicy,
} from "../src/lib/auth/security-policy";

/* ------------------------------------------------------------------------- */
/* Codes: the RFC's own vectors, not our own output.                          */
/* ------------------------------------------------------------------------- */

/** RFC 6238's seed, as ASCII: `12345678901234567890`. */
const RFC_SECRET_BYTES = Buffer.from("12345678901234567890", "ascii");
const RFC_SECRET = base32Encode(RFC_SECRET_BYTES);

test("TOTP matches RFC 6238's published SHA-1 vectors", () => {
  // The RFC prints eight digits; the same generator with `digits: 8` is what has
  // to reproduce them, and the six-digit form is that code's last six digits.
  const vectors: Array<[number, string]> = [
    [59, "94287082"],
    [1_111_111_109, "07081804"],
    [1_111_111_111, "14050471"],
    [1_234_567_890, "89005924"],
    [2_000_000_000, "69279037"],
    [20_000_000_000, "65353130"],
  ];
  for (const [seconds, expected] of vectors) {
    const at = new Date(seconds * 1000);
    assert.equal(hotp(RFC_SECRET, currentTimeStep(at), 8), expected, `HOTP/TOTP at ${seconds}`);
    assert.equal(totpCode(RFC_SECRET, at, { digits: 8 }), expected);
    assert.equal(totpCode(RFC_SECRET, at), expected.slice(-TOTP_DIGITS));
  }
});

test("base32 round-trips, tolerates what people paste, and refuses what is not base32", () => {
  const bytes = Buffer.from("an authenticator secret", "utf8");
  assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  const secret = createTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(totpSecretMatches(secret, secret.toLowerCase().replace(/(.{4})/g, "$1 ").trim()), true);
  assert.equal(base32Decode("not base32!"), null);
  assert.equal(normalizeTotpCode(" 12 34-56 "), "123456");
  assert.equal(normalizeTotpCode("12345"), null, "five digits is not a code");
  assert.equal(normalizeTotpCode(123456), null, "a number is not a typed code");
});

test("one submitted field is sorted into the kind of code it is", () => {
  assert.deepEqual(classifySubmittedCode("123456"), { kind: "totp", normalized: "123456" });
  assert.deepEqual(classifySubmittedCode("abcde-fghjk"), { kind: "backup", normalized: "ABCDEFGHJK" });
  assert.deepEqual(classifySubmittedCode("hello"), { kind: "unknown", normalized: null });
  assert.deepEqual(classifySubmittedCode(undefined), { kind: "unknown", normalized: null });
});

/* ------------------------------------------------------------------------- */
/* Backup codes: single-use, hashed, and issued once.                         */
/* ------------------------------------------------------------------------- */

test("backup codes are unique, readable, and stored only as digests", () => {
  const codes = createBackupCodes();
  assert.equal(codes.length, BACKUP_CODE_COUNT);
  assert.equal(new Set(codes).size, BACKUP_CODE_COUNT, "no duplicates");
  for (const code of codes) {
    assert.match(code, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/, "no I, O, 0 or 1 to misread");
    assert.equal(normalizeBackupCode(code), code.replace("-", ""));
    // The digest is over the normalised form, so the code works however it is
    // typed, and the stored value is not the code.
    assert.match(hashBackupCode(normalizeBackupCode(code)!), /^[a-f0-9]{64}$/);
    assert.notEqual(hashBackupCode(normalizeBackupCode(code)!), code);
  }
  assert.equal(hashBackupCode(normalizeBackupCode(codes[0])!), hashBackupCode(normalizeBackupCode(codes[0])!), "lookup by digest");
});

/* ------------------------------------------------------------------------- */
/* Lockout: counted, bounded, and it lifts by itself.                          */
/* ------------------------------------------------------------------------- */

const POLICY = { maxFailedAttempts: 3, lockoutMinutes: 10 };
const STEP_AT = new Date("2026-10-16T12:00:00.000Z");
const STEP_SECRET = createTotpSecret();

function attempt(overrides: Partial<Parameters<typeof evaluateTotpAttempt>[0]> = {}) {
  return evaluateTotpAttempt({
    secret: STEP_SECRET,
    code: totpCode(STEP_SECRET, STEP_AT),
    at: STEP_AT,
    lastUsedStep: null,
    failedAttempts: 0,
    lockedUntil: null,
    policy: POLICY,
    ...overrides,
  });
}

test("a wrong code is counted, and the count is what reaches the configured maximum", () => {
  const first = attempt({ code: "000000" });
  assert.equal(first.outcome, "rejected");
  assert.equal(first.outcome === "rejected" && first.reason, "mismatch");
  assert.equal(first.outcome === "rejected" && first.failedAttempts, 1);
  assert.equal(first.outcome === "rejected" && first.lockedNow, false);
  assert.match(first.outcome === "rejected" ? first.message : "", /attempt 1 of 3/);

  const second = attempt({ code: "000000", failedAttempts: 1 });
  assert.equal(second.outcome === "rejected" && second.lockedNow, false);

  const third = attempt({ code: "000000", failedAttempts: 2 });
  assert.equal(third.outcome === "rejected" && third.lockedNow, true);
  assert.match(third.outcome === "rejected" ? third.message : "", /attempt 3 of 3/);
  assert.ok(third.outcome === "rejected" && third.lockedUntil);
  assert.equal(
    third.outcome === "rejected" && third.lockedUntil?.toISOString(),
    new Date(STEP_AT.getTime() + POLICY.lockoutMinutes * 60_000).toISOString(),
    "the lock is a moment, not a flag: nothing has to sweep it",
  );
});

test("a locked account refuses without checking the code, and the lock ends by itself", () => {
  const lockedUntil = new Date(STEP_AT.getTime() + 5 * 60_000);
  const duringLock = attempt({ lockedUntil, failedAttempts: 3 });
  assert.equal(duringLock.outcome === "rejected" && duringLock.reason, "locked");
  assert.equal(duringLock.outcome === "rejected" && duringLock.failedAttempts, 3, "a locked attempt is not counted again");
  assert.match(duringLock.outcome === "rejected" ? duringLock.message : "", /locked for another 5 minutes/);

  // The same row, asked again after the moment has passed: the lock is over, and
  // the code for *that* moment is what is accepted.
  const after = new Date(lockedUntil.getTime() + 1_000);
  const afterLock = attempt({ lockedUntil, failedAttempts: 3, at: after, code: totpCode(STEP_SECRET, after) });
  assert.equal(afterLock.outcome, "verified");
});

test("an accepted code resets the count, and the same time step cannot be used twice", () => {
  const accepted = attempt({ failedAttempts: 2 });
  assert.equal(accepted.outcome, "verified");
  assert.equal(accepted.outcome === "verified" && accepted.failedAttempts, 0);
  assert.equal(accepted.outcome === "verified" && accepted.lockedUntil, null);

  const replayed = attempt({ lastUsedStep: accepted.outcome === "verified" ? accepted.step : null });
  assert.equal(replayed.outcome === "rejected" && replayed.reason, "replayed");
  assert.match(replayed.outcome === "rejected" ? replayed.message : "", /already been used/);

  // One step either side is accepted — the tolerance every authenticator app
  // assumes — and the step it matched is what is reported back.
  const previous = attempt({ at: new Date(STEP_AT.getTime() - TOTP_PERIOD_SECONDS * 1000) });
  assert.equal(previous.outcome, "verified");
});

test("a malformed code is its own reason, so the sentence says what to do", () => {
  const malformed = attempt({ code: "abc" });
  assert.equal(malformed.outcome === "rejected" && malformed.reason, "malformed");
  assert.match(malformed.outcome === "rejected" ? malformed.message : "", /six-digit code/);
});

/* ------------------------------------------------------------------------- */
/* Enrolment and activation, against an in-memory store.                      */
/* ------------------------------------------------------------------------- */

const ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  TRADING_CREDENTIAL_ENCRYPTION_KEY: createHash("sha256").update("test fixture key").digest("hex"),
};

function memoryTotpStore(rows?: { credential?: TotpCredentialRow | null }) {
  const state: {
    credential: TotpCredentialRow | null;
    backupCodes: Array<{ id: string; credentialId: string; codeHash: string; usedAt: Date | null }>;
    audit: Array<{ action: string; outcome: string; detail: Record<string, unknown>; objectId: string }>;
  } = {
    credential: rows?.credential ?? null,
    backupCodes: [],
    audit: [],
  };
  let counter = 0;
  const store: TotpServiceStore = {
    findCredential: async () => state.credential,
    createCredential: async (data) => {
      counter += 1;
      // A fresh row per enrolment: the secret columns come from the caller, and
      // everything that tracks use starts empty.
      state.credential = {
        ...data,
        id: `cred_${counter}`,
        userId: "user_1",
        activatedAt: null,
        lastUsedAt: null,
        lastUsedStep: null,
        failedAttempts: 0,
        lockedUntil: null,
        revokedAt: null,
      };
      return state.credential;
    },
    updateCredential: async (_userId, data) => {
      state.credential = { ...(state.credential as TotpCredentialRow), ...data };
      return state.credential;
    },
    deleteCredential: async () => {
      state.credential = null;
      state.backupCodes = [];
    },
    replaceBackupCodes: async (credentialId, codeHashes) => {
      state.backupCodes = codeHashes.map((codeHash, index) => ({ id: `code_${index}`, credentialId, codeHash, usedAt: null }));
    },
    findBackupCode: async (credentialId, codeHash) =>
      state.backupCodes.find((row) => row.credentialId === credentialId && row.codeHash === codeHash) ?? null,
    markBackupCodeUsed: async (backupCodeId, at) => {
      const row = state.backupCodes.find((entry) => entry.id === backupCodeId);
      if (!row || row.usedAt) return false;
      row.usedAt = at;
      return true;
    },
    countUnusedBackupCodes: async (credentialId) => state.backupCodes.filter((row) => row.credentialId === credentialId && !row.usedAt).length,
    recordAudit: async (entry) => {
      state.audit.push({ action: entry.action, outcome: entry.outcome, detail: entry.detail, objectId: entry.objectId });
    },
  };
  return { store, state };
}

test("enrolment issues a secret once, and activation is what makes it count", async () => {
  const { store, state } = memoryTotpStore();
  const offer = await beginEnrolment({
    store,
    userId: "user_1",
    account: "0x5a40…Bf8c",
    issuer: "Veylora",
    label: "Veylora · 0x5a40…Bf8c",
    now: STEP_AT,
    env: ENV,
  });
  assert.equal(offer.ok, true);
  if (!offer.ok) return;

  assert.match(offer.offer.secret, /^[A-Z2-7]{32}$/);
  assert.match(offer.offer.otpauthUri, /^otpauth:\/\/totp\/Veylora%3A/);
  assert.match(offer.offer.otpauthUri, /issuer=Veylora/);
  assert.match(offer.offer.otpauthUri, /digits=6/);
  assert.match(offer.offer.otpauthUri, /period=30/);
  // The stored column is not the secret, and the secret is not in the audit trail.
  assert.notEqual(state.credential?.secretCiphertext, offer.offer.secret);
  assert.ok(!JSON.stringify(state.audit).includes(offer.offer.secret), "no secret in the audit trail");
  // Checked as a boolean rather than against null: `assert.equal` asserts the
  // type of what it is given, and a narrowed column cannot be read back as a
  // date later in the same scope.
  assert.equal(Boolean(state.credential?.activatedAt), false);
  assert.deepEqual(sealOpen(state.credential!), offer.offer.secret, "sealed at rest, openable by the code check");

  // Not activated yet, so nothing is demanded of the account.
  const beforeActivation = await verifyCode({
    store, userId: "user_1", code: totpCode(offer.offer.secret, STEP_AT), now: STEP_AT, policy: POLICY, purpose: "step-up", env: ENV,
  });
  assert.equal(beforeActivation.ok, false);
  assert.equal(beforeActivation.ok === false && beforeActivation.code, "TOTP_NOT_ACTIVATED");

  const wrong = await activateEnrolment({ store, userId: "user_1", code: "000000", now: STEP_AT, policy: POLICY, env: ENV });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.ok === false && wrong.failedAttempts, 1, "a failed activation is counted");

  const activated = await activateEnrolment({
    store, userId: "user_1", code: totpCode(offer.offer.secret, STEP_AT), now: STEP_AT, policy: POLICY, env: ENV,
  });
  assert.equal(activated.ok, true);
  if (!activated.ok) return;
  assert.equal(activated.backupCodes.length, BACKUP_CODE_COUNT);
  assert.equal(state.credential?.activatedAt?.toISOString(), STEP_AT.toISOString());
  assert.equal(state.credential?.failedAttempts, 0, "activating cleared the failed attempt");
  assert.ok(!JSON.stringify(state.audit).includes(activated.backupCodes[0]), "no backup code in the audit trail");
  assert.ok(state.audit.some((entry) => entry.action === "AUTH_TOTP_ACTIVATED"));

  // Activating twice issues nothing: the codes exist in readable form once.
  const again = await activateEnrolment({
    store, userId: "user_1", code: totpCode(offer.offer.secret, STEP_AT), now: STEP_AT, policy: POLICY, env: ENV,
  });
  assert.equal(again.ok, false);

  // Enrolling over an active credential is refused without the explicit ask.
  const overwrite = await beginEnrolment({
    store, userId: "user_1", account: "a", issuer: "Veylora", label: "l", now: STEP_AT, env: ENV,
  });
  assert.equal(overwrite.ok, false);
  assert.equal(overwrite.ok === false && overwrite.reason, "ALREADY_ACTIVE");
  const replaced = await beginEnrolment({
    store, userId: "user_1", account: "a", issuer: "Veylora", label: "l", now: STEP_AT, allowActiveReplacement: true, env: ENV,
  });
  assert.equal(replaced.ok, true, "a fresh sign-in is what authorises replacing an unreachable authenticator");
  const replacementAudit = state.audit.filter((entry) => entry.action === "AUTH_TOTP_ENROLMENT_STARTED").pop();
  assert.equal(replacementAudit?.detail.replacedActive, true);
});

test("a backup code works once, works while locked, and clears the lock", async () => {
  const { store, state } = memoryTotpStore();
  const offer = await beginEnrolment({
    store, userId: "user_1", account: "a", issuer: "Veylora", label: "l", now: STEP_AT, env: ENV,
  });
  assert.equal(offer.ok, true);
  if (!offer.ok) return;
  const activated = await activateEnrolment({
    store, userId: "user_1", code: totpCode(offer.offer.secret, STEP_AT), now: STEP_AT, policy: POLICY, env: ENV,
  });
  assert.equal(activated.ok, true);
  if (!activated.ok) return;
  const backupCode = activated.backupCodes[3];

  // The account is locked by its own wrong typing: three wrong codes reach the
  // configured maximum, and the fourth attempt is refused without being checked.
  // The attempt that *causes* the lock is still a wrong code — its reason is the
  // mismatch, and its message is the one that says the account is now locked.
  for (let index = 1; index <= POLICY.maxFailedAttempts; index += 1) {
    const wrong = await verifyCode({
      store, userId: "user_1", code: "000000", now: STEP_AT, policy: POLICY, purpose: "step-up", env: ENV,
    });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.ok === false && wrong.failedAttempts, index);
    assert.equal(wrong.ok === false && wrong.code, "TOTP_REJECTED");
    if (index === POLICY.maxFailedAttempts) {
      assert.equal(wrong.ok === false && wrong.status, 401);
      assert.ok(wrong.ok === false && wrong.lockedUntil, "the attempt that reaches the maximum sets the lock");
      assert.match(wrong.ok === false ? wrong.error : "", /now locked for 10 minutes/);
    }
  }
  const nowLocked = await verifyCode({
    store, userId: "user_1", code: "000000", now: STEP_AT, policy: POLICY, purpose: "step-up", env: ENV,
  });
  assert.equal(nowLocked.ok === false && nowLocked.code, "TOTP_LOCKED");
  assert.equal(nowLocked.ok === false && nowLocked.failedAttempts, POLICY.maxFailedAttempts, "a locked attempt is not counted again");

  // The recovery path the owner controls: a backup code, while locked.
  const recovered = await verifyCode({
    store, userId: "user_1", backupCode, now: STEP_AT, policy: POLICY, purpose: "step-up", env: ENV,
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.ok === true && recovered.method, "BACKUP_CODE");
  assert.equal(recovered.ok === true && recovered.backupCodesRemaining, BACKUP_CODE_COUNT - 1);
  assert.equal(Boolean(state.credential?.lockedUntil), false, "recovering clears the lock behind it");
  assert.ok(state.audit.some((entry) => entry.action === "AUTH_TOTP_BACKUP_CODE_USED"));

  // Once. The second presentation is refused, and the count is unmoved.
  const reused = await verifyCode({
    store, userId: "user_1", backupCode, now: STEP_AT, policy: POLICY, purpose: "step-up", env: ENV,
  });
  assert.equal(reused.ok, false);
  assert.equal(reused.ok === false && reused.code, "BACKUP_CODE_USED");

  const unknown = await verifyCode({
    store, userId: "user_1", backupCode: "ZZZZZ-ZZZZZ", now: STEP_AT, policy: POLICY, purpose: "step-up", env: ENV,
  });
  assert.equal(unknown.ok === false && unknown.code, "BACKUP_CODE_INVALID");
});

test("every failed code and every accepted one is audited, and never with the code", async () => {
  const { store, state } = memoryTotpStore();
  const offer = await beginEnrolment({ store, userId: "user_1", account: "a", issuer: "Veylora", label: "l", now: STEP_AT, env: ENV });
  assert.equal(offer.ok, true);
  if (!offer.ok) return;
  await activateEnrolment({ store, userId: "user_1", code: totpCode(offer.offer.secret, STEP_AT), now: STEP_AT, policy: POLICY, env: ENV });

  const code = totpCode(offer.offer.secret, new Date(STEP_AT.getTime() + TOTP_PERIOD_SECONDS * 1000));
  const verified = await verifyCode({
    store, userId: "user_1", code, now: new Date(STEP_AT.getTime() + TOTP_PERIOD_SECONDS * 1000), policy: POLICY, purpose: "step-up", env: ENV,
  });
  assert.equal(verified.ok, true);
  const failed = await verifyCode({
    store, userId: "user_1", code: "111111", now: STEP_AT, policy: POLICY, purpose: "step-up", env: ENV,
  });
  assert.equal(failed.ok, false);

  assert.ok(state.audit.some((entry) => entry.action === "AUTH_TOTP_VERIFIED" && entry.outcome === "SUCCESS"));
  const failure = state.audit.find((entry) => entry.action === "AUTH_TOTP_FAILED");
  assert.ok(failure, "a failed code is on the trail");
  assert.equal(failure?.detail.reason, "mismatch");
  assert.equal(failure?.detail.failedAttempts, 1);
  assert.ok(!JSON.stringify(state.audit).includes(String(code)), "no code in the audit trail");
});

test("disabling revokes the credential and takes the backup codes with it", async () => {
  const { store, state } = memoryTotpStore();
  const offer = await beginEnrolment({ store, userId: "user_1", account: "a", issuer: "Veylora", label: "l", now: STEP_AT, env: ENV });
  assert.equal(offer.ok, true);
  if (!offer.ok) return;
  await activateEnrolment({ store, userId: "user_1", code: totpCode(offer.offer.secret, STEP_AT), now: STEP_AT, policy: POLICY, env: ENV });

  const disabled = await disableTotp({ store, userId: "user_1", now: STEP_AT, reason: "Replaced the phone." });
  assert.equal(disabled.ok, true);
  assert.equal(state.credential?.revokedAt?.toISOString(), STEP_AT.toISOString());
  assert.equal(state.backupCodes.length, 0);

  const afterwards = await verifyCode({
    store, userId: "user_1", code: totpCode(offer.offer.secret, STEP_AT), now: STEP_AT, policy: POLICY, purpose: "step-up", env: ENV,
  });
  assert.equal(afterwards.ok, false);
  assert.equal(afterwards.ok === false && afterwards.code, "TOTP_NOT_ENROLLED");
});

/** Open a sealed credential with the production function — no reimplementation. */
function sealOpen(credential: TotpCredentialRow): string {
  return openTotpSecret(
    { ciphertext: credential.secretCiphertext, iv: credential.secretIv, authTag: credential.secretAuthTag },
    ENV,
  );
}

/* ------------------------------------------------------------------------- */
/* The sealed secret itself.                                                   */
/* ------------------------------------------------------------------------- */

test("the secret is sealed with its own associated data and never stored in the clear", () => {
  const secret = createTotpSecret();
  const sealed = sealTotpSecret(secret, ENV);
  assert.notEqual(sealed.ciphertext, secret);
  assert.ok(!Buffer.from(sealed.ciphertext, "base64url").toString("utf8").includes(secret));
  assert.equal(openTotpSecret(sealed, ENV), secret);
  assert.equal(TOTP_SECRET_AAD, "veylora:totp-secret:v1");

  // Another deployment key cannot open it, and a tampered tag or a malformed iv
  // is refused rather than guessed at.
  const otherKey: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    TRADING_CREDENTIAL_ENCRYPTION_KEY: createHash("sha256").update("another key").digest("hex"),
  };
  assert.throws(() => openTotpSecret(sealed, otherKey));
  assert.throws(() => openTotpSecret({ ...sealed, authTag: Buffer.alloc(16).toString("base64url") }, ENV));
  assert.throws(() => openTotpSecret({ ...sealed, iv: Buffer.alloc(4).toString("base64url") }, ENV));
  assert.throws(() => openTotpSecret({ ...sealed, ciphertext: "" }, ENV));

  // A fresh IV every time means the same secret never produces the same bytes.
  assert.notEqual(sealTotpSecret(secret, ENV).ciphertext, sealed.ciphertext);
  assert.notEqual(sealTotpSecret(secret, ENV).iv, sealed.iv);
});

/* ------------------------------------------------------------------------- */
/* Sessions: one row per device, revoked on the next request.                  */
/* ------------------------------------------------------------------------- */

const SECRET = "test-only-session-secret-that-is-long-enough-to-sign";

function memorySessionStore(rows: SessionRecordRow[]) {
  const state = { rows: rows.map((row) => ({ ...row })), audit: [] as Array<{ action: string; detail?: Record<string, unknown> }> };
  const store: SessionRecordStore = {
    findSession: async (sessionId) => state.rows.find((row) => row.id === sessionId) ?? null,
    listSessions: async (userId) => state.rows.filter((row) => row.userId === userId),
    revokeSession: async ({ sessionId, at, reason }) => {
      const row = state.rows.find((entry) => entry.id === sessionId);
      if (!row || row.revokedAt) return false;
      row.revokedAt = at;
      row.revokedReason = reason;
      return true;
    },
    revokeSessionsExcept: async ({ userId, keepSessionId, at, reason }) => {
      const targets = state.rows.filter((row) => row.userId === userId && !row.revokedAt && row.id !== keepSessionId);
      for (const row of targets) {
        row.revokedAt = at;
        row.revokedReason = reason;
      }
      return targets.map((row) => row.id);
    },
    recordAudit: async (entry) => {
      state.audit.push({ action: entry.action, detail: entry.detail });
    },
  };
  return { store, state };
}

function sessionRow(overrides: Partial<SessionRecordRow> = {}): SessionRecordRow {
  return {
    id: createSessionId(),
    userId: "user_1",
    deviceLabel: "Chrome on Linux",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0.0.0 Safari/537.36",
    ipAddress: "203.0.113.7",
    createdAt: STEP_AT,
    lastSeenAt: STEP_AT,
    expiresAt: new Date(STEP_AT.getTime() + 8 * 60 * 60 * 1000),
    totpVerifiedAt: null,
    totpLastStep: null,
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  };
}

test("devices are labelled from the header, and an unknown one is named as unknown", () => {
  assert.equal(
    describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) MetaMaskMobile/7.24.0 Mobile/15E148 Safari/604.1").label,
    "MetaMask Mobile · iOS",
  );
  assert.equal(describeDevice("Mozilla/5.0 (Linux; Android 14) Chrome/141.0.0.0 Mobile Safari/537.36").label, "Chrome on Android");
  assert.equal(describeDevice("Mozilla/5.0 (Windows NT 10.0) Firefox/131.0").label, "Firefox on Windows");
  assert.equal(describeDevice("curl/8.4.0").label, "curl on an unknown system");
  assert.equal(describeDevice(null).label, "Unrecognised client");
});

test("revoking one session ends that device on its next request, and only that one", async () => {
  const laptop = sessionRow();
  const phone = sessionRow({ id: createSessionId(), deviceLabel: "Safari on iOS" });
  const { store, state } = memorySessionStore([laptop, phone]);
  const now = new Date(STEP_AT.getTime() + 60_000);

  // Both cookies name a live row: both devices resolve.
  assert.equal(sessionIsUsable(await store.findSession(laptop.id), { userId: "user_1", now }), "active");
  assert.equal(sessionIsUsable(await store.findSession(phone.id), { userId: "user_1", now }), "active");

  const outcome = await revokeSessionById({ store, userId: "user_1", sessionId: phone.id, at: now, reason: "Not mine." });
  assert.deepEqual(outcome, { revoked: true, sessionId: phone.id, deviceLabel: "Safari on iOS" });

  // The phone's next request: the row it names is revoked, so it does not resolve.
  assert.equal(sessionIsUsable(await store.findSession(phone.id), { userId: "user_1", now }), "revoked");
  // The laptop is untouched — the whole reason for a per-device row.
  assert.equal(sessionIsUsable(await store.findSession(laptop.id), { userId: "user_1", now }), "active");
  assert.equal(state.audit.filter((entry) => entry.action === "AUTH_SESSION_REVOKED").length, 1);

  // Revoking it again is a no-op rather than a second audit entry.
  const again = await revokeSessionById({ store, userId: "user_1", sessionId: phone.id, at: now, reason: "Not mine." });
  assert.deepEqual(again, { revoked: false, reason: "ALREADY_REVOKED" });

  // Someone else's session id is refused, and nothing is written.
  const foreign = sessionRow({ id: createSessionId(), userId: "user_2" });
  const foreignStore = memorySessionStore([foreign]);
  const refused = await revokeSessionById({
    store: foreignStore.store, userId: "user_1", sessionId: foreign.id, at: now, reason: "guess",
  });
  assert.deepEqual(refused, { revoked: false, reason: "NOT_YOURS" });
  assert.equal(foreignStore.state.rows[0].revokedAt, null);

  // An expired row is as good as revoked, without anyone having acted.
  const stale = sessionRow({ expiresAt: new Date(STEP_AT.getTime() - 1_000) });
  assert.equal(sessionIsUsable(stale, { userId: "user_1", now }), "expired");
});

test("a cookie that names no session row is not a session at all", () => {
  const claims = {
    userId: "user_1",
    walletIdentityId: "wallet_1",
    sessionId: createSessionId(),
    chainNamespace: "eip155" as const,
    chainReference: "1",
    sessionVersion: 0,
    issuedAt: Math.floor(STEP_AT.getTime() / 1000),
    expiresAt: Math.floor(STEP_AT.getTime() / 1000) + 3600,
  };
  const cookie = createSessionCookieValue(claims, SECRET);
  assert.deepEqual(verifySessionCookieValue(cookie, SECRET, claims.issuedAt), claims);

  // A cookie issued before this phase carries no session id — JSON drops the
  // undefined key, which is exactly the legacy cookie. It resolves to no row, so
  // it is refused rather than treated as a session with no device.
  const legacyCookie = createSessionCookieValue({ ...claims, sessionId: undefined } as unknown as typeof claims, SECRET);
  assert.equal(verifySessionCookieValue(legacyCookie, SECRET, claims.issuedAt), null);
  assert.equal(verifySessionCookieValue(createSessionCookieValue({ ...claims, sessionId: "not-an-id" }, SECRET), SECRET, claims.issuedAt), null);
});

test("signing out everywhere else ends the other rows and leaves this one working", async () => {
  const laptop = sessionRow();
  const phone = sessionRow({ id: createSessionId(), deviceLabel: "Safari on iOS" });
  const tablet = sessionRow({ id: createSessionId(), deviceLabel: "Firefox on Android" });
  const { store, state } = memorySessionStore([laptop, phone, tablet]);
  const now = new Date(STEP_AT.getTime() + 60_000);

  const outcome = await revokeOtherSessions({
    store, userId: "user_1", keepSessionId: laptop.id, at: now, reason: "Every other session ended from the panel.",
  });
  assert.equal(outcome.revokedSessionIds.length, 2);
  assert.equal(sessionIsUsable(await store.findSession(laptop.id), { userId: "user_1", now }), "active");
  assert.equal(sessionIsUsable(await store.findSession(phone.id), { userId: "user_1", now }), "revoked");
  assert.equal(sessionIsUsable(await store.findSession(tablet.id), { userId: "user_1", now }), "revoked");
  assert.equal(state.audit.at(-1)?.action, "AUTH_SESSIONS_REVOKED_OTHERS");
  assert.equal(state.audit.at(-1)?.detail?.revokedCount, 2);

  // Without a live current session there is no "other": nothing is ended, because
  // ending everything is a different action than the one that was asked for.
  const empty = await revokeOtherSessions({
    store, userId: "user_1", keepSessionId: createSessionId(), at: now, reason: "x",
  });
  assert.deepEqual(empty.revokedSessionIds, []);
});

test("the session list and the request path answer the same way", () => {
  const row = sessionRow({ lastSeenAt: new Date(STEP_AT.getTime() + 30_000) });
  const now = new Date(STEP_AT.getTime() + 60_000);
  const summary = summariseSession(row, { currentSessionId: row.id, now });
  assert.equal(summary.status, "ACTIVE");
  assert.equal(summary.isCurrent, true);
  assert.equal(summary.ipAddress, "203.0.113.7");
  assert.equal(summary.createdAt, STEP_AT.toISOString());

  // Revoked: the list says REVOKED, and the rule the request path uses says the
  // row is not usable — one fact, two readers, no drift.
  const revoked = { ...row, revokedAt: now, revokedReason: "SIGN_OUT" };
  assert.equal(summariseSession(revoked, { currentSessionId: row.id, now }).status, "REVOKED");
  assert.equal(sessionIsUsable(revoked, { userId: "user_1", now }), "revoked");

  // The account-wide rule is unchanged by any of this: an old session version
  // still fails, which is what sign-out relies on.
  assert.equal(sessionMatchesUser(
    { ...customClaims(), sessionVersion: 0 },
    { status: "ACTIVE", sessionVersion: 1 },
  ), false);
});

function customClaims() {
  return {
    userId: "user_1",
    walletIdentityId: "wallet_1",
    sessionId: createSessionId(),
    chainNamespace: "eip155" as const,
    chainReference: "1",
    sessionVersion: 0,
    issuedAt: Math.floor(STEP_AT.getTime() / 1000),
    expiresAt: Math.floor(STEP_AT.getTime() / 1000) + 3600,
  };
}

/* ------------------------------------------------------------------------- */
/* The policy: scopes as data, and the step-up decision it drives.             */
/* ------------------------------------------------------------------------- */

test("the policy is data: validated for shape, and every scope defaults off", () => {
  const defaults = defaultSecurityPolicy();
  assert.deepEqual(defaults, {
    requireTotpForSignIn: false,
    requireTotpForTrading: false,
    requireTotpForFunding: false,
    stepUpMinutes: 15,
    maxFailedAttempts: 5,
    lockoutMinutes: 15,
  });
  assert.equal(validateSecurityPolicyUpdate(defaults).valid, true);

  // Out of range, wrong type, and unknown fields are all refused, and each
  // refusal names the number it is about.
  for (const bad of [
    { ...defaults, stepUpMinutes: 0 },
    { ...defaults, stepUpMinutes: 121 },
    { ...defaults, stepUpMinutes: 1.5 },
    { ...defaults, maxFailedAttempts: 0 },
    { ...defaults, lockoutMinutes: 1_441 },
    { ...defaults, stepUpMinutes: "15" },
    { ...defaults, requireTotpForTrading: "on" },
    { ...defaults, requireTotpForSignIn: true, extra: 1 },
    null,
    [],
  ]) {
    assert.equal(validateSecurityPolicyUpdate(bad).valid, false, `${JSON.stringify(bad)} must be refused`);
  }
  const refusal = validateSecurityPolicyUpdate({ ...defaults, stepUpMinutes: 0 });
  assert.match(refusal.valid === false ? refusal.error : "", /step-up window/);

  // Scope mapping: the switch that guards each action is the one the action reads.
  const policed: SecurityPolicy = { ...defaults, requireTotpForFunding: true };
  assert.equal(isScopeRequired(policed, "funding"), true);
  assert.equal(isScopeRequired(policed, "trading"), false);
  assert.equal(isScopeRequired(policed, "sign-in"), false);
  assert.equal(isScopeRequired(defaults, "trading"), false);
});

test("a stored policy row reads back as a policy, storage columns and all", () => {
  // The row a database actually returns, which is what the readers are handed:
  // the six policy fields *plus* `id`, `updatedByUserId` and `updatedAt`. A
  // reader that validated the row as-is would refuse every row that exists, and
  // every scope would silently read as off.
  const storedRow = {
    id: "global",
    requireTotpForSignIn: false,
    requireTotpForTrading: true,
    requireTotpForFunding: false,
    stepUpMinutes: 30,
    maxFailedAttempts: 3,
    lockoutMinutes: 60,
    updatedByUserId: "dev-owner-user",
    updatedAt: new Date("2026-10-16T11:34:05.643Z"),
  };

  // The row is not a valid *submission* — the storage columns are unsupported
  // fields there, and that strictness stays exactly as it was.
  assert.equal(validateSecurityPolicyUpdate(storedRow).valid, false);

  // Projected to its six fields, the same row is the policy it was written as.
  assert.deepEqual(selectSecurityPolicyFields(storedRow), {
    requireTotpForSignIn: false,
    requireTotpForTrading: true,
    requireTotpForFunding: false,
    stepUpMinutes: 30,
    maxFailedAttempts: 3,
    lockoutMinutes: 60,
  });
  const read = readSecurityPolicyRow(storedRow);
  assert.deepEqual(read, selectSecurityPolicyFields(storedRow));
  // ...and the switch that was on is still on, which is the whole point.
  assert.equal(isScopeRequired(read, "trading"), true);

  // No row at all is the seeded meaning: nothing is demanded.
  assert.deepEqual(readSecurityPolicyRow(null), defaultSecurityPolicy());

  // A row whose *policy* value is unusable still throws rather than being
  // rounded into a requirement nobody set.
  assert.throws(() => readSecurityPolicyRow({ ...storedRow, stepUpMinutes: 0 }));
  assert.throws(() => readSecurityPolicyRow({ ...storedRow, requireTotpForTrading: "on" as unknown as boolean }));
});

test("a scope is only enforced when there is an authenticator behind it", () => {
  const policy: SecurityPolicy = { ...defaultSecurityPolicy(), requireTotpForTrading: true, stepUpMinutes: 15 };
  const now = STEP_AT;

  // Off: nothing is asked, whatever else is true.
  assert.deepEqual(
    decideStepUp({ policy: defaultSecurityPolicy(), scope: "trading", enrolled: true, totpVerifiedAt: null, now }),
    { required: false, reason: "SCOPE_OFF" },
  );

  // On with no activated authenticator: reported as not enforced, in those words.
  // This is the case that must never become a locked door the owner cannot open.
  assert.deepEqual(
    decideStepUp({ policy, scope: "trading", enrolled: false, totpVerifiedAt: null, now }),
    { required: false, reason: "NOT_ENROLLED" },
  );

  // On, enrolled, and this device proved a code inside the window: nothing to ask.
  assert.deepEqual(
    decideStepUp({ policy, scope: "trading", enrolled: true, totpVerifiedAt: new Date(now.getTime() - 10 * 60_000), now }),
    { required: false, reason: "FRESH_VERIFICATION" },
  );

  // The window elapses, and the action asks again — per device, because the
  // verification lives on the session row rather than on the account.
  const stale = decideStepUp({
    policy, scope: "trading", enrolled: true, totpVerifiedAt: new Date(now.getTime() - 16 * 60_000), now,
  });
  assert.equal(stale.required, true);
  assert.equal(stale.required === true && stale.scope, "trading");
  assert.match(stale.required === true ? stale.message : "", /Trading needs a code/);

  // Never verified in this session at all is the same answer.
  assert.equal(
    decideStepUp({ policy, scope: "trading", enrolled: true, totpVerifiedAt: null, now }).required,
    true,
  );

  // Exactly at the boundary the code is asked for again: the window is a window.
  assert.equal(
    decideStepUp({ policy, scope: "trading", enrolled: true, totpVerifiedAt: new Date(now.getTime() - 15 * 60_000), now }).required,
    true,
  );

  // Changing the policy changes the answer immediately — same inputs, no restart.
  assert.equal(
    decideStepUp({
      policy: { ...policy, stepUpMinutes: 60 }, scope: "trading", enrolled: true,
      totpVerifiedAt: new Date(now.getTime() - 16 * 60_000), now,
    }).required,
    false,
  );
});
