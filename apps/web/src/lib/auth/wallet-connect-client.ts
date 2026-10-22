"use client";

import type { Eip1193Provider } from "@/lib/auth/eip1193";
import { PairingFailure, pairingLinks, pairingUriProblem, walletConnectMetadata, type PairingLinks } from "@/lib/auth/wallet-connect";

/**
 * The pairing port, and the one implementation of it that talks to a relay.
 *
 * The page needs four things from a pairing — a way to reach the phone, the
 * provider to sign with once it answers, whether a session is still live, and
 * progress as it happens — and nothing else. Keeping that in a type means the
 * pairing surface can be driven in a test and in a browser by a double, which is
 * the only way to exercise "the phone declined" or "the code expired" without a
 * phone and a relay that agrees to fail on request.
 *
 * The implementation wraps `@walletconnect/ethereum-provider` with
 * `showQrModal: false`, because this application renders its own QR, its own
 * deep link and its own copy button, and needs the pairing's progress to be
 * visible on the page rather than inside somebody else's modal. The provider is
 * the protocol's own: the SIWE message, the nonce and the verification are phase
 * 07's, and pairing only changes how the wallet is reached.
 */

export type PairingPortEvent =
  | { type: "uri"; uri: string }
  | { type: "paired" }
  | { type: "chain"; chainId: number }
  | { type: "disconnected" }
  | { type: "failed"; error: unknown };

export type PairingResume = { accounts: readonly string[]; chainId: number | null };

export type PairingPort = {
  /**
   * Begin a pairing and resolve as soon as there is something to scan. The
   * pairing itself keeps going afterwards, and reports itself through
   * `subscribe` — that is why this resolves with links rather than with a
   * session.
   */
  start: () => Promise<PairingLinks>;
  /** A session that survived a reload, or null when there is none. */
  resume: () => Promise<PairingResume | null>;
  /** The provider to sign with, once paired. Null before that. */
  provider: () => Eip1193Provider | null;
  /** The chain the paired wallet reports, once paired. */
  chainId: () => number | null;
  /** What the paired wallet calls itself, for copy ("Trust Wallet declined the pairing"). */
  walletName: () => string | null;
  /** End the pairing on both sides. */
  disconnect: () => Promise<void>;
  /** Stop listening. Leaves the session alone. */
  stop: () => void;
  /** Progress, as the wallet and the relay report it. */
  subscribe: (listener: (event: PairingPortEvent) => void) => () => void;
};

export type PairingRequest = {
  projectId: string;
  /** The validated application origin (`APP_BASE_URL`), never a request Host. */
  origin: string;
  /** The chains `AUTH_EVM_CHAIN_IDS` accepts. At least one is required. */
  chainIds: readonly number[];
};

/** How long the relay gets to issue a pairing code before the attempt is reported as failed. */
const URI_TIMEOUT_MS = 20_000;

export type PairingFactory = (request: PairingRequest) => Promise<PairingPort>;

/**
 * The factory the login page uses, unless a development build has replaced it.
 *
 * Pairing is the one sign-in path that cannot be exercised without a phone and a
 * live relay, which makes the states that matter most — the wallet declined, the
 * code expired, the phone came back paired — the ones that would otherwise never
 * be run. So a development build lets the surface be driven by a double placed on
 * `window.__veyloraPairingFactory`, exactly as the phase 07 click-path drove
 * injected wallets with mock providers. The check is compiled out of production
 * builds, so no deployed page can be steered this way.
 */
export function resolvePairingFactory(scope: unknown = typeof window === "undefined" ? undefined : window): PairingFactory {
  if (process.env.NODE_ENV !== "production") {
    const injected = (scope as { __veyloraPairingFactory?: PairingFactory } | undefined)?.__veyloraPairingFactory;
    if (typeof injected === "function") return injected;
  }
  return createWalletConnectPairing;
}

/**
 * The real port over `@walletconnect/ethereum-provider`.
 *
 * Imported dynamically and only from the browser: the provider reaches for
 * `window` and `localStorage` as it initialises, so it must never be evaluated
 * while the server renders the login page.
 */
export async function createWalletConnectPairing(request: PairingRequest): Promise<PairingPort> {
  if (request.chainIds.length === 0) {
    throw new PairingFailure("NOT_CONFIGURED", "No EVM chain is configured for sign-in, so a wallet cannot be paired.", false);
  }

  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  const provider = await EthereumProvider.init({
    projectId: request.projectId,
    // `optionalChains` rather than `chains`: a required chain the wallet does not
    // support would make the wallet refuse the whole session, and this deployment
    // accepts sign-in on any one of the chains it configures.
    optionalChains: [...request.chainIds] as [number, ...number[]],
    // This application draws its own QR, deep link and copy button, and its own
    // progress; the provider's bundled modal is not used at all.
    showQrModal: false,
    metadata: walletConnectMetadata({ origin: request.origin }),
    // No `rpcMap`: sign-in reads the chain, the account and one signature from
    // the wallet, and never sends an RPC read through the pairing, so there is
    // nothing here worth pointing at this application's own RPC proxy.
  });

  const listeners = new Set<(event: PairingPortEvent) => void>();
  const emit = (event: PairingPortEvent) => {
    for (const listener of [...listeners]) listener(event);
  };

  const onDisplayUri = (uri: string) => emit({ type: "uri", uri });
  const onConnect = () => emit({ type: "paired" });
  const onChainChanged = (chainId: string) => {
    const parsed = Number.parseInt(chainId.startsWith("0x") ? chainId.slice(2) : chainId, 16);
    if (Number.isSafeInteger(parsed) && parsed > 0) emit({ type: "chain", chainId: parsed });
  };
  const onDisconnected = () => emit({ type: "disconnected" });

  provider.on("display_uri", onDisplayUri);
  provider.on("connect", onConnect);
  provider.on("chainChanged", onChainChanged);
  provider.on("session_delete", onDisconnected);
  provider.on("disconnect", onDisconnected);

  const hasSession = () => Boolean(provider.session) && provider.accounts.length > 0;

  return {
    async start() {
      const uri = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          provider.removeListener("display_uri", onUri);
          // Not classified as an expiry: no code was ever issued, so nothing
          // expired. The relay is the thing that did not answer.
          reject(
            new PairingFailure(
              "RELAY_UNAVAILABLE",
              "The WalletConnect relay did not issue a pairing code within 20 seconds, so there is nothing to scan. " +
                "Check this device's connection and start pairing again.",
            ),
          );
        }, URI_TIMEOUT_MS);

        function onUri(value: string) {
          clearTimeout(timer);
          resolve(value);
        }
        provider.once("display_uri", onUri);

        // Fire and forget: this promise settles when the wallet approves, which
        // is long after there is something on screen to scan. Its failure is
        // reported through `subscribe`, where the surface is listening.
        void provider.connect().catch((error: unknown) => emit({ type: "failed", error }));
      });

      const problem = pairingUriProblem(uri);
      if (problem) {
        throw new PairingFailure("PAIRING_FAILED", `The relay answered with something that cannot be paired: ${problem}`);
      }
      return pairingLinks(uri);
    },

    async resume() {
      // `EthereumProvider.init` restores a persisted session before this runs,
      // so a reload after the phone approved finds it here.
      if (!hasSession()) return null;
      return { accounts: [...provider.accounts], chainId: Number.isSafeInteger(provider.chainId) ? provider.chainId : null };
    },

    provider() {
      if (!hasSession()) return null;
      // Only `request` is exposed: that is all the phase 07 flow calls, and the
      // flow re-reads the chain and the account through it on every attempt.
      return {
        request: (args) =>
          provider.request({
            method: args.method,
            params: Array.isArray(args.params) ? [...args.params] : args.params,
          }) as Promise<unknown>,
      };
    },

    chainId() {
      return Number.isSafeInteger(provider.chainId) ? provider.chainId : null;
    },

    walletName() {
      // The wallet names itself in the session it approved; there is no other
      // source for it and nothing is inferred from the accounts it returned.
      const name = provider.session?.peer?.metadata?.name;
      return typeof name === "string" && name.trim() ? name.trim() : null;
    },

    async disconnect() {
      await provider.disconnect();
    },

    stop() {
      provider.removeListener("display_uri", onDisplayUri);
      provider.removeListener("connect", onConnect);
      provider.removeListener("chainChanged", onChainChanged);
      provider.removeListener("session_delete", onDisconnected);
      provider.removeListener("disconnect", onDisconnected);
      listeners.clear();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
