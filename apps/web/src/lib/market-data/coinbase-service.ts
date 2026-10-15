import { CoinbasePublicMarketDataProvider } from "@/lib/market-data/providers/coinbase";
import { MarketDataService } from "@/lib/market-data/service";

export const coinbaseMarketData = new MarketDataService(new CoinbasePublicMarketDataProvider(), {
  quotesMs: 2_000,
  candlesMs: 30_000,
  newsMs: 60_000,
});