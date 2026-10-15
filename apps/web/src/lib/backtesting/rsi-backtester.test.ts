import assert from "node:assert/strict";
import test from "node:test";
import type { MarketCandle } from "@/lib/market-data/provider";
import { runRsiBacktest, validateBacktestRequest } from "@/lib/backtesting/rsi-backtester";

const backtestNow = new Date("2026-10-15T23:59:59.999Z");

function historicalFixture(count = 366): MarketCandle[] {
  const start = Date.parse("2025-10-14T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const phase = index % 80;
    const close = phase < 40 ? 120 - phase : 80 + (phase - 40);
    const openTime = new Date(start + index * 86_400_000);
    const closeTime = new Date(openTime.getTime() + 86_400_000);
    return {
      instrument: { id: "BTC-USD", symbol: "BTC-USD", baseAsset: "BTC", quoteAsset: "USD" },
      interval: "1d",
      openTime: openTime.toISOString(),
      closeTime: closeTime.toISOString(),
      open: String(close),
      high: String(close + 1),
      low: String(close - 1),
      close: String(close),
      volume: "100",
      provenance: {
        providerId: "coinbase-exchange",
        providerName: "Coinbase Exchange",
        endpointOrigin: "https://api.exchange.coinbase.com",
        observedAt: closeTime.toISOString(),
        fetchedAt: backtestNow.toISOString(),
        freshness: "DELAYED",
        responseHash: "fixture-only",
      },
    };
  });
}

const request = {
  symbol: "BTC-USD",
  initialCapitalUsd: "10000",
  feeBps: "10",
  slippageBps: "5",
  buyRsiBelow: "30",
  sellRsiAbove: "70",
};

test("backtest requires explicit capital, fees, slippage, and valid strategy thresholds", () => {
  assert.equal(validateBacktestRequest(request).valid, true);
  assert.equal(validateBacktestRequest({ ...request, feeBps: "0" }).valid, false);
  assert.equal(validateBacktestRequest({ ...request, slippageBps: "0" }).valid, false);
  assert.equal(validateBacktestRequest({ ...request, buyRsiBelow: "80", sellRsiAbove: "20" }).valid, false);
  assert.equal(validateBacktestRequest({ ...request, from: "2026-01-01" }).valid, false);
});

test("backtest returns full-period equity, trade, fee, slippage, drawdown, win-rate, and profit-factor results", () => {
  const validation = validateBacktestRequest(request);
  assert.equal(validation.valid, true);
  if (!validation.valid) return;
  const result = runRsiBacktest(validation.value, historicalFixture(), backtestNow);

  assert.equal(result.source, "coinbase-exchange");
  assert.equal(result.interval, "1d");
  assert.ok(Date.parse(result.periodEnd) - Date.parse(result.periodStart) >= 330 * 86_400_000);
  assert.ok(result.barCount >= 300);
  assert.ok(result.equityCurve.length === result.barCount);
  assert.ok(result.trades.length > 0);
  const tradePnl = result.trades.reduce((total, trade) => total + Number(trade.pnlUsd), 0);
  assert.ok(Math.abs(Number(result.finalCapitalUsd) - Number(result.initialCapitalUsd) - tradePnl) < 0.02);
  assert.ok(Number(result.totalFeesUsd) > 0);
  assert.ok(Number(result.totalSlippageUsd) > 0);
  assert.ok(Number.isFinite(Number(result.maxDrawdownPercent)));
  assert.ok(result.winRatePercent !== null);
  assert.ok(result.profitFactor === null || Number.isFinite(Number(result.profitFactor)));
  assert.deepEqual(result.strategy.actions, [
    { conditionId: "entry", action: "BUY" },
    { conditionId: "exit", action: "SELL" },
  ]);
});

test("backtest rejects insufficient historical coverage rather than shortening the period", () => {
  const validation = validateBacktestRequest(request);
  assert.equal(validation.valid, true);
  if (!validation.valid) return;
  assert.throws(() => runRsiBacktest(validation.value, historicalFixture(180), backtestNow), /INSUFFICIENT_HISTORY/);
});

test("backtest applies the configured trade cap and stop-loss with an adverse gap fill", () => {
  const configured = validateBacktestRequest({
    ...request,
    maxTradeSizeUsd: "2500",
    stopLossPercent: "4",
    dailyLossHaltPercent: "2",
  });
  assert.equal(configured.valid, true);
  assert.equal(validateBacktestRequest({ ...request, maxTradeSizeUsd: "2501" }).valid, false);
  assert.equal(validateBacktestRequest({ ...request, maxTradeSizeUsd: "2500", stopLossPercent: "5" }).valid, false);
  assert.equal(validateBacktestRequest({ ...request, dailyLossHaltPercent: "2.01" }).valid, false);
  if (!configured.valid) return;

  const candles = historicalFixture();
  const baseline = runRsiBacktest(request, candles, backtestNow);
  const entryIndex = candles.findIndex(({ openTime }) => openTime === baseline.trades[0]?.entryAt);
  assert.ok(entryIndex >= 0 && entryIndex + 1 < candles.length);
  const gapDown = candles.map((candle, index) => index === entryIndex + 1 ? { ...candle, low: "1" } : candle);
  const result = runRsiBacktest(configured.value, gapDown, backtestNow);

  assert.equal(result.maxTradeSizeUsd, "2500");
  assert.equal(result.stopLossPercent, "4");
  assert.equal(result.dailyLossHaltPercent, "2");
  assert.equal(result.trades[0]?.exitReason, "STOP_LOSS");
  assert.ok(Number(result.trades[0]?.exitPrice) < Number(result.trades[0]?.entryPrice) * 0.96);
});