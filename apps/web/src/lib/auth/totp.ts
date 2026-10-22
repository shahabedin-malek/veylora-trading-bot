import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Two-factor codes, as cryptography rather than as a flow.
 *
 * Everything here is pure: given a secret, a code and a clock, it says whether
 * the code is this account's code, and — separately — what should happen to the
 * attempt. Nothing reads the database, so the whole module is exercised by tests
 * directly, including against the RFC's own vectors.
 *
 * The three pieces:
 *   * TOTP (RFC 6238) — HMAC-SHA1 over the time step, truncated to six digits.
 *     The window is one step either side, which is the tolerance every
 *     authenticator app assumes, and the accepted step is returned so the caller
 *     can refuse to accept the same step twice (a code is otherwise valid for its
 *     whole period, including to a second request).
 *   * `evaluateTotpAttempt` — one decision function that owns the lockout too:
 *     wrong codes are counted, the count is what reaches the configured maximum,
 *     and the lock is a timestamp rather than a flag so it ends by itself. The
 *     maximum and the duration are policy the owner edits, not constants here.
 *   * Backup codes — issued once as readable strings, stored by digest, and
 *     single-use because the row has a `usedAt`. A locked account can still use
 *     one: that is the recovery path the owner controls.
 */

export const TOTP_ALGORITHM = "SHA1";
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DEFAULT_WINDOW_STEPS = 1;
export const TOTP_SECRET_BYTES = 20;
export const BACKUP_CODE_COUNT = 10;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, unpadded — the form every authenticator app accepts. */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** Lenient on input, exact on output: case, spaces and hyphens are ignored. */
export function base32Decode(value: string): Buffer | null {
  const normalized = value.trim().toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  if (!normalized || /[^A-Z2-7]/.test(normalized)) return null;
  const bytes: number[] = [];
  let bits = 0;
  let accumulator = 0;
  for (const character of normalized) {
    accumulator = (accumulator << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A new authenticator secret: 160 bits, base32, as RFC 4226 recommends. */
export function createTotpSecret(bytes: number = TOTP_SECRET_BYTES): string {
  return base32Encode(randomBytes(bytes));
}

/** The time step a moment belongs to. */
export function currentTimeStep(at: Date, periodSeconds: number = TOTP_PERIOD_SECONDS): number {
  return Math.floor(at.getTime() / 1000 / periodSeconds);
}

/** HOTP (RFC 4226): HMAC over the counter, then dynamic truncation. */
export function hotp(secret: string, counter: number, digits: number = TOTP_DIGITS): string | null {
  const key = base32Decode(secret);
  if (!key || key.length === 0 || !Number.isSafeInteger(counter) || counter < 0) return null;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The code for a moment. */
export function totpCode(
  secret: string,
  at: Date,
  options: { digits?: number; periodSeconds?: number } = {},
): string | null {
  return hotp(secret, currentTimeStep(at, options.periodSeconds ?? TOTP_PERIOD_SECONDS), options.digits ?? TOTP_DIGITS);
}

/** Digits only, and nothing else: what the user meant, whatever they typed around it. */
export function normalizeTotpCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/[\s-]/g, "");
  return /^\d{6,8}$/.test(digits) ? digits : null;
}

export function totpSecretMatches(left: string, right: string): boolean {
  const a = base32Decode(left);
  const b = base32Decode(right);
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * Shown once, beside the secret in its readable form: this is the only moment
 * either exists outside the sealed column.
 */
export function otpauthUri(input: {
  secret: string;
  account: string;
  issuer: string;
  digits?: number;
  periodSeconds?: number;
  algorithm?: string;
}): string {
  const parameters = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: input.algorithm ?? TOTP_ALGORITHM,
    digits: String(input.digits ?? TOTP_DIGITS),
    period: String(input.periodSeconds ?? TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(`${input.issuer}:${input.account}`)}?${parameters.toString()}`;
}

/** Why a code was not accepted. Each one is a different thing to do about it. */
export type TotpRejectionReason = "malformed" | "mismatch" | "replayed" | "locked";

/** What the caller counts and stores after an attempt. */
export type TotpAttempt =
  | { outcome: "verified"; step: number; failedAttempts: 0; lockedUntil: null }
  | {
      outcome: "rejected";
      reason: TotpRejectionReason;
      message: string;
      failedAttempts: number;
      lockedUntil: Date | null;
      /** True when this attempt is the one that reached the maximum. */
      lockedNow: boolean;
    };

export type TotpAttemptPolicy = {
  maxFailedAttempts: number;
  lockoutMinutes: number;
  windowSteps?: number;
};

/**
 * One decision about one attempt: locked, wrong, replayed, or accepted.
 *
 * The lockout is checked first and reported as its own reason, because "this
 * account is locked for another four minutes" is not the same event as "that code
 * was wrong" — and it is the one the person needs to read. A rejected attempt is
 * counted, and the count is what reaches the maximum; the lock is stored as the
 * moment it ends, so nothing has to sweep anything to lift it.
 */
export function evaluateTotpAttempt(input: {
  secret: string;
  code: unknown;
  at: Date;
  digits?: number;
  periodSeconds?: number;
  lastUsedStep: number | null;
  failedAttempts: number;
  lockedUntil: Date | null;
  policy: TotpAttemptPolicy;
}): TotpAttempt {
  const { at, policy } = input;
  if (input.lockedUntil && input.lockedUntil.getTime() > at.getTime()) {
    const secondsRemaining = Math.ceil((input.lockedUntil.getTime() - at.getTime()) / 1000);
    return {
      outcome: "rejected",
      reason: "locked",
      message:
        `This account is locked for another ${describeDuration(secondsRemaining)} after too many wrong codes, ` +
        "so no code was checked. A backup code still works, and the lock lifts by itself.",
      failedAttempts: input.failedAttempts,
      lockedUntil: input.lockedUntil,
      lockedNow: false,
    };
  }

  const code = normalizeTotpCode(input.code);
  if (!code) {
    return countFailedAttempt(input, at, "malformed", "That is not a six-digit code. Nothing was checked.");
  }

  const digits = input.digits ?? TOTP_DIGITS;
  const periodSeconds = input.periodSeconds ?? TOTP_PERIOD_SECONDS;
  if (code.length !== digits) {
    return countFailedAttempt(input, at, "malformed", `This authenticator issues ${digits}-digit codes. Nothing was checked.`);
  }

  const step = currentTimeStep(at, periodSeconds);
  const windowSteps = policy.windowSteps ?? TOTP_DEFAULT_WINDOW_STEPS;
  let matchedStep: number | null = null;
  for (let offset = -windowSteps; offset <= windowSteps; offset += 1) {
    const candidateStep = step + offset;
    if (candidateStep < 0) continue;
    const expected = hotp(input.secret, candidateStep, digits);
    if (expected && safeEqualText(expected, code)) {
      matchedStep = candidateStep;
      break;
    }
  }

  if (matchedStep === null) {
    return countFailedAttempt(input, at, "mismatch", "That code is not this account's code for the current time, so nothing was verified.");
  }

  // A code is valid for its whole period, so accepting the same *step* twice
  // would let one reading of the screen be presented twice.
  if (input.lastUsedStep !== null && matchedStep <= input.lastUsedStep) {
    return countFailedAttempt(input, at, "replayed", "That code has already been used. Wait for the next one and try again.");
  }

  return { outcome: "verified", step: matchedStep, failedAttempts: 0, lockedUntil: null };
}

function countFailedAttempt(
  input: { failedAttempts: number; policy: TotpAttemptPolicy },
  at: Date,
  reason: Exclude<TotpRejectionReason, "locked">,
  message: string,
): TotpAttempt {
  const failedAttempts = input.failedAttempts + 1;
  const reachesMaximum = input.policy.maxFailedAttempts > 0 && failedAttempts >= input.policy.maxFailedAttempts;
  const lockedUntil = reachesMaximum ? new Date(at.getTime() + input.policy.lockoutMinutes * 60_000) : null;
  return {
    outcome: "rejected",
    reason,
    message: reachesMaximum
      ? `${message} This was attempt ${failedAttempts} of ${input.policy.maxFailedAttempts}, so the account is now ` +
        `locked for ${describeDuration(input.policy.lockoutMinutes * 60)}. A backup code still works, and the lock lifts by itself.`
      : `${message} That was attempt ${failedAttempts} of ${input.policy.maxFailedAttempts} before this account locks.`,
    failedAttempts,
    lockedUntil,
    lockedNow: reachesMaximum,
  };
}

function safeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A duration a person can read, for the lockout sentences. */
export function describeDuration(seconds: number): string {
  const rounded = Math.max(1, Math.round(seconds));
  if (rounded < 60) return `${rounded} second${rounded === 1 ? "" : "s"}`;
  const minutes = Math.round(rounded / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * Ten backup codes, in the only moment they exist in readable form.
 *
 * The alphabet avoids the characters a person misreads when copying from paper,
 * and the digest is taken over the normalised form, so the code works whether it
 * is typed with hyphens, spaces or in lower case.
 */
export function createBackupCodes(count: number = BACKUP_CODE_COUNT): string[] {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const codes = new Set<string>();
  while (codes.size < count) {
    let code = "";
    for (let index = 0; index < 10; index += 1) code += alphabet[randomInt(alphabet.length)];
    codes.add(`${code.slice(0, 5)}-${code.slice(5)}`);
  }
  return [...codes];
}

export function normalizeBackupCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.toUpperCase().replace(/[\s-]/g, "");
  return /^[A-HJ-NP-Z2-9]{10}$/.test(normalized) ? normalized : null;
}

/**
 * One field, two kinds of code: what the person typed, sorted by its own shape.
 *
 * A single "code" input is what every sign-in page has, and asking someone who
 * has lost their phone to first find a *different* field is how a recovery path
 * stops being one. A six-to-eight digit value is a TOTP code; ten characters from
 * the backup alphabet is a backup code; anything else is neither, and is refused
 * as a wrong code rather than being guessed at.
 */
export function classifySubmittedCode(value: unknown): { kind: "totp" | "backup" | "unknown"; normalized: string | null } {
  const totp = normalizeTotpCode(value);
  if (totp) return { kind: "totp", normalized: totp };
  const backup = normalizeBackupCode(value);
  if (backup) return { kind: "backup", normalized: backup };
  return { kind: "unknown", normalized: null };
}

/**
 * The digest a backup code is stored as.
 *
 * SHA-256 over the normalised code. No salt and no stretching, deliberately: the
 * code is ten characters from a 32-character alphabet drawn without repetition
 * (about 50 bits), it is single-use, it expires with the credential, and the
 * digest must be lookup-able by value — a per-row salt would turn every
 * verification into a scan of every code belonging to the account. What protects
 * it is that the codes are never reusable and never displayed again.
 */
export function hashBackupCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}
