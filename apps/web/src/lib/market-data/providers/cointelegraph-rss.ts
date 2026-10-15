import { createHash } from "node:crypto";
import Parser from "rss-parser";
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
const MAX_RESPONSE_BYTES = 1_000_000;

export type RssFeedConfig = {
  id: string;
  sourceName: string;
  url: string;
  allowedItemHosts: readonly string[];
  allowedImageHosts: readonly string[];
};

function unavailable<T>(reason: "not-configured" | "provider-error" | "rate-limited" | "invalid-response", retryable: boolean): MarketDataResult<T> {
  return { status: "unavailable", reason, retryable };
}

export class PublicRssProvider implements MarketDataProvider {
  readonly id: string;
  private readonly parser = new Parser({
    customFields: {
      item: [
        ["media:content", "mediaContent", { keepArray: true }],
        ["media:thumbnail", "mediaThumbnail", { keepArray: true }],
      ],
    },
  });

  constructor(
    private readonly config: RssFeedConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.id = config.id;
  }

  async getQuotes(_request: QuoteRequest): Promise<MarketDataResult<MarketQuote>> {
    void _request;
    return unavailable("not-configured", false);
  }

  async getCandles(_request: CandleRequest): Promise<MarketDataResult<MarketCandle>> {
    void _request;
    return unavailable("not-configured", false);
  }

  async getNews(request: NewsRequest): Promise<MarketDataResult<MarketNewsItem>> {
    const limit = request.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) return unavailable("invalid-response", false);

    let response: Response;
    try {
      response = await this.fetcher(this.config.url, {
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
    if (Buffer.byteLength(xml, "utf8") > MAX_RESPONSE_BYTES) return unavailable("invalid-response", false);

    let feed: Awaited<ReturnType<Parser["parseString"]>>;
    try {
      feed = await this.parser.parseString(xml);
    } catch {
      return unavailable("invalid-response", false);
    }

    const since = request.since ? Date.parse(request.since) : Number.NEGATIVE_INFINITY;
    if (request.since && !Number.isFinite(since)) return unavailable("invalid-response", false);
    const fetchedAt = new Date().toISOString();
    const responseHash = createHash("sha256").update(xml).digest("hex");
    const data: MarketNewsItem[] = [];

    for (const item of feed.items ?? []) {
      if (data.length >= limit || !item.title?.trim() || !item.link) continue;
      let itemUrl: URL;
      try {
        itemUrl = new URL(item.link);
      } catch {
        continue;
      }
      if (itemUrl.protocol !== "https:" || !this.config.allowedItemHosts.includes(itemUrl.hostname)) continue;

      const publishedTime = item.isoDate ? Date.parse(item.isoDate) : item.pubDate ? Date.parse(item.pubDate) : Number.NaN;
      if (Number.isFinite(since) && (!Number.isFinite(publishedTime) || publishedTime < since)) continue;
      const publishedAt = Number.isFinite(publishedTime) ? new Date(publishedTime).toISOString() : null;
      const title = item.title.trim();
      const contentHash = createHash("sha256").update(`${title}\n${itemUrl.toString()}\n${publishedAt ?? ""}`).digest("hex");
      const imageUrl = extractImageUrl(
        [item.mediaContent, item.enclosure?.type?.startsWith("image/") ? item.enclosure.url : null, item.mediaThumbnail],
        this.config,
      );

      data.push({
        title,
        sourceName: this.config.sourceName,
        url: itemUrl.toString(),
        imageUrl,
        publishedAt,
        contentHash,
        provenance: {
          providerId: this.id,
          providerName: this.config.sourceName,
          endpointOrigin: new URL(this.config.url).origin,
          observedAt: publishedAt,
          fetchedAt,
          freshness: "DELAYED",
          responseHash,
        },
      });
    }

    return { status: "available", data };
  }
}

function imageUrlCandidates(value: unknown): string[] {
  if (typeof value === "string") return /^https:\/\//i.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(imageUrlCandidates);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const direct = [record.url, record.href, record.src].filter((candidate): candidate is string => typeof candidate === "string");
  return [...direct, ...Object.values(record).filter((candidate) => typeof candidate === "object").flatMap(imageUrlCandidates)];
}

function extractImageUrl(values: readonly unknown[], config: RssFeedConfig): string | null {
  const feedUrl = new URL(config.url);
  for (const candidate of values.flatMap(imageUrlCandidates)) {
    if (candidate.length > 2_048) continue;
    try {
      const image = new URL(candidate, feedUrl);
      if (image.protocol !== "https:" || image.username || image.password || !config.allowedImageHosts.includes(image.hostname)) continue;
      image.search = "";
      image.hash = "";
      return image.toString();
    } catch {
      continue;
    }
  }
  return null;
}

export class CointelegraphRssProvider extends PublicRssProvider {
  constructor(fetcher: typeof fetch = fetch) {
    super({
      id: "cointelegraph-rss",
      sourceName: "Cointelegraph",
      url: "https://cointelegraph.com/rss",
      allowedItemHosts: ["cointelegraph.com"],
      allowedImageHosts: ["s3-images.ctmedia.io"],
    }, fetcher);
  }
}