-- Phase 13: the ledger of record.
--
-- Three tables, and the shape of them is the arithmetic.
--
--   * `LedgerAccount` — one asset's worth of one thing, at one address money can
--     be posted to. `code` is unique and is the whole identity:
--     `user:<userId>:<asset>:available` is what an account holds (a liability of
--     the platform towards it) and `platform:<bucket>:<asset>` is where the other
--     side of every movement lands. `(userId, asset, bucket)` unique gives one
--     account per asset per bucket per account and nothing else, so a concurrent
--     issuance cannot produce two available accounts for the same dollars.
--     `creditLineMinor` is the explicit permission a balance needs before it may
--     go negative; null is the normal case.
--
--   * `LedgerTransaction` — the unit that is *balanced*: its entries' debits and
--     credits add up, per asset, in minor units. `idempotencyKey` is unique, which
--     is what makes posting exactly-once: a retry, a re-read block range or a
--     second runner can only ever produce the transaction that already exists.
--     `reversesTransactionId` points a compensating transaction at the one it
--     undoes, so a mistake is corrected by addition and nothing is ever edited.
--
--   * `LedgerEntry` — one leg. `amountMinor` is an exact integer count of the
--     asset's smallest unit, kept as text: a ledger amount is not a number a
--     machine may round, and neither `Int` (32 bits wide) nor `BigInt` (which the
--     SQLite development schema cannot represent) can hold it. `direction` is
--     DEBIT or CREDIT and `sequence` orders the legs inside their transaction;
--     `(transactionId, sequence)` unique keeps that order well defined.
--
-- There is deliberately **no balance column anywhere**: a balance is the sum of
-- the entries, so it cannot drift from them. `status`-style sets live in code
-- (`src/lib/ledger/accounts.ts`, `states.ts`-style) and `scripts/dev-database.mjs`
-- refuses to derive the SQLite development schema from a file containing an enum.
--
-- Rollback: drop the three tables. Nothing else reads them: the ledger's only
-- writer in this phase is deposit crediting, and dropping it costs the balance
-- surface, not any funds — the deposit rows that were credited keep their record
-- and their audit trail.

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "userId" TEXT,
    "creditLineMinor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerTransaction" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "actorUserId" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "memo" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversesTransactionId" TEXT,

    CONSTRAINT "LedgerTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "amountMinor" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_code_key" ON "LedgerAccount"("code");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_userId_asset_bucket_key" ON "LedgerAccount"("userId", "asset", "bucket");

-- CreateIndex
CREATE INDEX "LedgerAccount_asset_bucket_idx" ON "LedgerAccount"("asset", "bucket");

-- CreateIndex
CREATE INDEX "LedgerAccount_userId_asset_idx" ON "LedgerAccount"("userId", "asset");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerTransaction_idempotencyKey_key" ON "LedgerTransaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LedgerTransaction_actorUserId_occurredAt_idx" ON "LedgerTransaction"("actorUserId", "occurredAt");

-- CreateIndex
CREATE INDEX "LedgerTransaction_kind_occurredAt_idx" ON "LedgerTransaction"("kind", "occurredAt");

-- CreateIndex
CREATE INDEX "LedgerTransaction_sourceType_sourceId_idx" ON "LedgerTransaction"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_transactionId_sequence_key" ON "LedgerEntry"("transactionId", "sequence");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_createdAt_idx" ON "LedgerEntry"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_asset_direction_idx" ON "LedgerEntry"("asset", "direction");

-- AddForeignKey
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerTransaction" ADD CONSTRAINT "LedgerTransaction_reversesTransactionId_fkey" FOREIGN KEY ("reversesTransactionId") REFERENCES "LedgerTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "LedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
