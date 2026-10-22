/**
 * One reason type for every path that stops, idles or fails.
 *
 * A run that did nothing has to say why. Before this type each path invented its
 * own sentence — or said nothing at all — so an alert that never triggered, an
 * order that was refused and a provider that was rate-limited arrived at the UI
 * as the same absence. A reason is a code, a specific message and whether
 * retrying could change the answer; the code is what a caller branches on and
 * what is persisted, the message is what the owner reads.
 *
 * Every code carries its own default message, so a reason can never degrade into
 * "something went wrong": the caller either supplies a specific message or gets
 * the one below.
 */

export const REASON_CODES = [
  // Money and orders.
  "INSUFFICIENT_BALANCE",
  "ORDER_REJECTED",
  "RISK_LIMIT_BLOCKED",
  // Conditions and timing — a process that idles on purpose.
  "NO_ENTRY_CONDITION",
  "NOT_YET_DUE",
  "ALREADY_RUNNING",
  "ALREADY_COMPLETED",
  "STALE_DATA",
  // Deposits: an arrival on chain that is not (yet) money in the account.
  "AWAITING_CONFIRMATIONS",
  "BELOW_MINIMUM_AMOUNT",
  "TOKEN_NOT_ENABLED",
  "TOKEN_AWAITING_VALUATION",
  "UNKNOWN_RECIPIENT",
  "CHAIN_REORGANIZED",
  // The ledger of record: a book that does not add up, or a movement it refused.
  "LEDGER_UNBALANCED",
  "LEDGER_POSTING_REFUSED",
  // Withdrawals: a request refused, a broadcast refused, a transfer that went
  // wrong on chain, or a request held by the owner's own new-address window.
  "INVALID_AMOUNT",
  "INVALID_DESTINATION",
  "NETWORK_UNSUPPORTED",
  "NETWORK_UNAVAILABLE",
  "NONCE_CONFLICT",
  "TRANSACTION_REVERTED",
  "WITHDRAWAL_EXPIRED",
  "WITHDRAWAL_HELD",
  "WITHDRAWALS_PAUSED",
  // Credentials and configuration.
  "INVALID_CREDENTIAL",
  "MISSING_CONFIGURATION",
  "MISSING_IDEMPOTENCY_KEY",
  "IDEMPOTENCY_KEY_REUSED",
  "AUTHENTICATION_REQUIRED",
  "NOT_PERMITTED",
  // Venues and providers.
  "VENUE_UNAVAILABLE",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_ERROR",
  "INVALID_PROVIDER_RESPONSE",
  "PROVIDER_NOT_CONNECTED",
  // Infrastructure.
  "DATABASE_UNAVAILABLE",
  // The honest last resort, which still says where to look.
  "UNKNOWN",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

type ReasonDefaults = {
  message: string;
  retryable: boolean;
};

const DEFAULTS: Record<ReasonCode, ReasonDefaults> = {
  INSUFFICIENT_BALANCE: { message: "The account does not hold enough balance for this order.", retryable: false },
  ORDER_REJECTED: { message: "The venue refused the order.", retryable: false },
  RISK_LIMIT_BLOCKED: { message: "The risk policy blocked this action.", retryable: false },
  NO_ENTRY_CONDITION: { message: "No entry condition was met, so nothing was opened.", retryable: true },
  NOT_YET_DUE: { message: "This run is not due yet.", retryable: true },
  ALREADY_RUNNING: { message: "Another runner already holds this job's lease, so this invocation left it alone.", retryable: true },
  ALREADY_COMPLETED: {
    message: "This operation was already completed, so its original result was returned instead of being repeated.",
    retryable: false,
  },
  STALE_DATA: { message: "The freshest data available is too old to act on.", retryable: true },
  AWAITING_CONFIRMATIONS: {
    message: "The transfer is on chain but has fewer confirmations than this network requires before it is credited.",
    retryable: true,
  },
  BELOW_MINIMUM_AMOUNT: {
    message: "The transfer is smaller than the deposit minimum this deployment credits, so it was recorded and left uncredited.",
    retryable: false,
  },
  TOKEN_AWAITING_VALUATION: {
    message:
      "This arrival is in a token this network does not configure, so it is held for the owner to credit at its USDT value.",
    retryable: false,
  },
  TOKEN_NOT_ENABLED: {
    message: "The token that arrived is not one the owner has enabled for deposits on this network, so nothing was credited.",
    retryable: false,
  },
  UNKNOWN_RECIPIENT: {
    message: "The transfer's recipient is not a deposit address this deployment issued, so it was recorded without an account.",
    retryable: false,
  },
  CHAIN_REORGANIZED: {
    message: "The block that carried this transfer is no longer in the chain, so the pending deposit was reverted.",
    retryable: true,
  },
  LEDGER_UNBALANCED: {
    message: "The ledger's own invariants are violated, so a balance it shows cannot be trusted.",
    retryable: false,
  },
  LEDGER_POSTING_REFUSED: {
    message: "The ledger refused to post this movement, so nothing was credited.",
    retryable: false,
  },
  INVALID_AMOUNT: {
    message: "The amount is not an amount this asset can be sent in, so the withdrawal was refused.",
    retryable: false,
  },
  INVALID_DESTINATION: {
    message: "The destination is not an address this network can send to, so the withdrawal was refused.",
    retryable: false,
  },
  NETWORK_UNSUPPORTED: {
    message: "This deployment has no usable withdrawal route on that network, so the withdrawal was refused.",
    retryable: false,
  },
  NETWORK_UNAVAILABLE: {
    message: "The network's RPC endpoint could not be reached, so nothing was broadcast.",
    retryable: true,
  },
  NONCE_CONFLICT: {
    message: "The account's transaction nonce was taken by another transfer before this one could use it.",
    retryable: true,
  },
  TRANSACTION_REVERTED: {
    message: "The transaction was mined and reverted, so the transfer did not happen.",
    retryable: false,
  },
  WITHDRAWAL_EXPIRED: {
    message: "The request sat unspent past its expiry, so it was cancelled and the amount released.",
    retryable: false,
  },
  WITHDRAWAL_HELD: {
    message: "This is the first withdrawal to that address, so the amount is held for the window the owner configured.",
    retryable: true,
  },
  WITHDRAWALS_PAUSED: {
    message: "Withdrawals are paused by the owner, so no new request is accepted and nothing new is sent.",
    retryable: true,
  },
  INVALID_CREDENTIAL: { message: "The stored credential was refused.", retryable: false },
  MISSING_CONFIGURATION: { message: "Required configuration is missing.", retryable: false },
  MISSING_IDEMPOTENCY_KEY: {
    message: "A money mutation needs an idempotency key so a retry resolves to the same operation instead of a second one.",
    retryable: false,
  },
  IDEMPOTENCY_KEY_REUSED: {
    message: "This idempotency key is already bound to a different operation, so the request was refused rather than replayed.",
    retryable: false,
  },
  AUTHENTICATION_REQUIRED: { message: "A signed-in session is required.", retryable: false },
  NOT_PERMITTED: { message: "This account is not permitted to use this.", retryable: false },
  VENUE_UNAVAILABLE: { message: "The venue could not be reached.", retryable: true },
  PROVIDER_RATE_LIMITED: { message: "The provider rate-limited this request.", retryable: true },
  PROVIDER_ERROR: { message: "The provider answered with an error.", retryable: true },
  INVALID_PROVIDER_RESPONSE: { message: "The provider answered in a shape that could not be read.", retryable: false },
  PROVIDER_NOT_CONNECTED: { message: "The provider is not connected for this account.", retryable: false },
  DATABASE_UNAVAILABLE: { message: "The database could not be read.", retryable: true },
  UNKNOWN: { message: "The cause was not identified; the server log for this request has the detail.", retryable: true },
};

export type Reason = {
  code: ReasonCode;
  message: string;
  retryable: boolean;
  /** The integration this reason came from, when it came from one. */
  providerId?: string;
  /** The exact environment variable to set, when configuration is the cause. */
  variable?: string;
  /** A safe, redacted extra sentence (an HTTP status, a provider code). */
  detail?: string;
};

export type ReasonInput = {
  /** A specific sentence. Not a replacement for the code: the code still answers "what kind". */
  message?: string;
  retryable?: boolean;
  providerId?: string;
  variable?: string;
  detail?: string;
};

/**
 * Build a reason. The code is the only required input, because a caller who
 * knows what happened should not also have to write the sentence.
 */
export function reason(code: ReasonCode, input: ReasonInput = {}): Reason {
  const defaults = DEFAULTS[code];
  const built: Reason = {
    code,
    message: input.message?.trim() || defaults.message,
    retryable: input.retryable ?? defaults.retryable,
  };
  if (input.providerId?.trim()) built.providerId = input.providerId.trim();
  if (input.variable?.trim()) built.variable = input.variable.trim();
  if (input.detail?.trim()) built.detail = input.detail.trim();
  return built;
}

/** The sentence for a code, for a caller that has no reason object in hand. */
export function reasonMessage(code: ReasonCode): string {
  return DEFAULTS[code].message;
}

/** The JSON shape a reason crosses an API boundary as. */
export type SerializedReason = {
  code: ReasonCode;
  message: string;
  retryable: boolean;
  providerId?: string;
  variable?: string;
  detail?: string;
};

/**
 * Serialise for a response body or a stored column: keys in a fixed order and
 * optional keys omitted when empty, so two identical reasons produce identical
 * JSON and a stored value stays comparable.
 */
export function serializeReason(value: Reason): SerializedReason {
  const serialized: SerializedReason = {
    code: value.code,
    message: value.message,
    retryable: value.retryable,
  };
  if (value.providerId) serialized.providerId = value.providerId;
  if (value.variable) serialized.variable = value.variable;
  if (value.detail) serialized.detail = value.detail;
  return serialized;
}

/** True when this value is a reason code this build understands. */
export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === "string" && (REASON_CODES as readonly string[]).includes(value);
}

export function isReason(value: unknown): value is Reason {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isReasonCode(candidate.code) && typeof candidate.message === "string" && typeof candidate.retryable === "boolean";
}

/**
 * Read a reason back off a JSON boundary. Returns null for anything that is not
 * a well-formed reason, so a caller decides what an unknown payload means
 * instead of rendering an empty sentence.
 */
export function parseReason(value: unknown): Reason | null {
  if (!isReason(value)) return null;
  const candidate = value as Record<string, unknown>;
  const parsed: Reason = {
    code: candidate.code as ReasonCode,
    message: (candidate.message as string).trim() || reasonMessage(candidate.code as ReasonCode),
    retryable: candidate.retryable as boolean,
  };
  if (typeof candidate.providerId === "string" && candidate.providerId) parsed.providerId = candidate.providerId;
  if (typeof candidate.variable === "string" && candidate.variable) parsed.variable = candidate.variable;
  if (typeof candidate.detail === "string" && candidate.detail) parsed.detail = candidate.detail;
  return parsed;
}

/** A reason as a single sentence, for a log line or a span of plain text. */
export function describeReason(value: Reason): string {
  const parts = [`${value.code}: ${value.message}`];
  if (value.variable) parts.push(`set ${value.variable}`);
  if (value.providerId) parts.push(`provider ${value.providerId}`);
  if (value.detail) parts.push(value.detail);
  return parts.join(" · ");
}
