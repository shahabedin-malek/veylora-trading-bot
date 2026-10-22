import { describeAcceptedChains, evmChainLabel } from "@/lib/auth/chain-labels";

/**
 * WalletConnect pairing: the part that is not a browser.
 *
 * Pairing a phone is the only sign-in path whose state lives outside the page —
 * a QR is displayed, a wallet app somewhere approves it, and a signature comes
 * back through a relay. Everything that can be decided without touching that
 * relay is decided here, so it can be tested without one: which variable holds
 * the project id, what each pairing state is called, what a failure is called,
 * what goes into the QR, what a "deep link" and a "copy link" actually are, and
 * what may be written to a log.
 *
 * The state machine is explicit for one specific reason. Phase 07 shipped a bug
 * where a failure path returned while the form was still "busy", leaving a
 * control on screen that could never be pressed. Pairing has more ways to stall
 * than signing does — a QR nobody scans, a phone that walks away, a relay that
 * drops — so the allowed transitions are declared in one table instead of being
 * implied by whichever `setState` calls happen to run, and `failed` can always
 * be retried in place without a reload.
 */

/**
 * The two names this application reads for the protocol project id, in
 * precedence order: the current Reown name first, the name the vendor used
 * before the rebrand second. Both are public (they end up in the browser
 * bundle); neither is a secret. Naming them here is what lets `/login` say
 * exactly which one to set instead of showing a broken QR.
 */
export const WALLET_CONNECT_PROJECT_ID_VARIABLES = [
  "NEXT_PUBLIC_REOWN_PROJECT_ID",
  "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID",
] as const;

export type WalletConnectProjectIdVariable = (typeof WALLET_CONNECT_PROJECT_ID_VARIABLES)[number];

export type WalletConnectConfiguration =
  | { configured: true; projectId: string; variable: WalletConnectProjectIdVariable }
  | { configured: false; variables: readonly WalletConnectProjectIdVariable[]; reason: string };

/**
 * A project id is an identifier, not a placeholder: a value that still reads as
 * "replace me" is treated as unset, so a half-filled `.env` reports the missing
 * variable rather than failing at the relay with an opaque error.
 */
function isUsable(value: string | undefined): value is string {
  const trimmed = value?.trim();
  return Boolean(trimmed) && !/^(?:replace|change.?me|example|your.?|todo)/i.test(trimmed ?? "");
}

/**
 * Which project id this build has, and the sentence to show when it has none.
 *
 * The caller must pass the two variables by their literal names
 * (`process.env.NEXT_PUBLIC_REOWN_PROJECT_ID`), because that is the only form
 * Next.js replaces with a value in a browser bundle — a lookup by variable name
 * would compile to `undefined` and the missing-configuration path would then
 * never be reachable in production.
 */
export function resolveWalletConnectProjectId(env: {
  NEXT_PUBLIC_REOWN_PROJECT_ID?: string;
  NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?: string;
}): WalletConnectConfiguration {
  if (isUsable(env.NEXT_PUBLIC_REOWN_PROJECT_ID)) {
    return { configured: true, projectId: env.NEXT_PUBLIC_REOWN_PROJECT_ID.trim(), variable: "NEXT_PUBLIC_REOWN_PROJECT_ID" };
  }
  if (isUsable(env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID)) {
    return {
      configured: true,
      projectId: env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID.trim(),
      variable: "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID",
    };
  }
  return {
    configured: false,
    variables: WALLET_CONNECT_PROJECT_ID_VARIABLES,
    reason:
      "WalletConnect mobile pairing needs a project id from the Reown dashboard. Set NEXT_PUBLIC_REOWN_PROJECT_ID " +
      "(or NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID) and restart, and the QR appears here. Injected wallets and the " +
      "rest of sign-in work without it.",
  };
}

// ─── states ──────────────────────────────────────────────────────────────────

/**
 * Every state the pairing surface can be in. `preparing` is separate from
 * `waiting` because initialising the provider involves real work (and, on a
 * restored session, no QR at all) — folding it into `waiting` is what would
 * show a QR-shaped hole for a second before there is anything to scan.
 */
export type PairingStage = "idle" | "preparing" | "waiting" | "paired" | "signing" | "signed" | "failed";

export type PairingStageCopy = {
  /** Sidebar-style state, uppercase, short. */
  label: string;
  /** One sentence for the person holding the phone. */
  detail: string;
};

export const PAIRING_STAGE_COPY: Record<PairingStage, PairingStageCopy> = {
  idle: {
    label: "PAIRING NOT STARTED",
    detail: "Start pairing to show a QR code, a deep link and a link you can copy.",
  },
  preparing: {
    label: "PREPARING PAIRING",
    detail: "Reaching the WalletConnect relay and asking it for a pairing code.",
  },
  waiting: {
    label: "WAITING FOR THE WALLET",
    detail: "Scan the QR with a mobile wallet, open the deep link on the phone, or paste the copied link into the wallet.",
  },
  paired: {
    label: "PAIRED",
    detail: "The wallet approved the connection. Signing in with the address it shared.",
  },
  signing: {
    label: "SIGNING IN",
    detail: "The sign-in message was sent to the wallet. Approve it there to finish signing in.",
  },
  signed: {
    label: "SIGNED IN",
    detail: "The signature verified and a session was created.",
  },
  failed: {
    label: "PAIRING FAILED",
    detail: "Nothing was signed in. Start pairing again — no page reload is needed.",
  },
};

export type PairingEvent =
  | { type: "START" }
  | { type: "URI_READY" }
  | { type: "PAIRED" }
  | { type: "SIGN_REQUESTED" }
  | { type: "SIGNED" }
  | { type: "FAILED" }
  | { type: "RESET" };

/**
 * The legal transitions. Anything not listed leaves the stage unchanged, which
 * is the behaviour a late event needs: a provider that reports its URI after the
 * user already cancelled, or a `disconnect` after the session was signed, must
 * not drag the surface backwards into a state it already left.
 */
const PAIRING_TRANSITIONS: Record<PairingStage, Partial<Record<PairingEvent["type"], PairingStage>>> = {
  idle: { START: "preparing", RESET: "idle" },
  preparing: { URI_READY: "waiting", PAIRED: "paired", FAILED: "failed", RESET: "idle" },
  waiting: { URI_READY: "waiting", PAIRED: "paired", FAILED: "failed", RESET: "idle" },
  paired: { SIGN_REQUESTED: "signing", FAILED: "failed", RESET: "idle" },
  signing: { SIGNED: "signed", FAILED: "failed", RESET: "idle" },
  signed: { RESET: "idle" },
  // A failure is never terminal: START is the in-place retry the phase asks for,
  // and it goes back through `preparing` so a stale QR is never reused.
  failed: { START: "preparing", RESET: "idle" },
};

/** Where the pairing surface goes when `event` arrives. Total, never throws. */
export function advancePairingStage(stage: PairingStage, event: PairingEvent): PairingStage {
  return PAIRING_TRANSITIONS[stage][event.type] ?? stage;
}

/** Whether the surface is doing something, so controls must not accept a second start. */
export function pairingIsBusy(stage: PairingStage): boolean {
  return stage === "preparing" || stage === "waiting" || stage === "paired" || stage === "signing";
}

/** Whether this stage can show a QR, a deep link and a copy link. */
export function pairingShowsUri(stage: PairingStage): boolean {
  return stage === "waiting" || stage === "preparing";
}

// ─── failures ────────────────────────────────────────────────────────────────

/**
 * A pairing failure, named so the page can branch on it and worded so the person
 * reading it knows what to do next. Every one is retryable: pairing is a
 * request to a device that may be locked, asleep, declined or on the wrong
 * network, and none of those are reasons to reload a page.
 */
export type PairingFailureCode =
  | "NOT_CONFIGURED"
  | "ORIGIN_MISMATCH"
  | "PAIRING_EXPIRED"
  | "PAIRING_DECLINED"
  | "UNSUPPORTED_CHAIN"
  | "RELAY_UNAVAILABLE"
  | "PROJECT_ID_REJECTED"
  | "PAIRING_FAILED";

export class PairingFailure extends Error {
  readonly code: PairingFailureCode;
  readonly retryable: boolean;

  constructor(code: PairingFailureCode, message: string, retryable = true) {
    super(message);
    this.name = "PairingFailure";
    this.code = code;
    this.retryable = retryable;
  }
}

export function isPairingFailure(error: unknown): error is PairingFailure {
  return error instanceof PairingFailure;
}

function looksLike(error: unknown, pattern: RegExp): boolean {
  const text = [
    error instanceof Error ? error.name : null,
    error instanceof Error ? error.message : typeof error === "string" ? error : null,
    typeof error === "object" && error !== null ? (error as { reason?: unknown }).reason : null,
    typeof error === "object" && error !== null ? (error as { data?: unknown }).data : null,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
  return pattern.test(text);
}

// The words the relay, the provider and wallets actually use. WalletConnect's
// own errors are strings on `Error.message` as often as they are codes, so both
// are read.
const EXPIRY_PATTERN = /\b(expir(ed|y)|timed? ?out|timeout|pairing (is )?(no longer|not) (valid|open))\b/i;
const DECLINED_PATTERN = /\b(user (rejected|denied|cancell?ed|declined)|rejected the (request|session)|declined|action_rejected)\b/i;
// Two tests rather than one pattern: the relay words this both ways round —
// "Missing or invalid projectId" and "projectId is required" — and a single
// ordered pattern would only recognise whichever the library happened to use.
const PROJECT_ID_NAMED_PATTERN = /\bproject ?id\b/i;
const PROJECT_ID_REJECTED_PATTERN = /\b(missing|invalid|not (found|configured|authorized|allowed|recognized)|required|forbidden|unauthori[sz]ed)\b/i;
const RELAY_PATTERN = /\b(relay|websocket|socket|network (error|request failed)|failed to fetch|connection (closed|refused|lost)|ECONNREFUSED|ETIMEDOUT)\b/i;

/**
 * One place decides what a failed pairing is called.
 *
 * The relay's own errors are not four different sentences a user can act on —
 * they are library text — so each distinguishable situation is mapped to its
 * own code and its own sentence, and anything unrecognised still leaves the user
 * with a retry rather than a wall of relay output.
 *
 * A paired wallet on an unsupported chain is *not* classified here: that is a
 * chain decision, made from the chain the wallet reports, and it has its own
 * sentence (`pairedChainFailure`) because the user has to change something in the
 * wallet rather than start over.
 */
export function classifyPairingFailure(error: unknown): PairingFailure {
  if (isPairingFailure(error)) return error;

  if (looksLike(error, EXPIRY_PATTERN)) return pairingExpiredFailure();

  if (looksLike(error, DECLINED_PATTERN)) {
    return new PairingFailure(
      "PAIRING_DECLINED",
      "The wallet declined the pairing, so no connection was made and nothing was signed. Start pairing again to show a new code.",
    );
  }

  if (looksLike(error, PROJECT_ID_NAMED_PATTERN) && looksLike(error, PROJECT_ID_REJECTED_PATTERN)) {
    return new PairingFailure(
      "PROJECT_ID_REJECTED",
      "The WalletConnect relay refused this project id, so no wallet was connected and nothing was signed. Check " +
        "NEXT_PUBLIC_REOWN_PROJECT_ID against the Reown dashboard and that this origin is allowed there, then start pairing again.",
    );
  }

  if (looksLike(error, RELAY_PATTERN)) {
    return new PairingFailure(
      "RELAY_UNAVAILABLE",
      "The WalletConnect relay could not be reached, so no pairing code was issued. Check this device's connection and start pairing again.",
    );
  }

  return new PairingFailure(
    "PAIRING_FAILED",
    "Pairing did not complete, so nothing was signed in. Start pairing again to show a new code.",
  );
}

/**
 * The pairing code lapsed before a wallet answered it. Exported so the page's own
 * countdown and the relay's own error report the same thing the same way.
 */
export function pairingExpiredFailure(): PairingFailure {
  return new PairingFailure(
    "PAIRING_EXPIRED",
    "This pairing code expired before a wallet answered it. Start pairing again to get a fresh code — nothing was signed.",
  );
}

/** The paired wallet is on a chain this deployment does not accept for sign-in. */
export function pairedChainFailure(context: { chainId: number; acceptedChainIds: readonly number[] }): PairingFailure {
  return new PairingFailure(
    "UNSUPPORTED_CHAIN",
    `The paired wallet is on ${evmChainLabel(context.chainId)} (chain ${context.chainId}). ` +
      `${describeAcceptedChains(context.acceptedChainIds)} Nothing was signed. Switch the network in the wallet, ` +
      "then start pairing again — or sign in with an injected wallet already on an accepted network.",
  );
}

/** No project id: reported as a configuration gap, not as a failed pairing. */
export function pairingNotConfiguredFailure(reason: string): PairingFailure {
  return new PairingFailure("NOT_CONFIGURED", reason, false);
}

/**
 * The page is not served from the origin sign-in is configured for. Not
 * retryable in place: the fix is to open the application on its own origin, so
 * the message says that rather than inviting another press.
 */
export function pairingOriginFailure(reason: string): PairingFailure {
  return new PairingFailure("ORIGIN_MISMATCH", reason, false);
}

// ─── the URI: QR, deep link, copy link, and what may be logged ───────────────

export type PairingLinks = {
  /** The raw WalletConnect URI, exactly as the relay issued it. */
  uri: string;
  /** What the QR encodes. The raw URI: a QR is scanned, not opened. */
  qrValue: string;
  /** What a phone opens. The same URI, opened instead of scanned. */
  deepLink: string;
  /** What the copy button puts on the clipboard. The same URI again. */
  copyValue: string;
  /** The pairing's own expiry, when the URI carries one. */
  expiresAt: Date | null;
};

/**
 * Why a value cannot be offered as a pairing, or null when it can.
 *
 * A QR is a promise that something can scan it, and a `wc:` URI is the only
 * thing a WalletConnect wallet can consume. Checking here means a relay that
 * answers with an error object cannot end up rendered as a QR code that no
 * wallet will ever read.
 */
export function pairingUriProblem(value: unknown): string | null {
  if (typeof value !== "string") return "the pairing code was not a string.";
  const uri = value.trim();
  if (!uri.startsWith("wc:")) return "the pairing code did not look like a WalletConnect URI.";
  if (uri.length > 4096) return "the pairing code was implausibly long.";
  return null;
}

/**
 * The expiry the URI carries, as the `expiryTimestamp` query parameter (unix
 * seconds). Read through `URLSearchParams` rather than by position, so a relay
 * that adds or reorders parameters cannot make this claim something wrong — and
 * a URI without one yields null, which the page reports as "no stated expiry"
 * instead of inventing a countdown.
 */
export function pairingUriExpiry(uri: string): Date | null {
  const queryStart = uri.indexOf("?");
  if (queryStart === -1) return null;
  const seconds = Number(new URLSearchParams(uri.slice(queryStart + 1)).get("expiryTimestamp"));
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

export function pairingUriIsExpired(uri: string, now: Date): boolean {
  const expiresAt = pairingUriExpiry(uri);
  return expiresAt !== null && expiresAt.getTime() <= now.getTime();
}

/**
 * One URI, offered three ways.
 *
 * All three carry the identical `wc:` URI, which is what "the same pairing"
 * means: a QR scans it, a deep link opens it, and a copied link is pasted into a
 * wallet that asks for one. Deliberately *not* rewritten into a per-wallet
 * universal link — there is no universal wallet deep-link format, each vendor
 * documents its own, and inventing one is how a link ends up opening a download
 * page instead of the pairing.
 */
export function pairingLinks(uri: string): PairingLinks {
  const trimmed = uri.trim();
  return {
    uri: trimmed,
    qrValue: trimmed,
    deepLink: trimmed,
    copyValue: trimmed,
    expiresAt: pairingUriExpiry(trimmed),
  };
}

/**
 * The URI with its pairing key removed, for anywhere a human might read it.
 *
 * A `wc:` URI carries a symmetric key: whoever holds it can answer the pairing.
 * It has to be shown — it *is* the QR — but it must never be logged or exported,
 * because a log is a copy that outlives the pairing. Only the topic and the
 * non-secret parameters survive this.
 */
export function redactedPairingUri(value: unknown): string {
  if (typeof value !== "string") return "(not a pairing URI)";
  const uri = value.trim();
  if (!uri.startsWith("wc:")) return "(not a pairing URI)";
  const queryStart = uri.indexOf("?");
  if (queryStart === -1) return `${uri.slice(0, 16)}…`;
  const params = new URLSearchParams(uri.slice(queryStart + 1));
  for (const secret of ["symKey", "sym_key"]) {
    if (params.has(secret)) params.set(secret, "redacted");
  }
  const topic = uri.slice(0, queryStart);
  const shown = topic.length > 24 ? `${topic.slice(0, 24)}…` : topic;
  return `${shown}?${params.toString()}`;
}

/**
 * The metadata a wallet displays while it is being asked to pair. `url` and
 * `icons` must come from the deployment's validated origin (`APP_BASE_URL`), not
 * from the request's Host header: the wallet shows this to the user as "the site
 * asking to connect", so deriving it from an attacker-controlled header would
 * let a proxied request name somebody else's site.
 */
export function walletConnectMetadata(input: { origin: string; name?: string; iconUrl?: string | null }) {
  const origin = input.origin.replace(/\/$/, "");
  return {
    name: input.name ?? "Veylora",
    description: input.name ?? "Veylora",
    url: origin,
    icons: input.iconUrl ? [input.iconUrl] : [],
  };
}
