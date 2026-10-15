import { createHmac, timingSafeEqual } from "node:crypto";

export type SessionClaims = {
  userId: string;
  walletIdentityId: string;
  chainNamespace: "eip155";
  chainReference: string;
  sessionVersion: number;
  issuedAt: number;
  expiresAt: number;
};

export function createSessionCookieValue(claims: SessionClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifySessionCookieValue(value: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): SessionClaims | null {
  if (value.length > 1024) return null;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra || !/^[A-Za-z0-9_-]+$/.test(payload)) return null;

  const expected = createHmac("sha256", secret).update(payload).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;

  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionClaims;
  } catch {
    return null;
  }

  if (
    !claims ||
    typeof claims.userId !== "string" ||
    typeof claims.walletIdentityId !== "string" ||
    claims.chainNamespace !== "eip155" ||
    typeof claims.chainReference !== "string" ||
    !Number.isSafeInteger(claims.sessionVersion) ||
    claims.sessionVersion < 0 ||
    !Number.isSafeInteger(claims.issuedAt) ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.issuedAt > nowSeconds + 30 ||
    claims.expiresAt <= nowSeconds ||
    claims.expiresAt <= claims.issuedAt ||
    claims.expiresAt - claims.issuedAt > 8 * 60 * 60 + 30
  ) {
    return null;
  }

  return claims;
}

export function isSessionActive(expiresAt: Date, now = new Date()): boolean {
  return expiresAt.getTime() > now.getTime();
}