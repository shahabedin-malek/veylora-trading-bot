import DecimalJS from "decimal.js";
import {
  BACKTEST_MIN_CANDLE_COUNT,
  BACKTEST_MIN_COVERAGE_DAYS,
  type BacktestResult,
} from "@/lib/backtesting/rsi-backtester";
import type { TransitionDecision, TransitionRefusalCode } from "@/lib/orders/state-machine";
import { DEFAULT_RISK_POLICY } from "@/lib/risk-controls/policy";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";

const Decimal = DecimalJS.clone({ precision: 40 });
const MAX_CONFIGURED_BUDGET_USD = "1000000000";

export type BotState = "DRAFT" | "PAPER" | "ARMED" | "LIVE" | "KILLED";
export type BotSchedule = "DAILY_CLOSE";

/**
 * The smart-trading activation lifecycle (phase 23).
 *
 * Two different questions live here, and keeping them apart is the whole point:
 *
 *  - {@link StrategyActivationIntent} is what the **owner** asked for, stored on the
 *    activation row. It is only ever `RUNNING` or `STOPPED`, and a repeated start or stop
 *    leaves it unchanged rather than stacking another decision on top.
 *  - {@link StrategyRunState} is what the **system** observes right now: `running`, `idle`
 *    with a reason, `stopped`, or `error` from the last pass. An account can be running
 *    (intent) while idle (observation) because a venue key is missing — which is exactly
 *    the state the phase requires the panel to name rather than hide behind "off".
 *
 * The bot builder's DRAFT/PAPER/ARMED/LIVE/KILLED states remain the per-bot lifecycle;
 * this is the account-level switch that starts and stops the automation itself.
 */
export type StrategyActivationIntent = "RUNNING" | "STOPPED";
export type StrategyRunState = "running" | "idle" | "stopped" | "error";

export const STRATEGY_ACTIVATION_INTENTS: readonly StrategyActivationIntent[] = ["RUNNING", "STOPPED"];
export const STRATEGY_RUN_STATES: readonly StrategyRunState[] = ["running", "idle", "stopped", "error"];

export function isStrategyActivationIntent(value: unknown): value is StrategyActivationIntent {
  return value === "RUNNING" || value === "STOPPED";
}

export function isStrategyRunState(value: unknown): value is StrategyRunState {
  return typeof value === "string" && (STRATEGY_RUN_STATES as readonly string[]).includes(value);
}

/**
 * Which of the four states the account is in, from the two facts that decide it.
 *
 * A blocker outranks a failed last pass because the blocker is the actionable thing: a
 * pass that failed because there is no venue key will fail again until a key is added, so
 * "idle — no venue connected" is the honest label. An error is shown only when the last
 * pass itself failed for a reason the configuration list does not explain.
 */
export function evaluateStrategyRunState(input: {
  intent: StrategyActivationIntent | null;
  blockerCount: number;
  lastOutcome: "running" | "idle" | "error" | null;
}): StrategyRunState {
  if (input.intent !== "RUNNING") return "stopped";
  if (input.blockerCount > 0) return "idle";
  if (input.lastOutcome === "error") return "error";
  return "running";
}

export type BotConfiguration = {
  name: string;
  description: string;
  symbol: string;
  schedule: BotSchedule;
  budgetCapUsd: string;
  maxTradeSizeUsd: string;
  stopLossPercent: string;
  dailyLossHaltPercent: string;
  feeBps: string;
  slippageBps: string;
  buyRsiBelow: string;
  sellRsiAbove: string;
  maxDrawdownGatePercent: string;
  minWinRateGatePercent: string;
  minProfitFactorGate: string;
};

export type BotConfigurationValidation =
  | { valid: true; value: BotConfiguration }
  | { valid: false; error: string };

export type BacktestGateResult = { passed: boolean; reasons: string[] };

/**
 * Bot-specific refusal codes, on top of the shared ones.
 *
 * A strategy's transition and an order's transition are different rulebooks, but
 * they answer the same question — "may this move happen, and if not, why not?" —
 * and they answer it in the same shape (`TransitionDecision` from
 * `src/lib/orders/state-machine.ts`). A caller that handles one handles the
 * other: read `allowed`, then either the `status` to move to or the `code` and
 * `reason` that explain the refusal. Nothing here is a permission to be granted —
 * every refusal names a piece of work that is not written yet (see
 * {@link LIVE_PATH_REQUIREMENTS}).
 */
export type BotRefusalCode = TransitionRefusalCode | "BACKTEST_NOT_PASSED" | "LIVE_PATH_INCOMPLETE";

export type BotTransition =
  | { allowed: true; status: BotState }
  | { allowed: false; code: BotRefusalCode; reason: string };

// What the live path still lacks. Each line is a piece of work that is not written yet,
// not a permission anyone has to grant: ARMED and LIVE reject transitions while this list
// is non-empty, and the same list is what the bot builder shows.
export const LIVE_PATH_REQUIREMENTS = [
  "Live venue, chain, RPC endpoint, and token/contract allow-list: not configured.",
  "Live order path: not written. The evaluator returns ALLOW or REFUSE and submits nothing.",
  "Integer-cent ledger and append-only audit: wired for paper accounting only.",
  "Wallet signing of order intents and a live verified-funds check: not implemented.",
  "Kill switch: refuses order intents; a live order path still has to honour it.",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}

export function validateBotConfiguration(value: unknown): BotConfigurationValidation {
  const keys = [
    "name", "description", "symbol", "schedule", "budgetCapUsd", "maxTradeSizeUsd", "stopLossPercent",
    "dailyLossHaltPercent", "feeBps", "slippageBps", "buyRsiBelow", "sellRsiAbove",
    "maxDrawdownGatePercent", "minWinRateGatePercent", "minProfitFactorGate",
  ];
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    return { valid: false, error: "Every strategy field and backtest pass threshold is required." };
  }
  if (typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > 64) {
    return { valid: false, error: "Name must be 1–64 characters." };
  }
  if (typeof value.description !== "string" || value.description.trim().length > 280) {
    return { valid: false, error: "Description must be at most 280 characters." };
  }
  if (typeof value.symbol !== "string" || !USD_WATCHLIST.some(({ productId }) => productId === value.symbol)) {
    return { valid: false, error: "Choose a supported Coinbase USD market." };
  }
  if (value.schedule !== "DAILY_CLOSE") return { valid: false, error: "Only the backtested daily-close schedule is available." };

  const numericKeys = keys.filter((key) => !["name", "description", "symbol", "schedule"].includes(key));
  if (numericKeys.some((key) => !isDecimal(value[key]))) return { valid: false, error: "All risk, cost, and gate values must be plain decimals." };

  const budget = new Decimal(value.budgetCapUsd as string);
  const maxTrade = new Decimal(value.maxTradeSizeUsd as string);
  const stopLossPercent = new Decimal(value.stopLossPercent as string);
  const dailyHaltPercent = new Decimal(value.dailyLossHaltPercent as string);
  const entry = new Decimal(value.buyRsiBelow as string);
  const exit = new Decimal(value.sellRsiAbove as string);
  const feeBps = new Decimal(value.feeBps as string);
  const slippageBps = new Decimal(value.slippageBps as string);
  const maxDrawdownGate = new Decimal(value.maxDrawdownGatePercent as string);
  const minWinRateGate = new Decimal(value.minWinRateGatePercent as string);
  const minProfitFactorGate = new Decimal(value.minProfitFactorGate as string);

  if (!budget.isFinite() || budget.lessThan(20) || budget.greaterThan(MAX_CONFIGURED_BUDGET_USD)) {
    return { valid: false, error: "Bot budget must be from USD 20 to USD 1,000,000,000." };
  }
  if (!maxTrade.isFinite() || maxTrade.lte(0) || maxTrade.greaterThan(budget.mul(DEFAULT_RISK_POLICY.maxOpenExposurePercent).div(100))) {
    return { valid: false, error: `Per-trade size cannot exceed ${DEFAULT_RISK_POLICY.maxOpenExposurePercent}% of the bot budget.` };
  }
  if (!stopLossPercent.isFinite() || stopLossPercent.lte(0) || stopLossPercent.gt(100) ||
    maxTrade.mul(stopLossPercent).div(100).greaterThan(budget.mul(DEFAULT_RISK_POLICY.maxRiskPerTradePercent).div(100))) {
    return { valid: false, error: "Stop-loss risk must be positive and keep max trade loss within the 1% per-trade cap." };
  }
  if (!dailyHaltPercent.isFinite() || dailyHaltPercent.lte(0) || dailyHaltPercent.gt(DEFAULT_RISK_POLICY.dailyLossHaltPercent)) {
    return { valid: false, error: "Daily-loss halt must be positive and no higher than the 2% policy cap." };
  }
  if (!feeBps.isFinite() || feeBps.lte(0) || feeBps.gt(500) || !slippageBps.isFinite() || slippageBps.lte(0) || slippageBps.gt(1000)) {
    return { valid: false, error: "Fee and slippage assumptions must be positive and within the backtester bounds." };
  }
  if (!entry.isFinite() || entry.lt(0) || entry.gte(50) || !exit.isFinite() || exit.lte(50) || exit.gt(100) || !entry.lt(exit)) {
    return { valid: false, error: "RSI entry must be below 50 and exit above 50." };
  }
  if (!maxDrawdownGate.isFinite() || maxDrawdownGate.lte(0) || maxDrawdownGate.gt(100) ||
    !minWinRateGate.isFinite() || minWinRateGate.lt(0) || minWinRateGate.gt(100) ||
    !minProfitFactorGate.isFinite() || minProfitFactorGate.lte(0) || minProfitFactorGate.gt(100)) {
    return { valid: false, error: "Set valid drawdown, win-rate, and profit-factor pass thresholds." };
  }

  return {
    valid: true,
    value: {
      name: value.name.trim(),
      description: value.description.trim(),
      symbol: value.symbol,
      schedule: "DAILY_CLOSE",
      budgetCapUsd: budget.toFixed(),
      maxTradeSizeUsd: maxTrade.toFixed(),
      stopLossPercent: stopLossPercent.toFixed(),
      dailyLossHaltPercent: dailyHaltPercent.toFixed(),
      feeBps: feeBps.toFixed(),
      slippageBps: slippageBps.toFixed(),
      buyRsiBelow: entry.toFixed(),
      sellRsiAbove: exit.toFixed(),
      maxDrawdownGatePercent: maxDrawdownGate.toFixed(),
      minWinRateGatePercent: minWinRateGate.toFixed(),
      minProfitFactorGate: minProfitFactorGate.toFixed(),
    },
  };
}

export function evaluateBacktestGate(config: BotConfiguration, result: BacktestResult): BacktestGateResult {
  const reasons: string[] = [];
  const coverageDays = (Date.parse(result.periodEnd) - Date.parse(result.periodStart)) / 86_400_000;
  if (result.source !== "coinbase-exchange" || result.interval !== "1d" || result.barCount < BACKTEST_MIN_CANDLE_COUNT || coverageDays < BACKTEST_MIN_COVERAGE_DAYS) {
    reasons.push("Complete full-period Coinbase daily history is required.");
  }
  const maxDrawdown = Number(result.maxDrawdownPercent);
  const winRate = result.winRatePercent === null ? Number.NaN : Number(result.winRatePercent);
  const profitFactor = result.profitFactor === null ? Number.NaN : Number(result.profitFactor);
  if (!Number.isFinite(maxDrawdown) || maxDrawdown > Number(config.maxDrawdownGatePercent)) reasons.push("Maximum drawdown did not meet the user-set gate.");
  if (!Number.isFinite(winRate) || winRate < Number(config.minWinRateGatePercent)) reasons.push("Win rate did not meet the user-set gate or there were no closed trades.");
  if (!Number.isFinite(profitFactor) || profitFactor < Number(config.minProfitFactorGate)) reasons.push("Profit factor did not meet the user-set gate or is unavailable.");
  return { passed: reasons.length === 0, reasons };
}

/**
 * Decide whether a strategy may move, without performing the move. Pure, like the
 * order machine's equivalent: the same question can be asked by the panel that
 * renders the button, by the route that would apply it and by a unit test, and all
 * three get one answer.
 */
export function evaluateBotTransition(state: BotState, nextState: BotState, backtestPassed: boolean): BotTransition {
  if (state === "KILLED") {
    return { allowed: false, code: "TERMINAL_STATE", reason: "KILLED is terminal, so it cannot be left." };
  }
  if (nextState === "KILLED") return { allowed: true, status: "KILLED" };
  if (state === "DRAFT" && nextState === "PAPER") {
    return backtestPassed
      ? { allowed: true, status: "PAPER" }
      : {
          allowed: false,
          code: "BACKTEST_NOT_PASSED",
          reason: "A passing full-period backtest is required before paper state.",
        };
  }
  if (nextState === "ARMED" || nextState === "LIVE") {
    return { allowed: false, code: "LIVE_PATH_INCOMPLETE", reason: LIVE_PATH_REQUIREMENTS.join(" ") };
  }
  return { allowed: false, code: "NOT_ALLOWED", reason: `Transition ${state} → ${nextState} is not allowed.` };
}

/**
 * The same decision, named for the callers that already use it. Kept so the
 * promotion path and the panel keep one implementation of the rule.
 */
export function transitionBotState(state: BotState, nextState: BotState, backtestPassed: boolean): BotTransition {
  return evaluateBotTransition(state, nextState, backtestPassed);
}

/** A strategy move the lifecycle does not allow, thrown instead of silently ignored. */
export class IllegalBotTransitionError extends Error {
  readonly code: BotRefusalCode;
  readonly from: BotState;
  readonly to: BotState;

  constructor(input: { code: BotRefusalCode; from: BotState; to: BotState; reason: string }) {
    super(input.reason);
    this.name = "IllegalBotTransitionError";
    this.code = input.code;
    this.from = input.from;
    this.to = input.to;
  }
}

/**
 * Apply a strategy move, or throw.
 *
 * A caller about to change something uses this **before** the change: a refusal
 * here means nothing was activated, killed or written. The same `code` and
 * `reason` the panel would show come back on the error, so a route can answer
 * with them instead of re-deriving the sentence.
 */
export function assertBotTransition(
  state: BotState,
  nextState: BotState,
  backtestPassed: boolean,
): Extract<BotTransition, { allowed: true }> {
  const decision = evaluateBotTransition(state, nextState, backtestPassed);
  if (!decision.allowed) {
    throw new IllegalBotTransitionError({ code: decision.code, from: state, to: nextState, reason: decision.reason });
  }
  return decision;
}

/** Re-exported so a caller can branch on the shared decision shape without a second import. */
export type { TransitionDecision };