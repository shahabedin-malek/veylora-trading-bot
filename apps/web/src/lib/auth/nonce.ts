import { createHash, randomBytes } from "node:crypto";

export function createAuthNonce(): string {
  return randomBytes(24).toString("hex");
}

export function hashAuthNonce(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

/** The stored half of a nonce: what the route looked up, without the digest. */
export type AuthNonceState = {
  consumedAt: Date | null;
  expiresAt: Date;
};

export type NonceRejectionCode = "NONCE_UNKNOWN" | "NONCE_REUSED" | "NONCE_EXPIRED";

/**
 * Why this nonce cannot be used, or null when it is still good.
 *
 * These three used to share one sentence — "SIWE nonce is missing, expired, or
 * already used." — which left the person reading it unable to tell a slow sign-in
 * (the nonce aged out while they found their wallet) from a replayed one (this
 * exact request was already exchanged for a session, which is the case worth
 * looking into). They are separate events, so they get separate reasons, and the
 * client turns the reason into the sentence it shows.
 *
 * The order is deliberate: a consumed nonce is reported as reused even when it
 * has also expired, because reuse is the stronger statement about what happened.
 */
export type NonceInspection<T extends AuthNonceState> =
  | { ok: true; record: T }
  | { ok: false; code: NonceRejectionCode; error: string };

export function inspectAuthNonce<T extends AuthNonceState>(record: T | null, now: Date): NonceInspection<T> {
  if (!record) {
    return {
      ok: false,
      code: "NONCE_UNKNOWN",
      error: "This sign-in request is not recognised, so no session was created. Start sign-in again.",
    };
  }
  if (record.consumedAt) {
    return {
      ok: false,
      code: "NONCE_REUSED",
      error: "This sign-in request was already exchanged for a session, so it cannot be used again. Start sign-in again.",
    };
  }
  if (record.expiresAt.getTime() <= now.getTime()) {
    return {
      ok: false,
      code: "NONCE_EXPIRED",
      error: "This sign-in request expired before it was signed. Start sign-in again and sign promptly.",
    };
  }
  return { ok: true, record };
}
