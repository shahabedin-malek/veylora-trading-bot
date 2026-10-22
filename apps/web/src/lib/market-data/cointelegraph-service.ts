import { CointelegraphRssProvider } from "@/lib/market-data/providers/cointelegraph-rss";
import { MarketDataService } from "@/lib/market-data/service";
import { instrumentFetch, PROVIDER_IDS } from "@/lib/observability/provider-call";

export const cointelegraphNews = new MarketDataService(
  new CointelegraphRssProvider(instrumentFetch({ providerId: PROVIDER_IDS.cointelegraph })),
  {
    quotesMs: 1_000,
    candlesMs: 1_000,
    newsMs: 5 * 60_000,
  },
);
