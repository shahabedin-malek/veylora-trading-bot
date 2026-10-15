import DecimalJS from "decimal.js";

const Decimal = DecimalJS.clone({ precision: 100 });

export const RISK_POLICY_VERSION = "veylora-risk-v1";

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
};

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
  | "paper-bot-not-active";

export type RiskDecision =
  | { decision: "ALLOW"; policyVersion: typeof RISK_POLICY_VERSION; reasons: [] }
  | { decision: "REFUSE"; policyVersion: typeof RISK_POLICY_VERSION; reasons: RiskRefusalReason[] };

function amount(value: string | null): InstanceType<typeof Decimal> | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const parsed = new Decimal(value);
  return parsed.isFinite() ? parsed : null;
}

export function getRiskControlsStatus(policy: AdjustableRiskPolicy) {
  return {
    status: "Connected",
    detail: `Admin policy loaded · ${policy.approvedSymbols.length} site symbols · ${policy.killSwitchActive ? "kill switch active" : "kill switch ready"} · order execution disabled`,
    executionEnabled: false,
    policyVersion: RISK_POLICY_VERSION,
  } as const;
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
  if (RISK_POLICY.requireKillSwitchCheck && (input.killSwitchActive || policy.killSwitchActive)) reasons.add("kill-switch-active");
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

  const refusals = [...reasons];
  return refusals.length > 0
    ? { decision: "REFUSE", policyVersion: RISK_POLICY_VERSION, reasons: refusals }
    : { decision: "ALLOW", policyVersion: RISK_POLICY_VERSION, reasons: [] };
}