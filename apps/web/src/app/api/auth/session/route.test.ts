import assert from "node:assert/strict";
import test from "node:test";
import { createSessionCookieValue, verifySessionCookieValue } from "@/lib/auth/session-token";

test("stateless session cookie is signed, expires, and rejects changed claims", () => {
  const secret = "unit-test-secret-that-is-never-used-outside-this-test";
  const claims = {
    userId: "user_test",
    walletIdentityId: "wallet_test",
    chainNamespace: "eip155" as const,
    chainReference: "1",
    sessionVersion: 0,
    issuedAt: 1_800_000_000,
    expiresAt: 1_800_000_600,
  };
  const cookie = createSessionCookieValue(claims, secret);
  assert.deepEqual(verifySessionCookieValue(cookie, secret, claims.issuedAt), claims);
  assert.equal(verifySessionCookieValue(cookie, secret, claims.expiresAt), null);
  assert.equal(verifySessionCookieValue(`${cookie}x`, secret), null);
  assert.equal(verifySessionCookieValue(cookie, `${secret}x`), null);
});
