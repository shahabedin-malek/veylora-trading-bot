import assert from "node:assert/strict";
import test from "node:test";
import { createAuthNonce, hashAuthNonce } from "@/lib/auth/nonce";

test("auth nonce is opaque, SIWE-compatible, and stored only as a hash", () => {
  const nonce = createAuthNonce();
  assert.match(nonce, /^[a-f0-9]{48}$/);
  assert.notEqual(hashAuthNonce(nonce), nonce);
  assert.equal(hashAuthNonce(nonce), hashAuthNonce(nonce));
});
