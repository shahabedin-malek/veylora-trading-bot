import { createHash } from "node:crypto";
import DecimalJS from "decimal.js";
import { isLosslessNumber, parse as parseLosslessJson } from "lossless-json";
import Parser from "rss-parser";
import { COINBASE_REST_BASE_URL, COINBASE_STATUS_FEED_URL } from "@/lib/market-data/coinbase-config";
import type {
  CandleInterval,
  CandleRequest,
  InstrumentReference,
  MarketCandle,
  MarketDataProvider,
  MarketDataResult,
  MarketProvenance,
  MarketQuote,
  NewsRequest,
  QuoteRequest,
  MarketNewsItem,
} from "@/lib/market-data/provider";

export { COINBASE_REST_BASE_URL, COINBASE_WEBSOCKET_URL } from "@/lib/market-data/coinbase-config";

const MAX_PRODUCTS_PER_REQUEST = 20;
const MAX_CANDLE_CHUNKS = 20;
const CANDLE_CHUNK_SIZE = 299;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_NEWS_RESPONSE_BYTES = 1_000_000;
const Decimal = DecimalJS.clone({ precision: 100 });
const INTERVAL_SECONDS: Record<CandleInterval, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3_600,
  "4h": 14_400,
  "1d": 86_400,
};

type CoinbaseResponse<T> = { ok: true; body: T; responseHash: string } | { ok: false; result: MarketDataResult<never> };

type CoinbaseBookLevel = [price: string, size: string, orderCount: unknown];

type CoinbaseBook = {
  bids: CoinbaseBookLevel[];
  asks: CoinbaseBookLevel[];
  sequence: number;
  time: string;
};

type CoinbaseCandle = [number, string, string, string, string, string];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDecimalText(value: unknown): value is string {
  return typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value);
}

function parseProductId(value: string): InstrumentReference | null {
  if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(value)) return null;
  const [baseAsset, quoteAsset] = value.split("-");
  if (!baseAsset || !quoteAsset) return null;
  return { id: value, symbol: value, baseAsset, quoteAsset };
}

function unavailable<T>(reason: "provider-error" | "rate-limited" | "invalid-response", retryable: boolean): MarketDataResult<T> {
  return { status: "unavailable", reason, retryable };
}

async function requestJson<T>(url: URL, fetcher: typeof fetch): Promise<CoinbaseResponse<T>> {
  let response: Response;
  try {
    response = await fetcher(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, result: unavailable("provider-error", true) };
  }

  if (response.status === 429) return { ok: false, result: unavailable("rate-limited", true) };
  if (!response.ok) return { ok: false, result: unavailable("provider-error", response.status >= 500 || response.status === 408) };

  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, result: unavailable("invalid-response", true) };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    return { ok: false, result: unavailable("invalid-response", false) };
  }

  let body: T;
  try {
    body = parseLosslessJson(text) as T;
  } catch {
    return { ok: false, result: unavailable("invalid-response", false) };
  }

  return {
    ok: true,
    body,
    responseHash: createHash("sha256").update(text).digest("hex"),
  };
}

function provenance(url: URL, observedAt: string | null, responseHash: string): MarketProvenance {
  const fetchedAt = new Date().toISOString();
  const observedTime = observedAt ? Date.parse(observedAt) : Number.NaN;
  const freshness = Number.isFinite(observedTime) && Date.now() - observedTime <= 30_000 ? "FRESH" : "STALE";
  return {
    providerId: "coinbase-exchange",
    providerName: "Coinbase Exchange",
    endpointOrigin: url.origin,
    observedAt,
    fetchedAt,
    freshness,
    responseHash,
  };
}

function parseBookLevel(value: unknown): value is CoinbaseBookLevel {
  return Array.isArray(value) && value.length >= 2 && isDecimalText(value[0]) && isDecimalText(value[1]);
}

function parseBook(value: unknown): value is CoinbaseBook {
  return (
    isRecord(value) &&
    Array.isArray(value.bids) && value.bids.length > 0 && value.bids.every(parseBookLevel) &&
    Array.isArray(value.asks) && value.asks.length > 0 && value.asks.every(parseBookLevel) &&
    Number.isSafeInteger(Number(value.sequence)) &&
    typeof value.time === "string" &&
    Number.isFinite(Date.parse(value.time))
  );
}

function decimalToken(value: unknown): string | null {
  if (isDecimalText(value)) return value;
  if (!isLosslessNumber(value)) return null;
  try {
    const decimal = new Decimal(value.toString());
    return decimal.isFinite() ? decimal.toFixed() : null;
  } catch {
    return null;
  }
}

function parseCandle(value: unknown): CoinbaseCandle | null {
  if (!Array.isArray(value) || value.length !== 6) return null;
  const timestampToken = typeof value[0] === "number" || isLosslessNumber(value[0]) ? String(value[0]) : "";
  const timestamp = Number(timestampToken);
  if (!/^\d+$/.test(timestampToken) || !Number.isSafeInteger(timestamp)) return null;

  const decimals = value.slice(1).map(decimalToken);
  if (decimals.some((decimal) => decimal === null)) return null;
  return [timestamp, decimals[0]!, decimals[1]!, decimals[2]!, decimals[3]!, decimals[4]!];
}

function toMarketCandle(
  instrument: InstrumentReference,
  interval: CandleInterval,
  candle: CoinbaseCandle,
  responseUrl: URL,
  responseHash: string,
): MarketCandle {
  const [timestamp, low, high, open, close, volume] = candle;
  const openTimeMs = timestamp * 1_000;
  const intervalMs = INTERVAL_SECONDS[interval] * 1_000;
  const openTime = new Date(openTimeMs).toISOString();
  const closeTime = new Date(openTimeMs + intervalMs).toISOString();
  return {
    instrument,
    interval,
    openTime,
    closeTime,
    open,
    high,
    low,
    close,
    volume,
    provenance: { ...provenance(responseUrl, closeTime, responseHash), freshness: "DELAYED" },
  };
}

function aggregateFourHourCandles(
  instrument: InstrumentReference,
  hourlyCandles: CoinbaseCandle[],
  responseUrl: URL,
  responseHash: string,
): MarketCandle[] {
  const groups = new Map<number, CoinbaseCandle[]>();
  const fourHours = INTERVAL_SECONDS["4h"];
  for (const candle of hourlyCandles) {
    const bucket = Math.floor(candle[0] / fourHours) * fourHours;
    const values = groups.get(bucket) ?? [];
    values.push(candle);
    groups.set(bucket, values);
  }

  return [...groups.entries()].sort(([left], [right]) => left - right).flatMap(([bucket, values]) => {
    values.sort(([left], [right]) => left - right);
    const first = values[0];
    const last = values.at(-1);
    if (!first || !last) return [];

    let high = new Decimal(first[2]);
    let low = new Decimal(first[1]);
    let volume = new Decimal(0);
    for (const candle of values) {
      const candleHigh = new Decimal(candle[2]);
      const candleLow = new Decimal(candle[1]);
      if (candleHigh.greaterThan(high)) high = candleHigh;
      if (candleLow.lessThan(low)) low = candleLow;
      volume = volume.plus(candle[5]);
    }

    const aggregated: CoinbaseCandle = [bucket, low.toFixed(), high.toFixed(), first[3], last[4], volume.toFixed()];
    return [toMarketCandle(instrument, "4h", aggregated, responseUrl, responseHash)];
  });
}

export class CoinbasePublicMarketDataProvider implements MarketDataProvider {
  readonly id = "coinbase-exchange";
  private readonly rssParser = new Parser();

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async getQuotes(request: QuoteRequest): Promise<MarketDataResult<MarketQuote>> {
    if (request.instruments.length === 0 || request.instruments.length > MAX_PRODUCTS_PER_REQUEST) {
      return unavailable("invalid-response", false);
    }

    const quotes: MarketQuote[] = [];
    for (const productId of request.instruments) {
      const instrument = parseProductId(productId);
      if (!instrument) return unavailable("invalid-response", false);

      const url = new URL(`/products/${encodeURIComponent(productId)}/book`, COINBASE_REST_BASE_URL);
      url.searchParams.set("level", "1");
      const response = await requestJson<unknown>(url, this.fetcher);
      if (!response.ok) return response.result;
      if (!parseBook(response.body)) return unavailable("invalid-response", false);

      quotes.push({
        instrument,
        bid: response.body.bids[0]?.[0] ?? null,
        ask: response.body.asks[0]?.[0] ?? null,
        last: null,
        baseVolume24h: null,
        priceChangePercent24h: null,
        provenance: provenance(url, response.body.time, response.responseHash),
      });
    }

    return { status: "available", data: quotes };
  }

  async getCandles(request: CandleRequest): Promise<MarketDataResult<MarketCandle>> {
    const instrument = parseProductId(request.instrument);
    const fromMs = Date.parse(request.from);
    const toMs = Date.parse(request.to);
    if (!instrument || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      return unavailable("invalid-response", false);
    }

    const responseGranularity = request.interval === "4h" ? 3_600 : INTERVAL_SECONDS[request.interval];
    const stepMs = responseGranularity * 1_000;
    const startMs = Math.floor(fromMs / stepMs) * stepMs;
    const chunkMs = CANDLE_CHUNK_SIZE * stepMs;
    const chunkCount = Math.ceil((toMs - startMs) / chunkMs);
    if (chunkCount > MAX_CANDLE_CHUNKS) return unavailable("invalid-response", false);

    const url = new URL(`/products/${encodeURIComponent(request.instrument)}/candles`, COINBASE_REST_BASE_URL);
    url.searchParams.set("granularity", String(responseGranularity));
    const rawCandles = new Map<number, CoinbaseCandle>();
    const hashes: string[] = [];

    for (let cursor = startMs; cursor < toMs; cursor += chunkMs) {
      const chunkEnd = Math.min(cursor + chunkMs, toMs);
      const chunkUrl = new URL(url);
      chunkUrl.searchParams.set("start", new Date(cursor).toISOString());
      chunkUrl.searchParams.set("end", new Date(chunkEnd).toISOString());
      const response = await requestJson<unknown>(chunkUrl, this.fetcher);
      if (!response.ok) return response.result;
      if (!Array.isArray(response.body)) {
        return unavailable("invalid-response", false);
      }
      const parsedCandles = response.body.map(parseCandle);
      if (parsedCandles.some((candle) => candle === null)) return unavailable("invalid-response", false);
      hashes.push(response.responseHash);
      for (const candle of parsedCandles) {
        if (candle) rawCandles.set(candle[0], candle);
      }
    }

    const responseHash = createHash("sha256").update(hashes.join(":" )).digest("hex");
    const sortedCandles = [...rawCandles.values()].sort(([left], [right]) => left - right);
    const currentTime = Date.now();
    const completeCandles = sortedCandles.filter(([timestamp]) => timestamp * 1_000 + stepMs <= currentTime);
    const requestedCandles = request.interval === "4h"
      ? aggregateFourHourCandles(instrument, completeCandles, url, responseHash)
      : completeCandles.map((candle) => toMarketCandle(instrument, request.interval, candle, url, responseHash));
    const requestedIntervalMs = INTERVAL_SECONDS[request.interval] * 1_000;
    const alignedRequestStart = Math.floor(fromMs / requestedIntervalMs) * requestedIntervalMs;
    const inRequestedRange = requestedCandles.filter((candle) => {
      const candleStart = Date.parse(candle.openTime);
      return candleStart >= alignedRequestStart && candleStart < toMs;
    });

    return { status: "available", data: inRequestedRange };
  }

  async getNews(request: NewsRequest): Promise<MarketDataResult<MarketNewsItem>> {
    const limit = request.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      return unavailable("invalid-response", false);
    }

    let response: Response;
    try {
      response = await this.fetcher(COINBASE_STATUS_FEED_URL, {
        cache: "no-store",
        headers: { Accept: "application/rss+xml, application/xml, text/xml" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return unavailable("provider-error", true);
    }
    if (response.status === 429) return unavailable("rate-limited", true);
    if (!response.ok) return unavailable("provider-error", response.status >= 500 || response.status === 408);

    let xml: string;
    try {
      xml = await response.text();
    } catch {
      return unavailable("invalid-response", true);
    }
    if (Buffer.byteLength(xml, "utf8") > MAX_NEWS_RESPONSE_BYTES) return unavailable("invalid-response", false);

    let feed: Awaited<ReturnType<Parser["parseString"]>>;
    try {
      feed = await this.rssParser.parseString(xml);
    } catch {
      return unavailable("invalid-response", false);
    }

    const since = request.since ? Date.parse(request.since) : Number.NEGATIVE_INFINITY;
    if (request.since && !Number.isFinite(since)) return unavailable("invalid-response", false);
    const fetchedAt = new Date().toISOString();
    const feedHash = createHash("sha256").update(xml).digest("hex");
    const sourceName = feed.title?.trim() || "Coinbase Exchange Status";
    const expectedHost = new URL(COINBASE_STATUS_FEED_URL).hostname;
    const data: MarketNewsItem[] = [];

    for (const item of feed.items ?? []) {
      if (data.length >= limit || !item.title?.trim() || !item.link) continue;
      let itemUrl: URL;
      try {
        itemUrl = new URL(item.link);
      } catch {
        continue;
      }
      if (itemUrl.protocol !== "https:" || itemUrl.hostname !== expectedHost) continue;

      const publishedTime = item.isoDate ? Date.parse(item.isoDate) : item.pubDate ? Date.parse(item.pubDate) : Number.NaN;
      if (Number.isFinite(since) && (!Number.isFinite(publishedTime) || publishedTime < since)) continue;
      const publishedAt = Number.isFinite(publishedTime) ? new Date(publishedTime).toISOString() : null;
      const title = item.title.trim();
      const contentHash = createHash("sha256").update(`${title}\n${itemUrl.toString()}\n${publishedAt ?? ""}`).digest("hex");

      data.push({
        title,
        sourceName,
        url: itemUrl.toString(),
        imageUrl: null,
        publishedAt,
        contentHash,
        provenance: {
          providerId: "coinbase-exchange-status",
          providerName: sourceName,
          endpointOrigin: new URL(COINBASE_STATUS_FEED_URL).origin,
          observedAt: publishedAt,
          fetchedAt,
          freshness: "DELAYED",
          responseHash: feedHash,
        },
      });
    }

    return { status: "available", data };
  }
}