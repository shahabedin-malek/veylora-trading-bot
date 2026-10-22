/**
 * The strategy runner's failure taxonomy, in one place.
 *
 * Phase 24's requirement is that a pass which does not trade says *why*, in terms the
 * owner can act on: an insufficient venue balance is a funding problem, an invalid
 * credential is a key problem, a reached risk limit is a policy problem, and "no entry
 * condition met" is the strategy working as designed. Keeping the codes here — rather
 * than as strings spread through the loop, the panel and the job summary — is what makes
 * "each reason is reachable and displayed" a property a test can check by enumerating
 * this list.
 *
 * `kind` is the only classification the surfaces need:
 *  - `placed` — the pass acted (this is the reason column of a decision that placed).
 *  - `idle`   — deliberately nothing happened; the strategy is fine.
 *  - `error`  — the pass could not do its job and needs attention.
 *
 * An `action` is present wherever the owner has somewhere to go; a reason without one is
 * a fact about the market, not a task.
 */

export const STRATEGY_REASON_CODES = [
  // What a pass did.
  "ENTRY_CONDITION_MET",
  "EXIT_CONDITION_MET",
  "STOP_LOSS_TRIGGERED",
  // Why it did nothing.
  "NO_ENTRY_CONDITION",
  "EXIT_CONDITION_NOT_MET",
  "POSITION_OPEN",
  // Funding and credentials.
  "INSUFFICIENT_VENUE_BALANCE",
  "INVALID_CREDENTIAL",
  "CREDENTIAL_MISSING",
  // The venue or the data.
  "VENUE_UNREACHABLE",
  "RATE_LIMITED",
  "MARKET_DATA_UNAVAILABLE",
  // The owner's configuration.
  "RISK_LIMIT_REACHED",
  "STRATEGY_DISABLED",
  // The schedule itself.
  "RUNNER_MISSED_WINDOW",
  // The order path's answer.
  "ORDER_REFUSED",
  "ORDER_FAILED",
] as const;

export type StrategyReasonCode = (typeof STRATEGY_REASON_CODES)[number];

export type StrategyReasonKind = "placed" | "idle" | "error";

export type StrategyReasonInfo = {
  label: string;
  kind: StrategyReasonKind;
  /** The sentence the panel shows when no more specific detail exists. */
  fallback: string;
  action?: { label: string; href: string };
  /** Whether this reason is one the requirement's taxonomy names explicitly. */
  taxonomy: boolean;
};

export const STRATEGY_REASON_INFO: Record<StrategyReasonCode, StrategyReasonInfo> = {
  ENTRY_CONDITION_MET: {
    label: "Entry condition met",
    kind: "placed",
    fallback: "The entry condition was met and an order was placed.",
    taxonomy: false,
  },
  EXIT_CONDITION_MET: {
    label: "Exit condition met",
    kind: "placed",
    fallback: "The exit condition was met and the position was closed.",
    taxonomy: false,
  },
  STOP_LOSS_TRIGGERED: {
    label: "Stop-loss triggered",
    kind: "placed",
    fallback: "The price reached the position's stop-loss, so the position was closed.",
    action: { label: "Open orders", href: "/trade#order-state-title" },
    taxonomy: false,
  },
  NO_ENTRY_CONDITION: {
    label: "No entry condition met",
    kind: "idle",
    fallback: "The entry condition was not met, so nothing was opened.",
    taxonomy: true,
  },
  EXIT_CONDITION_NOT_MET: {
    label: "Exit not due",
    kind: "idle",
    fallback: "A position is open and the exit condition is not met yet, so it was left alone.",
    taxonomy: false,
  },
  POSITION_OPEN: {
    label: "An order is still open",
    kind: "idle",
    fallback: "An order for this strategy is still working at the venue, so no second order was placed.",
    action: { label: "Open orders", href: "/trade#order-state-title" },
    taxonomy: false,
  },
  INSUFFICIENT_VENUE_BALANCE: {
    label: "Insufficient venue balance",
    kind: "idle",
    fallback: "The exchange account does not hold enough of the quote asset for this order.",
    action: { label: "Trading accounts", href: "/trade#account-connections-title" },
    taxonomy: true,
  },
  INVALID_CREDENTIAL: {
    label: "Invalid or revoked credential",
    kind: "idle",
    fallback: "The exchange key this account trades with was refused, so nothing was sent.",
    action: { label: "Check the key", href: "/trade#account-connections-title" },
    taxonomy: true,
  },
  CREDENTIAL_MISSING: {
    label: "No placeable credential",
    kind: "idle",
    fallback: "No exchange key on this account can place an order, so the strategy kept running and placed nothing.",
    action: { label: "Connect a key", href: "/admin/access" },
    taxonomy: true,
  },
  VENUE_UNREACHABLE: {
    label: "Venue unreachable",
    kind: "error",
    fallback: "The exchange could not be reached, so the order was not placed. The next pass tries again.",
    taxonomy: true,
  },
  RATE_LIMITED: {
    label: "Rate limited",
    kind: "error",
    fallback: "The exchange rate-limited the request, so the order was not placed. The next pass tries again.",
    taxonomy: true,
  },
  MARKET_DATA_UNAVAILABLE: {
    label: "Market data unavailable",
    kind: "error",
    fallback: "There were not enough closed candles to compute the strategy's signal, so nothing was decided.",
    action: { label: "Market data", href: "/admin/data" },
    taxonomy: false,
  },
  RISK_LIMIT_REACHED: {
    label: "Risk limit reached",
    kind: "idle",
    fallback: "The risk policy refused the order, so nothing was sent.",
    action: { label: "Risk controls", href: "/admin/risk" },
    taxonomy: true,
  },
  STRATEGY_DISABLED: {
    label: "Strategy disabled",
    kind: "idle",
    fallback: "This activation names a strategy this build does not publish, so no decision can be made.",
    action: { label: "Choose a strategy", href: "/trade" },
    taxonomy: true,
  },
  RUNNER_MISSED_WINDOW: {
    label: "Runner missed its window",
    kind: "idle",
    fallback:
      "One or more evaluation windows passed without a runner invocation — a deploy, a crash or a missed schedule. The gap is recorded here and the loop continued.",
    action: { label: "Runner heartbeat", href: "/admin/data" },
    taxonomy: true,
  },
  ORDER_REFUSED: {
    label: "Order refused",
    kind: "idle",
    fallback: "The order path refused the order before it was sent.",
    taxonomy: false,
  },
  ORDER_FAILED: {
    label: "Order failed at the venue",
    kind: "error",
    fallback: "The venue did not accept the order. Its own answer is recorded beside this decision.",
    taxonomy: false,
  },
};

export function isStrategyReasonCode(value: unknown): value is StrategyReasonCode {
  return typeof value === "string" && (STRATEGY_REASON_CODES as readonly string[]).includes(value);
}

/** The reason's sentence, with the caller's own detail appended when there is one. */
export function describeStrategyReason(code: StrategyReasonCode, detail?: string | null): string {
  const fallback = STRATEGY_REASON_INFO[code].fallback;
  const trimmed = (detail ?? "").trim();
  if (!trimmed) return fallback;
  // Callers pass the runner's or the venue's own sentence. It replaces the generic
  // fallback rather than being appended to it, so the panel never reads a duplicate.
  return trimmed;
}

/**
 * An order-path reason, in this taxonomy.
 *
 * The order path already classifies what happened (`observability/reason.ts`); this maps
 * those codes rather than re-deriving the cause from prose. Anything the mapping does not
 * name is `ORDER_FAILED`, which is still specific about *where* the failure was.
 */
export function strategyCodeForOrderFailure(input: {
  code: string | null | undefined;
  kind: "refused" | "failed" | "unresolved";
}): StrategyReasonCode {
  const code = input.code ?? "";
  if (code === "INVALID_CREDENTIAL" || code === "AUTHENTICATION_REQUIRED" || code === "NOT_PERMITTED") {
    return "INVALID_CREDENTIAL";
  }
  if (code === "MISSING_CONFIGURATION" || code === "PROVIDER_NOT_CONNECTED") return "CREDENTIAL_MISSING";
  if (code === "INSUFFICIENT_BALANCE") return "INSUFFICIENT_VENUE_BALANCE";
  if (code === "PROVIDER_RATE_LIMITED") return "RATE_LIMITED";
  if (code === "VENUE_UNAVAILABLE" || code === "NETWORK_UNAVAILABLE" || code === "PROVIDER_ERROR") {
    return "VENUE_UNREACHABLE";
  }
  if (code === "RISK_LIMIT_BLOCKED") return "RISK_LIMIT_REACHED";
  if (input.kind === "refused") return "ORDER_REFUSED";
  return "ORDER_FAILED";
}

/**
 * The risk policy's own refusal reasons, as one sentence.
 *
 * They are quoted rather than reinvented: "symbol-not-allowed" is the policy's word, and
 * the owner's fix is on the policy page, not in the strategy.
 */
export function describeRiskRefusal(reasons: readonly string[]): string {
  if (reasons.length === 0) {
    return "The risk policy refused the order, so nothing was sent.";
  }
  return `The risk policy refused the order (${reasons.join(", ")}), so nothing was sent. Fix it in the risk controls and the next pass will act.`;
}
