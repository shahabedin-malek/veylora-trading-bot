import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { hashAuthNonce, inspectAuthNonce } from "@/lib/auth/nonce";

const NOW = new Date("2026-10-16T12:00:00.000Z");

test("SIWE nonce persistence uses an irreversible digest key", () => {
  const nonce = "a".repeat(48);
  const digest = hashAuthNonce(nonce);
  assert.equal(digest, createHash("sha256").update(nonce).digest("hex"));
  assert.notEqual(digest, nonce);
});

test("an expired, a replayed and an unknown nonce get their own reason, and a good one none", () => {
  const live = { consumedAt: null, expiresAt: new Date(NOW.getTime() + 60_000) };
  const usable = inspectAuthNonce(live, NOW);
  assert.equal(usable.ok, true);
  assert.equal(usable.ok && usable.record, live);

  const unknown = inspectAuthNonce(null, NOW);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.ok === false && unknown.code, "NONCE_UNKNOWN");
  assert.match(unknown.ok === false ? unknown.error : "", /Start sign-in again/);

  const expired = inspectAuthNonce({ consumedAt: null, expiresAt: NOW }, NOW);
  assert.equal(expired.ok === false && expired.code, "NONCE_EXPIRED");
  assert.match(expired.ok === false ? expired.error : "", /expired before it was signed/);

  // A nonce that was exchanged for a session is reported as reused even after
  // it has also aged out: reuse is the stronger statement about what happened,
  // and it is the one worth looking at.
  const replayed = inspectAuthNonce({ consumedAt: new Date(NOW.getTime() - 1), expiresAt: NOW }, NOW);
  assert.equal(replayed.ok === false && replayed.code, "NONCE_REUSED");
  assert.match(replayed.ok === false ? replayed.error : "", /already exchanged for a session/);

  // Three different codes, three different sentences: a slow sign-in and a
  // replayed request are no longer the same message.
  const codes = [unknown, expired, replayed].map((outcome) => (outcome.ok === false ? outcome.code : ""));
  const messages = [unknown, expired, replayed].map((outcome) => (outcome.ok === false ? outcome.error : ""));
  assert.equal(new Set(codes).size, 3);
  assert.equal(new Set(messages).size, 3);
  for (const message of messages) assert.ok(!/missing, expired, or already used/.test(message));
});
