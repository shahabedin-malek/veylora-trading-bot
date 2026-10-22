import assert from "node:assert/strict";
import test from "node:test";
import { SiweMessage } from "siwe";
import { keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { inspectInjectedWalletChain, signInWithEvmWallet, switchInjectedWalletChain } from "../src/lib/auth/evm-wallet-sign-in";
import { toHexChainId, type Eip1193Provider } from "../src/lib/auth/eip1193";
import { verifySiweMessage } from "../src/lib/auth/siwe";
import { SignInFailure } from "../src/lib/auth/wallet-errors";
import { discoverInjectedWallets } from "../src/lib/auth/wallet-providers";

/**
 * The sign-in flow, driven against fake injected wallets.
 *
 * The flow used to be reachable only through React hooks and a real extension,
 * so it could not be tested at all. Now the provider is supplied by the caller,
 * so these tests play the part of MetaMask / Rabby / Coinbase Wallet: they
 * report a chain, hand over an account, sign a real SIWE message with a real
 * key, and can refuse, vanish or lie about where a switch landed.
 *
 * The nonce endpoint here builds a genuine EIP-4361 message and the signature is
 * produced by a real secp256k1 key, so the last assertion of the happy path
 * feeds the captured (message, signature) into the production verifier
 * (`verifySiweMessage`) and checks it recovers the wallet's own canonical
 * address. Nothing about the crypto is faked; only the transport is.
 */

const account = privateKeyToAccount(keccak256(stringToHex("Phase 07 wallet fixture only")));
const otherAccount = privateKeyToAccount(keccak256(stringToHex("Phase 07 second wallet fixture")));
const ORIGIN = "http://localhost:3000";
const DOMAIN = "localhost:3000";
const ALLOWED = [1];
const NONCE_TTL_MS = 5 * 60 * 1000;

type FakeWalletOptions = {
  chainId?: number;
  address?: string;
  signer?: typeof account;
  /** What `eth_chainId` reports *after* a switch request resolves. */
  chainAfterSwitch?: number;
  switchError?: unknown;
  signError?: unknown;
  accountsError?: unknown;
};

function fakeWallet(options: FakeWalletOptions = {}) {
  const signer = options.signer ?? account;
  const state = {
    chainId: options.chainId ?? 1,
    address: options.address ?? signer.address,
    signCalls: 0,
    switchCalls: [] as number[],
    requestedMethods: [] as string[],
  };

  const provider: Eip1193Provider = {
    isMetaMask: true,
    async request({ method, params }: { method: string; params?: readonly unknown[] | Record<string, unknown> }) {
      state.requestedMethods.push(method);
      switch (method) {
        case "eth_chainId":
          return toHexChainId(state.chainId);
        case "eth_requestAccounts":
          if (options.accountsError) throw options.accountsError;
          return [state.address];
        case "personal_sign": {
          state.signCalls += 1;
          if (options.signError) throw options.signError;
          const [message] = params as [string, string];
          return signer.signMessage({ message });
        }
        case "wallet_switchEthereumChain": {
          const [target] = params as [{ chainId: string }];
          const chainId = Number.parseInt(target.chainId.slice(2), 16);
          state.switchCalls.push(chainId);
          if (options.switchError) throw options.switchError;
          state.chainId = options.chainAfterSwitch ?? chainId;
          return null;
        }
        default:
          throw new Error(`Unexpected method ${method}`);
      }
    },
  };

  return { provider, state };
}

/**
 * A stand-in for the two auth routes: a real SIWE message from the nonce
 * endpoint, and a verify endpoint that records the signature it was handed.
 */
function fakeAuthRoutes() {
  const captured: { message?: string; signature?: string; verifyCalls: number } = { verifyCalls: 0 };
  const messageFor = (address: string, chainId: number, nonce: string) =>
    new SiweMessage({
      scheme: "http",
      domain: DOMAIN,
      address,
      statement: "Sign in to Veylora. This does not authorize a transaction.",
      uri: `${ORIGIN}/login`,
      version: "1",
      chainId,
      nonce,
      issuedAt: new Date().toISOString(),
      expirationTime: new Date(Date.now() + NONCE_TTL_MS).toISOString(),
    }).prepareMessage();

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = JSON.parse(String(init?.body ?? "{}")) as { address?: string; chainId?: number; message?: string; signature?: string };
    if (url.endsWith("/api/auth/nonce")) {
      return Response.json({ message: messageFor(body.address ?? account.address, body.chainId ?? 1, "0123456789abcdef") });
    }
    if (url.endsWith("/api/auth/verify")) {
      captured.verifyCalls += 1;
      captured.message = body.message;
      captured.signature = body.signature;
      // No address in the body on purpose: the flow then reports the account it
      // itself resolved and normalised, which is what the last test checks.
      return Response.json({ authenticated: true, role: "OWNER" });
    }
    throw new Error(`Unexpected request to ${url}`);
  }) as typeof fetch;

  return { fetchImpl, captured };
}

test("a wallet that signs completes the whole flow, and its signature verifies server-side", async () => {
  const { provider } = fakeWallet();
  const { fetchImpl, captured } = fakeAuthRoutes();
  const scope = { ethereum: provider };

  const result = await signInWithEvmWallet({
    scope,
    walletKind: "metamask",
    walletName: "MetaMask",
    allowedChainIds: ALLOWED,
    fetchImpl,
  });

  assert.equal(result.address, account.address);
  assert.equal(result.role, "OWNER");
  assert.equal(result.chainId, 1);
  assert.equal(captured.verifyCalls, 1);

  // The signature the flow produced is one the production verifier accepts, and
  // it recovers the wallet's own address.
  const verified = await verifySiweMessage({
    message: captured.message as string,
    signature: captured.signature as string,
    expectedNonce: "0123456789abcdef",
    domain: DOMAIN,
    uri: `${ORIGIN}/login`,
    scheme: "http",
    allowedChainIds: new Set(ALLOWED),
  });
  assert.equal(verified.addressCanonical, account.address.toLowerCase());
});

test("a wrong network is refused before the wallet is ever asked for an account", async () => {
  const { provider, state } = fakeWallet({ chainId: 8453 });
  const { fetchImpl } = fakeAuthRoutes();

  await assert.rejects(
    signInWithEvmWallet({
      scope: { ethereum: provider },
      walletKind: "metamask",
      walletName: "MetaMask",
      allowedChainIds: ALLOWED,
      fetchImpl,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SignInFailure);
      assert.equal(error.code, "UNSUPPORTED_CHAIN");
      assert.match(error.message, /Base/);
      assert.match(error.message, /chain 8453/);
      assert.match(error.message, /Sign-in accepts Ethereum Mainnet\./);
      return true;
    },
  );

  // The point of reading the chain first: no prompt, no signature, no request.
  assert.deepEqual(state.requestedMethods, ["eth_chainId"]);
  assert.equal(state.signCalls, 0);
});

test("a switch is confirmed against the wallet rather than assumed", async () => {
  const moved = fakeWallet({ chainId: 1 });
  const switched = await switchInjectedWalletChain({
    scope: { ethereum: moved.provider },
    walletKind: "metamask",
    walletName: "MetaMask",
    chainId: 1,
  });
  assert.equal(switched.chainId, 1);
  assert.deepEqual(moved.state.switchCalls, [1]);

  // A wallet that accepts the request but stays where it was cannot be trusted
  // to sign on the requested chain, and that is its own failure.
  const stuck = fakeWallet({ chainId: 8453, chainAfterSwitch: 8453 });
  await assert.rejects(
    switchInjectedWalletChain({
      scope: { ethereum: stuck.provider },
      walletKind: "metamask",
      walletName: "MetaMask",
      chainId: 1,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SignInFailure);
      assert.equal(error.code, "CHAIN_SWITCH_FAILED");
      assert.match(error.message, /still reporting Base/);
      return true;
    },
  );
});

test("a declined switch and a wallet that lacks the network are different failures", async () => {
  const declined = fakeWallet({ chainId: 8453, switchError: Object.assign(new Error("User rejected the request."), { code: 4001 }) });
  declined.provider.isRabby = true;
  await assert.rejects(
    switchInjectedWalletChain({ scope: { ethereum: declined.provider }, walletKind: "rabby", walletName: "Rabby", chainId: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof SignInFailure);
      assert.equal(error.code, "CHAIN_SWITCH_REJECTED");
      assert.equal(error.retryable, true);
      return true;
    },
  );

  const unaware = fakeWallet({ chainId: 8453, switchError: Object.assign(new Error("Unrecognized chain ID."), { code: 4902 }) });
  await assert.rejects(
    switchInjectedWalletChain({ scope: { ethereum: unaware.provider }, walletKind: "metamask", walletName: "MetaMask", chainId: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof SignInFailure);
      assert.equal(error.code, "CHAIN_UNKNOWN");
      return true;
    },
  );
});

test("after a confirmed switch the sign-in carries on and completes", async () => {
  const wallet = fakeWallet({ chainId: 8453 });
  const { fetchImpl } = fakeAuthRoutes();
  const scope = { ethereum: wallet.provider };

  const before = await inspectInjectedWalletChain({ scope, walletKind: "metamask", walletName: "MetaMask", allowedChainIds: ALLOWED });
  assert.deepEqual({ chainId: before.chainId, accepted: before.accepted }, { chainId: 8453, accepted: false });

  await switchInjectedWalletChain({ scope, walletKind: "metamask", walletName: "MetaMask", chainId: 1 });
  const after = await inspectInjectedWalletChain({ scope, walletKind: "metamask", walletName: "MetaMask", allowedChainIds: ALLOWED });
  assert.equal(after.accepted, true);

  const result = await signInWithEvmWallet({ scope, walletKind: "metamask", walletName: "MetaMask", allowedChainIds: ALLOWED, fetchImpl });
  assert.equal(result.chainId, 1);
});

test("a rejected signature, a cancelled prompt and a missing provider each read differently", async () => {
  const { fetchImpl } = fakeAuthRoutes();
  const rejected = Object.assign(new Error("User rejected the request."), { code: 4001 });

  const refusingWallet = fakeWallet({ signError: rejected });
  await assert.rejects(
    signInWithEvmWallet({
      scope: { ethereum: refusingWallet.provider },
      walletKind: "metamask",
      walletName: "MetaMask",
      allowedChainIds: ALLOWED,
      fetchImpl,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SignInFailure);
      assert.equal(error.code, "SIGNATURE_REJECTED");
      assert.equal(error.retryable, true);
      assert.match(error.message, /rejected in your wallet/);
      assert.match(error.message, /no session was created/);
      return true;
    },
  );

  // Coinbase Wallet, which announces itself with its own flag: the flow looks
  // the wallet up by kind, so the fake has to be the wallet being asked for.
  const closedWallet = fakeWallet({ accountsError: rejected });
  closedWallet.provider.isCoinbaseWallet = true;
  await assert.rejects(
    signInWithEvmWallet({
      scope: { ethereum: closedWallet.provider },
      walletKind: "coinbase",
      walletName: "Coinbase Wallet",
      allowedChainIds: ALLOWED,
      fetchImpl,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SignInFailure);
      assert.equal(error.code, "PROMPT_CANCELLED");
      assert.match(error.message, /Coinbase Wallet closed the connection request/);
      return true;
    },
  );

  // The wallet was detected when the page rendered and is gone by the time the
  // user presses its button: re-discovery is what turns that into a sentence
  // instead of a call on a provider that is no longer there.
  await assert.rejects(
    signInWithEvmWallet({
      scope: { ethereum: undefined },
      walletKind: "metamask",
      walletName: "MetaMask",
      allowedChainIds: ALLOWED,
      fetchImpl,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SignInFailure);
      assert.equal(error.code, "PROVIDER_UNAVAILABLE");
      assert.match(error.message, /no longer available in this browser/);
      return true;
    },
  );

  // Three failures, three codes, three sentences.
  assert.equal(new Set(["SIGNATURE_REJECTED", "PROMPT_CANCELLED", "PROVIDER_UNAVAILABLE"]).size, 3);
});

test("a provider that vanishes between the nonce and the signature is reported, not crashed on", async () => {
  const wallet = fakeWallet({
    signError: Object.assign(new Error("The provider is disconnected from all chains."), { code: 4900 }),
  });
  const { fetchImpl, captured } = fakeAuthRoutes();

  await assert.rejects(
    signInWithEvmWallet({
      scope: { ethereum: wallet.provider },
      walletKind: "metamask",
      walletName: "MetaMask",
      allowedChainIds: ALLOWED,
      fetchImpl,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SignInFailure);
      assert.equal(error.code, "PROVIDER_UNAVAILABLE");
      return true;
    },
  );
  // The nonce was issued and the signature never happened, so nothing was
  // exchanged for a session.
  assert.equal(captured.verifyCalls, 0);
});

test("a replayed or expired nonce is reported with the server's own reason", async () => {
  const { provider } = fakeWallet();

  // The sentences the routes actually send, per code (`verify/route.ts`).
  const serverReasons = {
    NONCE_REUSED: "This sign-in request was already exchanged for a session, so it cannot be used again. Start sign-in again.",
    NONCE_EXPIRED: "This sign-in request expired before it was signed. Start sign-in again and sign promptly.",
    NONCE_UNKNOWN: "This sign-in request is not recognised, so no session was created. Start sign-in again.",
  } as const;

  for (const code of ["NONCE_REUSED", "NONCE_EXPIRED", "NONCE_UNKNOWN"] as const) {
    const reason = serverReasons[code];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/auth/nonce")) {
        return Response.json({
          message: new SiweMessage({
            scheme: "http",
            domain: DOMAIN,
            address: account.address,
            uri: `${ORIGIN}/login`,
            version: "1",
            chainId: 1,
            nonce: "0123456789abcdef",
            issuedAt: new Date().toISOString(),
            expirationTime: new Date(Date.now() + NONCE_TTL_MS).toISOString(),
          }).prepareMessage(),
        });
      }
      return Response.json({ error: reason, code }, { status: 401 });
    }) as typeof fetch;

    await assert.rejects(
      signInWithEvmWallet({ scope: { ethereum: provider }, walletKind: "metamask", walletName: "MetaMask", allowedChainIds: ALLOWED, fetchImpl }),
      (error: unknown) => {
        assert.ok(error instanceof SignInFailure);
        // The server's own sentence is what the user reads, and the code is
        // what the page branches on.
        assert.equal(error.code, code);
        assert.equal(error.message, reason);
        assert.equal(error.retryable, true);
        return true;
      },
    );
  }

  // A 503 from a deployment that cannot sign anyone in is not retryable, and
  // says so rather than inviting the user to try again forever.
  const unavailable = (async () => Response.json({ error: "Authentication is not configured: SESSION_SECRET is not configured." }, { status: 503 })) as typeof fetch;
  await assert.rejects(
    signInWithEvmWallet({ scope: { ethereum: provider }, walletKind: "metamask", walletName: "MetaMask", allowedChainIds: ALLOWED, fetchImpl: unavailable }),
    (error: unknown) => {
      assert.ok(error instanceof SignInFailure);
      assert.equal(error.code, "NOT_CONFIGURED");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("a wallet that reports a non-address account signs nothing", async () => {
  const wallet = fakeWallet({ address: "not-an-address" });
  const { fetchImpl, captured } = fakeAuthRoutes();

  await assert.rejects(
    signInWithEvmWallet({
      scope: { ethereum: wallet.provider },
      walletKind: "metamask",
      walletName: "MetaMask",
      allowedChainIds: ALLOWED,
      fetchImpl,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SignInFailure);
      assert.equal(error.code, "SIGN_IN_REFUSED");
      return true;
    },
  );
  assert.equal(wallet.state.signCalls, 0);
  assert.equal(captured.verifyCalls, 0);
});

test("the flow re-reads the page's wallets, so a swapped provider is used", async () => {
  const first = fakeWallet({ signer: account });
  const second = fakeWallet({ signer: otherAccount });
  const scope: { ethereum: Eip1193Provider } = { ethereum: first.provider };
  const { fetchImpl } = fakeAuthRoutes();

  // The extension re-injects between render and click.
  scope.ethereum = second.provider;
  assert.equal(discoverInjectedWallets(scope).detected.length, 1);
  assert.equal(discoverInjectedWallets(scope).detected[0].provider, second.provider);

  const result = await signInWithEvmWallet({
    scope,
    walletKind: "metamask",
    walletName: "MetaMask",
    allowedChainIds: ALLOWED,
    fetchImpl,
  });
  assert.equal(result.address, otherAccount.address);
  assert.equal(first.state.signCalls, 0);
});
