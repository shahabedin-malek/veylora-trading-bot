import { MarketCache } from "@/lib/market-data/cache";
import type {
  CandleRequest,
  MarketCandle,
  MarketDataProvider,
  MarketDataResult,
  MarketNewsItem,
  MarketQuote,
  NewsRequest,
  QuoteRequest,
} from "@/lib/market-data/provider";

export type MarketCacheTtl = {
  quotesMs: number;
  candlesMs: number;
  newsMs: number;
};

function notConfigured<T>(): MarketDataResult<T> {
  return { status: "unavailable", reason: "not-configured", retryable: false };
}

export class MarketDataService {
  private readonly quoteCache = new MarketCache<MarketQuote>();
  private readonly candleCache = new MarketCache<MarketCandle>();
  private readonly newsCache = new MarketCache<MarketNewsItem>();

  constructor(
    private readonly provider: MarketDataProvider | null,
    private readonly ttl: MarketCacheTtl,
  ) {}

  getQuotes(request: QuoteRequest): Promise<MarketDataResult<MarketQuote>> {
    if (!this.provider) return Promise.resolve(notConfigured());
    return this.quoteCache.get(
      this.cacheKey("quotes", request),
      () => this.provider!.getQuotes(request),
      this.ttl.quotesMs,
    );
  }

  getCandles(request: CandleRequest): Promise<MarketDataResult<MarketCandle>> {
    if (!this.provider) return Promise.resolve(notConfigured());
    return this.candleCache.get(
      this.cacheKey("candles", request),
      () => this.provider!.getCandles(request),
      this.ttl.candlesMs,
    );
  }

  getNews(request: NewsRequest): Promise<MarketDataResult<MarketNewsItem>> {
    if (!this.provider) return Promise.resolve(notConfigured());
    return this.newsCache.get(
      this.cacheKey("news", request),
      () => this.provider!.getNews(request),
      this.ttl.newsMs,
    );
  }

  clearCache(): void {
    this.quoteCache.clear();
    this.candleCache.clear();
    this.newsCache.clear();
  }

  private cacheKey(kind: string, request: object): string {
    return JSON.stringify([this.provider?.id, kind, request]);
  }
}