import { prisma } from "@/lib/db";
import { CoinbasePublicMarketDataProvider } from "@/lib/market-data/providers/coinbase";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";

const provider = new CoinbasePublicMarketDataProvider();
const end = new Date();
const start = new Date(end.getTime() - 365 * 86_400_000);

async function main() {
  const unavailableProducts: string[] = [];
  try {
    let totalWrites = 0;
    for (const instrument of USD_WATCHLIST) {
      const result = await provider.getCandles({
        instrument: instrument.productId,
        interval: "1d",
        from: start.toISOString(),
        to: end.toISOString(),
      });

      if (result.status !== "available") {
        unavailableProducts.push(instrument.productId);
        console.error(`${instrument.productId}: history unavailable (${result.reason}).`);
        continue;
      }

      const writes = result.data.map((candle) =>
        prisma.marketCandleRecord.upsert({
          where: {
            providerId_symbol_interval_openTime: {
              providerId: candle.provenance.providerId,
              symbol: candle.instrument.symbol,
              interval: candle.interval,
              openTime: new Date(candle.openTime),
            },
          },
          create: {
            providerId: candle.provenance.providerId,
            symbol: candle.instrument.symbol,
            interval: candle.interval,
            openTime: new Date(candle.openTime),
            closeTime: new Date(candle.closeTime),
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            providerObservedAt: candle.provenance.observedAt ? new Date(candle.provenance.observedAt) : null,
            fetchedAt: new Date(candle.provenance.fetchedAt),
            freshness: candle.provenance.freshness,
            responseHash: candle.provenance.responseHash,
          },
          update: {
            closeTime: new Date(candle.closeTime),
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            providerObservedAt: candle.provenance.observedAt ? new Date(candle.provenance.observedAt) : null,
            fetchedAt: new Date(candle.provenance.fetchedAt),
            freshness: candle.provenance.freshness,
            responseHash: candle.provenance.responseHash,
          },
        }),
      );

      await prisma.$transaction(writes);
      totalWrites += writes.length;
      console.log(`${instrument.productId}: stored ${writes.length} daily candles.`);
    }

    console.log(`Stored ${totalWrites} daily candles across ${USD_WATCHLIST.length - unavailableProducts.length}/${USD_WATCHLIST.length} curated USD markets.`);
    if (unavailableProducts.length > 0) process.exitCode = 1;
  } catch {
    console.error("Coinbase history sync failed; no unverified data was stored.");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();