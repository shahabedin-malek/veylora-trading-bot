import assert from "node:assert/strict";
import test from "node:test";
import {
  assertBotTransition,
  evaluateBacktestGate,
  IllegalBotTransitionError,
  transitionBotState,
  validateBotConfiguration,
  type BotConfiguration,
} from "@/lib/bot-builder/state-machine";
import type { BacktestResult } from "@/lib/backtesting/rsi-backtester";

const config: BotConfiguration = {
  name: "RSI daily",
  description: "Test strategy",
  symbol: "BTC-USD",
  schedule: "DAILY_CLOSE",
  budgetCapUsd: "10000",
  maxTradeSizeUsd: "2500",
  stopLossPercent: "4",
  dailyLossHaltPercent: "2",
  feeBps: "10",
  slippageBps: "5",
  buyRsiBelow: "30",
  sellRsiAbove: "70",
  maxDrawdownGatePercent: "20",
  minWinRateGatePercent: "40",
  minProfitFactorGate: "1.2",
};

const passingBacktest = {
  source: "coinbase-exchange",
  interval: "1d",
  barCount: 365,
  periodStart: "2025-10-14T00:00:00.000Z",
  periodEnd: "2026-10-14T00:00:00.000Z",
  maxDrawdownPercent: "12",
  winRatePercent: "55",
  profitFactor: "1.5",
} as BacktestResult;

test("bot configuration enforces budget, per-trade, stop-loss, and daily-loss caps", () => {
  assert.equal(validateBotConfiguration(config).valid, true);
  assert.equal(validateBotConfiguration({ ...config, maxTradeSizeUsd: "2501" }).valid, false);
  assert.equal(validateBotConfiguration({ ...config, stopLossPercent: "5" }).valid, false);
  assert.equal(validateBotConfiguration({ ...config, dailyLossHaltPercent: "2.01" }).valid, false);
  assert.equal(validateBotConfiguration({ ...config, budgetCapUsd: "19" }).valid, false);
});

test("paper transition requires a passing full-period backtest against user gates", () => {
  assert.deepEqual(evaluateBacktestGate(config, passingBacktest), { passed: true, reasons: [] });
  assert.deepEqual(transitionBotState("DRAFT", "PAPER", false), {
    allowed: false,
    code: "BACKTEST_NOT_PASSED",
    reason: "A passing full-period backtest is required before paper state.",
  });
  assert.deepEqual(transitionBotState("DRAFT", "PAPER", true), { allowed: true, status: "PAPER" });

  const failingBacktest = { ...passingBacktest, maxDrawdownPercent: "21" } as BacktestResult;
  const gate = evaluateBacktestGate(config, failingBacktest);
  assert.equal(gate.passed, false);
  assert.match(gate.reasons.join(" "), /drawdown/);
});

test("armed/live transitions are denied and killed strategies are terminal", () => {
  assert.equal(transitionBotState("PAPER", "ARMED", true).allowed, false);
  assert.equal(transitionBotState("PAPER", "LIVE", true).allowed, false);
  assert.equal(transitionBotState("DRAFT", "KILLED", false).allowed, true);
  assert.equal(transitionBotState("KILLED", "DRAFT", true).allowed, false);
});

test("a strategy move answers in the shared decision shape and throws when refused", () => {
  // Same shape as an order transition: `allowed`, then either `status` or
  // `code` + `reason`, so one caller handles both rulebooks.
  const refused = transitionBotState("PAPER", "ARMED", true);
  assert.equal(refused.allowed, false);
  assert.equal(refused.allowed === false && refused.code, "LIVE_PATH_INCOMPLETE");

  const terminal = transitionBotState("KILLED", "PAPER", true);
  assert.equal(terminal.allowed === false && terminal.code, "TERMINAL_STATE");

  assert.deepEqual(assertBotTransition("DRAFT", "PAPER", true), { allowed: true, status: "PAPER" });
  assert.throws(
    () => assertBotTransition("DRAFT", "PAPER", false),
    (error: unknown) =>
      error instanceof IllegalBotTransitionError &&
      error.code === "BACKTEST_NOT_PASSED" &&
      error.from === "DRAFT" &&
      error.to === "PAPER",
  );
});