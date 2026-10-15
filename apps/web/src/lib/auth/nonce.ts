import { createHash, randomBytes } from "node:crypto";

export function createAuthNonce(): string {
  return randomBytes(24).toString("hex");
}

export function hashAuthNonce(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}