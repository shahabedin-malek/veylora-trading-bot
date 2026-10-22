import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";

/**
 * Inbound signal authentication (phase 31).
 *
 * A signal arrives from outside — a TradingView alert, a script, another service — so the two
 * questions this module answers are "is this really from the owner" and "is this the first
 * time". Both are answered before the body is parsed, which is the ordering requirement:
 * nothing reads a JSON document that has not been proven to carry a valid signature.
 *
 * The scheme is the one every webhook provider ships:
 *
 *   signature = HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
 *   headers   = X-Signal-Signature: sha256=<hex>, X-Signal-Timestamp: <ISO 8601 | epoch>
 *
 * The timestamp is inside the signed material, so a captured signature cannot be moved to a
 * fresh timestamp; and the timestamp is bounded by the token's own replay window, so a
 * captured request cannot be replayed forever. The signal id in the body is the second fence:
 * the unique `dedupeKey` on `SignalEvent` refuses a second attempt with the same id (see
 * `log.ts`), which also covers a legitimate retry inside the window.
 *
 * Secrets are sealed with AES-256-GCM under the platform's trading key, with an AAD that names
 * the purpose. Signal material therefore cannot be decrypted as a webhook secret or an
 * exchange key even if the ciphertext were moved between rows. Nothing here is ever returned
 * by a route after creation, and nothing here is logged.
 */

/** The env variable that holds the 32-byte key; already required by the venue vault. */
export const SECRET_ENCRYPTION_KEY_ENV = "TRADING_CREDENTIAL_ENCRYPTION_KEY";

const MIN_REPLAY_WINDOW_SECONDS = 30;
const MAX_REPLAY_WINDOW_SECONDS = 3_600;
export const DEFAULT_REPLAY_WINDOW_SECONDS = 300;

export const SIGNAL_TOKEN_PREFIX = "sig_";
export const SIGNAL_SECRET_PREFIX = "ss_";
export const SIGNAL_SIGNATURE_HEADER = "x-signal-signature";
export const SIGNAL_TIMESTAMP_HEADER = "x-signal-timestamp";
export const SIGNAL_SOURCE_HEADER = "x-signal-source";
export const SIGNAL_MAX_BODY_BYTES = 32_768;

export type SealedSecret = {
  ciphertext: string;
  iv: string;
  authTag: string;
};

type SecretPurpose = "signal" | "webhook";

const SECRET_AAD: Record<SecretPurpose, string> = {
  signal: "veylora:signal-secret:v1",
  webhook: "veylora:webhook-secret:v1",
};

function encryptionKey(): Buffer {
  const value = process.env[SECRET_ENCRYPTION_KEY_ENV]?.trim();
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${SECRET_ENCRYPTION_KEY_ENV} must be configured as 32 bytes of hex.`);
  }
  return Buffer.from(value, "hex");
}

/** Encrypt a secret for storage. The plaintext never leaves this call. */
export function sealSecret(purpose: SecretPurpose, secret: string): SealedSecret {
  if (!secret.trim()) throw new Error("A secret is required.");
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(SECRET_AAD[purpose], "utf8"));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
  };
}

/** Decrypt a stored secret. Throws when the row was sealed for another purpose or tampered. */
export function openSecret(purpose: SecretPurpose, sealed: SealedSecret): string {
  const key = encryptionKey();
  const iv = Buffer.from(sealed.iv, "base64url");
  const authTag = Buffer.from(sealed.authTag, "base64url");
  const ciphertext = Buffer.from(sealed.ciphertext, "base64url");
  if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length === 0 || ciphertext.length > 4_096) {
    throw new Error("Invalid sealed secret record.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(SECRET_AAD[purpose], "utf8"));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * A new endpoint credential.
 *
 * The token is the name in the URL and never changes; the secret signs bodies. Two values
 * rather than one because the URL is written into a third-party alert box and will end up in
 * its logs, while the secret is pasted into a header and stays out of URLs entirely.
 *
 * `tokenHash` is the only form stored, and `tokenPrefix` is the fragment the panel shows.
 */
export function generateSignalToken(): { token: string; secret: string; tokenHash: string; tokenPrefix: string } {
  const token = `${SIGNAL_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
  return {
    token,
    secret: `${SIGNAL_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`,
    tokenHash: hashSignalToken(token),
    tokenPrefix: maskSignalToken(token),
  };
}

export function hashSignalToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

/**
 * The recognisable fragment of a token: first six and last four characters.
 *
 * Short enough that a log line, a table cell and a support screenshot cannot be turned back
 * into the credential; long enough that an owner with several tokens can tell them apart.
 */
export function maskSignalToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length <= 14) return `${trimmed.slice(0, 4)}…`;
  return `${trimmed.slice(0, 9)}…${trimmed.slice(-4)}`;
}

/** The one-way digest a signal row keeps instead of the body it received. */
export function hashSignalBody(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

/** HMAC over `${timestamp}.${rawBody}`, hex. */
export function signalSignature(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

export type SignalVerificationFailure =
  | "BODY_TOO_LARGE"
  | "SIGNATURE_MISSING"
  | "TIMESTAMP_MISSING"
  | "TIMESTAMP_INVALID"
  | "TIMESTAMP_OUT_OF_WINDOW"
  | "SIGNATURE_INVALID";

export type SignalVerification =
  | { ok: true; timestamp: string; ageSeconds: number }
  | { ok: false; code: SignalVerificationFailure; status: number; message: string };

/** Parse the header timestamp as ISO 8601, epoch seconds or epoch milliseconds. */
export function parseSignalTimestamp(value: string | null | undefined): Date | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  if (/^\d{10}$/.test(trimmed)) return new Date(Number(trimmed) * 1_000);
  if (/^\d{13}$/.test(trimmed)) return new Date(Number(trimmed));
  const parsed = new Date(trimmed);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/** The owner's window, clamped to what this build can honour. */
export function normalizeReplayWindowSeconds(value: unknown): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (!Number.isFinite(numeric)) return DEFAULT_REPLAY_WINDOW_SECONDS;
  return Math.min(MAX_REPLAY_WINDOW_SECONDS, Math.max(MIN_REPLAY_WINDOW_SECONDS, Math.round(numeric)));
}

export { MIN_REPLAY_WINDOW_SECONDS, MAX_REPLAY_WINDOW_SECONDS };

function signatureBytes(header: string): Buffer | null {
  const trimmed = header.trim().replace(/^sha256=/i, "");
  if (!/^[a-f0-9]{64}$/i.test(trimmed)) return null;
  return Buffer.from(trimmed, "hex");
}

/**
 * Verify one request. Pure: the caller passes the raw bytes, the headers it read, the secret
 * it opened for this token and the token's own window.
 *
 * The checks run in this order on purpose. Size first, so an oversized body is refused before
 * anything hashes it. Then presence, then readability, then freshness, then the signature:
 * a stale request is refused as stale even if its signature is perfect, which is the answer
 * the sender needs to hear.
 */
export function verifySignal(input: {
  rawBody: string;
  signature: string | null | undefined;
  timestamp: string | null | undefined;
  secret: string;
  replayWindowSeconds?: number;
  now?: Date;
}): SignalVerification {
  const size = Buffer.byteLength(input.rawBody, "utf8");
  if (size > SIGNAL_MAX_BODY_BYTES) {
    return {
      ok: false,
      code: "BODY_TOO_LARGE",
      status: 413,
      message: `The signal body was ${size} bytes; this endpoint accepts at most ${SIGNAL_MAX_BODY_BYTES}.`,
    };
  }
  if (!(input.signature ?? "").trim()) {
    return {
      ok: false,
      code: "SIGNATURE_MISSING",
      status: 401,
      message: `No ${SIGNAL_SIGNATURE_HEADER} header was sent, so the signal was not read.`,
    };
  }
  if (!(input.timestamp ?? "").trim()) {
    return {
      ok: false,
      code: "TIMESTAMP_MISSING",
      status: 401,
      message: `No ${SIGNAL_TIMESTAMP_HEADER} header was sent, so freshness could not be checked.`,
    };
  }
  const signature = signatureBytes(input.signature as string);
  if (!signature) {
    return {
      ok: false,
      code: "SIGNATURE_INVALID",
      status: 401,
      message: `The ${SIGNAL_SIGNATURE_HEADER} header is not a SHA-256 HMAC in hex.`,
    };
  }
  const sentAt = parseSignalTimestamp(input.timestamp);
  if (!sentAt) {
    return {
      ok: false,
      code: "TIMESTAMP_INVALID",
      status: 401,
      message: `The ${SIGNAL_TIMESTAMP_HEADER} header is not an ISO 8601 date or an epoch timestamp.`,
    };
  }
  const now = input.now ?? new Date();
  const window = normalizeReplayWindowSeconds(input.replayWindowSeconds);
  const ageSeconds = Math.round((now.getTime() - sentAt.getTime()) / 1_000);
  if (Math.abs(ageSeconds) > window) {
    return {
      ok: false,
      code: "TIMESTAMP_OUT_OF_WINDOW",
      status: 401,
      message: `The signal timestamp is ${Math.abs(ageSeconds)}s from now; this token accepts a window of ${window}s.`,
    };
  }

  const expected = Buffer.from(signalSignature(input.secret, (input.timestamp as string).trim(), input.rawBody), "hex");
  if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) {
    return {
      ok: false,
      code: "SIGNATURE_INVALID",
      status: 401,
      message: "The signature did not match the body and timestamp that arrived, so nothing was read.",
    };
  }
  return { ok: true, timestamp: (input.timestamp as string).trim(), ageSeconds };
}

/** True for a market this build can place on. Exported so mapping and the panel agree. */
export function isSupportedSignalMarket(market: string): boolean {
  return USD_WATCHLIST.some(({ productId }) => productId === market);
}
