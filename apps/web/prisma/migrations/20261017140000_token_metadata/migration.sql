-- Phase 18: a shared token metadata cache.
--
-- Symbol, name and decimals are public chain facts, the same for every account,
-- so this table has no user id and no balance in it. `fetchedAt` is when the
-- provider actually answered; the reader treats a row younger than its freshness
-- window as a hit and refreshes an older one, and `?refresh=1` forces a refresh.
--
-- A cache read that fails (a stopped database, a missing table) is a miss, not a
-- request failure: the aggregation reads balances from the chain regardless and
-- lists a token by its address when metadata could not be resolved. Nothing here
-- is a source of truth about a holding.
--
-- `contractAddress` is stored checksummed, matching the allow-list convention.
--
-- Rollback: drop the table. Metadata is re-read from the provider on the next
-- load; no holding, balance or total depends on a cached row.

-- CreateTable
CREATE TABLE "TokenMetadata" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "symbol" TEXT,
    "name" TEXT,
    "decimals" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'alchemy_getTokenMetadata',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenMetadata_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TokenMetadata_chainId_contractAddress_key" ON "TokenMetadata"("chainId", "contractAddress");

-- CreateIndex
CREATE INDEX "TokenMetadata_chainId_fetchedAt_idx" ON "TokenMetadata"("chainId", "fetchedAt");
