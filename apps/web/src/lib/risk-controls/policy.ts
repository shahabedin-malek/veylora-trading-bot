import DecimalJS from "decimal.js";

const Decimal = DecimalJS.clone({ precision: 100 });

export const RISK_POLICY_VERSION = "veylora-risk-v1";

/**
 * The owner's limits (phases 22 and 25).
 *
 * Every one of them is admin data: nothing here is a constant in the trading path, and the
 * evaluator only ever reads what the row says. The phase-25 limits follow one rule about
 * zero — **zero means unlimited**, not "refuse everything" — because a cap of 0 is how an
 * owner says "I do not want to be limited here", and a value that reads like a limit while
 * refusing every order would be the opposite of a protection. `null` is never used for that
 * meaning: an absent value is a configuration gap that fails closed.
 */
export type AdjustableRiskPolicy = {
  maxRiskPerTradePercent: string;
  maxOpenExposurePercent: string;
  dailyLossHaltPercent: string;
  maxTradesPerDay: number;
  defaultMaxLeverage: string;
  minimumVerifiedBalanceUsd: string;
  first24HourExposureUsd: string;
  approvedSymbols: readonly string[];
  killSwitchActive: boolean;
  /** Largest notional one order may request, USD. `"0"` = unlimited. */
  maxOrderNotionalUsd: string;
  /** Largest open notional one strategy may hold, USD. `"0"` = unlimited. */
  maxStrategyNotionalUsd: string;
  /** Most non-terminal orders/positions open at once. `0` = unlimited. */
  maxOpenPositions: number;
  /** Most order intents allowed per interval. `0` = unlimited. */
  maxTradesPerInterval: number;
  /** The interval the per-interval trade cap is counted over, in minutes. */
  tradeIntervalMinutes: number;
  /**
   * After a halt, how long new intents are held back. `0` = no cooldown.
   *
   * A halt is either a refusal on the daily-loss limit or the owner releasing the global
   * kill switch: the point is that "and now we are back" is a moment with a wait after it,
   * not the same instant as the halt ending.
   */
  cooldownMinutes: number;
  /** Venues orders may use. Empty = every configured venue. */
  allowedVenues: readonly string[];
};

export const DEFAULT_RISK_POLICY: AdjustableRiskPolicy = {
  maxRiskPerTradePercent: "1",
  maxOpenExposurePercent: "25",
  dailyLossHaltPercent: "2",
  maxTradesPerDay: 10,
  defaultMaxLeverage: "1",
  minimumVerifiedBalanceUsd: "20",
  first24HourExposureUsd: "20",
  approvedSymbols: [],
  killSwitchActive: false,
  maxOrderNotionalUsd: "0",
  maxStrategyNotionalUsd: "0",
  maxOpenPositions: 0,
  maxTradesPerInterval: 0,
  tradeIntervalMinutes: 60,
  cooldownMinutes: 0,
  allowedVenues: [],
};

/** True when a numeric cap is present and not the owner's "unlimited". */
export function capIsSet(cap: string | number): boolean {
  return typeof cap === "number" ? cap > 0 : /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(cap) && new Decimal(cap).gt(0);
}

export const RISK_POLICY = {
  requireStopLoss: true,
  requireMaximumLossBound: true,
  requireVerifiedFunds: true,
  requireApprovedVenue: true,
  requireLiveArm: true,
  requirePerUserSymbolAllowList: true,
  requireKillSwitchCheck: true,
  requireAppendOnlyAudit: true,
} as const;

export type RiskOrderInput = {
  executionMode?: "LIVE" | "PAPER";
  paperBotActive?: boolean;
  reducePosition?: boolean;
  symbol: string;
  allowedSymbols: readonly string[];
  venueApproved: boolean;
  liveArmed: boolean;
  killSwitchActive: boolean;
  auditAvailable: boolean;
  hasValidStopLoss: boolean;
  capitalUsd: string | null;
  verifiedAvailableUsd: string | null;
  requestedNotionalUsd: string;
  serverComputedMaxLossUsd: string;
  currentOpenExposureUsd: string;
  dailyLossUsd: string;
  tradesToday: number;
  leverage: string;
  first24HoursAfterArm: boolean;
  exposureSinceArmUsd: string;
  /** Phase 25: the strategy this intent belongs to, when one is placing it. */
  strategyKey?: string | null;
  /** Open notional already attributed to that strategy. */
  strategyOpenNotionalUsd?: string;
  /** Non-terminal orders at the venue right now. */
  openPositionCount?: number;
  /** Intents in the last `tradeIntervalMinutes`. */
  tradesInInterval?: number;
  /** The venue the order would go to, for the allow-list. */
  venueId?: string | null;
  /** Minutes left of a post-halt cooldown, or 0 when none is running. */
  cooldownRemainingMinutes?: number;
  /** The owner's per-strategy switch for the strategy placing this order. */
  strategyKillSwitchActive?: boolean;
};

export type RiskRefusalReason =
  | "invalid-order-input"
  | "venue-not-approved"
  | "trading-not-armed"
  | "kill-switch-active"
  | "audit-unavailable"
  | "capital-unconfigured"
  | "verified-funds-required"
  | "minimum-balance-not-met"
  | "insufficient-verified-funds"
  | "symbol-not-allowed"
  | "stop-loss-required"
  | "per-trade-risk-exceeded"
  | "open-exposure-exceeded"
  | "daily-loss-halt"
  | "trade-count-exceeded"
  | "leverage-exceeded"
  | "first-day-exposure-exceeded"
  | "risk-policy-unavailable"
  | "risk-state-unavailable"
  | "paper-bot-not-active"
  // Phase 25: the owner's own caps, each named with the value it saw.
  | "order-notional-exceeded"
  | "strategy-notional-exceeded"
  | "open-positions-exceeded"
  | "interval-trade-count-exceeded"
  | "venue-not-allowed"
  | "cooldown-active";

/**
 * One cap an intent met, with what the evaluator actually observed.
 *
 * Requirement 3 of the phase is that a refusal names *the limit that refused it and the
 * current value against the cap*, so the numbers travel with the decision rather than
 * having to be reconstructed from the policy row afterwards.
 */
export type RiskLimitBreach = {
  reason: RiskRefusalReason;
  /** The setting's own name, as the panel labels it. */
  limit: string;
  /** The cap, or `null` when the limit is not numeric (a venue list, a cooldown clock). */
  cap: string | null;
  /** What was measured against it. */
  observed: string;
  scope: "order" | "strategy" | "account" | "venue";
};

export type RiskDecision =
  | { decision: "ALLOW"; policyVersion: typeof RISK_POLICY_VERSION; reasons: [] }
  | {
      decision: "REFUSE";
      policyVersion: typeof RISK_POLICY_VERSION;
      reasons: RiskRefusalReason[];
      /** The owner's caps that refused it, in the order they were checked. */
      limits: RiskLimitBreach[];
    };

function amount(value: string | null): InstanceType<typeof Decimal> | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const parsed = new Decimal(value);
  return parsed.isFinite() ? parsed : null;
}

/**
 * What the risk surface says about the policy it loaded.
 *
 * The last clause is the owner's real-money switch (phase 22), read from the same settings
 * row rather than from a constant: "live execution on" is a fact about the deployment's
 * configuration, and a status line that said otherwise would be the one place the owner
 * could not tell.
 */
export function getRiskControlsStatus(
  policy: AdjustableRiskPolicy,
  options: { liveExecutionEnabled?: boolean } = {},
) {
  const live = options.liveExecutionEnabled === true;
  return {
    status: "Connected",
    detail: `Admin policy loaded · ${policy.approvedSymbols.length} site symbols · ${policy.killSwitchActive ? "kill switch active" : "kill switch ready"} · live execution ${live ? "ON in /admin/risk" : "switched off"}`,
    executionEnabled: live,
    policyVersion: RISK_POLICY_VERSION,
  } as const;
}

/**
 * The owner's own controls, evaluated on their own (phase 25).
 *
 * Two things live here: the kill switches and the phase-25 caps. They are separated from
 * the rest of the policy because they are the limits the owner edits in `/admin/risk` and
 * expects to hold on *every* order path — the strategy loop, a manual submission, paper or
 * live. The order path's other rules (a declared stop-loss, an armed live key, verified
 * funds) belong to the armed path's own contract and are checked there.
 *
 * `reducing` is a close: it lowers exposure, and no cap here should trap it. The kill
 * switch is not a cap and is still honoured.
 */
function ownerLimitBreaches(
  input: RiskOrderInput,
  policy: AdjustableRiskPolicy,
  options: { reducing: boolean },
): { reasons: RiskRefusalReason[]; limits: RiskLimitBreach[] } {
  const reasons: RiskRefusalReason[] = [];
  const limits: RiskLimitBreach[] = [];
  const breach = (entry: RiskLimitBreach) => {
    reasons.push(entry.reason);
    limits.push(entry);
  };
  const notional = amount(input.requestedNotionalUsd);

  // Requirement 2: one global switch stops every strategy, and a per-strategy switch stops
  // only its own. Both are the same refusal, named with which one is engaged.
  if (RISK_POLICY.requireKillSwitchCheck && (input.killSwitchActive || policy.killSwitchActive || input.strategyKillSwitchActive === true)) {
    breach({
      reason: "kill-switch-active",
      limit: input.strategyKillSwitchActive === true ? "strategyKillSwitch" : "killSwitchActive",
      cap: null,
      observed: "engaged",
      scope: input.strategyKillSwitchActive === true ? "strategy" : "account",
    });
  }

  if (!options.reducing && notional && capIsSet(policy.maxOrderNotionalUsd)) {
    const cap = new Decimal(policy.maxOrderNotionalUsd);
    if (notional.greaterThan(cap)) {
      breach({ reason: "order-notional-exceeded", limit: "maxOrderNotionalUsd", cap: cap.toFixed(2), observed: notional.toFixed(2), scope: "order" });
    }
  }

  if (!options.reducing && notional && capIsSet(policy.maxStrategyNotionalUsd)) {
    const cap = new Decimal(policy.maxStrategyNotionalUsd);
    const strategyOpen = amount(input.strategyOpenNotionalUsd ?? "0");
    if (strategyOpen === null) {
      reasons.push("invalid-order-input");
    } else if (strategyOpen.plus(notional).greaterThan(cap)) {
      breach({
        reason: "strategy-notional-exceeded",
        limit: "maxStrategyNotionalUsd",
        cap: cap.toFixed(2),
        observed: strategyOpen.plus(notional).toFixed(2),
        scope: "strategy",
      });
    }
  }

  const openPositions = input.openPositionCount ?? 0;
  if (!options.reducing && Number.isInteger(policy.maxOpenPositions) && policy.maxOpenPositions > 0 && openPositions >= policy.maxOpenPositions) {
    breach({
      reason: "open-positions-exceeded",
      limit: "maxOpenPositions",
      cap: String(policy.maxOpenPositions),
      observed: String(openPositions),
      scope: "account",
    });
  }

  const intervalTrades = input.tradesInInterval ?? 0;
  if (!options.reducing && Number.isInteger(policy.maxTradesPerInterval) && policy.maxTradesPerInterval > 0 && intervalTrades >= policy.maxTradesPerInterval) {
    breach({
      reason: "interval-trade-count-exceeded",
      limit: "maxTradesPerInterval",
      cap: String(policy.maxTradesPerInterval),
      observed: String(intervalTrades),
      scope: "account",
    });
  }

  // An empty list means "every configured venue"; a list that is set refuses a venue it does
  // not name, including an unknown one — a check that cannot see its venue has not passed.
  if (policy.allowedVenues.length > 0 && !(input.venueId && policy.allowedVenues.includes(input.venueId))) {
    breach({
      reason: "venue-not-allowed",
      limit: "allowedVenues",
      cap: null,
      observed: input.venueId ?? "unknown",
      scope: "venue",
    });
  }

  const cooldownRemaining = input.cooldownRemainingMinutes ?? 0;
  if (!options.reducing && cooldownRemaining > 0) {
    breach({
      reason: "cooldown-active",
      limit: "cooldownMinutes",
      cap: String(policy.cooldownMinutes),
      observed: `${cooldownRemaining} min remaining`,
      scope: "account",
    });
  }

  return { reasons, limits };
}

/**
 * The owner's limits alone, for a path that has its own reasons to exist.
 *
 * A manual submission is not an armed strategy pass: it has no declared capital, no
 * stop-loss obligation and no per-strategy budget. Running the whole policy over it would
 * refuse ordinary paper orders for rules that were written for the armed path. What it
 * must still obey is the kill switches and every cap the owner set — so that is exactly
 * what this evaluates, on paper and live alike (requirement 6).
 */
export function evaluateOwnerLimits(
  input: RiskOrderInput,
  policy: AdjustableRiskPolicy,
): RiskDecision {
  const reducing = input.reducePosition === true;
  const { reasons, limits } = ownerLimitBreaches(input, policy, { reducing });
  return reasons.length > 0
    ? { decision: "REFUSE", policyVersion: RISK_POLICY_VERSION, reasons: [...new Set(reasons)], limits }
    : { decision: "ALLOW", policyVersion: RISK_POLICY_VERSION, reasons: [] };
}

export function evaluateRiskOrder(
  input: RiskOrderInput,
  policy: AdjustableRiskPolicy,
): RiskDecision {
  const reasons = new Set<RiskRefusalReason>();
  const paperMode = input.executionMode === "PAPER";
  const reducingPaperPosition = paperMode && input.reducePosition === true;
  const capital = amount(input.capitalUsd);
  const funds = amount(input.verifiedAvailableUsd);
  const notional = amount(input.requestedNotionalUsd);
  const maxLoss = amount(input.serverComputedMaxLossUsd);
  const openExposure = amount(input.currentOpenExposureUsd);
  const dailyLoss = amount(input.dailyLossUsd);
  const leverage = amount(input.leverage);
  const exposureSinceArm = amount(input.exposureSinceArmUsd);

  if (
    (input.capitalUsd !== null && capital === null) ||
    (input.verifiedAvailableUsd !== null && funds === null) ||
    [notional, maxLoss, openExposure, dailyLoss, leverage, exposureSinceArm].some((value) => value === null)
  ) {
    reasons.add("invalid-order-input");
  }
  if (paperMode && input.paperBotActive !== true) reasons.add("paper-bot-not-active");
  if (!paperMode && RISK_POLICY.requireApprovedVenue && !input.venueApproved) reasons.add("venue-not-approved");
  if (!paperMode && RISK_POLICY.requireLiveArm && !input.liveArmed) reasons.add("trading-not-armed");
  // The kill switches and the owner's caps are evaluated together, below.
  if (RISK_POLICY.requireAppendOnlyAudit && !input.auditAvailable) reasons.add("audit-unavailable");
  if (!reducingPaperPosition && RISK_POLICY.requireStopLoss && !input.hasValidStopLoss) reasons.add("stop-loss-required");
  if (!reducingPaperPosition && RISK_POLICY.requireMaximumLossBound && (!maxLoss || maxLoss.isZero())) reasons.add("invalid-order-input");
  if (
    RISK_POLICY.requirePerUserSymbolAllowList &&
    (!input.symbol || !input.allowedSymbols.includes(input.symbol) || !policy.approvedSymbols.includes(input.symbol))
  ) {
    reasons.add("symbol-not-allowed");
  }
  if (!Number.isSafeInteger(input.tradesToday) || input.tradesToday < 0) reasons.add("invalid-order-input");
  if (!reducingPaperPosition && input.tradesToday >= policy.maxTradesPerDay) reasons.add("trade-count-exceeded");

  if (!capital || capital.isZero()) reasons.add("capital-unconfigured");
  if (!paperMode && RISK_POLICY.requireVerifiedFunds && !funds) reasons.add("verified-funds-required");
  if (!paperMode && funds && funds.lessThan(policy.minimumVerifiedBalanceUsd)) reasons.add("minimum-balance-not-met");
  if (notional?.isZero() || maxLoss?.isZero() || leverage?.isZero()) reasons.add("invalid-order-input");
  if (!paperMode && funds && notional && notional.greaterThan(funds)) reasons.add("insufficient-verified-funds");
  if (!reducingPaperPosition && capital && maxLoss && maxLoss.greaterThan(capital.mul(policy.maxRiskPerTradePercent).div(100))) {
    reasons.add("per-trade-risk-exceeded");
  }
  if (!reducingPaperPosition && capital && openExposure && notional && openExposure.plus(notional).greaterThan(capital.mul(policy.maxOpenExposurePercent).div(100))) {
    reasons.add("open-exposure-exceeded");
  }
  if (!reducingPaperPosition && capital && dailyLoss && dailyLoss.greaterThanOrEqualTo(capital.mul(policy.dailyLossHaltPercent).div(100))) {
    reasons.add("daily-loss-halt");
  }
  if (leverage && leverage.greaterThan(policy.defaultMaxLeverage)) reasons.add("leverage-exceeded");
  if (!paperMode && input.first24HoursAfterArm && exposureSinceArm && notional && exposureSinceArm.plus(notional).greaterThan(policy.first24HourExposureUsd)) {
    reasons.add("first-day-exposure-exceeded");
  }

  // Phase 25: the owner's own caps and switches, with the value each saw.
  const owner = ownerLimitBreaches(input, policy, { reducing: reducingPaperPosition });
  for (const reason of owner.reasons) reasons.add(reason);

  const refusals = [...reasons];
  return refusals.length > 0
    ? { decision: "REFUSE", policyVersion: RISK_POLICY_VERSION, reasons: refusals, limits: owner.limits }
    : { decision: "ALLOW", policyVersion: RISK_POLICY_VERSION, reasons: [] };
}