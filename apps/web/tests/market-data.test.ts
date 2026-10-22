import assert from "node:assert/strict";
import test from "node:test";
import { MarketCache } from "../src/lib/market-data/cache";
import { MarketDataService } from "../src/lib/market-data/service";
import { calculateRsi } from "../src/lib/market-data/indicators";
import { buildYearMarketReport } from "../src/lib/market-data/year-report";
import { CoinbasePublicMarketDataProvider, COINBASE_REST_BASE_URL } from "../src/lib/market-data/providers/coinbase";
import { CointelegraphRssProvider, PublicRssProvider } from "../src/lib/market-data/providers/cointelegraph-rss";
import { USD_WATCHLIST } from "../src/lib/market-data/watchlist";
import type { MarketDataProvider, MarketDataResult } from "../src/lib/market-data/provider";

test("one-year market report calculates exact close change, high, low, and volume", () => {
  const report = buildYearMarketReport([
    { openTime: new Date("2025-10-14T00:00:00.000Z"), high: "12", low: "8", close: "10", volume: "1.25" },
    { openTime: new Date("2026-10-13T00:00:00.000Z"), high: "15", low: "9", close: "12", volume: "2.75" },
  ]);

  assert.deepEqual(report, {
    bars: 2,
    startDate: "2025-10-14",
    endDate: "2026-10-13",
    startClose: "10",
    endClose: "12",
    periodChangePercent: "20.00",
    high: "15",
    low: "8",
    volume: "4",
  });
});

test("one-year market report stays unavailable for insufficient or invalid candles", () => {
  assert.equal(buildYearMarketReport([
    { openTime: new Date("2026-10-13T00:00:00.000Z"), high: "12", low: "8", close: "10", volume: "1" },
  ]), null);
  assert.equal(buildYearMarketReport([
    { openTime: new Date("2025-10-14T00:00:00.000Z"), high: "12", low: "8", close: "0", volume: "1" },
    { openTime: new Date("2026-10-13T00:00:00.000Z"), high: "12", low: "8", close: "10", volume: "1" },
  ]), null);
});

test("curated USD watchlist contains ten unique Coinbase products", () => {
  const productIds = USD_WATCHLIST.map(({ productId }) => productId);
  assert.equal(productIds.length, 10);
  assert.equal(new Set(productIds).size, 10);
  assert.ok(productIds.every((productId) => /^[A-Z0-9]+-USD$/.test(productId)));
});

test("Wilder RSI handles gains, losses, flat prices, and smoothing", () => {
  assert.equal(calculateRsi([1, 2, 1, 2], 2), 75);
  assert.equal(calculateRsi([5, 5, 5, 5], 3), 50);
  assert.equal(calculateRsi([1, 2, 3, 4], 3), 100);
  assert.equal(calculateRsi([4, 3, 2, 1], 3), 0);
});

test("Wilder RSI rejects insufficient, invalid, and non-positive input", () => {
  assert.equal(calculateRsi([1, 2, 3], 3), null);
  assert.equal(calculateRsi([1, 2, Number.NaN, 4], 2), null);
  assert.equal(calculateRsi([1, 2, 3], 0), null);
  assert.equal(calculateRsi([1, 2, 0, 4], 2), null);
});

test("market provider distinguishes unavailable data from an empty successful response", async () => {
  const provider: MarketDataProvider = {
    id: "unconfigured",
    async getQuotes() {
      return { status: "unavailable", reason: "not-configured", retryable: false };
    },
    async getCandles() {
      return { status: "unavailable", reason: "not-configured", retryable: false };
    },
    async getNews() {
      return { status: "unavailable", reason: "not-configured", retryable: false };
    },
  };

  assert.deepEqual(await provider.getQuotes({ instruments: [] }), {
    status: "unavailable",
    reason: "not-configured",
    retryable: false,
  });
  assert.deepEqual(await provider.getCandles({ instrument: "", interval: "1h", from: "", to: "" }), {
    status: "unavailable",
    reason: "not-configured",
    retryable: false,
  });
  assert.deepEqual(await provider.getNews({}), {
    status: "unavailable",
    reason: "not-configured",
    retryable: false,
  });

  const emptySuccess: MarketDataResult<never> = { status: "available", data: [] };
  assert.deepEqual(emptySuccess, { status: "available", data: [] });
});

test("market cache returns unexpired results and discards them after a failed refresh", async () => {
  const cache = new MarketCache<string>();
  let currentTime = 1_000;
  let fetchCount = 0;
  const load = async (): Promise<MarketDataResult<string>> => {
    fetchCount += 1;
    return { status: "available", data: ["observed"] };
  };

  assert.deepEqual(await cache.get("BTC-USD", load, 100, () => currentTime), { status: "available", data: ["observed"] });
  currentTime = 1_050;
  assert.deepEqual(await cache.get("BTC-USD", load, 100, () => currentTime), { status: "available", data: ["observed"] });
  assert.equal(fetchCount, 1);

  currentTime = 1_100;
  const unavailable: MarketDataResult<string> = {
    status: "unavailable",
    reason: "rate-limited",
    retryable: true,
  };
  assert.deepEqual(await cache.get("BTC-USD", async () => unavailable, 100, () => currentTime), unavailable);
  assert.deepEqual(
    await cache.get("BTC-USD", async () => {
      throw new Error("provider failure");
    }, 100, () => currentTime),
    { status: "unavailable", reason: "provider-error", retryable: true },
  );
});

test("market cache rejects invalid TTLs", async () => {
  const cache = new MarketCache<string>();
  await assert.rejects(cache.get("empty-ttl", async () => ({ status: "available", data: [] }), 0), RangeError);
});

test("market cache isolates query keys and bounds retained entries", async () => {
  const cache = new MarketCache<string>(2);
  let fetchCount = 0;
  const load = (value: string) => async (): Promise<MarketDataResult<string>> => {
    fetchCount += 1;
    return { status: "available", data: [value] };
  };

  assert.deepEqual(await cache.get("BTC-USD", load("btc"), 100), { status: "available", data: ["btc"] });
  assert.deepEqual(await cache.get("ETH-USD", load("eth"), 100), { status: "available", data: ["eth"] });
  assert.deepEqual(await cache.get("BTC-USD", load("wrong"), 100), { status: "available", data: ["btc"] });
  assert.equal(fetchCount, 2);

  await cache.get("SOL-USD", load("sol"), 100);
  await cache.get("BTC-USD", load("btc-refreshed"), 100);
  await cache.get("ETH-USD", load("eth-refreshed"), 100);
  assert.equal(fetchCount, 4);
});

test("market cache coalesces concurrent loads for the same query", async () => {
  const cache = new MarketCache<string>();
  let resolveLoad!: (result: MarketDataResult<string>) => void;
  let fetchCount = 0;
  const load = () => {
    fetchCount += 1;
    return new Promise<MarketDataResult<string>>((resolve) => {
      resolveLoad = resolve;
    });
  };

  const first = cache.get("BTC-USD", load, 100);
  const second = cache.get("BTC-USD", load, 100);
  resolveLoad({ status: "available", data: ["btc"] });
  assert.deepEqual(await Promise.all([first, second]), [
    { status: "available", data: ["btc"] },
    { status: "available", data: ["btc"] },
  ]);
  assert.equal(fetchCount, 1);
});

test("market data service stays unavailable without a provider and caches each query kind", async () => {
  let quoteCalls = 0;
  const provider: MarketDataProvider = {
    id: "test-provider",
    async getQuotes() {
      quoteCalls += 1;
      return { status: "available", data: [] };
    },
    async getCandles() {
      return { status: "available", data: [] };
    },
    async getNews() {
      return { status: "available", data: [] };
    },
  };
  const ttl = { quotesMs: 1_000, candlesMs: 1_000, newsMs: 1_000 };
  const disconnected = new MarketDataService(null, ttl);
  assert.deepEqual(await disconnected.getQuotes({ instruments: ["BTC-USD"] }), {
    status: "unavailable",
    reason: "not-configured",
    retryable: false,
  });

  const service = new MarketDataService(provider, ttl);
  const request = { instruments: ["BTC-USD"] };
  assert.deepEqual(await service.getQuotes(request), { status: "available", data: [] });
  assert.deepEqual(await service.getQuotes(request), { status: "available", data: [] });
  assert.equal(quoteCalls, 1);
  assert.deepEqual(await service.getQuotes({ instruments: ["ETH-USD"] }), { status: "available", data: [] });
  assert.equal(quoteCalls, 2);
  service.clearCache();
  assert.deepEqual(await service.getQuotes(request), { status: "available", data: [] });
  assert.equal(quoteCalls, 3);
});

test("a cached market value is tied to its provider, its as-of and its freshness window", async () => {
  // The property the key exists for: a value from an earlier window is never
  // returned as a current one, and two questions about different moments are two
  // entries rather than one answer pretending to cover both.
  let clock = 0;
  let calls = 0;
  const service = new MarketDataService(
    {
      id: "provider-a",
      async getQuotes() {
        calls += 1;
        return { status: "available", data: [] };
      },
      async getCandles() {
        calls += 1;
        return { status: "available", data: [] };
      },
      async getNews() {
        calls += 1;
        return { status: "available", data: [] };
      },
    },
    { quotesMs: 1_000, candlesMs: 1_000, newsMs: 1_000 },
    () => clock,
  );

  await service.getQuotes({ instruments: ["BTC-USD"] });
  await service.getQuotes({ instruments: ["BTC-USD"] });
  assert.equal(calls, 1, "the same question in the same window is one call");

  clock = 999;
  await service.getQuotes({ instruments: ["BTC-USD"] });
  assert.equal(calls, 1, "the same window still answers from the cache");

  clock = 1_000;
  await service.getQuotes({ instruments: ["BTC-USD"] });
  assert.equal(calls, 2, "a value from the previous window is not served as current");

  const first = { instrument: "BTC-USD", interval: "1d" as const, from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z" };
  await service.getCandles(first);
  await service.getCandles(first);
  assert.equal(calls, 3);
  await service.getCandles({ ...first, to: "2026-10-03T00:00:00.000Z" });
  assert.equal(calls, 4, "a candle range is part of the key: another as-of is another question");
});

test("Coinbase public provider maps the approved level-one book with timestamp and response hash", async () => {
  const fetcher: typeof fetch = async (input) => {
    assert.equal(String(input), `${COINBASE_REST_BASE_URL}/products/BTC-USD/book?level=1`);
    return Response.json({
      bids: [["83092.86", "0.01", 3]],
      asks: [["83092.88", "0.02", 4]],
      sequence: 12_345,
      auction_mode: false,
      auction: null,
      time: "2026-10-13T19:17:10.562Z",
    });
  };
  const provider = new CoinbasePublicMarketDataProvider(fetcher);
  const result = await provider.getQuotes({ instruments: ["BTC-USD"] });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  const quote = result.data[0];
  assert.ok(quote);
  assert.deepEqual(
    {
      instrument: quote.instrument,
      bid: quote.bid,
      ask: quote.ask,
      last: quote.last,
      baseVolume24h: quote.baseVolume24h,
      priceChangePercent24h: quote.priceChangePercent24h,
    },
    {
      instrument: { id: "BTC-USD", symbol: "BTC-USD", baseAsset: "BTC", quoteAsset: "USD" },
      bid: "83092.86",
      ask: "83092.88",
      last: null,
      baseVolume24h: null,
      priceChangePercent24h: null,
    },
  );
  assert.equal(quote.provenance.providerId, "coinbase-exchange");
  assert.equal(quote.provenance.endpointOrigin, COINBASE_REST_BASE_URL);
  assert.equal(quote.provenance.observedAt, "2026-10-13T19:17:10.562Z");
  assert.equal(quote.provenance.freshness, "STALE");
  assert.match(quote.provenance.fetchedAt, /^2026-\d{2}-\d{2}T/);
  assert.match(quote.provenance.responseHash ?? "", /^[a-f0-9]{64}$/);
});

test("Coinbase candle adapter parses production candles and aggregates four-hour values exactly", async () => {
  const rows = [
    [Date.parse("2026-10-13T08:00:00.000Z") / 1_000, "10.10", "10.40", "10.20", "10.30", "1.10"],
    [Date.parse("2026-10-13T09:00:00.000Z") / 1_000, "10.00", "10.50", "10.30", "10.10", "0.20"],
    [Date.parse("2026-10-13T10:00:00.000Z") / 1_000, "10.05", "10.35", "10.10", "10.25", "0.30"],
    [Date.parse("2026-10-13T11:00:00.000Z") / 1_000, "10.15", "10.60", "10.25", "10.55", "0.40"],
  ];
  const fetcher: typeof fetch = async () => Response.json(rows);
  const provider = new CoinbasePublicMarketDataProvider(fetcher);
  const result = await provider.getCandles({
    instrument: "BTC-USD",
    interval: "4h",
    from: "2026-10-13T08:00:00.000Z",
    to: "2026-10-13T12:00:00.000Z",
  });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0]?.provenance.freshness, "DELAYED");
  assert.deepEqual(
    result.data.map(({ open, high, low, close, volume }) => ({ open, high, low, close, volume })),
    [{ open: "10.20", high: "10.6", low: "10", close: "10.55", volume: "2" }],
  );
});

test("Coinbase candle parser preserves high precision numeric JSON tokens", async () => {
  const timestamp = Date.parse("2026-10-13T08:00:00.000Z") / 1_000;
  const wireResponse = `[[${timestamp},0.000000240123456789,0.000000250123456789,0.000000245123456789,0.000000248123456789,12.000000000000000123]]`;
  const provider = new CoinbasePublicMarketDataProvider(async () => new Response(wireResponse));
  const result = await provider.getCandles({
    instrument: "BTC-USD",
    interval: "1h",
    from: "2026-10-13T08:00:00.000Z",
    to: "2026-10-13T09:00:00.000Z",
  });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.deepEqual(
    result.data.map(({ low, high, open, close, volume }) => ({ low, high, open, close, volume })),
    [{
      low: "0.000000240123456789",
      high: "0.000000250123456789",
      open: "0.000000245123456789",
      close: "0.000000248123456789",
      volume: "12.000000000000000123",
    }],
  );
});

test("Coinbase provider rejects invalid products and reports rate limiting without throwing", async () => {
  let fetchCount = 0;
  const provider = new CoinbasePublicMarketDataProvider(async () => {
    fetchCount += 1;
    return new Response("", { status: 429 });
  });
  assert.deepEqual(await provider.getQuotes({ instruments: ["btc-usd"] }), {
    status: "unavailable",
    reason: "invalid-response",
    retryable: false,
  });
  assert.equal(fetchCount, 0);
  assert.deepEqual(await provider.getQuotes({ instruments: ["BTC-USD"] }), {
    status: "unavailable",
    reason: "rate-limited",
    retryable: true,
  });
});

test("Coinbase Status RSS returns attributed delayed notices and filters non-first-party links", async () => {
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Coinbase Exchange Status - Incident History</title><item><title>Upcoming Trading Suspension: BTC-USD</title><link>https://status.exchange.coinbase.com/incidents/example</link><guid>incident-1</guid><pubDate>Tue, 13 Oct 2026 18:00:00 GMT</pubDate></item><item><title>Untrusted link</title><link>https://example.com/news</link><guid>incident-2</guid><pubDate>Tue, 13 Oct 2026 19:00:00 GMT</pubDate></item></channel></rss>`;
  const provider = new CoinbasePublicMarketDataProvider(async (input) => {
    assert.equal(String(input), "https://status.exchange.coinbase.com/history.rss");
    return new Response(feed, { headers: { "Content-Type": "application/rss+xml" } });
  });

  const result = await provider.getNews({ limit: 10 });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.data.length, 1);
  assert.deepEqual(result.data[0], {
    title: "Upcoming Trading Suspension: BTC-USD",
    sourceName: "Coinbase Exchange Status - Incident History",
    url: "https://status.exchange.coinbase.com/incidents/example",
    imageUrl: null,
    publishedAt: "2026-10-13T18:00:00.000Z",
    contentHash: result.data[0]?.contentHash,
    provenance: {
      providerId: "coinbase-exchange-status",
      providerName: "Coinbase Exchange Status - Incident History",
      endpointOrigin: "https://status.exchange.coinbase.com",
      observedAt: "2026-10-13T18:00:00.000Z",
      fetchedAt: result.data[0]?.provenance.fetchedAt,
      freshness: "DELAYED",
      responseHash: result.data[0]?.provenance.responseHash,
    },
  });
  assert.match(result.data[0]?.contentHash ?? "", /^[a-f0-9]{64}$/);
  assert.match(result.data[0]?.provenance.responseHash ?? "", /^[a-f0-9]{64}$/);
});

test("Cointelegraph RSS stores only metadata and rejects non-first-party article URLs", async () => {
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Cointelegraph.com News</title><item><title>Bitcoin market update</title><link>https://cointelegraph.com/markets/example</link><description>Article body must not be stored.</description><pubDate>Tue, 13 Oct 2026 19:00:00 +0000</pubDate></item><item><title>External article</title><link>https://example.com/story</link><pubDate>Tue, 13 Oct 2026 19:01:00 +0000</pubDate></item></channel></rss>`;
  const provider = new CointelegraphRssProvider(async (input) => {
    assert.equal(String(input), "https://cointelegraph.com/rss");
    return new Response(feed, { headers: { "Content-Type": "application/rss+xml" } });
  });

  const result = await provider.getNews({ limit: 10 });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.data.length, 1);
  assert.deepEqual(
    result.data.map(({ title, sourceName, url, publishedAt, provenance }) => ({
      title,
      sourceName,
      url,
      publishedAt,
      providerId: provenance.providerId,
      freshness: provenance.freshness,
    })),
    [{
      title: "Bitcoin market update",
      sourceName: "Cointelegraph",
      url: "https://cointelegraph.com/markets/example",
      publishedAt: "2026-10-13T19:00:00.000Z",
      providerId: "cointelegraph-rss",
      freshness: "DELAYED",
    }],
  );
  assert.equal("description" in result.data[0]!, false);
});

test("RSS image extraction keeps only HTTPS assets from explicitly allowed publisher hosts", async () => {
  const feed = `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Bitcoinist</title><item><title>Market update</title><link>https://bitcoinist.com/market-update</link><media:content url="https://untrusted.example/story.jpg" medium="image"/><media:content url="https://images.bitcoinist.com/story.jpg?width=640" medium="image"/><pubDate>Tue, 13 Oct 2026 19:00:00 +0000</pubDate></item></channel></rss>`;
  const provider = new PublicRssProvider({
    id: "bitcoinist-rss",
    sourceName: "Bitcoinist",
    url: "https://bitcoinist.com/feed/",
    allowedItemHosts: ["bitcoinist.com"],
    allowedImageHosts: ["images.bitcoinist.com"],
  }, async () => new Response(feed, { headers: { "Content-Type": "application/rss+xml" } }));

  const result = await provider.getNews({ limit: 10 });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.data[0]?.imageUrl, "https://images.bitcoinist.com/story.jpg");
});