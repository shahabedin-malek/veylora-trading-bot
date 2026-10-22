import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { getAddress, hashMessage, keccak256, stringToHex, type Hex } from "viem";
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
import {
  siweMessageHash,
  SiweVerificationError,
  statusForSiweVerificationCode,
  verifySiweMessage,
  type VerifySiweInput,
} from "../src/lib/auth/siwe";
import {
  CONTRACT_VERIFICATION_TIMEOUT_MS,
  EIP1271_MAGIC_VALUE,
  IS_VALID_SIGNATURE_SELECTOR,
  accountTypeLabel,
  createContractAccountVerifier,
  encodeIsValidSignatureCall,
  isAccountType,
  isAcceptedSignatureAnswer,
  isRetryableUnverifiableReason,
  readContractSignature,
  type ContractAccountVerifier,
  type ContractSignatureReading,
  type ContractUnverifiableReason,
} from "../src/lib/auth/contract-account";
import { createSessionCookieValue, sessionMatchesUser, verifySessionCookieValue } from "../src/lib/auth/session-token";
import { discoverInjectedWallets, findInjectedWallet } from "../src/lib/auth/wallet-providers";
import { classifyWalletError, signatureRequestFailure, unsupportedChainFailure } from "../src/lib/auth/wallet-errors";
import { canonicalWalletAddress, displayWalletAddress, normalizeWalletAddress, shortWalletAddress } from "../src/lib/auth/wallet-address";
import type { Eip1193Provider } from "../src/lib/auth/eip1193";

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

/** The same fixture, for any address: an account with a key, or a contract wallet. */
async function createSignedMessageFor(
  address: string,
  options: { chainId?: number; signer?: typeof account } = {},
) {
  const message = new SiweMessage({
    scheme: "http",
    domain: "localhost:3000",
    address,
    statement: "Sign in to Veylora. This does not authorize a transaction.",
    uri: `${origin}/login`,
    version: "1",
    chainId: options.chainId ?? 1,
    nonce: "0123456789abcdef",
    issuedAt: now.toISOString(),
    expirationTime: new Date(now.getTime() + 60_000).toISOString(),
  });
  const text = message.prepareMessage();
  const signature = await (options.signer ?? account).signMessage({ message: text });
  return { text, signature, nonce: message.nonce };
}

/** The configured origin, nonce, time and chain, with one thing changed per test. */
async function verify(
  signed: { text: string; signature: string; nonce: string },
  extra: Partial<VerifySiweInput> = {},
) {
  return verifySiweMessage({
    message: signed.text,
    signature: signed.signature,
    expectedNonce: signed.nonce,
    domain: "localhost:3000",
    uri: `${origin}/login`,
    scheme: "http",
    allowedChainIds,
    now,
    ...extra,
  });
}

/** The coded refusal a verification produced, or a failure if it produced none. */
async function refusal(pending: Promise<unknown>): Promise<SiweVerificationError> {
  try {
    await pending;
  } catch (error) {
    assert.ok(error instanceof SiweVerificationError, `expected a coded refusal, got ${String(error)}`);
    return error;
  }
  throw new Error("the verification was accepted, and this test requires it to be refused");
}

test("SIWE accepts a valid signature bound to the configured origin, nonce, time and chain", async () => {
  const signed = await createSignedMessage();
  const seen: unknown[] = [];
  const result = await verify(signed, {
    contractVerifier: async (input) => {
      seen.push(input);
      return { ok: true, valid: true, answer: EIP1271_MAGIC_VALUE };
    },
  });
  assert.equal(result.addressCanonical, account.address.toLowerCase());
  assert.equal(result.chainId, 1);
  // An account whose own key produced the signature is an EOA, and is decided
  // without asking any chain: the contract check is never reached.
  assert.equal(result.accountType, "EOA");
  assert.deepEqual(seen, [], "a key-based account does not need an RPC call");
});

test("SIWE rejects a tampered signature", async () => {
  const signed = await createSignedMessage();
  const rejected = await refusal(verify(signed, { signature: `0x${"00".repeat(65)}` }));
  assert.equal(rejected.code, "SIGNATURE_INVALID");
  assert.equal(rejected.retryable, false);
});

test("SIWE rejects an expired message and a chain outside the configured set", async () => {
  const expired = await createSignedMessage({ expiresAt: new Date(now.getTime() - 1) });
  const expiredRefusal = await refusal(verify(expired));
  assert.equal(expiredRefusal.code, "MESSAGE_EXPIRED");

  const unsupported = await createSignedMessage({ chainId: 11155111 });
  const chainRefusal = await refusal(verify(unsupported));
  assert.equal(chainRefusal.code, "CHAIN_NOT_ALLOWED");
  // The sentence names the chain the message claimed and the reason it was
  // refused, so the owner of a wallet on the wrong network knows what to change.
  assert.match(chainRefusal.message, /11155111/);
  assert.match(chainRefusal.message, /Nothing was signed in/);

  // A message whose chain is accepted but whose origin is not is its own
  // refusal, not the same one as the chain.
  const wrongOrigin = await refusal(verify(await createSignedMessage(), { domain: "evil.example" }));
  assert.equal(wrongOrigin.code, "ORIGIN_MISMATCH");
  assert.notEqual(wrongOrigin.code, chainRefusal.code);
});

test("one wallet is one account: the canonical form is single-sourced for lookup and display", () => {
  // The same wallet written four ways — as an extension reports it, as an
  // all-lowercase string, as an all-uppercase string, and with a *wrong* mixed
  // case checksum. All four are one account, which is what stops a case
  // difference from creating a second WalletIdentity row.
  const forms = [
    "0x5a407Ff50d55142c36144B390972c51A768eBf8c",
    "0x5a407ff50d55142c36144b390972c51a768ebf8c",
    "0X5A407FF50D55142C36144B390972C51A768EBF8C",
    "0x5a407fF50D55142C36144b390972C51a768EBf8C",
  ];
  const canonical = forms.map(canonicalWalletAddress);
  assert.deepEqual(new Set(canonical).size, 1, canonical.join(" / "));
  assert.equal(canonical[0], "0x5a407ff50d55142c36144b390972c51a768ebf8c");

  const display = forms.map(displayWalletAddress);
  assert.deepEqual(new Set(display).size, 1);
  assert.equal(display[0], "0x5a407Ff50d55142c36144B390972c51A768eBf8c");

  // The display form is the EIP-55 checksum of the canonical form, and the two
  // differ in case only.
  assert.equal(displayWalletAddress(display[0]), display[0]);
  assert.equal(canonicalWalletAddress(display[0]), canonical[0]);

  assert.deepEqual(normalizeWalletAddress("  0x5a407Ff50d55142c36144B390972c51A768eBf8c  "), {
    canonical: "0x5a407ff50d55142c36144b390972c51a768ebf8c",
    display: "0x5a407Ff50d55142c36144B390972c51A768eBf8c",
  });

  // Anything that is not a 20-byte hex address is refused rather than guessed at.
  for (const invalid of [null, undefined, 42, {}, "0x5a40", `${"0x"}${"a".repeat(39)}`, `${"0x"}${"a".repeat(41)}`, "0x5a407Ff50d55142c36144B390972c51A768eBf8G"]) {
    assert.equal(normalizeWalletAddress(invalid), null, `${String(invalid)} should not be an address`);
    assert.equal(canonicalWalletAddress(invalid), null);
  }

  assert.equal(shortWalletAddress("0x5a407Ff50d55142c36144B390972c51A768eBf8c"), "0x5a40...Bf8c");
  assert.equal(shortWalletAddress("a-label"), "a-label");
});

function injected(flags: Record<string, unknown>): Eip1193Provider {
  return { request: async () => [], ...flags };
}

test("the wallet list is what the browser actually injected, and the rest is reported as missing", () => {
  const metamask = injected({ isMetaMask: true });
  const rabby = injected({ isRabby: true, isMetaMask: true });
  const coinbase = injected({ isCoinbaseWallet: true, isMetaMask: true });

  const all = discoverInjectedWallets({ ethereum: { request: async () => [], providers: [metamask, rabby, coinbase] } });
  assert.deepEqual(all.detected.map((wallet) => wallet.name), ["MetaMask", "Rabby", "Coinbase Wallet"]);
  assert.deepEqual(all.missing, []);

  // Each wallet is named by its most specific flag, so a Rabby or Coinbase
  // provider that also sets isMetaMask is not mislabelled as MetaMask.
  assert.equal(discoverInjectedWallets({ ethereum: rabby }).detected[0].kind, "rabby");
  assert.equal(discoverInjectedWallets({ ethereum: coinbase }).detected[0].kind, "coinbase");

  // One provider reachable by two paths is one wallet, not two.
  const single = discoverInjectedWallets({ ethereum: { request: async () => [], providers: [metamask], isMetaMask: true } });
  assert.equal(single.detected.length, 1);

  // No extension at all: nothing detected, and the three wallets sign-in
  // supports are reported with somewhere to get them.
  const none = discoverInjectedWallets({ ethereum: undefined });
  assert.deepEqual(none.detected, []);
  assert.deepEqual(none.missing.map((wallet) => wallet.kind), ["rabby", "coinbase", "metamask"]);
  assert.ok(none.missing.every((wallet) => wallet.installUrl.startsWith("https://")), "a missing wallet names where to get it");
  assert.deepEqual(discoverInjectedWallets(null), { detected: [], missing: none.missing });

  // An unknown EIP-1193 provider is still usable, and is not called MetaMask.
  const generic = discoverInjectedWallets({ ethereum: { request: async () => [] } });
  assert.deepEqual(generic.detected.map((wallet) => wallet.kind), ["eip1193"]);
  assert.deepEqual(generic.detected[0].flags, []);

  // Coinbase Wallet's separate global, and a provider that is only reachable
  // through it, are found too.
  assert.equal(discoverInjectedWallets({ coinbaseWalletExtension: coinbase }).detected[0].kind, "coinbase");

  // Re-resolving is what lets the flow notice a wallet that has been removed.
  assert.equal(findInjectedWallet({ ethereum: rabby }, "rabby"), rabby);
  assert.equal(findInjectedWallet({ ethereum: metamask }, "rabby"), null);
});

test("a rejected signature, a cancelled prompt, a wrong chain and a vanished provider are four different answers", () => {
  const rejected = Object.assign(new Error("User rejected the request."), { code: 4001 });

  const signature = classifyWalletError(rejected, { step: "sign", walletName: "Rabby" });
  const prompt = classifyWalletError(rejected, { step: "connect", walletName: "Rabby" });
  const switchDeclined = classifyWalletError(rejected, { step: "switch", walletName: "Rabby" });
  const gone = classifyWalletError(Object.assign(new Error("Provider is disconnected."), { code: 4900 }), { step: "sign", walletName: "Rabby" });
  const chain = unsupportedChainFailure({ chainId: 8453, chainLabel: "Base", acceptedChains: describeAcceptedChains([1]) });

  assert.deepEqual(
    [signature.code, prompt.code, switchDeclined.code, gone.code, chain.code],
    ["SIGNATURE_REJECTED", "PROMPT_CANCELLED", "CHAIN_SWITCH_REJECTED", "PROVIDER_UNAVAILABLE", "UNSUPPORTED_CHAIN"],
  );
  assert.equal(new Set([signature.message, prompt.message, switchDeclined.message, gone.message, chain.message]).size, 5, "five situations, five sentences");
  for (const failure of [signature, prompt, switchDeclined, gone, chain]) {
    assert.equal(failure.retryable, true, `${failure.code} should be retryable`);
    // Every message says what happened to the session, so the user knows there
    // is nothing to undo before trying again.
    assert.match(failure.message, /no session was created|Nothing was signed|Nothing changed|nothing has to be undone|no sign-in was attempted/i, failure.message);
  }
  assert.match(chain.message, /Base/);
  assert.match(chain.message, /Sign-in accepts Ethereum Mainnet\./);

  // Wallets that throw plain messages with no code are recognised too, and a
  // wallet that already has a request open is not reported as a rejection.
  assert.equal(classifyWalletError(new Error("User denied message signature"), { step: "sign" }).code, "SIGNATURE_REJECTED");
  assert.equal(classifyWalletError(new Error("MetaMask is not connected"), { step: "sign", walletName: "MetaMask" }).code, "PROVIDER_UNAVAILABLE");
  assert.equal(classifyWalletError(new Error("Request already pending"), { step: "sign", walletName: "MetaMask" }).code, "REQUEST_ALREADY_PENDING");
  assert.equal(classifyWalletError(Object.assign(new Error("denied"), { code: 4100 }), { step: "connect" }).code, "WALLET_LOCKED");

  // A failure that already knows what it is passes through untouched, and an
  // unrecognised one still leaves the user able to retry.
  assert.equal(classifyWalletError(chain, { step: "sign" }), chain);
  const unknown = classifyWalletError(new Error("something else entirely"), { step: "connect", walletName: "MetaMask" });
  assert.equal(unknown.code, "PROVIDER_UNAVAILABLE");
  assert.equal(unknown.retryable, true);
  assert.ok(!/viem@|Version:/.test(unknown.message), "no library text reaches the user");

  // The server's own refusals keep their sentence and take their own code.
  assert.equal(signatureRequestFailure({ error: "expired", code: "NONCE_EXPIRED" }, 401).code, "NONCE_EXPIRED");
  assert.equal(signatureRequestFailure({ error: "used", code: "NONCE_REUSED" }, 401).code, "NONCE_REUSED");
  assert.equal(signatureRequestFailure({ error: "Authentication is not configured: X" }, 503).retryable, false);
  assert.equal(signatureRequestFailure({}, 401).code, "SIGN_IN_REFUSED");
  assert.ok(signatureRequestFailure({}, 401).message.length > 20);
});

test("the session cookie is only as good as the account it names, which is what sign-out changes", () => {
  const claims = {
    userId: "user_test",
    walletIdentityId: "wallet_test",
    sessionId: "0123456789abcdef0123456789abcdef",
    chainNamespace: "eip155" as const,
    chainReference: "1",
    sessionVersion: 4,
    issuedAt: 1_800_000_000,
    expiresAt: 1_800_000_600,
  };

  assert.equal(sessionMatchesUser(claims, { status: "ACTIVE", sessionVersion: 4 }), true);
  // Sign-out increments sessionVersion and clears the cookie; a cookie that was
  // copied before that no longer matches the user it names.
  assert.equal(sessionMatchesUser(claims, { status: "ACTIVE", sessionVersion: 5 }), false);
  assert.equal(sessionMatchesUser(claims, { status: "SUSPENDED", sessionVersion: 4 }), false);
  assert.equal(sessionMatchesUser(claims, null), false);
});

/* ------------------------------------------------------------------------- */
/* Phase 09 — contract wallets and smart accounts (EIP-1271).                */
/*                                                                           */
/* An address on an EVM chain is either a key pair or a contract, and the two */
/* are proved differently: a key-based account with `ecrecover` on the        */
/* signature alone, a contract wallet by asking the contract at that address  */
/* — EIP-1271 `isValidSignature` — on the chain the signed message names.     */
/* Every test below is about one of three outcomes being told apart:          */
/* accepted, refused, and *not checked* (which is never an acceptance).      */
/* ------------------------------------------------------------------------- */

/** A contract wallet: an address with code at it, and no key behind it. */
const contractWallet = getAddress(`0x${"a1".repeat(20)}`);
const ethereumRpcEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  ALCHEMY_ETHEREUM_MAINNET_RPC_URL: "https://eth-mainnet.g.alchemy.com/v2/unit-test-placeholder",
};
const baseRpcEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  ALCHEMY_BASE_MAINNET_RPC_URL: "https://base-mainnet.g.alchemy.com/v2/unit-test-placeholder",
};

type RpcCall = { id: number; method: string; params: unknown[] };

/** A node, in memory: it answers one batched request and records what it was asked. */
function fakeRpc(
  answer: (call: RpcCall) => { result?: unknown; error?: unknown },
  options: { status?: number } = {},
) {
  const seen: { url: string; calls: RpcCall[]; bounded: boolean }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const calls = JSON.parse(String(init?.body ?? "[]")) as RpcCall[];
    seen.push({ url: String(input), calls, bounded: init?.signal instanceof AbortSignal });
    if (options.status && options.status >= 400) return new Response("refused", { status: options.status });
    return Response.json(calls.map((call) => ({ jsonrpc: "2.0", id: call.id, ...answer(call) })));
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

/** A node that never answers, or answers by failing. */
function failingRpc(error: unknown): typeof fetch {
  return (async () => {
    throw error;
  }) as unknown as typeof fetch;
}

/** A contract whose verification call returns `answer` for `eth_call`. */
function contractRpc(options: { chainId?: string; code?: string; call?: { result?: unknown; error?: unknown } } = {}) {
  return fakeRpc((call) => {
    if (call.method === "eth_chainId") return { result: options.chainId ?? "0x1" };
    if (call.method === "eth_getCode") return { result: "code" in options ? options.code : "0x60806040" };
    return options.call ?? { result: EIP1271_MAGIC_VALUE };
  });
}

test("a contract wallet signs in through EIP-1271, and a key-based account is decided without a chain", async () => {
  const signed = await createSignedMessageFor(contractWallet);
  const asked: Parameters<ContractAccountVerifier>[0][] = [];
  const accepted: ContractSignatureReading = { ok: true, valid: true, answer: EIP1271_MAGIC_VALUE };
  const result = await verify(signed, {
    contractVerifier: async (input) => {
      asked.push(input);
      return accepted;
    },
  });

  assert.equal(result.accountType, "CONTRACT");
  assert.equal(result.addressCanonical, contractWallet.toLowerCase());
  assert.equal(result.addressDisplay, contractWallet);
  assert.equal(result.chainId, 1);

  // No key at that address produced this signature — the fixture signs with the
  // test account — which is exactly why the contract had to be the one to accept it.
  assert.notEqual(account.address.toLowerCase(), contractWallet.toLowerCase());
  assert.equal(asked.length, 1);
  assert.equal(asked[0].address, contractWallet);
  assert.equal(asked[0].chainId, 1, "the contract is asked on the chain the message names");
  assert.equal(asked[0].messageHash, hashMessage(signed.text));
  assert.equal(asked[0].signature, signed.signature);
});

test("the contract is reached over the chain's own RPC, in one bounded batched call", async () => {
  const signed = await createSignedMessageFor(contractWallet);
  const rpc = contractRpc();
  const result = await verify(signed, {
    contractVerifier: createContractAccountVerifier({ fetcher: rpc.fetcher, env: ethereumRpcEnv }),
  });
  assert.equal(result.accountType, "CONTRACT");

  assert.equal(rpc.seen.length, 1, "one batched round trip per check");
  const [request] = rpc.seen;
  assert.equal(request.bounded, true, "the check is bounded by a timeout");
  assert.equal(CONTRACT_VERIFICATION_TIMEOUT_MS, 5_000);
  assert.deepEqual(request.calls.map((call) => call.method), ["eth_chainId", "eth_getCode", "eth_call"]);
  const [call] = request.calls[2].params as [{ to: string; data: string }];
  assert.equal(call.to, contractWallet);
  assert.ok(call.data.startsWith(IS_VALID_SIGNATURE_SELECTOR));
  assert.ok(call.data.includes(siweMessageHash(signed.text).slice(2)), "the contract is asked about the EIP-191 hash of the text that was signed");
  // The endpoint is the configured one for that chain — the same resolution every
  // other RPC read uses. Its path carries the key, so nothing here returns it.
  assert.equal(new URL(request.url).host, "eth-mainnet.g.alchemy.com");
});

test("a refused signature, an unreachable chain and an address with no contract are three different refusals", async () => {
  const signed = await createSignedMessageFor(contractWallet);

  const contractRefused = await refusal(verify(signed, {
    contractVerifier: async () => ({ ok: true, valid: false, answer: "0x00000000" }),
  }));
  assert.equal(contractRefused.code, "CONTRACT_SIGNATURE_INVALID");
  assert.equal(contractRefused.retryable, true);
  assert.equal(statusForSiweVerificationCode(contractRefused.code), 401);

  const unreachable = await refusal(verify(signed, { contractVerifier: async () => ({ ok: false, reason: "rpc-unreachable" }) }));
  assert.equal(unreachable.code, "CONTRACT_VERIFICATION_UNAVAILABLE");
  assert.equal(unreachable.retryable, true, "an unreachable node is worth another attempt");
  assert.equal(statusForSiweVerificationCode(unreachable.code), 502);

  const timedOut = await refusal(verify(signed, { contractVerifier: async () => ({ ok: false, reason: "rpc-timeout" }) }));
  assert.equal(timedOut.code, "CONTRACT_VERIFICATION_UNAVAILABLE");
  assert.equal(timedOut.retryable, true);

  const noContract = await refusal(verify(signed, {
    contractVerifier: async () => ({ ok: false, reason: "not-deployed", detail: contractWallet }),
  }));
  assert.equal(noContract.code, "CONTRACT_ACCOUNT_NOT_DEPLOYED");
  assert.equal(noContract.retryable, false, "no contract there will not become one by retrying");
  assert.equal(statusForSiweVerificationCode(noContract.code), 503);

  const wrongNetwork = await refusal(verify(signed, {
    contractVerifier: async () => ({ ok: false, reason: "chain-mismatch", detail: "0x2105 for chain 1" }),
  }));
  assert.equal(wrongNetwork.code, "CONTRACT_CHAIN_MISMATCH");
  assert.equal(wrongNetwork.retryable, false);
  assert.equal(statusForSiweVerificationCode(wrongNetwork.code), 503);

  const unconfigured = await refusal(verify(signed, {
    contractVerifier: async () => ({ ok: false, reason: "rpc-unconfigured", detail: "ALCHEMY_ETHEREUM_MAINNET_RPC_URL" }),
  }));
  assert.equal(unconfigured.code, "CONTRACT_VERIFICATION_UNAVAILABLE");
  assert.equal(unconfigured.retryable, false);
  assert.match(unconfigured.message, /ALCHEMY_ETHEREUM_MAINNET_RPC_URL/);

  // Six situations, six sentences, and not one of them accepted a signature: a
  // check that could not be completed is never reported as a sign-in.
  const refusals = [contractRefused, unreachable, timedOut, noContract, wrongNetwork, unconfigured];
  assert.equal(new Set(refusals.map((error) => error.message)).size, refusals.length);
  assert.equal(new Set(refusals.map((error) => error.code)).size, 4, "four names: only the two \"could not ask\" reasons share one");
  for (const error of refusals) assert.match(error.message, /[Nn]othing was signed in/, error.code);
});

test("without a chain to ask, a signature no key produced is refused as a format, never accepted", async () => {
  const signed = await createSignedMessageFor(contractWallet);
  const unrecoverable = await refusal(verify(signed));
  assert.equal(unrecoverable.code, "SIGNATURE_INVALID");
  assert.equal(unrecoverable.retryable, false);

  const wrongShape = await refusal(verify(signed, { signature: "0x1626ba7e00" }));
  assert.equal(wrongShape.code, "SIGNATURE_FORMAT");
  assert.match(wrongShape.message, /key-based accounts only/);
  assert.notEqual(wrongShape.code, unrecoverable.code);
});

test("the chain is bound into the signature, and an endpoint answering for another one is refused", async () => {
  const signedBase = await createSignedMessageFor(contractWallet, { chainId: 8453 });
  const accepted = { ok: true, valid: true, answer: EIP1271_MAGIC_VALUE } as const;

  const asked: number[] = [];
  const result = await verify(signedBase, {
    allowedChainIds: new Set([8453]),
    contractVerifier: async (input) => {
      asked.push(input.chainId);
      return accepted;
    },
  });
  assert.deepEqual(asked, [8453]);
  assert.equal(result.chainId, 8453);
  assert.equal(result.accountType, "CONTRACT");

  // The same message against a deployment that accepts only Ethereum Mainnet: the
  // chain inside the signed message is what decides, before anything is asked.
  const askedAgain: number[] = [];
  const offChain = await refusal(verify(signedBase, {
    contractVerifier: async (input) => {
      askedAgain.push(input.chainId);
      return accepted;
    },
  }));
  assert.equal(offChain.code, "CHAIN_NOT_ALLOWED");
  assert.deepEqual(askedAgain, [], "an unaccepted chain is refused without an RPC call");

  // And a node that answers for a chain other than the one it was asked about is
  // a deployment mistake: its answer cannot be trusted, so there is no verdict.
  const mismatched = contractRpc({ chainId: "0x1" });
  const reading = await readContractSignature({
    address: contractWallet,
    chainId: 8453,
    messageHash: siweMessageHash(signedBase.text),
    signature: signedBase.signature,
    fetcher: mismatched.fetcher,
    env: baseRpcEnv,
  });
  assert.equal(reading.ok, false);
  assert.equal(reading.ok === false && reading.reason, "chain-mismatch");

  const refused = await refusal(verify(signedBase, {
    allowedChainIds: new Set([8453]),
    contractVerifier: createContractAccountVerifier({ fetcher: contractRpc({ chainId: "0x1" }).fetcher, env: baseRpcEnv }),
  }));
  assert.equal(refused.code, "CONTRACT_CHAIN_MISMATCH");
  assert.equal(refused.retryable, false);
  assert.match(refused.message, /different chain/);
});

test("every way the check can fail to reach a verdict is its own reason, over the wire", async () => {
  const ask = (fetcher: typeof fetch, overrides: Partial<Parameters<typeof readContractSignature>[0]> = {}) =>
    readContractSignature({
      address: contractWallet,
      chainId: 1,
      messageHash: siweMessageHash("a signed message"),
      signature: "0xdeadbeef" as Hex,
      fetcher,
      env: ethereumRpcEnv,
      ...overrides,
    });

  const noAnswer = await ask(failingRpc(new TypeError("fetch failed")));
  assert.equal(noAnswer.ok === false && noAnswer.reason, "rpc-unreachable");

  const timedOut = await ask(failingRpc(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })));
  assert.equal(timedOut.ok === false && timedOut.reason, "rpc-timeout");
  assert.notEqual(timedOut.ok === false && timedOut.reason, noAnswer.ok === false && noAnswer.reason);

  const httpFailure = await ask(fakeRpc(() => ({ result: "0x1" }), { status: 500 }).fetcher);
  assert.equal(httpFailure.ok === false && httpFailure.reason, "rpc-error");
  assert.equal(httpFailure.ok === false && httpFailure.detail, "500");

  const malformed = await ask(fakeRpc((call) => (call.method === "eth_chainId" ? { result: "0x1" } : {})).fetcher);
  assert.equal(malformed.ok === false && malformed.reason, "rpc-error");
  assert.equal(malformed.ok === false && malformed.detail, "eth_getCode");

  const notConfigured = await ask(contractRpc().fetcher, { env: { NODE_ENV: "test" } as NodeJS.ProcessEnv });
  assert.equal(notConfigured.ok === false && notConfigured.reason, "rpc-unconfigured");
  assert.equal(notConfigured.ok === false && notConfigured.detail, "ALCHEMY_ETHEREUM_MAINNET_RPC_URL");

  const unknownChain = await ask(contractRpc().fetcher, { chainId: 999_999 });
  assert.equal(unknownChain.ok === false && unknownChain.reason, "chain-unknown");

  const noBytecode = await ask(contractRpc({ code: "0x" }).fetcher);
  assert.equal(noBytecode.ok === false && noBytecode.reason, "not-deployed");
  assert.equal(noBytecode.ok === false && noBytecode.detail, contractWallet);

  // The contract's own refusal, per the standard: it reverts for a signature it
  // does not accept. That is a verdict — refused — and not an unavailable check.
  const reverted = await ask(contractRpc({ call: { error: { code: 3, message: "execution reverted" } } }).fetcher);
  assert.equal(reverted.ok, true);
  assert.equal(reverted.ok && reverted.valid, false);
  assert.equal(reverted.ok && reverted.answer, "(the call reverted)");

  const notMagic = await ask(contractRpc({ call: { result: "0x00000000" } }).fetcher);
  assert.equal(notMagic.ok && notMagic.valid, false);

  // Two of these are settled facts and will be just as true next time; the rest
  // are the network and this deployment, which is what "retryable" means here.
  const reasons: ContractUnverifiableReason[] = [
    "chain-unknown",
    "rpc-unconfigured",
    "rpc-unreachable",
    "rpc-timeout",
    "rpc-error",
    "chain-mismatch",
    "not-deployed",
  ];
  assert.deepEqual(reasons.map(isRetryableUnverifiableReason), [false, false, true, true, true, false, false]);
});

test("the EIP-1271 call is the standard's call, and only the magic value is an acceptance", () => {
  const hash = siweMessageHash("Sign in to Veylora. This does not authorize a transaction.");
  assert.equal(hash, hashMessage("Sign in to Veylora. This does not authorize a transaction."));
  assert.match(hash, /^0x[0-9a-f]{64}$/);

  const data = encodeIsValidSignatureCall({ hash, signature: "0xdeadbeef" });
  assert.ok(data.startsWith(IS_VALID_SIGNATURE_SELECTOR), "the selector of isValidSignature(bytes32,bytes)");
  assert.equal(data.slice(10, 74), hash.slice(2), "the hash is the first argument");
  // Two head words — the hash and this offset — so the signature's bytes begin at 0x40.
  assert.equal(data.slice(74, 138), `${'0'.repeat(62)}40`, "the signature is passed as an ABI bytes offset");
  assert.ok(data.includes("deadbeef"));
  // The selector and the value a contract returns for it are the same four bytes,
  // and they are the same four bytes as the last word here: the standard's answer.
  assert.equal(EIP1271_MAGIC_VALUE, IS_VALID_SIGNATURE_SELECTOR);

  for (const accepted of ["0x1626ba7e", "0x1626BA7E", " 0x1626ba7e "]) {
    assert.equal(isAcceptedSignatureAnswer(accepted), true, accepted);
  }
  for (const rejected of ["0x00000000", "0x", "", "0x1626ba7e00", "0x1626ba7", "0x1626ba7f", null, undefined, 12345]) {
    assert.equal(isAcceptedSignatureAnswer(rejected), false, String(rejected));
  }

  assert.equal(isAccountType("CONTRACT"), true);
  assert.equal(isAccountType("EOA"), true);
  assert.equal(isAccountType("SMART_ACCOUNT"), false, "a type this build does not know is not accepted as one");
  assert.equal(isAccountType(null), false);
  assert.equal(accountTypeLabel("CONTRACT"), "Contract wallet (EIP-1271)");
  assert.equal(accountTypeLabel("EOA"), "Externally owned account (EOA)");
});

test("the contract-wallet refusals keep their own name and their retryability on the way to the page", () => {
  const cases = [
    ["CONTRACT_VERIFICATION_UNAVAILABLE", 502, true],
    ["CONTRACT_SIGNATURE_INVALID", 401, true],
    ["CONTRACT_ACCOUNT_NOT_DEPLOYED", 503, false],
    ["CONTRACT_CHAIN_MISMATCH", 503, false],
  ] as const;
  const messages: string[] = [];
  for (const [code, status, retryable] of cases) {
    const failure = signatureRequestFailure({ error: `server sentence for ${code}`, code, retryable }, status);
    assert.equal(failure.code, code);
    assert.equal(failure.retryable, retryable);
    assert.equal(failure.message, `server sentence for ${code}`, "the server's own wording is what is shown");
    messages.push(failure.message);
  }
  assert.equal(new Set(messages).size, cases.length);

  // A 503 with no code at all is still "this deployment cannot do this yet", and
  // a refusal with no retryability sent still leaves the user able to try again.
  assert.equal(signatureRequestFailure({ error: "Authentication storage is unavailable." }, 503).code, "NOT_CONFIGURED");
  assert.equal(signatureRequestFailure({ error: "refused" }, 401).retryable, true);
});

test("stateless session cookie is signed, tamper-resistant, and expires", () => {
  const secret = createHash("sha256").update("test fixture signing input").digest("hex");
  const issuedAt = Math.floor(now.getTime() / 1000);
  const claims = {
    userId: "cm12345678901234567890123",
    walletIdentityId: "cm12345678901234567890123",
    sessionId: "fedcba9876543210fedcba9876543210",
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