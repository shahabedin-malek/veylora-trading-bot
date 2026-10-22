import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * The authenticator secret, sealed at rest.
 *
 * A TOTP secret is a credential: whoever holds it can produce every future code,
 * so it is never stored in the clear — not in the database, not in a log line,
 * not in an audit record. It is sealed with the deployment's AES-256-GCM key and
 * opened only inside the two operations that need it (enrolling, and checking a
 * code).
 *
 * The key is the deployment's existing encryption key, read through the same
 * variable the venue-credential vault uses. The *purpose* is separated instead,
 * with its own associated data: a venue-credential ciphertext cannot be opened as
 * a TOTP secret or the other way round, because the associated data differs. That
 * keeps one key in the secret store (nothing new to configure, nothing new to
 * rotate) while keeping the two uses cryptographically apart. A dedicated key is
 * the natural next step once there is more than one secret class to isolate; it is
 * recorded as a follow-up rather than required now.
 */

export const TOTP_SECRET_AAD = "veylora:totp-secret:v1";
export const TOTP_SECRET_ENV_NAME = "TRADING_CREDENTIAL_ENCRYPTION_KEY";

export type SealedTotpSecret = {
  ciphertext: string;
  iv: string;
  authTag: string;
};

export function isTotpEncryptionKeyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[TOTP_SECRET_ENV_NAME]?.trim();
  return Boolean(value && /^[a-f0-9]{64}$/i.test(value));
}

function encryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const value = env[TOTP_SECRET_ENV_NAME]?.trim();
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${TOTP_SECRET_ENV_NAME} must be configured as 32 bytes of hex to store an authenticator secret.`);
  }
  return Buffer.from(value, "hex");
}

export function sealTotpSecret(secret: string, env: NodeJS.ProcessEnv = process.env): SealedTotpSecret {
  if (!/^[A-Z2-7]{16,128}$/.test(secret)) throw new Error("Invalid authenticator secret.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(env), iv);
  cipher.setAAD(Buffer.from(TOTP_SECRET_AAD, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
  };
}

/** Throws rather than returning a partial secret: an unusable row is not a secret. */
export function openTotpSecret(sealed: SealedTotpSecret, env: NodeJS.ProcessEnv = process.env): string {
  const iv = Buffer.from(sealed.iv, "base64url");
  const authTag = Buffer.from(sealed.authTag, "base64url");
  const ciphertext = Buffer.from(sealed.ciphertext, "base64url");
  if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length === 0 || ciphertext.length > 4_096) {
    throw new Error("Invalid sealed authenticator secret.");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(env), iv);
  decipher.setAAD(Buffer.from(TOTP_SECRET_AAD, "utf8"));
  decipher.setAuthTag(authTag);
  const secret = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  if (!/^[A-Z2-7]{16,128}$/.test(secret)) throw new Error("Sealed authenticator secret did not open as one.");
  return secret;
}
