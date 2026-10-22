-- Phase 16: the fee table, as versions rather than a mutable row.
--
-- `effectiveFrom` is when a version starts applying. A save inserts a new row and
-- nothing is edited or deleted, so the past keeps the price the owner actually charged,
-- a future-dated change can be staged without moving today's number, and the audit
-- event a save writes points at two rows that still say what they said when it wrote
-- them. A single mutable row with an effective-from column would rewrite history on
-- every save.
--
-- The three JSON/percent columns are strings, like every amount in this schema: a fee
-- is money, and money is parsed into exact minor units at the boundary rather than
-- carried as a float. `withdrawalFeesJson` and `networkCostsJson` are asset-keyed maps
-- (`{ "USDT": "1" }`); `tiersJson` is the account tiers the pricing page renders, and
-- `performanceFeePercent` is a percentage of a profitable result only.
--
-- Zero is a complete, valid configuration everywhere: a deployment with no row at all
-- charges nothing, and the surfaces say "no fee" rather than showing a missing value.
--
-- Rollback: drop the table. Fees stop being read from it (the withdrawal path falls
-- back to its deployment values), the pricing page has no table to render, and no
-- ledger entry is touched — a fee already posted stays traceable to its own transaction.
--
-- Verified statement for statement against the DDL Prisma derives from
-- `prisma/schema.prisma` (`prisma migrate diff --from-empty --to-schema-datamodel`),
-- not executed against Postgres, because no Postgres is reachable from this machine.

-- CreateTable
CREATE TABLE "FeeSchedule" (
    "id" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "withdrawalFeesJson" TEXT NOT NULL DEFAULT '{}',
    "networkCostsJson" TEXT NOT NULL DEFAULT '{}',
    "performanceFeePercent" TEXT NOT NULL DEFAULT '0',
    "tiersJson" TEXT NOT NULL DEFAULT '[]',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeeSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FeeSchedule_effectiveFrom_idx" ON "FeeSchedule"("effectiveFrom");

-- CreateIndex
CREATE INDEX "FeeSchedule_createdByUserId_idx" ON "FeeSchedule"("createdByUserId");

-- AddForeignKey
ALTER TABLE "FeeSchedule" ADD CONSTRAINT "FeeSchedule_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
