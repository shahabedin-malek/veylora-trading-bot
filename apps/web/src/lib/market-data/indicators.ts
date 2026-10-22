/**
 * One indicator module, shared by everything that quotes a number.
 *
 * The backtester, the assistant's RSI tool and the screener all import
 * `calculateRsi` from here rather than carrying their own Wilder smoothing, so
 * the same closes cannot produce two different RSI values on two surfaces
 * (phase 19). `latestClosedRsi` is the "as of this moment" form of the same
 * calculation: it takes only candles that have closed, which is what makes a
 * screen reproducible for a fixed as-of time.
 */

export function calculateRsi(closes: readonly number[], period = 14): number | null {
  if (!Number.isSafeInteger(period) || period < 1 || closes.length <= period) return null;
  if (closes.some((close) => !Number.isFinite(close) || close <= 0)) return null;

  let averageGain = 0;
  let averageLoss = 0;

  for (let index = 1; index <= period; index += 1) {
    const change = closes[index]! - closes[index - 1]!;
    averageGain += Math.max(change, 0);
    averageLoss += Math.max(-change, 0);
  }

  averageGain /= period;
  averageLoss /= period;

  for (let index = period + 1; index < closes.length; index += 1) {
    const change = closes[index]! - closes[index - 1]!;
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (averageGain === 0 && averageLoss === 0) return 50;
  if (averageLoss === 0) return 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

/** A candle as the indicator module needs it: a close and the moment it closed. */
export type IndicatorCandle = {
  close: string;
  closeTime: string | Date;
};

export type RsiSnapshot = {
  /** The Wilder RSI-14 value over the supplied closes. */
  value: number;
  /** The close time of the newest candle that went into it. */
  closedAt: string;
  /** How many closed candles were used. */
  candles: number;
};

/**
 * RSI-14 as of `asOf`, using only candles that had closed by then.
 *
 * Returns null when the closes are unusable or there are not enough of them;
 * the caller states that reason rather than showing a number it could not
 * derive. A candle whose `closeTime` is malformed is ignored rather than
 * allowed to reorder the series.
 */
export function latestClosedRsi(
  candles: readonly IndicatorCandle[],
  period = 14,
  asOf: Date = new Date(),
): RsiSnapshot | null {
  if (!Number.isSafeInteger(period) || period < 1) return null;
  const asOfMs = asOf.getTime();
  if (!Number.isFinite(asOfMs)) return null;

  const closed = candles
    .map((candle) => ({ close: candle.close, closeAt: new Date(candle.closeTime).getTime() }))
    .filter((candle) => Number.isFinite(candle.closeAt) && candle.closeAt <= asOfMs)
    .sort((left, right) => left.closeAt - right.closeAt);
  if (closed.length <= period) return null;

  const value = calculateRsi(closed.map(({ close }) => Number(close)), period);
  if (value === null || !Number.isFinite(value)) return null;

  const newest = closed.at(-1);
  if (!newest) return null;
  return {
    value,
    closedAt: new Date(newest.closeAt).toISOString(),
    candles: closed.length,
  };
}
