import DecimalJS from "decimal.js";
import { latestClosedRsi, type IndicatorCandle } from "@/lib/market-data/indicators";
import type { StrategyReasonCode } from "./reasons";

const Decimal = DecimalJS.clone({ precision: 40 });

/**
 * The decision half of the 24/7 strategy runner: what one activation should do with the
 * market facts a pass has, and why it did not do anything when it didn't.
 *
 * It is pure on purpose — no database, no clock, no network, no order path. The loop in
 * `runner.ts` owns persistence and submission, `state.ts` owns how the owner's control is
 * described, and this file owns the rule. That split is what lets the whole taxonomy and
 * both sides of the entry/exit rule be tested by enumerating facts rather than by writing
 * rows.
 *
 * The interval is the strategy's own (`decisionIntervalMinutes`), not the runner's
 * cadence: the job runs every five minutes so a late or missed delivery is recovered
 * quickly, while a strategy is evaluated once per interval. A pass that lands in an
 * already-evaluated interval decides nothing, which is the mechanism behind "no condition
 * is evaluated twice within its own interval".
 */

export type StrategyDefinition = {
  id: string;
  label: string;
  /** The Coinbase product the strategy reads and trades. */
  market: string;
  /** How often the strategy is evaluated. The runner's cadence is independent. */
  decisionIntervalMinutes: number;
  /** RSI-14 on closed daily candles. */
  entryRsiBelow: string;
  exitRsiAbove: string;
  /** Distance below the entry price at which the position is closed. */
  stopLossPercent: string;
  /** The notional a single entry spends, in USD. */
  budgetUsd: string;
  detail: string;
};

export const STRATEGY_DEFINITIONS: readonly StrategyDefinition[] = [
  {
    id: "rsi-daily-close",
    label: "Smart RSI · daily close",
    market: "BTC-USD",
    decisionIntervalMinutes: 60,
    entryRsiBelow: "30",
    exitRsiAbove: "70",
    stopLossPercent: "2",
    budgetUsd: "25",
    detail:
      "Buys BTC-USD once per hour while the RSI-14 on closed daily candles is below 30, and exits when it is above 70 or the close reaches the position's stop-loss. One decision per hour, one order per decision.",
  },
];

export function strategyDefinition(id: string | null | undefined): StrategyDefinition | null {
  if (!id) return null;
  return STRATEGY_DEFINITIONS.find((strategy) => strategy.id === id) ?? null;
}

export function strategyIntervalMs(strategy: StrategyDefinition): number {
  return Math.max(1, strategy.decisionIntervalMinutes) * 60_000;
}

/** The interval a moment belongs to, aligned to the epoch so every account agrees. */
export function decisionWindowStart(now: number, strategy: StrategyDefinition): number {
  const interval = strategyIntervalMs(strategy);
  return Math.floor(now / interval) * interval;
}

/**
 * The windows a redeploy, a crash or a missed schedule skipped.
 *
 * `lastWindowStart` is the last window that produced a decision. If the current window is
 * two or more intervals later, everything in between ran without an evaluation. The
 * caller records one row for it — not one per window — because "the runner was absent from
 * 09:00 to 12:00" is one fact about the schedule, and a wall of gap rows would hide the
 * decisions around it.
 */
export function missedDecisionWindows(input: {
  lastWindowStart: number | null;
  windowStart: number;
  intervalMs: number;
}): { count: number; rowWindowStart: number } | null {
  const { lastWindowStart, windowStart, intervalMs } = input;
  if (lastWindowStart === null || !Number.isFinite(lastWindowStart)) return null;
  if (!Number.isFinite(windowStart) || !Number.isFinite(intervalMs) || intervalMs <= 0) return null;
  const elapsed = windowStart - lastWindowStart;
  if (elapsed <= intervalMs) return null;
  const missed = Math.max(1, Math.floor(elapsed / intervalMs) - 1);
  // The gap row is keyed to the last window that was skipped, which is always a different
  // window from the one this pass is about to evaluate — so the unique per-window index
  // cannot swallow either of them.
  return { count: missed, rowWindowStart: windowStart - intervalMs };
}

export type StrategyMarketView = {
  market: string;
  /** RSI-14 over the closed daily candles that were available. */
  rsi: number;
  /** The close time of the newest candle that went into the RSI. */
  rsiClosedAt: string;
  /** How many closed candles the RSI used. */
  candles: number;
  /** The newest closed candle's close, which is the price an order would be sized at. */
  lastClose: string;
  lastClosedAt: string;
};

/**
 * The signal a pass reads, from candles the caller already loaded.
 *
 * RSI comes from the shared indicator module so a strategy, the screener, the backtester
 * and the assistant cannot disagree about the same closes (phase 19). Only candles that
 * had closed by `asOf` are used: a still-forming daily candle would change under the
 * evaluation and make the same decision non-reproducible.
 */
export function marketViewFromCandles(
  input: {
    market: string;
    candles: readonly (IndicatorCandle & { openTime?: string | Date })[];
  },
  asOf: Date,
): StrategyMarketView | null {
  const snapshot = latestClosedRsi(input.candles, 14, asOf);
  if (!snapshot) return null;

  const closed = input.candles
    .map((candle) => ({ close: candle.close, closeAt: new Date(candle.closeTime).getTime() }))
    .filter((candle) => Number.isFinite(candle.closeAt) && candle.closeAt <= asOf.getTime())
    .sort((left, right) => left.closeAt - right.closeAt);
  const newest = closed.at(-1);
  if (!newest) return null;

  const lastClose = new Decimal(newest.close);
  if (!lastClose.isFinite() || lastClose.lte(0)) return null;

  return {
    market: input.market,
    rsi: snapshot.value,
    rsiClosedAt: snapshot.closedAt,
    candles: snapshot.candles,
    lastClose: lastClose.toFixed(),
    lastClosedAt: new Date(newest.closeAt).toISOString(),
  };
}

/** The open side of a strategy: what it holds, at what price, and where the stop is. */
export type StrategyPosition = {
  quantity: string;
  entryPrice: string;
  stopLossPrice: string | null;
};

export type StrategyCondition = {
  id: "entry-rsi" | "exit-rsi" | "stop-loss";
  label: string;
  met: boolean;
  value: string;
  threshold: string;
};

export type StrategyOrderPlan = {
  side: "BUY" | "SELL";
  quantity: string;
  notionalUsdCents: number;
  stopLossPrice: string;
};

export type StrategyPlacedDecision = {
  action: "ENTER" | "EXIT";
  code: "ENTRY_CONDITION_MET" | "EXIT_CONDITION_MET" | "STOP_LOSS_TRIGGERED";
  message: string;
  conditions: StrategyCondition[];
  order: StrategyOrderPlan;
};

export type StrategyHoldDecision = {
  action: "HOLD";
  /** The reasons a hold can carry, including the runner's own configuration and data reasons. */
  code: StrategyReasonCode;
  message: string;
  conditions: StrategyCondition[];
};

export type StrategyDecision = StrategyPlacedDecision | StrategyHoldDecision;

export type StrategyDecisionInput = {
  strategy: StrategyDefinition | null;
  market: StrategyMarketView | null;
  position: StrategyPosition | null;
  /** Orders for this market that are still working at the venue. */
  openOrderCount: number;
};

function stopPrice(price: InstanceType<typeof Decimal>, percent: string): InstanceType<typeof Decimal> {
  return price.mul(new Decimal(100).minus(percent).div(100));
}

function quantityFor(budget: InstanceType<typeof Decimal>, price: InstanceType<typeof Decimal>): InstanceType<typeof Decimal> {
  return budget.div(price);
}

/**
 * What to do this interval, from facts only.
 *
 * The order of the checks is the order of the owner's questions: is there a strategy at
 * all, is there a signal, does the policy allow a second order, is a position already
 * open, and only then does it look for an entry. An open order outranks a new entry
 * because two working orders for one strategy is exactly what requirement 5 forbids — the
 * per-interval window stops the same interval, and this stops a second order while the
 * first is still filling.
 */
export function evaluateStrategyDecision(input: StrategyDecisionInput): StrategyDecision {
  const { strategy, market, position, openOrderCount } = input;

  if (!strategy) {
    return {
      action: "HOLD",
      code: "STRATEGY_DISABLED",
      message: "This activation names a strategy this build does not publish, so no decision can be made.",
      conditions: [],
    };
  }
  if (!market) {
    return {
      action: "HOLD",
      code: "MARKET_DATA_UNAVAILABLE",
      message: `There are not enough closed daily candles for ${strategy.market} to compute the RSI-14 signal, so nothing was decided. The next pass tries again.`,
      conditions: [],
    };
  }

  const rsi = new Decimal(market.rsi);
  const entry = new Decimal(strategy.entryRsiBelow);
  const exit = new Decimal(strategy.exitRsiAbove);
  const lastClose = new Decimal(market.lastClose);

  const conditions: StrategyCondition[] = [
    {
      id: "entry-rsi",
      label: `RSI-14 below ${entry.toFixed()}`,
      met: rsi.lt(entry),
      value: rsi.toFixed(2),
      threshold: entry.toFixed(),
    },
    {
      id: "exit-rsi",
      label: `RSI-14 above ${exit.toFixed()}`,
      met: rsi.gt(exit),
      value: rsi.toFixed(2),
      threshold: exit.toFixed(),
    },
  ];

  if (openOrderCount > 0) {
    return {
      action: "HOLD",
      code: "POSITION_OPEN",
      message: `An order for ${strategy.market} is still working at the venue, so no second order was placed this interval.`,
      conditions,
    };
  }

  if (position) {
    const stop = position.stopLossPrice ? new Decimal(position.stopLossPrice) : stopPrice(new Decimal(position.entryPrice), strategy.stopLossPercent);
    conditions.push({
      id: "stop-loss",
      label: `Close at or above the ${stop.toFixed(2)} stop`,
      met: lastClose.gt(stop),
      value: lastClose.toFixed(2),
      threshold: stop.toFixed(2),
    });

    if (lastClose.lte(stop)) {
      return {
        action: "EXIT",
        code: "STOP_LOSS_TRIGGERED",
        message: `The ${strategy.market} close (${lastClose.toFixed(2)}) is at or below the position's stop (${stop.toFixed(2)}), so the position was closed.`,
        conditions,
        order: {
          side: "SELL",
          quantity: position.quantity,
          notionalUsdCents: Math.max(1, Math.round(lastClose.mul(new Decimal(position.quantity)).mul(100).toNumber())),
          stopLossPrice: stop.toFixed(2),
        },
      };
    }
    if (rsi.gt(exit)) {
      return {
        action: "EXIT",
        code: "EXIT_CONDITION_MET",
        message: `The RSI-14 (${rsi.toFixed(2)}) is above the ${exit.toFixed()} exit, so the position was closed.`,
        conditions,
        order: {
          side: "SELL",
          quantity: position.quantity,
          notionalUsdCents: Math.max(1, Math.round(lastClose.mul(new Decimal(position.quantity)).mul(100).toNumber())),
          stopLossPrice: stop.toFixed(2),
        },
      };
    }
    return {
      action: "HOLD",
      code: "EXIT_CONDITION_NOT_MET",
      message: `A ${strategy.market} position is open and neither exit is met: RSI-14 ${rsi.toFixed(2)} is at or below ${exit.toFixed()} and the close (${lastClose.toFixed(2)}) is above the ${stop.toFixed(2)} stop. It is left alone and checked again next interval.`,
      conditions,
    };
  }

  if (rsi.lt(entry)) {
    const budget = new Decimal(strategy.budgetUsd);
    const quantity = quantityFor(budget, lastClose);
    return {
      action: "ENTER",
      code: "ENTRY_CONDITION_MET",
      message: `The RSI-14 (${rsi.toFixed(2)}) is below the ${entry.toFixed()} entry, so a ${budget.toFixed(2)} USD buy of ${strategy.market} was placed with a ${stopPrice(lastClose, strategy.stopLossPercent).toFixed(2)} stop.`,
      conditions,
      order: {
        side: "BUY",
        quantity: quantity.toFixed(8),
        notionalUsdCents: Math.max(1, Math.round(budget.mul(100).toNumber())),
        stopLossPrice: stopPrice(lastClose, strategy.stopLossPercent).toFixed(2),
      },
    };
  }

  return {
    action: "HOLD",
    code: "NO_ENTRY_CONDITION",
    message: `The RSI-14 (${rsi.toFixed(2)}) is not below the ${entry.toFixed()} entry, so nothing was opened. The close was ${lastClose.toFixed(2)}.`,
    conditions,
  };
}
