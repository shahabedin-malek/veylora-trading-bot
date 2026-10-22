import { EIP1193_ERROR_CODES, providerErrorCode } from "@/lib/auth/eip1193";

/**
 * One place decides what a failed sign-in attempt is called and what it says.
 *
 * Before this module the login form printed `cause.message` from whatever threw
 * — which for a rejected signature is viem's `UserRejectedRequestError: User
 * rejected the request. Version: viem@2.x`, and for a vanished provider is a
 * bare "fetch failed". Four different situations that a user must handle four
 * different ways read as the same wall of library text, and none of them said
 * whether trying again was worth doing.
 *
 * Every failure now leaves as a `SignInFailure` carrying:
 *   - `code`, a stable name the tests and the UI both branch on;
 *   - `message`, one sentence written for the person looking at the wallet;
 *   - `retryable`, whether pressing the button again can help.
 *
 * Nothing here retries or reloads anything by itself. The caller keeps the user
 * on the page with their wallet still connected, so the next attempt is a
 * button press rather than a page refresh.
 */

export type SignInFailureCode =
  | "SIGNATURE_REJECTED"
  | "PROMPT_CANCELLED"
  | "UNSUPPORTED_CHAIN"
  | "CHAIN_SWITCH_REJECTED"
  | "CHAIN_SWITCH_FAILED"
  | "CHAIN_UNKNOWN"
  | "PROVIDER_UNAVAILABLE"
  | "WALLET_LOCKED"
  | "REQUEST_ALREADY_PENDING"
  | "NONCE_EXPIRED"
  | "NONCE_REUSED"
  | "NONCE_UNKNOWN"
  | "CHAIN_NOT_ALLOWED"
  | "MESSAGE_EXPIRED"
  | "SIGNATURE_FORMAT"
  | "SIGNATURE_INVALID"
  | "CONTRACT_SIGNATURE_INVALID"
  | "CONTRACT_ACCOUNT_NOT_DEPLOYED"
  | "CONTRACT_VERIFICATION_UNAVAILABLE"
  | "CONTRACT_CHAIN_MISMATCH"
  | "SIGN_IN_REFUSED"
  // The account has sign-in 2FA on and this attempt carried no code yet (phase
  // 10). Not a refusal: the page asks for the code and continues, without asking
  // the wallet to sign anything a second time.
  | "TOTP_REQUIRED"
  | "NOT_CONFIGURED";

/**
 * The server's own refusal names, kept as-is so the page can branch on the same
 * code the route decided with. Every one of them is a statement about the
 * signature the server actually judged — or, for the three contract-wallet
 * failures, that it could not judge it at all, which is why those three arrive
 * with `retryable: true` and must not be shown as a permanent refusal.
 */
const SERVER_REFUSAL_CODES: readonly SignInFailureCode[] = [
  "CHAIN_NOT_ALLOWED",
  "MESSAGE_EXPIRED",
  "SIGNATURE_FORMAT",
  "SIGNATURE_INVALID",
  "CONTRACT_SIGNATURE_INVALID",
  "CONTRACT_ACCOUNT_NOT_DEPLOYED",
  "CONTRACT_VERIFICATION_UNAVAILABLE",
  "CONTRACT_CHAIN_MISMATCH",
];

export class SignInFailure extends Error {
  readonly code: SignInFailureCode;
  readonly retryable: boolean;
  /**
   * A signed request the server has not spent yet, carried with a `TOTP_REQUIRED`
   * failure so the page can hand the *same* message and signature back with a
   * code — the wallet is not asked to sign a second time.
   */
  readonly pending?: { message: string; signature: string; address?: string };

  constructor(
    code: SignInFailureCode,
    message: string,
    retryable = true,
    pending?: { message: string; signature: string; address?: string },
  ) {
    super(message);
    this.name = "SignInFailure";
    this.code = code;
    this.retryable = retryable;
    if (pending) this.pending = pending;
  }
}

export function isSignInFailure(error: unknown): error is SignInFailure {
  return error instanceof SignInFailure;
}

/** The step being attempted, which decides what a rejection means. */
export type SignInStep = "connect" | "switch" | "sign" | "verify";

export type WalletFailureContext = {
  step: SignInStep;
  /** For copy: which wallet the user pressed, when one is known. */
  walletName?: string;
  /** For copy on the wrong-chain path, e.g. "Sign-in accepts Ethereum Mainnet." */
  acceptedChains?: string;
  /** The chain the wallet is actually on, for the wrong-chain sentence. */
  chainLabel?: string;
};

/** The EIP-1193 names and the messages wallets actually throw. */
function looksLike(error: unknown, pattern: RegExp): boolean {
  const text = [
    typeof error === "object" && error !== null ? (error as { name?: unknown }).name : null,
    error instanceof Error ? error.message : typeof error === "string" ? error : null,
    typeof error === "object" && error !== null ? (error as { shortMessage?: unknown }).shortMessage : null,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
  return pattern.test(text);
}

const REJECTION_PATTERN = /\b(user (rejected|denied|cancell?ed)|rejected the request|denied (the )?(message|transaction|signature|request)|action_rejected)\b/i;
const UNAUTHORIZED_PATTERN = /\b(unauthori[sz]ed|not been authori[sz]ed|not approved|has not been approved|account access)\b/i;
const DISCONNECTED_PATTERN = /\b(disconnect(ed)?|provider (is )?(not available|unavailable|not found)|connector not (found|connected)|no (injected )?provider|provider not found|ethereum provider (is )?(missing|undefined))\b/i;
const ALREADY_PENDING_PATTERN = /\b(already pending|request already (pending|in progress)|another request is)\b/i;
const UNRECOGNIZED_CHAIN_PATTERN = /\b(unrecognized chain|unknown chain|chain .* not (added|configured)|try adding the chain)\b/i;

/**
 * Turn anything thrown by a wallet or a route into the one failure the user is
 * shown. A `SignInFailure` passes through unchanged, so a rich failure raised
 * deeper in the flow (with its own wording) is never flattened by this.
 */
export function classifyWalletError(error: unknown, context: WalletFailureContext): SignInFailure {
  if (isSignInFailure(error)) return error;

  const code = providerErrorCode(error);
  const walletName = context.walletName ?? "Your wallet";

  if (code === EIP1193_ERROR_CODES.USER_REJECTED || (code === null && looksLike(error, REJECTION_PATTERN))) {
    if (context.step === "sign") {
      return new SignInFailure(
        "SIGNATURE_REJECTED",
        "The signature request was rejected in your wallet, so nothing was signed and no session was created. Press the button again to retry.",
      );
    }
    if (context.step === "switch") {
      return new SignInFailure(
        "CHAIN_SWITCH_REJECTED",
        `The network switch was rejected in ${walletName}. Nothing changed, and no signature was requested. You can try again, or move the wallet to the right network yourself and sign in.`,
      );
    }
    return new SignInFailure(
      "PROMPT_CANCELLED",
      `${walletName} closed the connection request before sharing an account, so no session was created. Press the button again to retry.`,
    );
  }

  if (code === EIP1193_ERROR_CODES.UNRECOGNIZED_CHAIN || looksLike(error, UNRECOGNIZED_CHAIN_PATTERN)) {
    return new SignInFailure(
      "CHAIN_UNKNOWN",
      `${walletName} does not have the network this sign-in needs configured, and sign-in will not add it for you. Add the network in ${walletName}, then press the button again.`,
    );
  }

  if (code === EIP1193_ERROR_CODES.UNAUTHORIZED || looksLike(error, UNAUTHORIZED_PATTERN)) {
    return new SignInFailure(
      "WALLET_LOCKED",
      `${walletName} did not authorise this site, or it is locked. Approve the connection in ${walletName} and press the button again.`,
    );
  }

  if (code === EIP1193_ERROR_CODES.DISCONNECTED || code === EIP1193_ERROR_CODES.CHAIN_DISCONNECTED || looksLike(error, DISCONNECTED_PATTERN)) {
    return new SignInFailure(
      "PROVIDER_UNAVAILABLE",
      `${walletName} stopped responding during sign-in, so no session was created. Reconnect it — or reload the page if it was removed or disabled — and press the button again.`,
    );
  }

  if (looksLike(error, ALREADY_PENDING_PATTERN)) {
    return new SignInFailure(
      "REQUEST_ALREADY_PENDING",
      `${walletName} already has a request open. Finish or dismiss it in the wallet, then press the button again.`,
    );
  }

  if (context.step === "switch") {
    return new SignInFailure(
      "CHAIN_SWITCH_FAILED",
      `The network switch to ${context.chainLabel ?? "the required network"} did not complete in ${walletName}. Nothing was signed. Move the wallet to that network and press the button again.`,
    );
  }

  return new SignInFailure(
    "PROVIDER_UNAVAILABLE",
    `${walletName} could not complete sign-in. Nothing was signed. Press the button again, or reload the page if the wallet was removed or disabled.`,
  );
}

/** The wrong-chain outcome, carrying both networks so the user can compare them. */
export function unsupportedChainFailure(context: {
  chainId: number;
  chainLabel: string;
  acceptedChains: string;
}): SignInFailure {
  // Raised before any prompt, because the chain is read before the wallet is
  // asked for anything — so the sentence can say so, and the user knows there is
  // nothing to undo.
  return new SignInFailure(
    "UNSUPPORTED_CHAIN",
    `Your wallet is connected to ${context.chainLabel} (chain ${context.chainId}), which this deployment does not accept for sign-in. ${context.acceptedChains} Nothing was signed and no session was created.`,
  );
}

/**
 * The chain the wallet reported after a switch, when it is not the one asked
 * for: the switch resolved, so this is not a rejection, but the wallet is still
 * on the wrong network and nothing may be signed from there.
 */
export function chainNotReachedFailure(context: {
  requestedChainId: number;
  reachedChainId: number;
  chainLabel: string;
}): SignInFailure {
  return new SignInFailure(
    "CHAIN_SWITCH_FAILED",
    `The switch was accepted but your wallet is still reporting ${context.chainLabel} (chain ${context.reachedChainId}). Nothing was signed. Switch to chain ${context.requestedChainId} in the wallet itself and press the button again.`,
  );
}

/**
 * A refusal from `/api/auth/nonce` or `/api/auth/verify`.
 *
 * The routes name their own reason (`{ error, code }`); this keeps that
 * sentence and only upgrades the code to a first-class one, because an expired
 * nonce and a replayed nonce are different events — one is a slow user, the
 * other is a retry of something already used — and both are recovered from by
 * starting a new sign-in rather than by fixing a wallet.
 */
export function signatureRequestFailure(
  payload: { error?: string; code?: string; retryable?: boolean },
  status: number,
): SignInFailure {
  const serverMessage = typeof payload.error === "string" && payload.error.length > 0 ? payload.error : null;
  // The route knows things this side cannot infer from a status code — most of
  // all whether a contract-wallet check that could not be completed is worth
  // retrying — so its answer wins when it gives one.
  const retryable = typeof payload.retryable === "boolean" ? payload.retryable : undefined;
  const byCode: Partial<Record<string, SignInFailureCode>> = {
    NONCE_EXPIRED: "NONCE_EXPIRED",
    NONCE_REUSED: "NONCE_REUSED",
    NONCE_UNKNOWN: "NONCE_UNKNOWN",
    // The server is asking a question, not refusing: the same message and
    // signature are still valid and can be presented again with a code.
    TOTP_REQUIRED: "TOTP_REQUIRED",
  };
  const serverCode = typeof payload.code === "string" ? payload.code : null;
  const code = serverCode
    ? (byCode[serverCode] ?? (SERVER_REFUSAL_CODES.includes(serverCode as SignInFailureCode) ? (serverCode as SignInFailureCode) : undefined))
    : undefined;
  if (code) {
    return new SignInFailure(code, serverMessage ?? "This sign-in attempt is no longer valid. Start it again.", retryable ?? true);
  }

  if (status === 503) {
    return new SignInFailure(
      "NOT_CONFIGURED",
      serverMessage ?? "This deployment cannot complete wallet sign-in yet.",
      retryable ?? false,
    );
  }
  return new SignInFailure(
    "SIGN_IN_REFUSED",
    serverMessage ?? "The server refused this sign-in. Nothing was signed in, so nothing has to be undone.",
    retryable ?? true,
  );
}
