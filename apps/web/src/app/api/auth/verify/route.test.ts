import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { hashAuthNonce } from "@/lib/auth/nonce";

test("SIWE nonce persistence uses an irreversible digest key", () => {
  const nonce = "a".repeat(48);
  const digest = hashAuthNonce(nonce);
  assert.equal(digest, createHash("sha256").update(nonce).digest("hex"));
  assert.notEqual(digest, nonce);
});
