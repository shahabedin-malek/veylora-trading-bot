import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SiweMessage } from "siwe";
import {
  describeAcceptedChains,
  evmChainLabel,
  formatEvmChainList,
} from "../src/lib/auth/chain-labels";
import {
  getAllowedEvmMainnetChainIds,
  getAuthConfig,
  getInitialAdminEvmAddress,
  shouldBootstrapInitialAdmin,
} from "../src/lib/auth/config";
import { verifySiweMessage } from "../src/lib/auth/siwe";
import { createSessionCookieValue, verifySessionCookieValue } from "../src/lib/auth/session-token";

const now = new Date("2026-10-13T12:00:00.000Z");
const account = privateKeyToAccount(keccak256(stringToHex("Veylora SIWE test fixture only")));
const origin = "http://localhost:3000";
const allowedChainIds = new Set([1]);

async function createSignedMessage(options: { chainId?: number; expiresAt?: Date } = {}) {
  const message = new SiweMessage({
    scheme: "http",
    domain: "localhost:3000",
    address: account.address,
    statement: "Sign in to Veylora. This does not authorize a transaction.",
    uri: `${origin}/login`,
    version: "1",
    chainId: options.chainId ?? 1,
    nonce: "0123456789abcdef",
    issuedAt: now.toISOString(),
    expirationTime: (options.expiresAt ?? new Date(now.getTime() + 60_000)).toISOString(),
  });
  const text = message.prepareMessage();
  const signature = await account.signMessage({ message: text });
  return { text, signature, nonce: message.nonce };
}

test("SIWE configuration accepts any configured EVM chain and fails closed when unset", () => {
  assert.equal(getAllowedEvmMainnetChainIds("").size, 0);
  assert.equal(getAllowedEvmMainnetChainIds("11155111").has(11155111), true);
  assert.equal(getAllowedEvmMainnetChainIds("1,8453").size, 2);
  assert.equal(getAllowedEvmMainnetChainIds("-1").size, 0);
  assert.equal(getAllowedEvmMainnetChainIds("1").has(1), true);
  assert.equal(
    getAuthConfig({ APP_BASE_URL: origin, AUTH_EVM_CHAIN_IDS: "", SESSION_SECRET: "x".repeat(40), NODE_ENV: "development" }),
    null,
  );
});

test("sign-in copy is derived from the chains actually configured", () => {
  assert.equal(evmChainLabel(1), "Ethereum Mainnet");
  assert.equal(evmChainLabel(8453), "Base");
  assert.equal(evmChainLabel(31337), "Chain 31337");

  assert.equal(formatEvmChainList([1]), "Ethereum Mainnet");
  assert.equal(formatEvmChainList([1, 8453]), "Base and Ethereum Mainnet");
  assert.equal(formatEvmChainList([1, 8453, 137]), "Base, Ethereum Mainnet and Polygon PoS");
  assert.equal(formatEvmChainList([1, 8453, 137, 10]), "Base, Ethereum Mainnet and 2 more");

  assert.equal(describeAcceptedChains([]), "No EVM chain is configured for sign-in.");
  assert.equal(describeAcceptedChains([1]), "Sign-in accepts Ethereum Mainnet.");
  // Env ordering must not reach the copy: "8453,1" and "1,8453" read the same.
  assert.equal(describeAcceptedChains([8453, 1]), "Sign-in accepts Base and Ethereum Mainnet.");
  assert.equal(describeAcceptedChains([1, 8453]), describeAcceptedChains([8453, 1]));
  assert.equal(formatEvmChainList([8453, 137, 1]), "Base, Ethereum Mainnet and Polygon PoS");
  assert.equal(/approv/i.test(describeAcceptedChains([1, 8453])), false);
});

test("initial owner address is normalized and malformed values fail closed", () => {
  assert.equal(
    getInitialAdminEvmAddress({ INITIAL_ADMIN_EVM_ADDRESS: "0x5a407Ff50d55142c36144B390972c51A768eBf8c", NODE_ENV: "test" } as NodeJS.ProcessEnv),
    "0x5a407ff50d55142c36144b390972c51a768ebf8c",
  );
  assert.equal(getInitialAdminEvmAddress({ INITIAL_ADMIN_EVM_ADDRESS: "not-an-address", NODE_ENV: "test" } as NodeJS.ProcessEnv), null);
});

test("initial owner bootstrap requires matching mainnet SIWE identity and no active owner", () => {
  const env = { INITIAL_ADMIN_EVM_ADDRESS: "0x5a407Ff50d55142c36144B390972c51A768eBf8c", NODE_ENV: "test" } as NodeJS.ProcessEnv;
  assert.equal(shouldBootstrapInitialAdmin({ addressCanonical: "0x5a407ff50d55142c36144b390972c51a768ebf8c", chainId: 1, activeOwnerExists: false, env }), true);
  assert.equal(shouldBootstrapInitialAdmin({ addressCanonical: "0x0000000000000000000000000000000000000001", chainId: 1, activeOwnerExists: false, env }), false);
  assert.equal(shouldBootstrapInitialAdmin({ addressCanonical: "0x5a407ff50d55142c36144b390972c51a768ebf8c", chainId: 5, activeOwnerExists: false, env }), true);
  assert.equal(shouldBootstrapInitialAdmin({ addressCanonical: "0x5a407ff50d55142c36144b390972c51a768ebf8c", chainId: 1, activeOwnerExists: true, env }), false);
});

test("SIWE accepts a valid signature bound to the configured origin, nonce, time and chain", async () => {
  const signed = await createSignedMessage();
  const result = await verifySiweMessage({
    message: signed.text,
    signature: signed.signature,
    expectedNonce: signed.nonce,
    domain: "localhost:3000",
    uri: `${origin}/login`,
    scheme: "http",
    allowedChainIds,
    now,
  });
  assert.equal(result.addressCanonical, account.address.toLowerCase());
  assert.equal(result.chainId, 1);
});

test("SIWE rejects a tampered signature", async () => {
  const signed = await createSignedMessage();
  await assert.rejects(
    verifySiweMessage({
      message: signed.text,
      signature: `0x${"00".repeat(65)}`,
      expectedNonce: signed.nonce,
      domain: "localhost:3000",
      uri: `${origin}/login`,
      scheme: "http",
      allowedChainIds,
      now,
    }),
  );
});

test("SIWE rejects an expired message and a chain outside the configured set", async () => {
  const expired = await createSignedMessage({ expiresAt: new Date(now.getTime() - 1) });
  await assert.rejects(
    verifySiweMessage({
      message: expired.text,
      signature: expired.signature,
      expectedNonce: expired.nonce,
      domain: "localhost:3000",
      uri: `${origin}/login`,
      scheme: "http",
      allowedChainIds,
      now,
    }),
  );

  const unsupported = await createSignedMessage({ chainId: 11155111 });
  await assert.rejects(
    verifySiweMessage({
      message: unsupported.text,
      signature: unsupported.signature,
      expectedNonce: unsupported.nonce,
      domain: "localhost:3000",
      uri: `${origin}/login`,
      scheme: "http",
      allowedChainIds,
      now,
    }),
  );
});

test("stateless session cookie is signed, tamper-resistant, and expires", () => {
  const secret = createHash("sha256").update("test fixture signing input").digest("hex");
  const issuedAt = Math.floor(now.getTime() / 1000);
  const claims = {
    userId: "cm12345678901234567890123",
    walletIdentityId: "cm12345678901234567890123",
    chainNamespace: "eip155" as const,
    chainReference: "1",
    sessionVersion: 3,
    issuedAt,
    expiresAt: issuedAt + 60,
  };
  const cookie = createSessionCookieValue(claims, secret);
  assert.ok(cookie.length > 256);
  assert.deepEqual(verifySessionCookieValue(cookie, secret, issuedAt), claims);
  assert.equal(verifySessionCookieValue(cookie, secret, issuedAt + 60), null);
  assert.equal(verifySessionCookieValue(`${cookie}x`, secret), null);
  assert.equal(verifySessionCookieValue(cookie, secret, issuedAt + 61), null);
});