import DecimalJS from "decimal.js";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";
import type { MarketCandle } from "@/lib/market-data/provider";
import { calculateRsi } from "@/lib/market-data/indicators";
import { DEFAULT_RISK_POLICY } from "@/lib/risk-controls/policy";

const Decimal = DecimalJS.clone({ precision: 60 });

export const BACKTEST_WINDOW_DAYS = 365;
export const BACKTEST_MIN_CANDLE_COUNT = 300;
export const BACKTEST_MIN_COVERAGE_DAYS = 330;
export const BACKTEST_RSI_PERIOD = 14;

export type RsiStrategy = {
  indicators: [{ id: "rsi14"; type: "RSI"; period: 14 }];
  conditions: [
    { id: "entry"; indicatorId: "rsi14"; operator: "CROSS_BELOW"; threshold: string },
    { id: "exit"; indicatorId: "rsi14"; operator: "CROSS_ABOVE"; threshold: string },
  ];
  actions: [
    { conditionId: "entry"; action: "BUY" },
    { conditionId: "exit"; action: "SELL" },
  ];
};

export type BacktestRequest = {
  symbol: string;
  initialCapitalUsd: string;
  feeBps: string;
  slippageBps: string;
  buyRsiBelow: string;
  sellRsiAbove: string;
  maxTradeSizeUsd?: string;
  stopLossPercent?: string;
  dailyLossHaltPercent?: string;
};

export type BacktestTrade = {
  entryAt: string;
  exitAt: string;
  entryPrice: string;
  exitPrice: string;
  quantity: string;
  feesUsd: string;
  slippageUsd: string;
  pnlUsd: string;
  pnlPercent: string;
  exitReason: "RSI_CROSS_ABOVE" | "STOP_LOSS" | "END_OF_PERIOD";
};

export type EquityPoint = { time: string; equityUsd: string };

export type BacktestResult = {
  symbol: string;
  source: "coinbase-exchange";
  interval: "1d";
  strategy: RsiStrategy;
  periodStart: string;
  periodEnd: string;
  barCount: number;
  initialCapitalUsd: string;
  maxTradeSizeUsd: string;
  stopLossPercent: string | null;
  dailyLossHaltPercent: string;
  finalCapitalUsd: string;
  totalReturnPercent: string;
  totalFeesUsd: string;
  totalSlippageUsd: string;
  maxDrawdownPercent: string;
  winRatePercent: string | null;
  profitFactor: string | null;
  losingTradeCount: number;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  notes: readonly string[];
};

export type BacktestValidation =
  | { valid: true; value: BacktestRequest }
  | { valid: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainDecimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}

function decimal(value: string): InstanceType<typeof Decimal> {
  return new Decimal(value);
}

export function validateBacktestRequest(value: unknown): BacktestValidation {
  const requiredKeys = ["symbol", "initialCapitalUsd", "feeBps", "slippageBps", "buyRsiBelow", "sellRsiAbove"];
  const optionalKeys = ["maxTradeSizeUsd", "stopLossPercent", "dailyLossHaltPercent"];
  if (!isRecord(value) || requiredKeys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => ![...requiredKeys, ...optionalKeys].includes(key))) {
    return { valid: false, error: "Provide symbol, capital, fee, slippage, and RSI entry/exit thresholds." };
  }
  if (typeof value.symbol !== "string" || !USD_WATCHLIST.some(({ productId }) => productId === value.symbol)) {
    return { valid: false, error: "Choose a supported Coinbase USD market." };
  }
  const numericKeys = [...requiredKeys.slice(1), ...optionalKeys.filter((key) => Object.hasOwn(value, key))];
  if (numericKeys.some((key) => !isPlainDecimal(value[key]))) {
    return { valid: false, error: "All backtest assumptions must be plain decimal values." };
  }

  const initialCapital = decimal(value.initialCapitalUsd as string);
  const feeBps = decimal(value.feeBps as string);
  const slippageBps = decimal(value.slippageBps as string);
  const buyThreshold = decimal(value.buyRsiBelow as string);
  const sellThreshold = decimal(value.sellRsiAbove as string);
  if (!initialCapital.isFinite() || initialCapital.lessThan(20) || initialCapital.greaterThan("1000000000")) {
    return { valid: false, error: "Starting capital must be between USD 20 and USD 1,000,000,000." };
  }
  if (!feeBps.isFinite() || feeBps.lte(0) || feeBps.greaterThan(500)) {
    return { valid: false, error: "Fee assumption must be greater than zero and no more than 500 bps per side." };
  }
  if (!slippageBps.isFinite() || slippageBps.lte(0) || slippageBps.greaterThan(1000)) {
    return { valid: false, error: "Slippage assumption must be greater than zero and no more than 1,000 bps per side." };
  }
  if (!buyThreshold.isFinite() || buyThreshold.lt(0) || buyThreshold.gte(50) ||
    !sellThreshold.isFinite() || sellThreshold.lte(50) || sellThreshold.gt(100) || !buyThreshold.lt(sellThreshold)) {
    return { valid: false, error: "RSI entry must be below 50 and exit above 50, with entry lower than exit." };
  }

  const maxTradeSize = value.maxTradeSizeUsd === undefined
    ? initialCapital.mul(DEFAULT_RISK_POLICY.maxOpenExposurePercent).div(100)
    : decimal(value.maxTradeSizeUsd as string);
  const stopLossPercent = value.stopLossPercent === undefined ? null : decimal(value.stopLossPercent as string);
  const dailyLossHaltPercent = value.dailyLossHaltPercent === undefined
    ? decimal(DEFAULT_RISK_POLICY.dailyLossHaltPercent)
    : decimal(value.dailyLossHaltPercent as string);
  const maximumPosition = initialCapital.mul(DEFAULT_RISK_POLICY.maxOpenExposurePercent).div(100);
  if (!maxTradeSize.isFinite() || maxTradeSize.lte(0) || maxTradeSize.greaterThan(maximumPosition)) {
    return { valid: false, error: `Per-trade size cannot exceed ${DEFAULT_RISK_POLICY.maxOpenExposurePercent}% of starting capital.` };
  }
  if (stopLossPercent && (
    !stopLossPercent.isFinite() || stopLossPercent.lte(0) || stopLossPercent.greaterThan(100) ||
    maxTradeSize.mul(stopLossPercent).div(100).greaterThan(initialCapital.mul(DEFAULT_RISK_POLICY.maxRiskPerTradePercent).div(100))
  )) {
    return { valid: false, error: "Stop-loss must be positive and keep max trade loss within the 1% risk cap." };
  }
  if (!dailyLossHaltPercent.isFinite() || dailyLossHaltPercent.lte(0) || dailyLossHaltPercent.greaterThan(DEFAULT_RISK_POLICY.dailyLossHaltPercent)) {
    return { valid: false, error: "Daily-loss halt must be positive and no higher than the 2% policy cap." };
  }

  return {
    valid: true,
    value: {
      symbol: value.symbol,
      initialCapitalUsd: initialCapital.toFixed(),
      feeBps: feeBps.toFixed(),
      slippageBps: slippageBps.toFixed(),
      buyRsiBelow: buyThreshold.toFixed(),
      sellRsiAbove: sellThreshold.toFixed(),
      maxTradeSizeUsd: maxTradeSize.toFixed(),
      ...(stopLossPercent ? { stopLossPercent: stopLossPercent.toFixed() } : {}),
      dailyLossHaltPercent: dailyLossHaltPercent.toFixed(),
    },
  };
}

export function createRsiStrategy(input: BacktestRequest): RsiStrategy {
  return {
    indicators: [{ id: "rsi14", type: "RSI", period: BACKTEST_RSI_PERIOD }],
    conditions: [
      { id: "entry", indicatorId: "rsi14", operator: "CROSS_BELOW", threshold: input.buyRsiBelow },
      { id: "exit", indicatorId: "rsi14", operator: "CROSS_ABOVE", threshold: input.sellRsiAbove },
    ],
    actions: [
      { conditionId: "entry", action: "BUY" },
      { conditionId: "exit", action: "SELL" },
    ],
  };
}

function validateCandleWindow(candles: readonly MarketCandle[], now: Date): MarketCandle[] {
  const ordered = [...candles].sort((left, right) => Date.parse(left.openTime) - Date.parse(right.openTime));
  const complete = ordered.filter((candle) => Date.parse(candle.closeTime) <= now.getTime());
  if (complete.length < BACKTEST_MIN_CANDLE_COUNT) throw new Error("INSUFFICIENT_HISTORY");
  if (complete.some((candle) => candle.interval !== "1d" || candle.provenance.providerId !== "coinbase-exchange")) {
    throw new Error("INVALID_CANDLE_SOURCE");
  }
  const firstTime = Date.parse(complete[0]!.openTime);
  const lastTime = Date.parse(complete.at(-1)!.closeTime);
  if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime) || (lastTime - firstTime) / 86_400_000 < BACKTEST_MIN_COVERAGE_DAYS) {
    throw new Error("INSUFFICIENT_HISTORY");
  }
  if (now.getTime() - lastTime > 48 * 60 * 60_000) throw new Error("HISTORY_STALE");
  if (complete.some((candle) => {
    try {
      const open = decimal(candle.open);
      const high = decimal(candle.high);
      const low = decimal(candle.low);
      const close = decimal(candle.close);
      return [open, high, low, close].some((number) => !number.isFinite() || number.lte(0)) || high.lt(low);
    } catch {
      return true;
    }
  })) throw new Error("INVALID_CANDLE_DATA");
  return complete;
}

export function runRsiBacktest(input: BacktestRequest, sourceCandles: readonly MarketCandle[], now = new Date()): BacktestResult {
  const candles = validateCandleWindow(sourceCandles, now);
  const closes = candles.map(({ close }) => Number(close));
  if (closes.some((close) => !Number.isFinite(close) || close <= 0)) throw new Error("INVALID_CANDLE_DATA");

  const capital = decimal(input.initialCapitalUsd);
  const maxTradeSize = decimal(input.maxTradeSizeUsd ?? capital.mul(DEFAULT_RISK_POLICY.maxOpenExposurePercent).div(100).toFixed());
  const stopLossPercent = input.stopLossPercent ? decimal(input.stopLossPercent) : null;
  const dailyLossHaltPercent = decimal(input.dailyLossHaltPercent ?? DEFAULT_RISK_POLICY.dailyLossHaltPercent);
  const feeRate = decimal(input.feeBps).dividedBy(10_000);
  const slippageRate = decimal(input.slippageBps).dividedBy(10_000);
  const buyThreshold = Number(input.buyRsiBelow);
  const sellThreshold = Number(input.sellRsiAbove);
  const strategy = createRsiStrategy(input);
  const rsi = closes.map((_, index) => calculateRsi(closes.slice(0, index + 1), BACKTEST_RSI_PERIOD));

  let cash = capital;
  let quantity = new Decimal(0);
  let entryAt = "";
  let entryPrice = new Decimal(0);
  let entryCost = new Decimal(0);
  let entryFee = new Decimal(0);
  let entrySlippage = new Decimal(0);
  let totalFees = new Decimal(0);
  let totalSlippage = new Decimal(0);
  const equityCurve: EquityPoint[] = [];
  const trades: BacktestTrade[] = [];
  let currentUtcDate = "";
  let dailyStartEquity = capital;
  let dailyLossHalted = false;

  const closePosition = (index: number, exitReason: BacktestTrade["exitReason"], rawExitPrice?: string) => {
    const referencePrice = decimal(rawExitPrice ?? candles[index]!.close);
    const fillPrice = referencePrice.times(new Decimal(1).minus(slippageRate));
    const gross = quantity.times(fillPrice);
    const exitFee = gross.times(feeRate);
    const exitSlippage = referencePrice.minus(fillPrice).times(quantity);
    const pnl = gross.minus(exitFee).minus(entryCost);
    cash = cash.plus(gross).minus(exitFee);
    const totalTradeFees = entryFee.plus(exitFee);
    const totalTradeSlippage = entrySlippage.plus(exitSlippage);
    trades.push({
      entryAt,
      exitAt: candles[index]!.closeTime,
      entryPrice: entryPrice.toFixed(),
      exitPrice: fillPrice.toFixed(),
      quantity: quantity.toFixed(),
      feesUsd: totalTradeFees.toFixed(),
      slippageUsd: totalTradeSlippage.toFixed(),
      pnlUsd: pnl.toFixed(),
      pnlPercent: pnl.dividedBy(entryCost).times(100).toDecimalPlaces(4).toFixed(4),
      exitReason,
    });
    totalFees = totalFees.plus(exitFee);
    totalSlippage = totalSlippage.plus(exitSlippage);
    quantity = new Decimal(0);
    entryCost = new Decimal(0);
    entryFee = new Decimal(0);
    entrySlippage = new Decimal(0);
  };

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]!;
    const utcDate = candle.openTime.slice(0, 10);
    if (utcDate !== currentUtcDate) {
      currentUtcDate = utcDate;
      dailyStartEquity = index === 0 ? capital : decimal(equityCurve.at(-1)!.equityUsd);
      dailyLossHalted = false;
    }

    const currentRsi = rsi[index];
    const previousRsi = index > 0 ? rsi[index - 1] : null;
    const close = decimal(candle.close);

    if (!quantity.isZero() && stopLossPercent) {
      const stopPrice = entryPrice.times(new Decimal(1).minus(stopLossPercent.dividedBy(100)));
      const low = decimal(candle.low);
      if (low.lte(stopPrice)) {
        const open = decimal(candle.open);
        const gapFillPrice = open.lt(stopPrice) ? open.toFixed() : stopPrice.toFixed();
        closePosition(index, "STOP_LOSS", gapFillPrice);
      }
    }

    const lowMarkEquity = cash.plus(quantity.times(decimal(candle.low)));
    const dailyLossLimit = dailyStartEquity.times(dailyLossHaltPercent).dividedBy(100);
    if (dailyStartEquity.minus(lowMarkEquity).greaterThanOrEqualTo(dailyLossLimit)) dailyLossHalted = true;

    const enter = !dailyLossHalted && quantity.isZero() && previousRsi !== null && currentRsi !== null && previousRsi > buyThreshold && currentRsi <= buyThreshold;
    const exit = !quantity.isZero() && previousRsi !== null && currentRsi !== null && previousRsi < sellThreshold && currentRsi >= sellThreshold;

    if (enter) {
      const fillPrice = close.times(new Decimal(1).plus(slippageRate));
      const allowedNotional = cash.lessThan(maxTradeSize) ? cash : maxTradeSize;
      quantity = allowedNotional.dividedBy(fillPrice);
      const notional = quantity.times(fillPrice);
      entryFee = notional.times(feeRate);
      entrySlippage = fillPrice.minus(close).times(quantity);
      entryCost = notional.plus(entryFee);
      entryAt = candles[index]!.openTime;
      entryPrice = fillPrice;
      totalFees = totalFees.plus(entryFee);
      totalSlippage = totalSlippage.plus(entrySlippage);
      cash = cash.minus(entryCost);
    } else if (exit) {
      closePosition(index, "RSI_CROSS_ABOVE");
    }

    const equity = cash.plus(quantity.times(close));
    equityCurve.push({ time: candles[index]!.closeTime, equityUsd: equity.toFixed() });
    if (dailyStartEquity.minus(equity).greaterThanOrEqualTo(dailyLossLimit)) dailyLossHalted = true;
  }

  if (!quantity.isZero()) {
    closePosition(candles.length - 1, "END_OF_PERIOD");
    equityCurve[equityCurve.length - 1] = { time: candles.at(-1)!.closeTime, equityUsd: cash.toFixed() };
  }

  let peak = capital;
  let maxDrawdown = new Decimal(0);
  for (const point of equityCurve) {
    const equity = decimal(point.equityUsd);
    if (equity.greaterThan(peak)) peak = equity;
    if (peak.greaterThan(0)) {
      const drawdown = peak.minus(equity).dividedBy(peak).times(100);
      if (drawdown.greaterThan(maxDrawdown)) maxDrawdown = drawdown;
    }
  }

  const winners = trades.filter((trade) => decimal(trade.pnlUsd).greaterThan(0));
  const losers = trades.filter((trade) => decimal(trade.pnlUsd).lessThan(0));
  const grossWins = winners.reduce((total, trade) => total.plus(trade.pnlUsd), new Decimal(0));
  const grossLosses = losers.reduce((total, trade) => total.plus(decimal(trade.pnlUsd).abs()), new Decimal(0));
  const finalCapital = cash;
  const firstCandle = candles[0]!;
  const lastCandle = candles.at(-1)!;

  return {
    symbol: input.symbol,
    source: "coinbase-exchange",
    interval: "1d",
    strategy,
    periodStart: firstCandle.openTime,
    periodEnd: lastCandle.closeTime,
    barCount: candles.length,
    initialCapitalUsd: capital.toFixed(),
    maxTradeSizeUsd: maxTradeSize.toFixed(),
    stopLossPercent: stopLossPercent?.toFixed() ?? null,
    dailyLossHaltPercent: dailyLossHaltPercent.toFixed(),
    finalCapitalUsd: finalCapital.toFixed(),
    totalReturnPercent: finalCapital.minus(capital).dividedBy(capital).times(100).toDecimalPlaces(4).toFixed(4),
    totalFeesUsd: totalFees.toFixed(),
    totalSlippageUsd: totalSlippage.toFixed(),
    maxDrawdownPercent: maxDrawdown.toDecimalPlaces(4).toFixed(4),
    winRatePercent: trades.length > 0 ? new Decimal(winners.length).dividedBy(trades.length).times(100).toDecimalPlaces(2).toFixed(2) : null,
    profitFactor: grossLosses.isZero() ? null : grossWins.dividedBy(grossLosses).toDecimalPlaces(4).toFixed(4),
    losingTradeCount: losers.length,
    trades,
    equityCurve,
    notes: [
      "Fixed trailing 365-day request; no date-range trimming or timeframe selection.",
      "Coinbase daily candle closes are delayed historical data; all runs include per-side fees and slippage supplied for this run.",
      "Configured position size, daily-loss halt, and stop-loss are simulated; daily candles cannot model intraday path or partial fills, and stop exits use adverse daily-open gap fills.",
      "RSI strategy fills are modeled at daily close plus/minus configured slippage; results are historical analysis, not an order or a return guarantee.",
      "Open positions are closed at the final historical close and incur exit slippage and fees.",
    ],
  };
}