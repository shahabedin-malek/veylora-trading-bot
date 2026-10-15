import { CointelegraphRssProvider } from "@/lib/market-data/providers/cointelegraph-rss";
import { MarketDataService } from "@/lib/market-data/service";

export const cointelegraphNews = new MarketDataService(new CointelegraphRssProvider(), {
  quotesMs: 1_000,
  candlesMs: 1_000,
  newsMs: 5 * 60_000,
});