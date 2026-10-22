import { CoinbasePublicMarketDataProvider } from "@/lib/market-data/providers/coinbase";
import { MarketDataService } from "@/lib/market-data/service";
import { instrumentFetch, PROVIDER_IDS } from "@/lib/observability/provider-call";

/**
 * The provider is handed an instrumented `fetch`, so every quote, candle and news
 * request it makes leaves a record (phase 04). The provider itself is unchanged:
 * it still takes a `fetcher`, which is why a test can construct it with a stub
 * and no record is written.
 *
 * The provider itself is exported as well as the caching service. Ingestion
 * (phase 19) needs the provider directly — it writes what it reads into
 * `MarketCandleRecord`, and a second read-through cache in front of it would make
 * "did the run fetch anything?" unanswerable.
 */
export const coinbaseMarketDataProvider = new CoinbasePublicMarketDataProvider(
  instrumentFetch({ providerId: PROVIDER_IDS.coinbase }),
);

export const coinbaseMarketData = new MarketDataService(coinbaseMarketDataProvider, {
  quotesMs: 2_000,
  candlesMs: 30_000,
  newsMs: 60_000,
});
