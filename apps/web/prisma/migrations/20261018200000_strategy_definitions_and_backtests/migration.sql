-- Phase 28: versioned strategy definitions, their runs, and the trading-cost assumptions.
--
-- `StrategyDefinition` is insert-only: every edit writes a new version under the same
-- name, so a backtest or paper run that named version 3 can still read the exact rules it
-- tested after version 4 exists. The unique index on (userId, name, version) is what makes
-- "the next version" a database fact rather than a client's claim.
--
-- `BacktestRun` stores the version it tested, the cost assumptions it applied and the full
-- result, so a result is never a number divorced from the inputs that produced it. A sweep
-- shares one `sweepId` across its rows: the per-run comparisons are one event, and the best
-- parameter set can be identified without re-deriving the sweep.
--
-- The four FeeSchedule columns hold the modelling assumptions a backtest prices fills with:
-- fee per side, spread per side, slippage per side, and daily funding on a leveraged
-- position. They are configuration, not charges: no ledger entry reads them. Defaults are
-- explicit so a deployment with no stored version still applies a realistic model, and zero
-- remains a valid configuration that the surfaces print as zero.
--
-- Rollback: drop the two tables and the four columns. Backtests stop being persisted and
-- the previous RSI-only backtester behaviour returns; no order or ledger row is touched.
--
-- Verified statement for statement against the DDL Prisma derives from
-- `prisma/schema.prisma` (`prisma migrate diff --from-empty --to-schema-datamodel`), not
-- executed against Postgres, because no Postgres is reachable from this machine. The
-- development pipeline derives its SQLite schema from the same models (`db:setup`).

-- AlterTable
ALTER TABLE "FeeSchedule" ADD COLUMN     "tradingFeeBps" TEXT NOT NULL DEFAULT '10',
ADD COLUMN     "spreadBps" TEXT NOT NULL DEFAULT '2',
ADD COLUMN     "slippageBps" TEXT NOT NULL DEFAULT '5',
ADD COLUMN     "fundingBpsPerDay" TEXT NOT NULL DEFAULT '0';

-- CreateTable
CREATE TABLE "StrategyDefinition" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "market" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL DEFAULT '1d',
    "text" TEXT NOT NULL,
    "definitionJson" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "promptJson" TEXT,
    "modelOutput" TEXT,
    "providerId" TEXT,
    "model" TEXT,
    "fallbackFrom" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "definitionVersion" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "sweepId" TEXT,
    "symbol" TEXT NOT NULL,
    "strategyText" TEXT NOT NULL,
    "parametersJson" TEXT NOT NULL DEFAULT '{}',
    "costAssumptionsJson" TEXT NOT NULL,
    "metricsJson" TEXT NOT NULL,
    "resultJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BacktestRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StrategyDefinition_userId_name_version_key" ON "StrategyDefinition"("userId", "name", "version");

-- CreateIndex
CREATE INDEX "StrategyDefinition_userId_createdAt_idx" ON "StrategyDefinition"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "BacktestRun_userId_createdAt_idx" ON "BacktestRun"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "BacktestRun_definitionId_definitionVersion_idx" ON "BacktestRun"("definitionId", "definitionVersion");

-- CreateIndex
CREATE INDEX "BacktestRun_sweepId_idx" ON "BacktestRun"("sweepId");

-- AddForeignKey
ALTER TABLE "StrategyDefinition" ADD CONSTRAINT "StrategyDefinition_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestRun" ADD CONSTRAINT "BacktestRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestRun" ADD CONSTRAINT "BacktestRun_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "StrategyDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
