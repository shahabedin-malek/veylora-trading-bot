import DecimalJS from "decimal.js";
import { calculateRsi } from "@/lib/market-data/indicators";
import type { MarketCandle } from "@/lib/market-data/provider";
import type { StrategyCondition, StrategyDefinition, StrategyIndicator } from "@/lib/strategies/definition";
import { renderStrategyText } from "@/lib/strategies/definition";
import { validateStrategyDefinition, isDecimalText } from "@/lib/strategies/validate";
import { describeCosts, type BacktestCosts } from "./costs";

/**
 * The general backtest engine: a definition in, costed trades and honest metrics out.
 *
 * It extends the phase-24 RSI backtester into something that can run any definition the
 * owner can write, while keeping the properties that made that one trustworthy:
 *
 *  - **Costs are applied per fill, not deducted at the end.** The entry pays the fee on its
 *    own notional and fills above the reference close by the spread and slippage; the exit
 *    does the mirror. So a run whose fee changes produces a *different* trade list, not the
 *    same list with a smaller total — which is what makes the cost-sensitivity test a real
 *    test rather than an arithmetic check.
 *  - **Metrics are reported with the cost assumptions.** Win rate, drawdown, expectancy and
 *    the trade count are returned beside the fee, spread, slippage and funding that were
 *    applied, and the result carries the same lines the panel prints.
 *  - **Nothing is fitted.** The engine evaluates one definition over one window it is
 *    given. A sweep runs the same engine per value and says, in the result, that the winner
 *    is in-sample selection.
 *
 * The one deliberate simplification: a leveraged notional is still fully funded from cash.
 * Leverage scales the *target* exposure and turns funding on; it does not model margin
 * calls, liquidation or borrowing limits, because doing so convincingly needs intraday
 * data this build does not have. The notes say so.
 */

const Decimal = DecimalJS.clone({ precision: 50 });

export const BACKTEST_MIN_BARS = 30;

export type BacktestTrade = {
  entryAt: string;
  exitAt: string;
  /** The close the fill was priced from. */
  entryReferencePrice: string;
  entryFillPrice: string;
  exitReferencePrice: string;
  exitFillPrice: string;
  quantity: string;
  feesUsd: string;
  spreadUsd: string;
  slippageUsd: string;
  fundingUsd: string;
  pnlUsd: string;
  pnlPercent: string;
  exitReason: "EXIT_CONDITION" | "STOP_LOSS" | "END_OF_PERIOD";
};

export type EquityPoint = { time: string; equityUsd: string };

export type BacktestMetrics = {
  finalCapitalUsd: string;
  totalReturnPercent: string;
  maxDrawdownPercent: string;
  peakEquityUsd: string;
  winRatePercent: string | null;
  expectancyUsd: string | null;
  profitFactor: string | null;
  tradeCount: number;
  losingTradeCount: number;
  totalFeesUsd: string;
  totalSpreadUsd: string;
  totalSlippageUsd: string;
  totalFundingUsd: string;
  totalCostsUsd: string;
};

export type BacktestResult = {
  symbol: string;
  interval: "1d";
  timeframe: string;
  definition: StrategyDefinition;
  definitionText: string;
  periodStart: string;
  periodEnd: string;
  barCount: number;
  initialCapitalUsd: string;
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  costs: BacktestCosts;
  costAssumptions: string[];
  notes: string[];
};

export type CapitalValidation = { valid: true; value: string } | { valid: false; error: string };

export function validateInitialCapital(value: unknown): CapitalValidation {
  if (!isDecimalText(value)) return { valid: false, error: "Starting capital must be a plain decimal, for example 10000." };
  const capital = new Decimal(value as string);
  if (!capital.isFinite() || capital.lessThan(20) || capital.greaterThan("1000000000")) {
    return { valid: false, error: "Starting capital must be between USD 20 and USD 1,000,000,000." };
  }
  return { valid: true, value: capital.toFixed() };
}

function validateCandles(candles: readonly MarketCandle[], timeframe: string, now: Date): MarketCandle[] {
  const ordered = [...candles].sort((left, right) => Date.parse(left.openTime) - Date.parse(right.openTime));
  const complete = ordered.filter((candle) => Date.parse(candle.closeTime) <= now.getTime());
  if (complete.length < BACKTEST_MIN_BARS) throw new Error("INSUFFICIENT_HISTORY");
  if (complete.some((candle) => candle.interval !== timeframe || candle.provenance.providerId !== "coinbase-exchange")) {
    throw new Error("INVALID_CANDLE_SOURCE");
  }
  const invalid = complete.some((candle) => {
    try {
      const open = new Decimal(candle.open);
      const high = new Decimal(candle.high);
      const low = new Decimal(candle.low);
      const close = new Decimal(candle.close);
      return [open, high, low, close].some((number) => !number.isFinite() || number.lte(0)) || high.lt(low);
    } catch {
      return true;
    }
  });
  if (invalid) throw new Error("INVALID_CANDLE_DATA");
  return complete;
}

// ─────────────────────────────────────────────────────────────────────────────
// Indicators and conditions
// ─────────────────────────────────────────────────────────────────────────────

function smaSeries(closes: readonly number[], period: number): (number | null)[] {
  const series: (number | null)[] = [];
  let sum = 0;
  for (let index = 0; index < closes.length; index += 1) {
    sum += closes[index]!;
    if (index >= period) sum -= closes[index - period]!;
    series.push(index >= period - 1 ? sum / period : null);
  }
  return series;
}

function emaSeries(closes: readonly number[], period: number): (number | null)[] {
  const series: (number | null)[] = [];
  const multiplier = 2 / (period + 1);
  let previous: number | null = null;
  for (let index = 0; index < closes.length; index += 1) {
    const close = closes[index]!;
    if (index < period - 1) {
      series.push(null);
      continue;
    }
    if (previous === null) {
      const seed = closes.slice(0, period).reduce((total, value) => total + value, 0) / period;
      previous = seed;
    } else {
      previous = (close - previous) * multiplier + previous;
    }
    series.push(previous);
  }
  return series;
}

export function indicatorSeries(indicator: StrategyIndicator, closes: readonly number[]): (number | null)[] {
  if (indicator.type === "PRICE") return closes.map((close) => close);
  const period = indicator.period ?? 14;
  if (indicator.type === "SMA") return smaSeries(closes, period);
  if (indicator.type === "EMA") return emaSeries(closes, period);
  return closes.map((_, index) => calculateRsi(closes.slice(0, index + 1), period));
}

export function conditionMet(
  condition: StrategyCondition,
  series: readonly (number | null)[],
  index: number,
): boolean {
  const current = series[index];
  if (current === null || current === undefined) return false;
  const threshold = Number(condition.threshold);
  switch (condition.operator) {
    case "BELOW":
      return current < threshold;
    case "ABOVE":
      return current > threshold;
    case "CROSS_BELOW": {
      const previous = index > 0 ? series[index - 1] : null;
      return previous !== null && previous !== undefined && previous > threshold && current <= threshold;
    }
    case "CROSS_ABOVE": {
      const previous = index > 0 ? series[index - 1] : null;
      return previous !== null && previous !== undefined && previous < threshold && current >= threshold;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────

export type BacktestInput = {
  definition: StrategyDefinition;
  candles: readonly MarketCandle[];
  costs: BacktestCosts;
  initialCapitalUsd: string;
  now?: Date;
};

export function runStrategyBacktest(input: BacktestInput): BacktestResult {
  const now = input.now ?? new Date();
  const validation = validateStrategyDefinition(input.definition);
  if (!validation.valid) throw new Error(`INVALID_DEFINITION: ${validation.issues.join(" ")}`);
  const definition = validation.definition;
  const capitalCheck = validateInitialCapital(input.initialCapitalUsd);
  if (!capitalCheck.valid) throw new Error(`INVALID_CAPITAL: ${capitalCheck.error}`);

  const candles = validateCandles(input.candles, definition.timeframe, now);
  const closes = candles.map(({ close }) => Number(close));
  if (closes.some((close) => !Number.isFinite(close) || close <= 0)) throw new Error("INVALID_CANDLE_DATA");

  const entrySeries = indicatorSeries(definition.entry.indicator, closes);
  const exitSeries = indicatorSeries(definition.exit.indicator, closes);
  // Both rules can watch the same indicator; computing twice is cheap and keeps the
  // condition function free of the assumption that they do.
  const add = (condition: StrategyCondition, series: readonly (number | null)[], index: number) =>
    conditionMet(condition, series, index);

  const capital = new Decimal(capitalCheck.value);
  const feeRate = new Decimal(input.costs.feeBps).div(10_000);
  const spreadRate = new Decimal(input.costs.spreadBps).div(10_000);
  const slippageRate = new Decimal(input.costs.slippageBps).div(10_000);
  // Funding is a borrow cost: a 1x position borrows nothing, so the configured rate is
  // applied only when the definition is leveraged. The result's notes say which it was.
  const fundingRate = new Decimal(definition.leverage > 1 ? input.costs.fundingBpsPerDay : "0").div(10_000);
  const sizeRate = new Decimal(definition.sizePercent).div(100);
  const stopPercent = definition.stopLossPercent === null ? null : new Decimal(definition.stopLossPercent);
  const haltPercent = new Decimal(definition.dailyLossHaltPercent).div(100);
  const leverage = new Decimal(definition.leverage);

  let cash = capital;
  let quantity = new Decimal(0);
  let entryAt = "";
  let entryReference = new Decimal(0);
  let entryFill = new Decimal(0);
  let entryCost = new Decimal(0);
  let entryFee = new Decimal(0);
  let entrySpread = new Decimal(0);
  let entrySlippage = new Decimal(0);
  let daysHeld = 0;
  const totals = {
    fees: new Decimal(0),
    spread: new Decimal(0),
    slippage: new Decimal(0),
    funding: new Decimal(0),
  };
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  let currentDay = "";
  let dayStartEquity = capital;
  let haltedDay = false;

  const closeTrade = (index: number, exitReason: BacktestTrade["exitReason"], referenceOverride?: string) => {
    const reference = new Decimal(referenceOverride ?? candles[index]!.close);
    const fill = reference.times(new Decimal(1).minus(spreadRate).minus(slippageRate));
    const proceeds = quantity.times(fill);
    const exitFee = proceeds.times(feeRate);
    const exitSpread = reference.times(spreadRate).times(quantity);
    const exitSlippage = reference.times(slippageRate).times(quantity);
    const fundingUsd = entryReference.times(quantity).times(fundingRate).times(Math.max(1, daysHeld));
    const pnl = proceeds.minus(exitFee).minus(fundingUsd).minus(entryCost);
    cash = cash.plus(proceeds).minus(exitFee).minus(fundingUsd);
    totals.fees = totals.fees.plus(entryFee).plus(exitFee);
    totals.spread = totals.spread.plus(entrySpread).plus(exitSpread);
    totals.slippage = totals.slippage.plus(entrySlippage).plus(exitSlippage);
    totals.funding = totals.funding.plus(fundingUsd);
    trades.push({
      entryAt,
      exitAt: candles[index]!.closeTime,
      entryReferencePrice: entryReference.toFixed(),
      entryFillPrice: entryFill.toFixed(),
      exitReferencePrice: reference.toFixed(),
      exitFillPrice: fill.toFixed(),
      quantity: quantity.toFixed(),
      feesUsd: entryFee.plus(exitFee).toFixed(),
      spreadUsd: entrySpread.plus(exitSpread).toFixed(),
      slippageUsd: entrySlippage.plus(exitSlippage).toFixed(),
      fundingUsd: fundingUsd.toFixed(),
      pnlUsd: pnl.toFixed(),
      pnlPercent: entryCost.isZero() ? "0" : pnl.div(entryCost).times(100).toDecimalPlaces(4).toFixed(4),
      exitReason,
    });
    quantity = new Decimal(0);
    entryCost = new Decimal(0);
    entryFee = new Decimal(0);
    entrySpread = new Decimal(0);
    entrySlippage = new Decimal(0);
    daysHeld = 0;
  };

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]!;
    const day = candle.openTime.slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      dayStartEquity = index === 0 ? capital : new Decimal(equityCurve.at(-1)?.equityUsd ?? capital.toFixed());
      haltedDay = false;
    }
    const reference = new Decimal(candle.close);

    if (!quantity.isZero()) daysHeld += 1;

    if (!quantity.isZero() && stopPercent) {
      const stopPrice = entryFill.times(new Decimal(100).minus(stopPercent).div(100));
      const low = new Decimal(candle.low);
      if (low.lte(stopPrice)) {
        const open = new Decimal(candle.open);
        const gapReference = open.lt(stopPrice) ? open : stopPrice;
        closeTrade(index, "STOP_LOSS", gapReference.toFixed());
      }
    }

    const lowMarkEquity = cash.plus(quantity.times(new Decimal(candle.low)));
    if (dayStartEquity.minus(lowMarkEquity).gte(dayStartEquity.times(haltPercent))) haltedDay = true;

    if (quantity.isZero() && !haltedDay && add(definition.entry, entrySeries, index)) {
      const equity = cash;
      const target = equity.times(sizeRate).times(leverage);
      const affordable = cash.div(new Decimal(1).plus(feeRate));
      const notional = Decimal.min(target, affordable);
      if (notional.gt(0)) {
        const fill = reference.times(new Decimal(1).plus(spreadRate).plus(slippageRate));
        quantity = notional.div(fill);
        const traded = quantity.times(fill);
        entryFee = traded.times(feeRate);
        entrySpread = reference.times(spreadRate).times(quantity);
        entrySlippage = reference.times(slippageRate).times(quantity);
        entryCost = traded.plus(entryFee);
        entryAt = candle.openTime;
        entryReference = reference;
        entryFill = fill;
        daysHeld = 0;
        cash = cash.minus(entryCost);
      }
    } else if (!quantity.isZero() && add(definition.exit, exitSeries, index)) {
      closeTrade(index, "EXIT_CONDITION");
    }

    const equity = cash.plus(quantity.times(reference));
    equityCurve.push({ time: candle.closeTime, equityUsd: equity.toFixed() });
    if (dayStartEquity.minus(equity).gte(dayStartEquity.times(haltPercent))) haltedDay = true;
  }

  if (!quantity.isZero()) {
    closeTrade(candles.length - 1, "END_OF_PERIOD");
    equityCurve[equityCurve.length - 1] = { time: candles.at(-1)!.closeTime, equityUsd: cash.toFixed() };
  }

  let peak = capital;
  let peakEquity = capital;
  let maxDrawdown = new Decimal(0);
  for (const point of equityCurve) {
    const equity = new Decimal(point.equityUsd);
    if (equity.gt(peak)) peak = equity;
    if (equity.gt(peakEquity)) peakEquity = equity;
    if (peak.gt(0)) {
      const drawdown = peak.minus(equity).div(peak).times(100);
      if (drawdown.gt(maxDrawdown)) maxDrawdown = drawdown;
    }
  }

  const winners = trades.filter((trade) => new Decimal(trade.pnlUsd).gt(0));
  const losers = trades.filter((trade) => new Decimal(trade.pnlUsd).lt(0));
  const grossWins = winners.reduce((total, trade) => total.plus(trade.pnlUsd), new Decimal(0));
  const grossLosses = losers.reduce((total, trade) => total.plus(new Decimal(trade.pnlUsd).abs()), new Decimal(0));
  const finalCapital = cash;
  const totalCosts = totals.fees.plus(totals.spread).plus(totals.slippage).plus(totals.funding);

  const metrics: BacktestMetrics = {
    finalCapitalUsd: finalCapital.toFixed(),
    totalReturnPercent: finalCapital.minus(capital).div(capital).times(100).toDecimalPlaces(4).toFixed(4),
    maxDrawdownPercent: maxDrawdown.toDecimalPlaces(4).toFixed(4),
    peakEquityUsd: peakEquity.toFixed(),
    winRatePercent: trades.length > 0 ? new Decimal(winners.length).div(trades.length).times(100).toDecimalPlaces(2).toFixed(2) : null,
    expectancyUsd:
      trades.length > 0
        ? trades.reduce((total, trade) => total.plus(trade.pnlUsd), new Decimal(0)).div(trades.length).toFixed(2)
        : null,
    profitFactor: grossLosses.isZero() ? null : grossWins.div(grossLosses).toDecimalPlaces(4).toFixed(4),
    tradeCount: trades.length,
    losingTradeCount: losers.length,
    totalFeesUsd: totals.fees.toFixed(),
    totalSpreadUsd: totals.spread.toFixed(),
    totalSlippageUsd: totals.slippage.toFixed(),
    totalFundingUsd: totals.funding.toFixed(),
    totalCostsUsd: totalCosts.toFixed(),
  };

  const costAssumptions = describeCosts(input.costs, { leverage: definition.leverage });

  return {
    symbol: definition.market,
    interval: "1d",
    timeframe: definition.timeframe,
    definition,
    definitionText: renderStrategyText(definition),
    periodStart: candles[0]!.openTime,
    periodEnd: candles.at(-1)!.closeTime,
    barCount: candles.length,
    initialCapitalUsd: capital.toFixed(),
    metrics,
    trades,
    equityCurve,
    costs: input.costs,
    costAssumptions,
    notes: [
      `Costs applied per fill: ${Number(input.costs.feeBps)} bps fee, ${Number(input.costs.spreadBps)} bps spread and ${Number(input.costs.slippageBps)} bps slippage against the position on each side.`,
      definition.leverage > 1
        ? `Leverage ${definition.leverage}x scales the target exposure and charges funding per day held. The notional is still fully funded from cash: margin calls and liquidation are not modelled.`
        : "The position is 1x, so no funding is charged and no borrowing is modelled.",
      "Daily candles cannot model the intraday path of a position; a stop fills at the daily open when it gaps through the stop price.",
      "Open positions are closed at the final historical close and pay the exit costs like any other exit.",
      "Results are historical analysis of one window, not an order and not a promise of future returns.",
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter sweeps
// ─────────────────────────────────────────────────────────────────────────────

export const SWEEP_PARAMETERS = ["ENTRY_THRESHOLD", "EXIT_THRESHOLD", "SIZE_PERCENT", "STOP_PERCENT"] as const;
export type SweepParameter = (typeof SWEEP_PARAMETERS)[number];

export const SWEEP_PARAMETER_LABELS: Record<SweepParameter, string> = {
  ENTRY_THRESHOLD: "Entry threshold",
  EXIT_THRESHOLD: "Exit threshold",
  SIZE_PERCENT: "Size (% of equity)",
  STOP_PERCENT: "Stop-loss (%)",
};

export const MAX_SWEEP_VALUES = 8;

export function applySweepValue(
  definition: StrategyDefinition,
  parameter: SweepParameter,
  value: string,
): StrategyDefinition {
  switch (parameter) {
    case "ENTRY_THRESHOLD":
      return { ...definition, entry: { ...definition.entry, threshold: value } };
    case "EXIT_THRESHOLD":
      return { ...definition, exit: { ...definition.exit, threshold: value } };
    case "SIZE_PERCENT":
      return { ...definition, sizePercent: value };
    case "STOP_PERCENT":
      return { ...definition, stopLossPercent: value };
  }
}

export type SweepRunSummary = {
  value: string;
  metrics: BacktestMetrics;
  isBest: boolean;
};

export type SweepResult = {
  symbol: string;
  parameter: SweepParameter;
  parameterLabel: string;
  values: string[];
  runs: SweepRunSummary[];
  bestValue: string | null;
  warning: string;
  costs: BacktestCosts;
  costAssumptions: string[];
  periodStart: string;
  periodEnd: string;
  barCount: number;
  definitionText: string;
};

export const OVERFITTING_WARNING =
  "The flagged value is the best of these runs on one history, which is in-sample selection: it is a hypothesis to test forward, not a guaranteed outcome.";

export type SweepInput = {
  definition: StrategyDefinition;
  candles: readonly MarketCandle[];
  costs: BacktestCosts;
  initialCapitalUsd: string;
  parameter: SweepParameter;
  values: readonly string[];
  now?: Date;
};

export function runParameterSweep(input: SweepInput): SweepResult {
  if (input.values.length < 2 || input.values.length > MAX_SWEEP_VALUES) {
    throw new Error(`INVALID_SWEEP: provide between 2 and ${MAX_SWEEP_VALUES} values.`);
  }
  const runs: SweepRunSummary[] = [];
  let first: BacktestResult | null = null;
  for (const value of input.values) {
    if (!isDecimalText(value)) throw new Error(`INVALID_SWEEP: "${value}" is not a decimal value.`);
    const candidate = applySweepValue(input.definition, input.parameter, value.trim());
    const validation = validateStrategyDefinition(candidate);
    if (!validation.valid) {
      throw new Error(`INVALID_SWEEP: ${value} produced a definition that cannot run: ${validation.issues.join(" ")}`);
    }
    const result = runStrategyBacktest({
      definition: validation.definition,
      candles: input.candles,
      costs: input.costs,
      initialCapitalUsd: input.initialCapitalUsd,
      ...(input.now ? { now: input.now } : {}),
    });
    first ??= result;
    runs.push({ value: value.trim(), metrics: result.metrics, isBest: false });
  }

  let bestIndex = 0;
  for (const [index, run] of runs.entries()) {
    if (Number(run.metrics.totalReturnPercent) > Number(runs[bestIndex]!.metrics.totalReturnPercent)) bestIndex = index;
  }
  const best = runs[bestIndex]!;
  best.isBest = true;

  const reference = first!;
  return {
    symbol: reference.symbol,
    parameter: input.parameter,
    parameterLabel: SWEEP_PARAMETER_LABELS[input.parameter],
    values: runs.map((run) => run.value),
    runs,
    bestValue: best.value,
    warning: OVERFITTING_WARNING,
    costs: input.costs,
    costAssumptions: reference.costAssumptions,
    periodStart: reference.periodStart,
    periodEnd: reference.periodEnd,
    barCount: reference.barCount,
    definitionText: reference.definitionText,
  };
}
