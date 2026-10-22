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
    /** A fixed clock, for a test that has to cross a freshness window without sleeping. */
    private readonly now: () => number = Date.now,
  ) {}

  getQuotes(request: QuoteRequest): Promise<MarketDataResult<MarketQuote>> {
    if (!this.provider) return Promise.resolve(notConfigured());
    const at = this.now();
    return this.quoteCache.get(
      this.cacheKey("quotes", request, this.ttl.quotesMs, at),
      () => this.provider!.getQuotes(request),
      this.ttl.quotesMs,
    );
  }

  getCandles(request: CandleRequest): Promise<MarketDataResult<MarketCandle>> {
    if (!this.provider) return Promise.resolve(notConfigured());
    const at = this.now();
    return this.candleCache.get(
      this.cacheKey("candles", request, this.ttl.candlesMs, at),
      () => this.provider!.getCandles(request),
      this.ttl.candlesMs,
    );
  }

  getNews(request: NewsRequest): Promise<MarketDataResult<MarketNewsItem>> {
    if (!this.provider) return Promise.resolve(notConfigured());
    const at = this.now();
    return this.newsCache.get(
      this.cacheKey("news", request, this.ttl.newsMs, at),
      () => this.provider!.getNews(request),
      this.ttl.newsMs,
    );
  }

  clearCache(): void {
    this.quoteCache.clear();
    this.candleCache.clear();
    this.newsCache.clear();
  }

  /**
   * What a cached value is: which provider answered, what was asked, and which
   * freshness window the answer belongs to.
   *
   * The provider id is the network the value came from — two feeds, or the same
   * feed pointed at another environment, never share an entry. The window is
   * `floor(now / ttl)`, so a value written in one window is not returned in the
   * next even if a clock or a TTL edit would otherwise let it survive: freshness is
   * part of the key, not a property an entry is trusted to remember about itself.
   * The request carries its own as-of (`to` for candles, `since` for news), so two
   * questions about different moments are different entries.
   */
  private cacheKey(kind: string, request: object, ttlMs: number, at: number): string {
    return JSON.stringify([this.provider?.id ?? "none", kind, request, Math.floor(at / ttlMs)]);
  }
}