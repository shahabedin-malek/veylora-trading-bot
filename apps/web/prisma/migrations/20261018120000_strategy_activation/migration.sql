-- Phase 23: one account's smart-trading activation.
--
-- A single row per account, keyed by `userId`, rather than a history table: the owner has
-- one start control and one stop control, and pressing them repeatedly must leave exactly
-- one activation. The history the phase asks for (who started or stopped it, when and why)
-- is the audit trail, written in the same transaction as each change.
--
-- `status` is the owner's intent (`RUNNING` or `STOPPED`). It defaults to STOPPED and starts
-- null in effect: an account with no row is not trading. `lastOutcome` and the
-- `lastReason*` pair are the runner's observation of the last pass, written only while the
-- row is RUNNING so a stop that lands mid-pass is never overwritten.
--
-- Rollback: drop the table. The strategy job then finds no activation and does nothing;
-- orders already placed remain reconciled by the order-reconciliation job.

-- CreateTable
CREATE TABLE "StrategyActivation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'STOPPED',
    "strategyId" TEXT,
    "startedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "lastChangeReason" TEXT,
    "lastChangedByUserId" TEXT,
    "lastChangedAt" TIMESTAMP(3),
    "lastEvaluatedAt" TIMESTAMP(3),
    "lastOutcome" TEXT,
    "lastReasonCode" TEXT,
    "lastReasonMessage" TEXT,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StrategyActivation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StrategyActivation_userId_key" ON "StrategyActivation"("userId");

-- CreateIndex
CREATE INDEX "StrategyActivation_status_lastEvaluatedAt_idx" ON "StrategyActivation"("status", "lastEvaluatedAt");

-- AddForeignKey
ALTER TABLE "StrategyActivation" ADD CONSTRAINT "StrategyActivation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
