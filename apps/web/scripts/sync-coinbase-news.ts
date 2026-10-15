import { prisma } from "@/lib/db";
import { CoinbasePublicMarketDataProvider } from "@/lib/market-data/providers/coinbase";
import { FINANCIAL_RSS_PROVIDERS } from "@/lib/market-data/rss-feeds";

const providers = [new CoinbasePublicMarketDataProvider(), ...FINANCIAL_RSS_PROVIDERS];

async function main() {
  try {
    const sourceResults = await Promise.all(providers.map(async (provider) => {
      try {
        const result = await provider.getNews({ limit: 30 });
        return result.status === "available"
          ? { providerId: provider.id, available: true, items: result.data }
          : { providerId: provider.id, available: false, items: [] };
      } catch {
        return { providerId: provider.id, available: false, items: [] };
      }
    }));
    const items = sourceResults.flatMap(({ items }) => items);
    const availableFeeds = sourceResults.filter(({ available }) => available).length;
    if (availableFeeds === 0) throw new Error("All configured public feeds are unavailable.");

    const writes = items.map((item) =>
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
    );

    await prisma.$transaction(writes);
    console.log(`Stored ${writes.length} headlines from ${availableFeeds}/${providers.length} public RSS feeds.`);
  } catch {
    console.error("RSS news sync failed; no unverified items were stored.");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();