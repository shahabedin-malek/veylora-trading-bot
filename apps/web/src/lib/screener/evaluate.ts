import DecimalJS from "decimal.js";
import { doesAlertTrigger, type MarketAlertCondition } from "@/lib/alerts/conditions";
import { latestClosedRsi } from "@/lib/market-data/indicators";
import { screenResultHash } from "@/lib/screener/model";

const Decimal = DecimalJS.clone({ precision: 60 });
const RSI_PERIOD = 14;
const SCREEN_INTERVAL = "15m";
/** Twice the candle interval: newer than this is FRESH relative to the as-of time. */
const FRESH_WINDOW_MS = 2 * 15 * 60_000;

/**
 * One stored candle, as the screener reads it.
 *
 * The screener deliberately reads what ingestion stored rather than asking the
 * provider again on every keystroke: a screen is a question about data, and the
 * answer has to name the data it used. The record's provider and close time
 * travel into the result, so a value can always be traced to a row.
 */
export type ScreenerCandle = {
  symbol: string;
  interval: string;
  openTime: Date | string;
  closeTime: Date | string;
  close: string;
  providerId: string;
  fetchedAt?: Date | string;
};

export type ScreenerRow = {
  symbol: string;
  /** The observed value, or null when it could not be derived. */
  value: string | null;
  /** The close time of the candle the value came from. */
  observedAt: string | null;
  matched: boolean;
  providerId: string | null;
  freshness: "FRESH" | "STALE" | null;
  /** Why there is no value, in one sentence; null when there is one. */
  reason: string | null;
};

export type ScreenEvaluation = {
  condition: MarketAlertCondition;
  threshold: string;
  symbols: string[];
  /** The moment the screen was asked, fixed for this result. */
  asOf: string;
  /** The newest candle that went into any row, or null when none did. */
  dataAsOf: string | null;
  providerIds: string[];
  interval: typeof SCREEN_INTERVAL;
  rows: ScreenerRow[];
  matchedCount: number;
  resultHash: string;
};

type PreparedCandle = {
  openTime: number;
  closeTime: number;
  close: string;
  providerId: string;
  fetchedAt: number;
};

function prepareCandles(candles: readonly ScreenerCandle[], symbol: string): PreparedCandle[] {
  // One row per open time. Ingestion keys by provider, so two providers may have
  // stored the same slot; the freshest fetch wins, deterministically, instead of
  // whichever row the database happened to return first.
  const byOpenTime = new Map<number, PreparedCandle>();
  for (const candle of candles) {
    if (candle.symbol !== symbol || candle.interval !== SCREEN_INTERVAL) continue;
    const openTime = new Date(candle.openTime).getTime();
    const closeTime = new Date(candle.closeTime).getTime();
    if (!Number.isFinite(openTime) || !Number.isFinite(closeTime) || closeTime <= openTime) continue;
    const fetchedAt = candle.fetchedAt ? new Date(candle.fetchedAt).getTime() : 0;
    const existing = byOpenTime.get(openTime);
    if (existing && existing.fetchedAt > fetchedAt) continue;
    byOpenTime.set(openTime, {
      openTime,
      closeTime,
      close: candle.close,
      providerId: candle.providerId,
      fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : 0,
    });
  }
  return [...byOpenTime.values()].sort((left, right) => left.openTime - right.openTime);
}

function decimalValue(text: string, options: { allowZero?: boolean } = {}): string | null {
  try {
    const value = new Decimal(text);
    if (!value.isFinite()) return null;
    if (options.allowZero ? value.isNegative() : !value.greaterThan(0)) return null;
    return value.toFixed();
  } catch {
    return null;
  }
}

function freshness(asOfMs: number, observedAtMs: number): "FRESH" | "STALE" {
  return asOfMs - observedAtMs <= FRESH_WINDOW_MS ? "FRESH" : "STALE";
}

/**
 * Evaluate one condition across a symbol set as of a fixed moment.
 *
 * The only inputs are the condition, the threshold, the symbols, the stored
 * 15m candles and `asOf`. Nothing reads a wall clock here — the caller supplies
 * the moment — so the same data and as-of time always produce the same rows and
 * the same `resultHash`. Candles that had not closed by `asOf` are not used,
 * which is also what makes replaying an older run meaningful.
 *
 * PRICE conditions use the newest closed 15m close. RSI-14 uses the same shared
 * `latestClosedRsi` the assistant and backtester derive their RSI from, so a
 * screen value and an alert value cannot drift apart.
 */
export function evaluateScreen(input: {
  condition: MarketAlertCondition;
  threshold: string;
  symbols: readonly string[];
  candles: readonly ScreenerCandle[];
  asOf: Date;
}): ScreenEvaluation {
  const asOfMs = input.asOf.getTime();
  if (!Number.isFinite(asOfMs)) throw new RangeError("A screen as-of time must be a valid date.");

  const threshold = decimalValue(input.threshold, { allowZero: true });
  if (threshold === null) throw new RangeError("A screen threshold must be a positive decimal.");

  const rows: ScreenerRow[] = [];
  const observedTimes: number[] = [];

  for (const symbol of input.symbols) {
    const prepared = prepareCandles(input.candles, symbol).filter((candle) => candle.closeTime <= asOfMs);
    const latest = prepared.at(-1);

    if (!latest) {
      rows.push({
        symbol,
        value: null,
        observedAt: null,
        matched: false,
        providerId: null,
        freshness: null,
        reason: "No closed 15-minute candle is stored for this symbol as of the screen time.",
      });
      continue;
    }

    let value: string | null;
    let observedAtMs: number;
    let providerId: string;

    if (input.condition.startsWith("RSI_")) {
      const rsi = latestClosedRsi(
        prepared.map((candle) => ({ close: candle.close, closeTime: new Date(candle.closeTime) })),
        RSI_PERIOD,
        input.asOf,
      );
      if (!rsi) {
        rows.push({
          symbol,
          value: null,
          observedAt: new Date(latest.closeTime).toISOString(),
          matched: false,
          providerId: latest.providerId,
          freshness: freshness(asOfMs, latest.closeTime),
          reason: `Not enough closed 15-minute candles for RSI-14 (${prepared.length} of ${RSI_PERIOD + 1}).`,
        });
        continue;
      }
      value = new Decimal(rsi.value).toDecimalPlaces(4).toFixed(4);
      observedAtMs = new Date(rsi.closedAt).getTime();
      const source = prepared.find((candle) => candle.closeTime === observedAtMs) ?? latest;
      providerId = source.providerId;
    } else {
      value = decimalValue(latest.close);
      observedAtMs = latest.closeTime;
      providerId = latest.providerId;
    }

    if (value === null) {
      rows.push({
        symbol,
        value: null,
        observedAt: new Date(observedAtMs).toISOString(),
        matched: false,
        providerId,
        freshness: freshness(asOfMs, observedAtMs),
        reason: "The newest stored close is not a usable positive decimal.",
      });
      continue;
    }

    observedTimes.push(observedAtMs);
    rows.push({
      symbol,
      value,
      observedAt: new Date(observedAtMs).toISOString(),
      matched: doesAlertTrigger(input.condition, threshold, value),
      providerId,
      freshness: freshness(asOfMs, observedAtMs),
      reason: null,
    });
  }

  const dataAsOf = observedTimes.length > 0 ? new Date(Math.max(...observedTimes)).toISOString() : null;
  const providerIds = [...new Set(rows.map((row) => row.providerId).filter((id): id is string => id !== null))].sort();
  return {
    condition: input.condition,
    threshold,
    symbols: [...input.symbols],
    asOf: input.asOf.toISOString(),
    dataAsOf,
    providerIds,
    interval: SCREEN_INTERVAL,
    rows,
    matchedCount: rows.filter((row) => row.matched).length,
    resultHash: screenResultHash({ condition: input.condition, threshold, rows }),
  };
}
