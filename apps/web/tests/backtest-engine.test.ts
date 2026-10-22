import assert from "node:assert/strict";
import test from "node:test";
import type { MarketCandle } from "@/lib/market-data/provider";
import { defaultBacktestCosts, describeCosts, type BacktestCosts } from "@/lib/backtesting/costs";
import { runParameterSweep, runStrategyBacktest, validateInitialCapital } from "@/lib/backtesting/engine";
import type { StrategyDefinition } from "@/lib/strategies/definition";
import { validateStrategyDefinition } from "@/lib/strategies/validate";

/**
 * Phase 28's engine, graded on what its acceptance criteria demand:
 *
 *  - **Costs are applied to the trades, not to the total.** The sensitivity tests change the
 *    fee, the spread or the slippage and assert the result moves — which can only happen if
 *    each fill was priced with them.
 *  - **The metrics the phase names are all present**, including expectancy and the trade
 *    count, beside the assumptions that produced them.
 *  - **A sweep flags a winner and says what that is**, and every refusal names its reason.
 */

const NOW = new Date("2026-10-18T23:59:59.999Z");
const BACKTEST_NOW = new Date("2026-10-18T12:00:00.000Z");

function candles(count = 240, interval: MarketCandle["interval"] = "1d"): MarketCandle[] {
  const start = Date.parse("2026-02-20T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + 12 * Math.sin(index / 8);
    const openTime = new Date(start + index * 86_400_000);
    const closeTime = new Date(openTime.getTime() + 86_400_000);
    return {
      instrument: { id: "BTC-USD", symbol: "BTC-USD", baseAsset: "BTC", quoteAsset: "USD" },
      interval,
      openTime: openTime.toISOString(),
      closeTime: closeTime.toISOString(),
      open: String(close.toFixed(4)),
      high: String((close + 1).toFixed(4)),
      low: String((close - 1).toFixed(4)),
      close: String(close.toFixed(4)),
      volume: "100",
      provenance: {
        providerId: "coinbase-exchange",
        providerName: "Coinbase Exchange",
        endpointOrigin: "https://api.exchange.coinbase.com",
        observedAt: closeTime.toISOString(),
        fetchedAt: NOW.toISOString(),
        freshness: "DELAYED",
        responseHash: "fixture-only",
      },
    };
  });
}

const definition: StrategyDefinition = {
  name: "Range rider",
  market: "BTC-USD",
  timeframe: "1d",
  entry: { indicator: { type: "PRICE", period: null }, operator: "BELOW", threshold: "95" },
  exit: { indicator: { type: "PRICE", period: null }, operator: "ABOVE", threshold: "105" },
  sizePercent: "25",
  stopLossPercent: null,
  dailyLossHaltPercent: "20",
  leverage: 1,
};

function costs(overrides: Partial<BacktestCosts> = {}): BacktestCosts {
  return { ...defaultBacktestCosts(), ...overrides };
}

test("summary returns costed trades, expectancy, drawdown, win rate and a printed cost model", () => {
  const result = runStrategyBacktest({
    definition,
    candles: candles(),
    costs: costs({ feeBps: "10", spreadBps: "2", slippageBps: "5", fundingBpsPerDay: "0" }),
    initialCapitalUsd: "10000",
    now: BACKTEST_NOW,
  });

  assert.ok(result.metrics.tradeCount > 0, "the fixture produces trades");
  assert.ok(result.metrics.winRatePercent !== null);
  assert.ok(result.metrics.expectancyUsd !== null);
  assert.ok(Number.isFinite(Number(result.metrics.maxDrawdownPercent)));
  assert.equal(result.barCount, 240);
  assert.equal(result.symbol, "BTC-USD");

  const summed =
    Number(result.metrics.totalFeesUsd) +
    Number(result.metrics.totalSpreadUsd) +
    Number(result.metrics.totalSlippageUsd) +
    Number(result.metrics.totalFundingUsd);
  assert.ok(Math.abs(summed - Number(result.metrics.totalCostsUsd)) < 0.01, "costs add up");
  assert.ok(Number(result.metrics.totalFeesUsd) > 0);
  assert.ok(Number(result.metrics.totalSpreadUsd) > 0);
  assert.ok(Number(result.metrics.totalSlippageUsd) > 0);

  assert.ok(result.costAssumptions.some((line) => line.includes("Fee 10 bps per side")));
  assert.ok(result.costAssumptions.some((line) => line.includes("No funding is charged")));
  assert.ok(result.notes.some((note) => note.includes("not a promise") || note.includes("not an order")));
});

test("the same strategy returns less when the fee, the spread or the slippage changes", () => {
  const input = (cost: BacktestCosts) =>
    runStrategyBacktest({ definition, candles: candles(), costs: cost, initialCapitalUsd: "10000", now: BACKTEST_NOW });

  const cheapFee = input(costs({ feeBps: "10", spreadBps: "0", slippageBps: "0" }));
  const dearFee = input(costs({ feeBps: "120", spreadBps: "0", slippageBps: "0" }));
  assert.ok(Number(dearFee.metrics.finalCapitalUsd) < Number(cheapFee.metrics.finalCapitalUsd), "a higher fee costs more");
  assert.ok(Number(dearFee.metrics.totalFeesUsd) > Number(cheapFee.metrics.totalFeesUsd));

  const noCosts = input(costs({ feeBps: "0", spreadBps: "0", slippageBps: "0" }));
  const spread = input(costs({ feeBps: "0", spreadBps: "40", slippageBps: "0" }));
  const slippage = input(costs({ feeBps: "0", spreadBps: "0", slippageBps: "40" }));
  assert.ok(Number(spread.metrics.finalCapitalUsd) < Number(noCosts.metrics.finalCapitalUsd), "spread is paid");
  assert.ok(Number(slippage.metrics.finalCapitalUsd) < Number(noCosts.metrics.finalCapitalUsd), "slippage is paid");
  assert.ok(Number(spread.metrics.totalSpreadUsd) > 0);
  assert.equal(Number(spread.metrics.totalSlippageUsd), 0);
  assert.ok(Number(slippage.metrics.totalSlippageUsd) > 0);
  assert.equal(Number(slippage.metrics.totalSpreadUsd), 0);
});

test("a leveraged definition pays funding per day held and says so", () => {
  const leveraged = validateStrategyDefinition({
    ...definition,
    leverage: 3,
    stopLossPercent: "20",
  });
  assert.equal(leveraged.valid, true);
  if (!leveraged.valid) return;

  const paid = runStrategyBacktest({
    definition: leveraged.definition,
    candles: candles(),
    costs: costs({ feeBps: "0", spreadBps: "0", slippageBps: "0", fundingBpsPerDay: "25" }),
    initialCapitalUsd: "10000",
    now: BACKTEST_NOW,
  });
  assert.ok(Number(paid.metrics.totalFundingUsd) > 0, "funding is charged on a leveraged position");
  assert.ok(paid.costAssumptions.some((line) => line.includes("Funding 25 bps per day")));
  assert.ok(paid.notes.some((note) => note.includes("margin calls and liquidation are not modelled")));

  const spot = runStrategyBacktest({
    definition,
    candles: candles(),
    costs: costs({ feeBps: "0", spreadBps: "0", slippageBps: "0", fundingBpsPerDay: "25" }),
    initialCapitalUsd: "10000",
    now: BACKTEST_NOW,
  });
  assert.equal(Number(spot.metrics.totalFundingUsd), 0, "a 1x position funds nothing");
});

test("a sweep flags one best value and states that the winner is in-sample selection", () => {
  const sweep = runParameterSweep({
    definition,
    candles: candles(),
    costs: costs({ feeBps: "10", spreadBps: "2", slippageBps: "5" }),
    initialCapitalUsd: "10000",
    parameter: "ENTRY_THRESHOLD",
    values: ["88", "93", "98"],
    now: BACKTEST_NOW,
  });

  assert.equal(sweep.runs.length, 3);
  assert.equal(sweep.runs.filter((run) => run.isBest).length, 1);
  assert.ok(sweep.bestValue !== null && ["88", "93", "98"].includes(sweep.bestValue));
  assert.match(sweep.warning, /in-sample selection/);
  assert.match(sweep.parameterLabel, /Entry threshold/);
  assert.equal(new Set(sweep.runs.map((run) => run.metrics.totalReturnPercent)).size, 3, "each value produces its own result");

  assert.throws(
    () =>
      runParameterSweep({
        definition,
        candles: candles(),
        costs: costs(),
        initialCapitalUsd: "10000",
        parameter: "ENTRY_THRESHOLD",
        values: ["90"],
        now: BACKTEST_NOW,
      }),
    /INVALID_SWEEP/,
  );
});

test("an unreadable window or candle source is refused by name", () => {
  assert.throws(
    () => runStrategyBacktest({ definition, candles: candles(20), costs: costs(), initialCapitalUsd: "10000", now: BACKTEST_NOW }),
    /INSUFFICIENT_HISTORY/,
  );
  assert.throws(
    () => runStrategyBacktest({ definition, candles: candles(240, "1h"), costs: costs(), initialCapitalUsd: "10000", now: BACKTEST_NOW }),
    /INVALID_CANDLE_SOURCE/,
  );
  assert.equal(validateInitialCapital("10").valid, false);
  assert.equal(validateInitialCapital("10000").valid, true);
  assert.equal(validateInitialCapital("1e6").valid, false);
});

test("the cost descriptions name the fee-table provenance when a stored version supplied them", () => {
  const lines = describeCosts(
    costs({ feeBps: "10", spreadBps: "2", slippageBps: "5", source: "owner-fee-table", appliedFrom: "2026-09-01T00:00:00.000Z" }),
    { leverage: 1 },
  );
  assert.ok(lines.some((line) => line.includes("fee table version in force since 2026-09-01")));
  assert.ok(lines.some((line) => line.includes("not charges")));
});
