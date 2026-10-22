import assert from "node:assert/strict";
import test from "node:test";
import { revokeSession, type SessionRevocationStore } from "@/lib/auth/session-revocation";
import { createSessionCookieValue, sessionMatchesUser, verifySessionCookieValue } from "@/lib/auth/session-token";

const SECRET = "unit-test-secret-that-is-never-used-outside-this-test";
const NOW = new Date("2026-10-16T12:00:00.000Z");
const issuedAt = Math.floor(NOW.getTime() / 1000);
/** The id of the session row this cookie points at (phase 10). */
const SESSION_ID = "0123456789abcdef0123456789abcdef";
const claims = {
  userId: "user_test",
  walletIdentityId: "wallet_test",
  sessionId: SESSION_ID,
  chainNamespace: "eip155" as const,
  chainReference: "1",
  sessionVersion: 0,
  issuedAt,
  expiresAt: issuedAt + 3600,
};

/** A user row and the audit trail, in memory. */
function memoryStore(initial: { status?: string; sessionVersion?: number } = {}, present = true) {
  const user = present
    ? { id: claims.userId, status: initial.status ?? "ACTIVE", sessionVersion: initial.sessionVersion ?? 0 }
    : null;
  const signOuts: Array<{ userId: string; sessionVersion: number; at: Date }> = [];
  const store: SessionRevocationStore = {
    findUser: async (userId) => (user && user.id === userId ? { ...user } : null),
    incrementSessionVersion: async (userId) => {
      assert.equal(userId, claims.userId);
      if (!user) throw new Error("no user");
      user.sessionVersion += 1;
      return user.sessionVersion;
    },
    recordSignOut: async (input) => {
      signOuts.push(input);
    },
  };
  return { store, signOuts, user };
}

test("stateless session cookie is signed, expires, and rejects changed claims", () => {
  const cookie = createSessionCookieValue(claims, SECRET);
  assert.deepEqual(verifySessionCookieValue(cookie, SECRET, claims.issuedAt), claims);
  assert.equal(verifySessionCookieValue(cookie, SECRET, claims.expiresAt), null);
  assert.equal(verifySessionCookieValue(`${cookie}x`, SECRET), null);
  assert.equal(verifySessionCookieValue(cookie, `${SECRET}x`), null);
});

test("signing out ends the session on the server, not only in the browser", async () => {
  const memory = memoryStore();
  const cookie = createSessionCookieValue(claims, SECRET);

  const outcome = await revokeSession({ store: memory.store, claims, now: NOW });
  assert.deepEqual(outcome, { revoked: true, userId: claims.userId, sessionVersion: 1 });
  assert.equal(memory.user?.sessionVersion, 1);
  assert.equal(memory.signOuts.length, 1, "the sign-out is on the audit trail");
  assert.equal(memory.signOuts[0].at, NOW);

  // The cookie is untouched and its signature still verifies — the invalidation
  // is not in the cookie, it is in the account the cookie names.
  assert.deepEqual(verifySessionCookieValue(cookie, SECRET, claims.issuedAt + 10), claims);

  // Which means: a cookie captured before sign-out no longer resolves, while a
  // fresh one issued after it does.
  assert.equal(sessionMatchesUser(claims, memory.user), false, "the signed-out cookie is refused server-side");
  assert.equal(
    sessionMatchesUser({ ...claims, sessionVersion: 1 }, memory.user),
    true,
    "a session started after the sign-out works",
  );
});

test("signing out twice is one sign-out, and a stale cookie cannot sign out a live session", async () => {
  const memory = memoryStore();
  await revokeSession({ store: memory.store, claims, now: NOW });
  const again = await revokeSession({ store: memory.store, claims, now: NOW });

  assert.deepEqual(again, { revoked: false, reason: "STALE_SESSION" });
  assert.equal(memory.user?.sessionVersion, 1, "the live session was not bumped a second time");
  assert.equal(memory.signOuts.length, 1);
});

test("an account that is gone or suspended signs out without being written to", async () => {
  const missing = memoryStore({}, false);
  assert.deepEqual(await revokeSession({ store: missing.store, claims, now: NOW }), {
    revoked: false,
    reason: "ACCOUNT_UNAVAILABLE",
  });
  assert.deepEqual(missing.signOuts, []);

  const suspended = memoryStore({ status: "SUSPENDED" });
  assert.deepEqual(await revokeSession({ store: suspended.store, claims, now: NOW }), {
    revoked: false,
    reason: "STALE_SESSION",
  });
  assert.equal(suspended.user?.sessionVersion, 0);
  assert.deepEqual(suspended.signOuts, []);
});
