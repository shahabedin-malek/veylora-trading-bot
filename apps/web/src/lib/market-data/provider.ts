export type DecimalText = string;

export type DataFreshness = "FRESH" | "DELAYED" | "STALE" | "UNKNOWN";

export type MarketProvenance = {
  providerId: string;
  providerName: string;
  endpointOrigin: string;
  observedAt: string | null;
  fetchedAt: string;
  freshness: DataFreshness;
  responseHash: string | null;
};

export type InstrumentReference = {
  id: string;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
};

export type MarketQuote = {
  instrument: InstrumentReference;
  bid: DecimalText | null;
  ask: DecimalText | null;
  last: DecimalText | null;
  baseVolume24h: DecimalText | null;
  priceChangePercent24h: DecimalText | null;
  provenance: MarketProvenance;
};

export type CandleInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export type MarketCandle = {
  instrument: InstrumentReference;
  interval: CandleInterval;
  openTime: string;
  closeTime: string;
  open: DecimalText;
  high: DecimalText;
  low: DecimalText;
  close: DecimalText;
  volume: DecimalText;
  provenance: MarketProvenance;
};

export type MarketNewsItem = {
  title: string;
  sourceName: string;
  url: string;
  imageUrl: string | null;
  publishedAt: string | null;
  contentHash: string;
  provenance: MarketProvenance;
};

export type MarketDataResult<T> =
  | { status: "available"; data: readonly T[] }
  | {
      status: "unavailable";
      reason: "not-configured" | "not-connected" | "provider-error" | "rate-limited" | "invalid-response";
      retryable: boolean;
    };

export type QuoteRequest = { instruments: readonly string[] };

export type CandleRequest = {
  instrument: string;
  interval: CandleInterval;
  from: string;
  to: string;
};

export type NewsRequest = {
  symbols?: readonly string[];
  since?: string;
  limit?: number;
};

export interface MarketDataProvider {
  readonly id: string;
  getQuotes(request: QuoteRequest): Promise<MarketDataResult<MarketQuote>>;
  getCandles(request: CandleRequest): Promise<MarketDataResult<MarketCandle>>;
  getNews(request: NewsRequest): Promise<MarketDataResult<MarketNewsItem>>;
}