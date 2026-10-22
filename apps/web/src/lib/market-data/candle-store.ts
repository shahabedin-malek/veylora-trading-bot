import type { MarketCandle, MarketNewsItem } from "@/lib/market-data/provider";
import type { CandleIngestStore } from "@/lib/market-data/ingest";

/**
 * The Prisma implementation of the ingestion store.
 *
 * It is created lazily and imports `@/lib/db` inside each method, for the same
 * reason the runner store does: importing the ingestion module (or the runner
 * registry that holds it) must not construct a database client, and a test that
 * injects an in-memory store must not need a database to exist.
 *
 * Every write is an `upsert` against the record's own unique key. That is the
 * idempotency guarantee, and it is enforced by the database rather than by a
 * read-then-write check that two concurrent runs could both pass.
 */

/** A bounded batch, so one long history does not become one enormous statement. */
const WRITE_BATCH_SIZE = 100;

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export function createPrismaCandleIngestStore(): CandleIngestStore {
  return {
    async openTimes({ providerId, symbol, interval, from, to }) {
      const { prisma } = await import("@/lib/db");
      const rows = await prisma.marketCandleRecord.findMany({
        where: {
          providerId,
          symbol,
          interval,
          openTime: { gte: from, lt: to },
        },
        select: { openTime: true },
      });
      return rows.map((row) => row.openTime);
    },

    async upsertCandles(candles) {
      if (candles.length === 0) return 0;
      const { prisma } = await import("@/lib/db");

      // Providers may repeat a slot across chunk boundaries. Keep the last one
      // per open time, so one statement never tries to write the same row twice.
      const unique = new Map<number, MarketCandle>();
      for (const candle of candles) {
        const openTime = Date.parse(candle.openTime);
        if (!Number.isFinite(openTime)) continue;
        unique.set(openTime, candle);
      }

      let written = 0;
      for (const batch of chunk([...unique.values()], WRITE_BATCH_SIZE)) {
        await prisma.$transaction(
          batch.map((candle) =>
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
                providerObservedAt: candle.provenance.observedAt
                  ? new Date(candle.provenance.observedAt)
                  : null,
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
                providerObservedAt: candle.provenance.observedAt
                  ? new Date(candle.provenance.observedAt)
                  : null,
                fetchedAt: new Date(candle.provenance.fetchedAt),
                freshness: candle.provenance.freshness,
                responseHash: candle.provenance.responseHash,
              },
            }),
          ),
        );
        written += batch.length;
      }
      return written;
    },

    async upsertNews(items) {
      if (items.length === 0) return 0;
      const { prisma } = await import("@/lib/db");

      const unique = new Map<string, MarketNewsItem>();
      for (const item of items) unique.set(`${item.provenance.providerId}\u0000${item.url}`, item);

      let written = 0;
      for (const batch of chunk([...unique.values()], WRITE_BATCH_SIZE)) {
        await prisma.$transaction(
          batch.map((item) =>
            prisma.marketNewsRecord.upsert({
              where: {
                providerId_url: {
                  providerId: item.provenance.providerId,
                  url: item.url,
                },
              },
              create: {
                providerId: item.provenance.providerId,
                sourceName: item.sourceName,
                title: item.title,
                url: item.url,
                imageUrl: item.imageUrl,
                publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
                fetchedAt: new Date(item.provenance.fetchedAt),
                contentHash: item.contentHash,
              },
              update: {
                sourceName: item.sourceName,
                title: item.title,
                imageUrl: item.imageUrl,
                publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
                fetchedAt: new Date(item.provenance.fetchedAt),
                contentHash: item.contentHash,
              },
            }),
          ),
        );
        written += batch.length;
      }
      return written;
    },
  };
}
