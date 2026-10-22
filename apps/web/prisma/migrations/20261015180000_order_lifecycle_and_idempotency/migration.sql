-- Phase 06: one lifecycle for orders, with idempotency and a record of attempts.
--
-- `TradeOrder` gains four things:
--   * `filledQuantity` — the cumulative executed quantity. Cumulative (not
--     per-fill) is what makes applying the same venue report twice idempotent,
--     and it is what a cancelled partially filled order keeps, so an execution
--     that happened is never dropped.
--   * `idempotencyKey` — the key the submission was made under, so a retried
--     request can be traced back to the operation that owns it.
--   * `attempts`, `lastAttemptAt`, `lastAttemptReason`,
--     `lastProviderResponseJson` — the last attempt and the venue's own answer
--     (redacted). "Why did this order fail?" is answered from the row.
--
-- `status` default moves from PENDING to CREATED: CREATED is the first state of
-- the lifecycle in `src/lib/orders/state-machine.ts`, and PENDING was a name no
-- code ever moved an order out of. Existing rows are left as they are (the store
-- reads an unknown status as CREATED rather than inventing one), and there are no
-- live rows in any environment this phase ships to.
--
-- The lifecycle is deliberately NOT a Postgres enum here: the status set lives in
-- one TypeScript table, and `scripts/dev-database.mjs` refuses to derive the
-- SQLite development schema from a file containing an enum.
--
-- `IdempotencyRecord` is new. The unique `(scope, key)` index is the mechanism,
-- not a detail: the reservation is an INSERT and the constraint decides the
-- winner, so no read-then-write window exists in which two submissions both
-- proceed.
--
-- Rollback: drop the added columns and the `IdempotencyRecord` table. No order in
-- this phase moves money, so a rollback is safe at any point.

-- AlterTable
ALTER TABLE "TradeOrder" ALTER COLUMN "status" SET DEFAULT 'CREATED';
ALTER TABLE "TradeOrder" ADD COLUMN "filledQuantity" TEXT NOT NULL DEFAULT '0';
ALTER TABLE "TradeOrder" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "TradeOrder" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TradeOrder" ADD COLUMN "lastAttemptAt" TIMESTAMP(3);
ALTER TABLE "TradeOrder" ADD COLUMN "lastAttemptReason" TEXT;
ALTER TABLE "TradeOrder" ADD COLUMN "lastProviderResponseJson" TEXT NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "resultJson" TEXT NOT NULL DEFAULT '{}',
    "reason" TEXT,
    "orderId" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TradeOrder_idempotencyKey_idx" ON "TradeOrder"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_scope_key_key" ON "IdempotencyRecord"("scope", "key");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_createdAt_idx" ON "IdempotencyRecord"("createdAt");

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
