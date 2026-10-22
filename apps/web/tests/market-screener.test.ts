import assert from "node:assert/strict";
import test from "node:test";
import { validateConditionThreshold, validateNewMarketAlert } from "@/lib/alerts/conditions";
import { calculateRsi } from "@/lib/market-data/indicators";
import {
  backfillCandleGaps,
  findCandleGaps,
  ingestCandleSeries,
  runMarketIngest,
  type CandleIngestStore,
} from "@/lib/market-data/ingest";
import { MarketDataHealthRegistry } from "@/lib/market-data/health";
import type {
  CandleInterval,
  CandleRequest,
  MarketCandle,
  MarketDataProvider,
  MarketDataResult,
  MarketNewsItem,
} from "@/lib/market-data/provider";
import { summarizeProviderCalls, type ProviderCallRecord } from "@/lib/observability/provider-call";
import { evaluateScreen, type ScreenerCandle } from "@/lib/screener/evaluate";
import {
  screenAlertInputs,
  screenResultHash,
  validateScreenerDefinition,
} from "@/lib/screener/model";

const STEP = 15 * 60_000;
const START = Date.parse("2026-10-13T00:00:00.000Z");

function candle(symbol: string, openMs: number, close: string, providerId = "coinbase-exchange", interval: CandleInterval = "15m"): MarketCandle {
  return {
    instrument: { id: symbol, symbol, baseAsset: symbol.split("-")[0]!, quoteAsset: "USD" },
    interval,
    openTime: new Date(openMs).toISOString(),
    closeTime: new Date(openMs + (interval === "1d" ? 86_400_000 : STEP)).toISOString(),
    open: close,
    high: close,
    low: close,
    close,
    volume: "1",
    provenance: {
      providerId,
      providerName: "Test feed",
      endpointOrigin: "https://example.test",
      observedAt: new Date(openMs).toISOString(),
      fetchedAt: new Date(openMs + 1_000).toISOString(),
      freshness: "DELAYED",
      responseHash: "a".repeat(64),
    },
  };
}

class MemoryCandleStore implements CandleIngestStore {
  readonly candles = new Map<string, MarketCandle>();
  readonly news = new Map<string, MarketNewsItem>();
  writes = 0;

  private key(candle: MarketCandle): string {
    return [candle.provenance.providerId, candle.instrument.symbol, candle.interval, candle.openTime].join("|");
  }

  async openTimes(input: { providerId: string; symbol: string; interval: CandleInterval; from: Date; to: Date }): Promise<Date[]> {
    return [...this.candles.values()]
      .filter(
        (entry) =>
          entry.provenance.providerId === input.providerId &&
          entry.instrument.symbol === input.symbol &&
          entry.interval === input.interval &&
          Date.parse(entry.openTime) >= input.from.getTime() &&
          Date.parse(entry.openTime) < input.to.getTime(),
      )
      .map((entry) => new Date(entry.openTime));
  }

  async upsertCandles(candles: readonly MarketCandle[]): Promise<number> {
    this.writes += candles.length;
    for (const entry of candles) this.candles.set(this.key(entry), entry);
    return candles.length;
  }

  async upsertNews(items: readonly MarketNewsItem[]): Promise<number> {
    for (const item of items) this.news.set(`${item.provenance.providerId}|${item.url}`, item);
    return items.length;
  }

  removeRange(symbol: string, fromMs: number, count: number): void {
    for (let index = 0; index < count; index += 1) {
      this.candles.delete(["coinbase-exchange", symbol, "15m", new Date(fromMs + index * STEP).toISOString()].join("|"));
    }
  }
}

type CandleFake = MarketDataProvider & { calls: { from: number; to: number }[] };

function candleProvider(options: { fail?: boolean; rows?: MarketCandle[]; id?: string } = {}): CandleFake {
  const calls: { from: number; to: number }[] = [];
  return {
    id: options.id ?? "coinbase-exchange",
    calls,
    async getQuotes() {
      return { status: "available", data: [] };
    },
    async getNews() {
      return { status: "available", data: [] };
    },
    async getCandles(request: CandleRequest): Promise<MarketDataResult<MarketCandle>> {
      calls.push({ from: Date.parse(request.from), to: Date.parse(request.to) });
      if (options.fail) return { status: "unavailable", reason: "provider-error", retryable: true };
      if (options.rows) return { status: "available", data: options.rows };
      const rows: MarketCandle[] = [];
      const step = request.interval === "1d" ? 86_400_000 : STEP;
      for (let cursor = Math.ceil(Date.parse(request.from) / step) * step; cursor < Date.parse(request.to); cursor += step) {
        rows.push(candle(request.instrument, cursor, "100", options.id, request.interval));
      }
      return { status: "available", data: rows };
    },
  };
}

function newsProvider(id: string, options: { fail?: boolean; count?: number } = {}): MarketDataProvider {
  return {
    id,
    async getQuotes() {
      return { status: "available", data: [] };
    },
    async getCandles() {
      return { status: "available", data: [] };
    },
    async getNews() {
      if (options.fail) return { status: "unavailable", reason: "rate-limited", retryable: true };
      const count = options.count ?? 2;
      return {
        status: "available",
        data: Array.from({ length: count }, (_, index) => ({
          title: `${id} headline ${index}`,
          sourceName: id,
          url: `https://example.test/${id}/${index}`,
          imageUrl: null,
          publishedAt: new Date(START + index * 60_000).toISOString(),
          contentHash: `${index}`.padStart(64, "b"),
          provenance: {
            providerId: id,
            providerName: id,
            endpointOrigin: "https://example.test",
            observedAt: null,
            fetchedAt: new Date(START).toISOString(),
            freshness: "DELAYED" as const,
            responseHash: "c".repeat(64),
          },
        })),
      };
    },
  };
}

test("a deleted candle range is restored exactly and a second backfill asks for nothing", async () => {
  const store = new MemoryCandleStore();
  const provider = candleProvider();
  const health = new MarketDataHealthRegistry();
  const from = new Date(START);
  const to = new Date(START + 12 * STEP);
  for (let index = 0; index < 12; index += 1) {
    await store.upsertCandles([candle("BTC-USD", START + index * STEP, "100")]);
  }
  assert.equal(store.candles.size, 12);
  store.removeRange("BTC-USD", START + 4 * STEP, 4);
  assert.equal(store.candles.size, 8);

  const first = await backfillCandleGaps({
    provider,
    store,
    health,
    symbol: "BTC-USD",
    interval: "15m",
    window: { from, to },
  });

  assert.equal(first.status, "restored");
  assert.equal(first.gaps.length, 1);
  assert.equal(first.gaps[0]?.from.toISOString(), new Date(START + 4 * STEP).toISOString());
  assert.equal(first.gaps[0]?.to.toISOString(), new Date(START + 8 * STEP).toISOString());
  assert.equal(first.restored, 4);
  assert.equal(store.candles.size, 12, "the deleted range is restored without a duplicate row");
  assert.equal(new Set(store.candles.keys()).size, 12);
  assert.deepEqual(provider.calls, [{ from: START + 4 * STEP, to: START + 8 * STEP }], "only the missing range is requested");

  const second = await backfillCandleGaps({
    provider,
    store,
    health,
    symbol: "BTC-USD",
    interval: "15m",
    window: { from, to },
  });
  assert.equal(second.status, "no-gaps");
  assert.equal(second.restored, 0);
  assert.equal(provider.calls.length, 1, "a complete series costs no provider call");
  assert.equal(store.candles.size, 12);
});

test("ingesting the same window twice updates rows instead of duplicating them", async () => {
  const store = new MemoryCandleStore();
  const healthy = new MarketDataHealthRegistry();
  const provider = candleProvider();
  const window = { from: new Date(START), to: new Date(START + 8 * STEP) };

  for (let run = 0; run < 2; run += 1) {
    const result = await ingestCandleSeries({
      provider,
      store,
      health: healthy,
      symbol: "BTC-USD",
      interval: "15m",
      window,
    });
    assert.equal(result.status, "ok");
    assert.equal(result.fetched, 8);
    assert.equal(result.written, 8);
  }

  assert.equal(store.candles.size, 8, "the second run updates the same eight rows");
  assert.equal(store.writes, 16, "both runs wrote, but the key is what bounds the table");
  assert.equal(healthy.snapshot()[0]?.successCount, 2);

  const duplicateBatch = [candle("BTC-USD", START, "100"), candle("BTC-USD", START, "101")];
  await store.upsertCandles(duplicateBatch);
  assert.equal(store.candles.size, 8);
});

test("gap detection groups consecutive slots and ignores a still-forming candle", () => {
  const existing = [START, START + STEP, START + 3 * STEP].map((value) => new Date(value));
  const gaps = findCandleGaps({
    existing,
    from: new Date(START),
    to: new Date(START + 4 * STEP),
    interval: "15m",
  });
  assert.deepEqual(
    gaps.map((gap) => [gap.from.getTime(), gap.to.getTime()]),
    [[START + 2 * STEP, START + 3 * STEP]],
  );

  // A window ending at 12:07 expects its last slot at 11:45; 12:00 is not yet closed.
  const closed = findCandleGaps({
    existing: [],
    from: new Date(Date.parse("2026-10-13T11:45:00.000Z")),
    to: new Date(Date.parse("2026-10-13T12:07:00.000Z")),
    interval: "15m",
  });
  assert.deepEqual(closed.map((gap) => gap.from.toISOString()), ["2026-10-13T11:45:00.000Z"]);
});

test("one failing provider does not block another, and the run names the failure", async () => {
  const store = new MemoryCandleStore();
  const health = new MarketDataHealthRegistry();
  const failingCandles = candleProvider({ fail: true });
  const failingNews = newsProvider("broken-rss", { fail: true });
  const healthyNews = newsProvider("healthy-rss", { count: 3 });

  const summary = await runMarketIngest({
    now: new Date(START + 12 * 60 * 60_000),
    symbols: ["BTC-USD"],
    intervals: ["15m"],
    candleProvider: failingCandles,
    newsProviders: [failingNews, healthyNews],
    store,
    health,
    includeNews: true,
    includeBackfill: false,
  });

  assert.equal(summary.candlesStored, 0);
  assert.equal(summary.newsStored, 3, "the healthy feed still stores its headlines");
  assert.equal(store.news.size, 3);
  assert.equal(summary.worked, true);
  assert.ok(summary.failures.some((failure) => failure.sourceId === "coinbase-exchange"));
  assert.ok(summary.failures.some((failure) => failure.sourceId === "broken-rss"));

  const candleHealth = summary.health.find((entry) => entry.sourceId === "coinbase-exchange");
  assert.equal(candleHealth?.failureCount, 1);
  assert.equal(candleHealth?.errorRate, 1);
  const healthyHealth = summary.health.find((entry) => entry.sourceId === "healthy-rss");
  assert.equal(healthyHealth?.successCount, 1);
  assert.equal(healthyHealth?.errorRate, 0);
});

test("a repeatedly failing source cools down and is skipped on the next run", async () => {
  const health = new MarketDataHealthRegistry();
  const now = new Date(START);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const summary = await runMarketIngest({
      now,
      symbols: ["BTC-USD"],
      intervals: ["15m"],
      candleProvider: candleProvider({ fail: true }),
      newsProviders: [],
      store: new MemoryCandleStore(),
      health,
      includeNews: false,
      includeBackfill: false,
    });
    assert.equal(summary.candlesStored, 0);
  }
  assert.equal(health.isCoolingDown("coinbase-exchange", now), true);

  const skipped = await runMarketIngest({
    now,
    symbols: ["BTC-USD"],
    intervals: ["15m"],
    candleProvider: candleProvider({ fail: true }),
    newsProviders: [],
    store: new MemoryCandleStore(),
    health,
    includeNews: false,
    includeBackfill: false,
  });
  assert.equal(skipped.skipped.length, 1);
  assert.match(skipped.skipped[0]?.reason ?? "", /cooling down/);
  assert.equal(skipped.operations.length, 0, "the cooled-down source is not called");

  health.recordSuccess("coinbase-exchange", 5, now);
  assert.equal(health.isCoolingDown("coinbase-exchange", now), false);
});

test("retained provider calls produce average latency and error rate", () => {
  const call = (durationMs: number, outcome: "ok" | "provider-error", occurredAt: string): ProviderCallRecord => ({
    providerId: "coinbase-exchange",
    method: "GET",
    url: "https://api.exchange.coinbase.com/products/BTC-USD/candles",
    statusCode: outcome === "ok" ? 200 : 500,
    outcome,
    reasonCode: outcome === "ok" ? null : "PROVIDER_ERROR",
    durationMs,
    attempts: 1,
    requestId: null,
    route: null,
    safeMessage: null,
    occurredAt,
  });
  const health = summarizeProviderCalls([
    call(40, "provider-error", "2026-10-13T12:04:00.000Z"),
    call(20, "ok", "2026-10-13T12:03:00.000Z"),
    call(30, "ok", "2026-10-13T12:02:00.000Z"),
    call(10, "ok", "2026-10-13T12:01:00.000Z"),
  ]);
  assert.equal(health.length, 1);
  assert.equal(health[0]?.averageDurationMs, 25);
  assert.equal(health[0]?.maxDurationMs, 40);
  assert.equal(health[0]?.errorRate, 0.25);
  assert.equal(health[0]?.lastOutcome, "provider-error");
  assert.equal(health[0]?.lastSuccessAt, "2026-10-13T12:03:00.000Z");
  assert.equal(health[0]?.lastFailureAt, "2026-10-13T12:04:00.000Z");
});

function rsiCandles(symbol: string, closes: readonly string[]): MarketCandle[] {
  return closes.map((close, index) => candle(symbol, START + index * STEP, close));
}

/** The stored-row shape the screener reads, derived from a provider candle. */
function stored(candles: readonly MarketCandle[]): ScreenerCandle[] {
  return candles.map((entry) => ({
    symbol: entry.instrument.symbol,
    interval: entry.interval,
    openTime: entry.openTime,
    closeTime: entry.closeTime,
    close: entry.close,
    providerId: entry.provenance.providerId,
    fetchedAt: entry.provenance.fetchedAt,
  }));
}

test("a screen evaluates the same data and as-of time to the same rows and hash", () => {
  const candles = stored([
    ...rsiCandles("BTC-USD", Array.from({ length: 20 }, (_, index) => String(100 + index))),
    ...rsiCandles("ETH-USD", Array.from({ length: 20 }, (_, index) => String(50 + index))),
  ]);
  const asOf = new Date(START + 20 * STEP);

  const first = evaluateScreen({
    condition: "PRICE_ABOVE",
    threshold: "110",
    symbols: ["BTC-USD", "ETH-USD", "SOL-USD"],
    candles,
    asOf,
  });
  const replay = evaluateScreen({
    condition: "PRICE_ABOVE",
    threshold: "110",
    symbols: ["BTC-USD", "ETH-USD", "SOL-USD"],
    candles,
    asOf: new Date(asOf),
  });

  assert.deepEqual(first, replay);
  assert.equal(first.resultHash, replay.resultHash);
  assert.equal(first.asOf, asOf.toISOString());
  assert.equal(first.dataAsOf, new Date(START + 19 * STEP + STEP).toISOString());
  assert.deepEqual(first.providerIds, ["coinbase-exchange"]);
  assert.deepEqual(
    first.rows.map((row) => [row.symbol, row.value, row.matched]),
    [
      ["BTC-USD", "119", true],
      ["ETH-USD", "69", false],
      ["SOL-USD", null, false],
    ],
  );
  assert.match(first.rows[2]?.reason ?? "", /No closed 15-minute candle/);

  const earlier = evaluateScreen({
    condition: "PRICE_ABOVE",
    threshold: "110",
    symbols: ["BTC-USD"],
    candles,
    asOf: new Date(START + 19 * STEP),
  });
  assert.equal(earlier.rows[0]?.value, "118", "candles that had not closed by the as-of time are not used");
  assert.notEqual(earlier.resultHash, first.resultHash);
});

test("the screener's RSI comes from the shared indicator module", () => {
  const closes = Array.from({ length: 20 }, (_, index) => 100 + index + (index % 3));
  const candles = stored(rsiCandles("BTC-USD", closes.map(String)));
  const asOf = new Date(START + 20 * STEP);
  const result = evaluateScreen({
    condition: "RSI_14_BELOW",
    threshold: "100",
    symbols: ["BTC-USD"],
    candles,
    asOf,
  });

  const expected = calculateRsi(closes, 14);
  assert.ok(expected !== null);
  assert.ok(Math.abs(Number(result.rows[0]?.value) - expected) < 0.0001);
  assert.equal(result.rows[0]?.matched, true);
  assert.equal(result.rows[0]?.providerId, "coinbase-exchange");
});

test("a screen definition uses the alert condition model and refuses what the alert endpoint refuses", () => {
  const valid = validateScreenerDefinition(
    { condition: "RSI_14_ABOVE", threshold: "70", symbols: ["BTC-USD", "ETH-USD"] },
    { requireName: true },
  );
  assert.equal(valid.valid, false, "a saved screen needs a name");

  const saved = validateScreenerDefinition(
    { name: "Overbought majors", condition: "RSI_14_ABOVE", threshold: "70", symbols: ["BTC-USD", "ETH-USD"] },
    { requireName: true },
  );
  assert.equal(saved.valid, true);
  if (!saved.valid) return;
  assert.deepEqual(saved.value.symbols, ["BTC-USD", "ETH-USD"]);

  assert.equal(validateScreenerDefinition({ condition: "RSI_14_ABOVE", threshold: "101", symbols: ["BTC-USD"] }).valid, false);
  assert.equal(validateScreenerDefinition({ condition: "PRICE_ABOVE", threshold: "10", symbols: ["DOGE-EUR"] }).valid, false);
  assert.equal(validateScreenerDefinition({ condition: "PRICE_ABOVE", threshold: "10", symbols: ["BTC-USD", "BTC-USD"] }).valid, false);
  assert.equal(validateScreenerDefinition({ condition: "PRICE_ABOVE", threshold: "10", symbols: [] }).valid, false);

  const sharedDirect = validateConditionThreshold("RSI_14_ABOVE", "101");
  const alertDirect = validateNewMarketAlert({ symbol: "BTC-USD", condition: "RSI_14_ABOVE", threshold: "101" });
  assert.equal(sharedDirect.valid, false);
  assert.equal(alertDirect.valid, false);
  if (!sharedDirect.valid && !alertDirect.valid) {
    assert.equal(sharedDirect.error, alertDirect.error, "one threshold rule, one refusal sentence");
  }
});

test("only matched symbols become alert inputs, with the screen's own condition", () => {
  const result = {
    condition: "PRICE_ABOVE" as const,
    threshold: "90",
    rows: [
      { symbol: "BTC-USD", matched: true },
      { symbol: "ETH-USD", matched: false },
      { symbol: "SOL-USD", matched: true },
    ],
  };
  assert.deepEqual(screenAlertInputs(result), [
    { symbol: "BTC-USD", condition: "PRICE_ABOVE", threshold: "90" },
    { symbol: "SOL-USD", condition: "PRICE_ABOVE", threshold: "90" },
  ]);
  assert.deepEqual(
    screenAlertInputs({ ...result, rows: result.rows.map((row) => ({ ...row, matched: false })) }),
    [],
  );
});

test("a result hash is stable across row order and changes with the condition", () => {
  const rows = [
    { symbol: "BTC-USD", value: "119", observedAt: "2026-10-13T05:00:00.000Z", matched: true, providerId: "coinbase-exchange" },
    { symbol: "ETH-USD", value: "69", observedAt: "2026-10-13T05:00:00.000Z", matched: false, providerId: "coinbase-exchange" },
  ];
  const forward = screenResultHash({ condition: "PRICE_ABOVE", threshold: "110", rows });
  const reversed = screenResultHash({ condition: "PRICE_ABOVE", threshold: "110", rows: [...rows].reverse() });
  assert.equal(forward, reversed);
  assert.notEqual(
    forward,
    screenResultHash({ condition: "PRICE_BELOW", threshold: "110", rows }),
  );
});
