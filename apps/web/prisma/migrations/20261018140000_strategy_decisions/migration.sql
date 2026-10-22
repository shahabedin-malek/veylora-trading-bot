-- Phase 24: the 24/7 strategy runner's decision record.
--
-- One row per strategy per evaluated interval, whether or not an order was placed. The
-- row is the answer to "what did the runner do, with what inputs, and why" for a pass that
-- ran while nobody was looking; it is written by `runStrategyDecisionPass` and read by the
-- per-strategy panel and the admin console.
--
-- Two guarantees live in the schema rather than in the loop:
--  - `StrategyActivation.lastWindowStart` is the claim a pass takes before it evaluates,
--    so two concurrent invocations cannot both decide the same interval.
--  - `StrategyDecision_activationId_windowStart_key` makes a second decision for the same
--    interval impossible to store, even if the claim were somehow won twice.
--
-- Rollback: drop the table and the column. The runner then finds no window claim, so a
-- pass after the revert evaluates the next interval; the phase-23 observation pass remains
-- the only writer of `lastEvaluatedAt`.

-- AlterTable
ALTER TABLE "StrategyActivation" ADD COLUMN "lastWindowStart" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "StrategyDecision" (
    "id" TEXT NOT NULL,
    "activationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "strategyId" TEXT,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "reasonMessage" TEXT NOT NULL,
    "market" TEXT,
    "inputsJson" TEXT NOT NULL DEFAULT '{}',
    "conditionsJson" TEXT NOT NULL DEFAULT '[]',
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StrategyDecision_activationId_windowStart_key" ON "StrategyDecision"("activationId", "windowStart");

-- CreateIndex
CREATE INDEX "StrategyDecision_userId_evaluatedAt_idx" ON "StrategyDecision"("userId", "evaluatedAt");

-- AddForeignKey
ALTER TABLE "StrategyDecision" ADD CONSTRAINT "StrategyDecision_activationId_fkey" FOREIGN KEY ("activationId") REFERENCES "StrategyActivation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategyDecision" ADD CONSTRAINT "StrategyDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
