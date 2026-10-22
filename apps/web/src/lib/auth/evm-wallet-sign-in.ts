"use client";

import { describeAcceptedChains, evmChainLabel } from "@/lib/auth/chain-labels";
import {
  readWalletChainId,
  requestWalletAccounts,
  signWalletMessage,
  switchWalletChain,
  type Eip1193Provider,
} from "@/lib/auth/eip1193";
import { normalizeWalletAddress } from "@/lib/auth/wallet-address";
import {
  chainNotReachedFailure,
  classifyWalletError,
  isSignInFailure,
  SignInFailure,
  signatureRequestFailure,
  unsupportedChainFailure,
  type WalletFailureContext,
} from "@/lib/auth/wallet-errors";
import { findInjectedWallet, type InjectedWalletKind } from "@/lib/auth/wallet-providers";

/**
 * The sign-in flow, driven against a discovered provider.
 *
 * It used to be written against `wagmi`'s React hooks, so it could only run
 * inside a rendered component against a real extension. Now every attempt takes
 * the page's global scope and the wallet's kind, the provider is re-resolved
 * from the page at the start of the attempt (so a wallet that was removed or
 * disabled between render and click is reported rather than used from a stale
 * reference), and all wallet access goes through `eip1193.ts`.
 *
 * The order is deliberate: the chain is read *before* any prompt appears, so a
 * deployment that would refuse the sign-in says so without the wallet ever
 * asking the user for anything.
 *
 * Nothing client-side is trusted by the server. `verify/route.ts` recovers the
 * signer from the signature, checks the chain inside the SIWE message and
 * matches both against the nonce it issued, so the address and chain read here
 * decide only what to *request* and what to *show*.
 *
 * A paired phone wallet (phase 08) is the same flow with the same nonce and the
 * same verification: the attempt names `walletKind: "walletconnect"` and hands
 * over the provider the pairing produced, and every step after that is the code
 * below. There is one sign-in, not one per transport.
 */

/**
 * How the wallet was reached: an injected provider on the page, or a paired
 * WalletConnect session. Only the first can be re-resolved from the page, which
 * is why a paired attempt must also carry its provider.
 */
export type WalletSignInKind = InjectedWalletKind | "walletconnect";

export type WalletChainInspection = {
  chainId: number;
  chainLabel: string;
  accepted: boolean;
  acceptedChainIds: readonly number[];
  acceptedChains: string;
};

export type SignInResult = {
  address: string;
  role: string;
  chainId: number;
  /**
   * True when this sign-in is what created the account.
   *
   * The page uses it to open the onboarding checklist: someone who has just made
   * an account should land on the four steps that make it useful, not on an
   * overview of surfaces they have not set up.
   */
  newAccount: boolean;
};

export type WalletAccessAttempt = {
  /** The page's global scope (`window`), re-read on every attempt. */
  scope: unknown;
  walletKind: WalletSignInKind;
  walletName: string;
  /**
   * The provider to sign with. Supplied by a pairing; absent for an injected
   * wallet, which is re-resolved from `scope` by kind so a wallet that was
   * removed between render and click is reported rather than used from a
   * stale reference.
   */
  provider?: Eip1193Provider;
};

export type SignInAttempt = WalletAccessAttempt & {
  allowedChainIds: readonly number[];
  fetchImpl?: typeof fetch;
  /**
   * The second factor, when the account demands one for sign-in. The page learns
   * that it does from the server, on the first attempt — so a scope that is off
   * asks for nothing, and the page cannot invent a requirement.
   */
  code?: string;
  backupCode?: string;
};

/**
 * A signed-in-progress attempt: the message and signature the server has seen,
 * kept so a code can be added without asking the wallet to sign again.
 */
export type PendingVerification = { message: string; signature: string };

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => null);
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** The provider for this attempt, or the "it is no longer there" failure. */
function requireProvider(attempt: WalletAccessAttempt): Eip1193Provider {
  if (attempt.provider) return attempt.provider;
  if (attempt.walletKind === "walletconnect") {
    throw new SignInFailure(
      "PROVIDER_UNAVAILABLE",
      "The paired wallet is not connected in this browser, so sign-in cannot start. Start pairing again to reconnect it.",
    );
  }
  const provider = findInjectedWallet(attempt.scope, attempt.walletKind);
  if (provider) return provider;
  throw new SignInFailure(
    "PROVIDER_UNAVAILABLE",
    `${attempt.walletName} is no longer available in this browser, so sign-in cannot start. Reload the page to look for it again, or install it and come back.`,
  );
}

async function step<T>(run: () => Promise<T>, context: WalletFailureContext): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw classifyWalletError(error, context);
  }
}

/**
 * Which chain the wallet is on, and whether this deployment accepts it.
 * Reads the wallet only — no prompt, no signature.
 */
export async function inspectInjectedWalletChain(
  input: WalletAccessAttempt & { allowedChainIds: readonly number[] },
): Promise<WalletChainInspection> {
  const provider = requireProvider(input);
  const chainId = await step(() => readWalletChainId(provider), { step: "connect", walletName: input.walletName });
  return {
    chainId,
    chainLabel: evmChainLabel(chainId),
    accepted: input.allowedChainIds.includes(chainId),
    acceptedChainIds: input.allowedChainIds,
    acceptedChains: describeAcceptedChains(input.allowedChainIds),
  };
}

/**
 * Ask the wallet to switch, and confirm it arrived.
 *
 * A resolved `wallet_switchEthereumChain` is the wallet saying "accepted", not
 * "done": the chain is read back afterwards and compared, and a switch that did
 * not land is reported as its own outcome instead of being assumed.
 */
export async function switchInjectedWalletChain(
  input: WalletAccessAttempt & { chainId: number },
): Promise<{ chainId: number }> {
  const provider = requireProvider(input);
  const outcome = await step(
    () => switchWalletChain(provider, input.chainId),
    { step: "switch", walletName: input.walletName, chainLabel: evmChainLabel(input.chainId) },
  );
  if (outcome.reachedChainId !== outcome.requestedChainId) {
    throw chainNotReachedFailure({
      requestedChainId: outcome.requestedChainId,
      reachedChainId: outcome.reachedChainId,
      chainLabel: evmChainLabel(outcome.reachedChainId),
    });
  }
  return { chainId: outcome.reachedChainId };
}

/**
 * One complete attempt: chain, account, nonce, signature, session.
 *
 * A failure at any step is a `SignInFailure`, always — so the page can name the
 * situation and leave the user able to press the button again without reloading.
 */
export async function signInWithEvmWallet(attempt: SignInAttempt): Promise<SignInResult> {
  const fetchImpl = attempt.fetchImpl ?? fetch;
  const inspection = await inspectInjectedWalletChain(attempt);
  if (!inspection.accepted) {
    throw unsupportedChainFailure({
      chainId: inspection.chainId,
      chainLabel: inspection.chainLabel,
      acceptedChains: inspection.acceptedChains,
    });
  }

  const provider = requireProvider(attempt);
  const reportedAddress = await step(() => requestWalletAccounts(provider), { step: "connect", walletName: attempt.walletName });
  const address = normalizeWalletAddress(reportedAddress);
  if (!address) {
    throw new SignInFailure(
      "SIGN_IN_REFUSED",
      `${attempt.walletName} reported an account that is not a valid EVM address, so no sign-in was attempted.`,
    );
  }

  const nonceResponse = await fetchImpl("/api/auth/nonce", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: address.display, chainId: inspection.chainId }),
  });
  const noncePayload = await readJson(nonceResponse);
  if (!nonceResponse.ok || typeof noncePayload.message !== "string") {
    throw signatureRequestFailure(noncePayload, nonceResponse.status);
  }

  const signature = await step(
    () => signWalletMessage(provider, { message: noncePayload.message as string, address: address.display }),
    { step: "sign", walletName: attempt.walletName },
  );

  const message = noncePayload.message as string;
  const result = await completeSignInVerification({
    message,
    signature,
    ...(attempt.code ? { code: attempt.code } : {}),
    ...(attempt.backupCode ? { backupCode: attempt.backupCode } : {}),
    fetchImpl,
  }).catch((error: unknown) => {
    // "This account also wants a code" is a question, and the answer needs the
    // signature the server just judged — so it travels with the failure rather
    // than being signed again on the next attempt.
    if (isSignInFailure(error) && error.code === "TOTP_REQUIRED") {
      throw new SignInFailure(error.code, error.message, true, { message, signature, address: address.display });
    }
    throw error;
  });

  return {
    address: result.address ?? address.display,
    role: result.role,
    chainId: inspection.chainId,
    newAccount: result.newAccount === true,
  };
}

/**
 * Exchange a signed message for a session, optionally with a code.
 *
 * Separate from the rest of the flow because the server may answer the first
 * presentation of a signature with 428 — "this account also wants a code for
 * sign-in" — and the answer to that is a second POST of the *same* message and
 * signature. The signature is not spent until the exchange succeeds (the nonce
 * is consumed inside the transaction that creates the session), so the user is
 * asked for a code rather than asked to sign twice.
 */
export async function completeSignInVerification(input: PendingVerification & {
  code?: string;
  backupCode?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ address?: string; role: string; twoFactor?: boolean; newAccount: boolean }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const verifyResponse = await fetchImpl("/api/auth/verify", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: input.message,
      signature: input.signature,
      ...(input.code ? { code: input.code } : {}),
      ...(input.backupCode ? { backupCode: input.backupCode } : {}),
    }),
  });
  const verification = await readJson(verifyResponse);
  if (!verifyResponse.ok || verification.authenticated !== true) {
    throw signatureRequestFailure(verification, verifyResponse.status);
  }

  return {
    ...(typeof verification.address === "string" ? { address: verification.address } : {}),
    role: typeof verification.role === "string" ? verification.role : "VIEWER",
    ...(verification.twoFactor === true ? { twoFactor: true } : {}),
    newAccount: verification.newAccount === true,
  };
}

/** `0x1234...abcd` for the wallet list, always from the display form. */
export function displayAddress(scope: unknown): string | null {
  return normalizeWalletAddress(scope)?.display ?? null;
}
