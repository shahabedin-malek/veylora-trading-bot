/**
 * Deterministic daily candles for the strategy pass.
 *
 * The 24/7 runner refreshes a stale series through Coinbase. The browser suite
 * must not depend on that network, so it pre-loads a complete, recent series
 * from this local seed and the runner evaluates it instead. The closes alternate
 * by one dollar, which leaves RSI near the middle and makes the pass a recorded
 * "no action" rather than a trade — enough to prove the runner advanced while the
 * browser was closed, without moving any money.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DAY_MS = 86_400_000;
const COUNT = 120;

async function main() {
  const now = Date.now();
  const rows = Array.from({ length: COUNT }, (_, index) => {
    const closeTime = new Date(now - 6 * 3_600_000 - (COUNT - 1 - index) * DAY_MS);
    const openTime = new Date(closeTime.getTime() - 23 * 3_600_000);
    const close = index % 2 === 0 ? "100.50" : "99.50";
    const open = index % 2 === 0 ? "99.75" : "100.25";
    const high = index % 2 === 0 ? "101.00" : "100.75";
    const low = index % 2 === 0 ? "99.25" : "99.00";
    return {
      providerId: "coinbase-exchange",
      symbol: "BTC-USD",
      interval: "1d",
      openTime,
      closeTime,
      open,
      high,
      low,
      close,
      volume: "1000",
      providerObservedAt: closeTime,
      fetchedAt: new Date(now),
      freshness: "fresh",
      responseHash: `e2e-fixture-${index}`,
    };
  });

  await prisma.marketCandleRecord.deleteMany({
    where: { providerId: "coinbase-exchange", symbol: "BTC-USD", interval: "1d" },
  });
  await prisma.marketCandleRecord.createMany({ data: rows });
  console.log(`Seeded ${rows.length} BTC-USD daily candles from ${rows[0]!.openTime.toISOString()}.`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
