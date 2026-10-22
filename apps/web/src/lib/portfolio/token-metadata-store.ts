/**
 * The Prisma-backed metadata cache.
 *
 * Deliberately thin, and deliberately allowed to fail: the reader in `tokens.ts`
 * treats a throw from either method as "the cache is unavailable" and continues
 * against the provider. A stopped database therefore cannot make a chain holding
 * disappear — it only makes the next metadata read slower.
 */
import { prisma } from "@/lib/db";
import type { CachedTokenMetadata, TokenMetadataStore } from "@/lib/portfolio/tokens";

export function createPrismaTokenMetadataStore(): TokenMetadataStore {
  return {
    async read({ chainId, addresses }) {
      if (addresses.length === 0) return [];
      const rows = await prisma.tokenMetadata.findMany({
        where: { chainId, contractAddress: { in: [...addresses] } },
        select: {
          chainId: true,
          contractAddress: true,
          symbol: true,
          name: true,
          decimals: true,
          fetchedAt: true,
          source: true,
        },
      });
      return rows satisfies CachedTokenMetadata[];
    },

    async write(rows) {
      if (rows.length === 0) return;
      // One transaction, one row at a time: a batch upsert keeps the write atomic
      // and stays inside the connection's parameter budget.
      await prisma.$transaction(
        rows.map((row) => prisma.tokenMetadata.upsert({
          where: { chainId_contractAddress: { chainId: row.chainId, contractAddress: row.contractAddress } },
          create: {
            chainId: row.chainId,
            contractAddress: row.contractAddress,
            symbol: row.symbol,
            name: row.name,
            decimals: row.decimals,
            source: row.source,
            fetchedAt: row.fetchedAt,
          },
          update: {
            symbol: row.symbol,
            name: row.name,
            decimals: row.decimals,
            source: row.source,
            fetchedAt: row.fetchedAt,
          },
        })),
      );
    },
  };
}
