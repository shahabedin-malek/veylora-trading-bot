import type {
  CandleInterval,
  MarketCandle,
  MarketDataProvider,
  MarketDataResult,
  MarketNewsItem,
} from "@/lib/market-data/provider";
import { marketDataHealth, type MarketDataHealthRegistry, type MarketDataSourceHealth } from "@/lib/market-data/health";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";

/**
 * Candle ingestion, gap detection and backfill (phase 19).
 *
 * The rule that makes this safe to run on any schedule is the unique key on
 * `MarketCandleRecord`: `(providerId, symbol, interval, openTime)`. Ingestion is
 * an upsert against that key, so running it twice updates the same rows instead
 * of appending a second copy, and a backfill that overlaps a range that is
 * already stored adds nothing. Gap detection is therefore allowed to be
 * approximate — it never has to be exactly right to avoid corrupting the table.
 *
 * Gap detection *is* exact about what it asks for, though: the expected slots
 * are generated from the interval and the closed-candle boundary, so a candle
 * that is still forming is not "missing". Without that, every run would ask the
 * provider for the incomplete current candle, the provider would correctly omit
 * it (it only returns complete candles), and the gap would be reported forever.
 *
 * A source failure does not stop a run. Each operation is recorded independently
 * in the health registry, a source that has failed repeatedly is skipped for a
 * cooldown, and the other sources carry on. The summary names every failure with
 * its reason, so "ingestion ran" is never a claim that everything arrived.
 */

const MINUTE_MS = 60_000;

export const CANDLE_INTERVAL_MS: Record<CandleInterval, number> = {
  "1m": MINUTE_MS,
  "5m": 5 * MINUTE_MS,
  "15m": 15 * MINUTE_MS,
  "1h": 60 * MINUTE_MS,
  "4h": 4 * 60 * MINUTE_MS,
  "1d": 86_400_000,
};

/** How far back a normal ingestion reaches, per interval. */
const INGEST_WINDOW_MS: Record<CandleInterval, number> = {
  "1m": 2 * 60 * MINUTE_MS,
  "5m": 6 * 60 * MINUTE_MS,
  "15m": 48 * 60 * MINUTE_MS,
  "1h": 30 * 86_400_000,
  "4h": 90 * 86_400_000,
  "1d": 90 * 86_400_000,
};

/** The intervals a run maintains. The screener reads both. */
export const INGESTED_INTERVALS: readonly CandleInterval[] = ["15m", "1d"];

export type CandleWindow = { from: Date; to: Date };

export type CandleGap = { from: Date; to: Date };

export type CandleIngestStore = {
  /** Candle open times already stored for one series inside a window. */
  openTimes(input: {
    providerId: string;
    symbol: string;
    interval: CandleInterval;
    from: Date;
    to: Date;
  }): Promise<Date[]>;
  /** Upsert by (providerId, symbol, interval, openTime). Returns rows written. */
  upsertCandles(candles: readonly MarketCandle[]): Promise<number>;
  /** Upsert by (providerId, url). Returns rows written. */
  upsertNews(items: readonly MarketNewsItem[]): Promise<number>;
};

/**
 * The closed-candle window for an interval as of `now`.
 *
 * `to` is exclusive and aligned down to a slot boundary, so the newest expected
 * slot is the most recent candle that has completely closed. A 15m run at 12:07
 * expects slots through 11:45 and does not treat 12:00 as missing.
 */
export function closedCandleWindow(interval: CandleInterval, now: Date): CandleWindow {
  const step = CANDLE_INTERVAL_MS[interval];
  const to = new Date(Math.floor(now.getTime() / step) * step);
  return { from: new Date(to.getTime() - INGEST_WINDOW_MS[interval]), to };
}

/**
 * The slots in `[from, to)` that are not in `existing`.
 *
 * Consecutive missing slots become one range whose `to` is exclusive, which is
 * exactly the shape a provider request wants. The returned ranges never overlap,
 * so a backfill cannot ask for the same missing candle twice.
 */
export function findCandleGaps(input: {
  existing: readonly Date[];
  from: Date;
  to: Date;
  interval: CandleInterval;
}): CandleGap[] {
  const step = CANDLE_INTERVAL_MS[input.interval];
  const fromMs = input.from.getTime();
  const toMs = input.to.getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) return [];

  const have = new Set(
    input.existing
      .map((value) => value.getTime())
      .filter((value) => Number.isFinite(value)),
  );

  const gaps: CandleGap[] = [];
  let rangeStart: number | null = null;
  let rangeLast: number | null = null;
  const firstSlot = Math.ceil(fromMs / step) * step;

  for (let slot = firstSlot; slot < toMs; slot += step) {
    if (have.has(slot)) {
      if (rangeStart !== null && rangeLast !== null) {
        gaps.push({ from: new Date(rangeStart), to: new Date(rangeLast + step) });
        rangeStart = null;
        rangeLast = null;
      }
      continue;
    }
    rangeStart ??= slot;
    rangeLast = slot;
  }
  if (rangeStart !== null && rangeLast !== null) {
    gaps.push({ from: new Date(rangeStart), to: new Date(rangeLast + step) });
  }
  return gaps;
}

type CandleFetchOutcome =
  | { status: "ok"; data: readonly MarketCandle[]; durationMs: number }
  | { status: "unavailable"; reason: string; durationMs: number };

async function fetchCandles(input: {
  provider: MarketDataProvider;
  symbol: string;
  interval: CandleInterval;
  from: Date;
  to: Date;
}): Promise<CandleFetchOutcome> {
  const startedAt = Date.now();
  let result: MarketDataResult<MarketCandle>;
  try {
    result = await input.provider.getCandles({
      instrument: input.symbol,
      interval: input.interval,
      from: input.from.toISOString(),
      to: input.to.toISOString(),
    });
  } catch {
    return { status: "unavailable", reason: "provider-error", durationMs: Date.now() - startedAt };
  }
  const durationMs = Date.now() - startedAt;
  if (result.status !== "available") {
    return { status: "unavailable", reason: result.reason, durationMs };
  }
  return { status: "ok", data: result.data, durationMs };
}

export type CandleSeriesResult =
  | {
      status: "ok";
      providerId: string;
      symbol: string;
      interval: CandleInterval;
      fetched: number;
      written: number;
      durationMs: number;
    }
  | {
      status: "unavailable";
      providerId: string;
      symbol: string;
      interval: CandleInterval;
      reason: string;
      fetched: number;
      written: number;
      durationMs: number;
    };

/** Fetch one window and upsert what the provider returned. */
export async function ingestCandleSeries(input: {
  provider: MarketDataProvider;
  store: CandleIngestStore;
  health: MarketDataHealthRegistry;
  symbol: string;
  interval: CandleInterval;
  window: CandleWindow;
  now?: Date;
}): Promise<CandleSeriesResult> {
  const outcome = await fetchCandles({
    provider: input.provider,
    symbol: input.symbol,
    interval: input.interval,
    from: input.window.from,
    to: input.window.to,
  });
  const base = {
    providerId: input.provider.id,
    symbol: input.symbol,
    interval: input.interval,
    durationMs: outcome.durationMs,
  };

  if (outcome.status === "unavailable") {
    input.health.recordFailure(input.provider.id, outcome.reason, outcome.durationMs, input.now);
    return { ...base, status: "unavailable", reason: outcome.reason, fetched: 0, written: 0 };
  }

  const fromMs = input.window.from.getTime();
  const toMs = input.window.to.getTime();
  const inWindow = outcome.data.filter((candle) => {
    const openTime = Date.parse(candle.openTime);
    return (
      candle.instrument.symbol === input.symbol &&
      candle.interval === input.interval &&
      Number.isFinite(openTime) &&
      openTime >= fromMs &&
      openTime < toMs
    );
  });

  let written: number;
  try {
    written = await input.store.upsertCandles(inWindow);
  } catch {
    input.health.recordFailure(input.provider.id, "storage-unavailable", outcome.durationMs, input.now);
    return { ...base, status: "unavailable", reason: "storage-unavailable", fetched: inWindow.length, written: 0 };
  }
  input.health.recordSuccess(input.provider.id, outcome.durationMs, input.now);
  return { ...base, status: "ok", fetched: inWindow.length, written };
}

export type BackfillResult = {
  status: "no-gaps" | "restored" | "unavailable";
  providerId: string;
  symbol: string;
  interval: CandleInterval;
  gaps: CandleGap[];
  restored: number;
  reason?: string;
};

/**
 * Fill the missing slots in a window, and only those.
 *
 * A gap that the provider still cannot fill stays missing; the next run will ask
 * again, and no row is invented to make the count look complete. Each gap is one
 * provider request for exactly its range, so overlapping backfills cannot
 * duplicate a candle and a second call after a successful one asks for nothing.
 */
export async function backfillCandleGaps(input: {
  provider: MarketDataProvider;
  store: CandleIngestStore;
  health: MarketDataHealthRegistry;
  symbol: string;
  interval: CandleInterval;
  window: CandleWindow;
  now?: Date;
}): Promise<BackfillResult> {
  const base = {
    providerId: input.provider.id,
    symbol: input.symbol,
    interval: input.interval,
  };
  let existing: Date[];
  try {
    existing = await input.store.openTimes({
      providerId: input.provider.id,
      symbol: input.symbol,
      interval: input.interval,
      from: input.window.from,
      to: input.window.to,
    });
  } catch {
    return { ...base, status: "unavailable", gaps: [], restored: 0, reason: "storage-unavailable" };
  }

  const gaps = findCandleGaps({
    existing,
    from: input.window.from,
    to: input.window.to,
    interval: input.interval,
  });
  if (gaps.length === 0) return { ...base, status: "no-gaps", gaps: [], restored: 0 };

  let restored = 0;
  for (const gap of gaps) {
    const outcome = await fetchCandles({
      provider: input.provider,
      symbol: input.symbol,
      interval: input.interval,
      from: gap.from,
      to: gap.to,
    });
    if (outcome.status === "unavailable") {
      input.health.recordFailure(input.provider.id, outcome.reason, outcome.durationMs, input.now);
      return { ...base, status: "unavailable", gaps, restored, reason: outcome.reason };
    }
    const inGap = outcome.data.filter((candle) => {
      const openTime = Date.parse(candle.openTime);
      return (
        candle.instrument.symbol === input.symbol &&
        candle.interval === input.interval &&
        Number.isFinite(openTime) &&
        openTime >= gap.from.getTime() &&
        openTime < gap.to.getTime()
      );
    });
    try {
      restored += await input.store.upsertCandles(inGap);
    } catch {
      input.health.recordFailure(input.provider.id, "storage-unavailable", outcome.durationMs, input.now);
      return { ...base, status: "unavailable", gaps, restored, reason: "storage-unavailable" };
    }
    input.health.recordSuccess(input.provider.id, outcome.durationMs, input.now);
  }

  return { ...base, status: "restored", gaps, restored };
}

export type MarketIngestOperation = {
  sourceId: string;
  kind: "candles" | "backfill" | "news";
  subject: string;
  ok: boolean;
  skipped: boolean;
  fetched: number;
  written: number;
  durationMs: number;
  reason: string | null;
};

export type MarketIngestSummary = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  symbols: string[];
  intervals: CandleInterval[];
  candlesFetched: number;
  candlesStored: number;
  newsStored: number;
  gapsFound: number;
  gapsRestored: number;
  worked: boolean;
  operations: MarketIngestOperation[];
  failures: { sourceId: string; subject: string; reason: string }[];
  skipped: { sourceId: string; subject: string; reason: string }[];
  health: MarketDataSourceHealth[];
};

export type MarketBackfillSummary = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  gapsFound: number;
  gapsRestored: number;
  worked: boolean;
  operations: MarketIngestOperation[];
  failures: { sourceId: string; subject: string; reason: string }[];
  health: MarketDataSourceHealth[];
};

function emptySummary(startedAt: Date): MarketIngestSummary {
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    durationMs: 0,
    symbols: [],
    intervals: [],
    candlesFetched: 0,
    candlesStored: 0,
    newsStored: 0,
    gapsFound: 0,
    gapsRestored: 0,
    worked: false,
    operations: [],
    failures: [],
    skipped: [],
    health: [],
  };
}

function failureReason(result: { reason?: string }): string {
  return result.reason ?? "provider-error";
}

/**
 * Refresh the candles the screener reads and the news the market pages show.
 *
 * Every symbol/interval and every news source is an independent operation. The
 * order is not significant and a failure is recorded, not thrown: a run that
 * lost Coinbase still stores every RSS feed it could read, and the summary says
 * exactly which source failed and why.
 */
export async function runMarketIngest(
  options: {
    now?: Date;
    symbols?: readonly string[];
    intervals?: readonly CandleInterval[];
    candleProvider?: MarketDataProvider;
    newsProviders?: readonly MarketDataProvider[];
    store?: CandleIngestStore;
    health?: MarketDataHealthRegistry;
    includeNews?: boolean;
    includeBackfill?: boolean;
  } = {},
): Promise<MarketIngestSummary> {
  const startedAt = options.now ?? new Date();
  const clock = () => Date.now();
  const health = options.health ?? marketDataHealth();
  const store = options.store ?? (await import("@/lib/market-data/candle-store")).createPrismaCandleIngestStore();
  const candleProvider =
    options.candleProvider ??
    (await import("@/lib/market-data/coinbase-service")).coinbaseMarketDataProvider;
  const symbols = [...new Set(options.symbols ?? USD_WATCHLIST.map(({ productId }) => productId))];
  const intervals = [...new Set(options.intervals ?? INGESTED_INTERVALS)];
  const includeNews = options.includeNews ?? true;
  const includeBackfill = options.includeBackfill ?? true;
  const summary = emptySummary(startedAt);
  summary.symbols = symbols;
  summary.intervals = intervals;

  for (const symbol of symbols) {
    if (health.isCoolingDown(candleProvider.id, startedAt)) {
      summary.skipped.push({
        sourceId: candleProvider.id,
        subject: symbol,
        reason: "cooling down after repeated failures",
      });
      break;
    }
    for (const interval of intervals) {
      const window = closedCandleWindow(interval, startedAt);
      const result = await ingestCandleSeries({
        provider: candleProvider,
        store,
        health,
        symbol,
        interval,
        window,
        now: startedAt,
      });
      summary.candlesFetched += result.fetched;
      summary.candlesStored += result.written;
      summary.operations.push({
        sourceId: candleProvider.id,
        kind: "candles",
        subject: `${symbol} ${interval}`,
        ok: result.status === "ok",
        skipped: false,
        fetched: result.fetched,
        written: result.written,
        durationMs: result.durationMs,
        reason: result.status === "ok" ? null : result.reason,
      });
      if (result.status !== "ok") {
        summary.failures.push({
          sourceId: candleProvider.id,
          subject: `${symbol} ${interval}`,
          reason: result.reason,
        });
      }

      if (includeBackfill) {
        const backfill = await backfillCandleGaps({
          provider: candleProvider,
          store,
          health,
          symbol,
          interval,
          window,
          now: startedAt,
        });
        summary.gapsFound += backfill.gaps.length;
        summary.gapsRestored += backfill.restored;
        if (backfill.gaps.length > 0) {
          summary.operations.push({
            sourceId: candleProvider.id,
            kind: "backfill",
            subject: `${symbol} ${interval}`,
            ok: backfill.status !== "unavailable",
            skipped: false,
            fetched: 0,
            written: backfill.restored,
            durationMs: 0,
            reason: backfill.reason ?? null,
          });
        }
        if (backfill.status === "unavailable") {
          summary.failures.push({
            sourceId: candleProvider.id,
            subject: `${symbol} ${interval} backfill`,
            reason: failureReason(backfill),
          });
        }
      }
    }
  }

  if (includeNews) {
    const newsProviders =
      options.newsProviders ?? (await import("@/lib/market-data/rss-feeds")).FINANCIAL_RSS_PROVIDERS;
    for (const provider of newsProviders) {
      if (health.isCoolingDown(provider.id, startedAt)) {
        summary.skipped.push({
          sourceId: provider.id,
          subject: "news",
          reason: "cooling down after repeated failures",
        });
        continue;
      }
      const opStarted = clock();
      try {
        const result = await provider.getNews({ limit: 30 });
        const durationMs = clock() - opStarted;
        if (result.status !== "available") {
          health.recordFailure(provider.id, result.reason, durationMs, startedAt);
          summary.operations.push({
            sourceId: provider.id,
            kind: "news",
            subject: "news",
            ok: false,
            skipped: false,
            fetched: 0,
            written: 0,
            durationMs,
            reason: result.reason,
          });
          summary.failures.push({ sourceId: provider.id, subject: "news", reason: result.reason });
          continue;
        }
        const written = await store.upsertNews(result.data);
        health.recordSuccess(provider.id, durationMs, startedAt);
        summary.newsStored += written;
        summary.operations.push({
          sourceId: provider.id,
          kind: "news",
          subject: "news",
          ok: true,
          skipped: false,
          fetched: result.data.length,
          written,
          durationMs,
          reason: null,
        });
      } catch {
        const durationMs = clock() - opStarted;
        health.recordFailure(provider.id, "provider-error", durationMs, startedAt);
        summary.operations.push({
          sourceId: provider.id,
          kind: "news",
          subject: "news",
          ok: false,
          skipped: false,
          fetched: 0,
          written: 0,
          durationMs,
          reason: "provider-error",
        });
        summary.failures.push({ sourceId: provider.id, subject: "news", reason: "provider-error" });
      }
    }
  }

  const finishedAt = new Date();
  summary.finishedAt = finishedAt.toISOString();
  summary.durationMs = finishedAt.getTime() - startedAt.getTime();
  summary.health = health.snapshot();
  summary.worked = summary.candlesStored > 0 || summary.newsStored > 0 || summary.gapsRestored > 0;
  return summary;
}

/**
 * Check every maintained series for missing slots and fill them.
 *
 * This is the recovery job: it fetches nothing when the stored history is
 * complete, so its cost is a set of indexed reads. It is also the job a test can
 * drive with a deliberately deleted range.
 */
export async function runMarketBackfill(
  options: {
    now?: Date;
    symbols?: readonly string[];
    intervals?: readonly CandleInterval[];
    candleProvider?: MarketDataProvider;
    store?: CandleIngestStore;
    health?: MarketDataHealthRegistry;
  } = {},
): Promise<MarketBackfillSummary> {
  const startedAt = options.now ?? new Date();
  const health = options.health ?? marketDataHealth();
  const store = options.store ?? (await import("@/lib/market-data/candle-store")).createPrismaCandleIngestStore();
  const candleProvider =
    options.candleProvider ??
    (await import("@/lib/market-data/coinbase-service")).coinbaseMarketDataProvider;
  const symbols = [...new Set(options.symbols ?? USD_WATCHLIST.map(({ productId }) => productId))];
  const intervals = [...new Set(options.intervals ?? INGESTED_INTERVALS)];
  const summary: MarketBackfillSummary = {
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    durationMs: 0,
    gapsFound: 0,
    gapsRestored: 0,
    worked: false,
    operations: [],
    failures: [],
    health: [],
  };

  outer: for (const symbol of symbols) {
    for (const interval of intervals) {
      if (health.isCoolingDown(candleProvider.id, startedAt)) break outer;
      const window = closedCandleWindow(interval, startedAt);
      const result = await backfillCandleGaps({
        provider: candleProvider,
        store,
        health,
        symbol,
        interval,
        window,
        now: startedAt,
      });
      if (result.gaps.length === 0 && result.status === "no-gaps") continue;
      summary.gapsFound += result.gaps.length;
      summary.gapsRestored += result.restored;
      summary.operations.push({
        sourceId: candleProvider.id,
        kind: "backfill",
        subject: `${symbol} ${interval}`,
        ok: result.status !== "unavailable",
        skipped: false,
        fetched: result.restored,
        written: result.restored,
        durationMs: 0,
        reason: result.reason ?? null,
      });
      if (result.status === "unavailable") {
        summary.failures.push({
          sourceId: candleProvider.id,
          subject: `${symbol} ${interval}`,
          reason: failureReason(result),
        });
      }
    }
  }

  const finishedAt = new Date();
  summary.finishedAt = finishedAt.toISOString();
  summary.durationMs = finishedAt.getTime() - startedAt.getTime();
  summary.health = health.snapshot();
  summary.worked = summary.gapsRestored > 0;
  return summary;
}
