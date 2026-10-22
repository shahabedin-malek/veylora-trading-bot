-- Phase 19: saved screens and their recorded runs.
--
-- A screen is an alert condition plus a symbol set, so `condition` and
-- `threshold` deliberately mirror `MarketAlert`; both are validated by the same
-- module. `symbolsJson` is read whole with the screen and never queried by
-- symbol, so text is enough.
--
-- A result keeps both the moment the screen was asked (`asOf`) and the newest
-- candle that answered it (`dataAsOf`). `resultHash` covers the condition and the
-- per-symbol rows, not the clock, so two runs over the same stored candles can be
-- compared without parsing prose.
--
-- Rollback: drop both tables. Screens are a saved view over stored market data;
-- no candle, alert or holding depends on them.

-- CreateTable
CREATE TABLE "Screener" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "threshold" TEXT NOT NULL,
    "symbolsJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Screener_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreenerResult" (
    "id" TEXT NOT NULL,
    "screenerId" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "dataAsOf" TIMESTAMP(3),
    "providerIdsJson" TEXT NOT NULL DEFAULT '[]',
    "resultsJson" TEXT NOT NULL,
    "resultHash" TEXT NOT NULL,
    "matchedCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScreenerResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Screener_userId_name_key" ON "Screener"("userId", "name");

-- CreateIndex
CREATE INDEX "Screener_userId_createdAt_idx" ON "Screener"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ScreenerResult_screenerId_asOf_idx" ON "ScreenerResult"("screenerId", "asOf");

-- AddForeignKey
ALTER TABLE "Screener" ADD CONSTRAINT "Screener_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreenerResult" ADD CONSTRAINT "ScreenerResult_screenerId_fkey" FOREIGN KEY ("screenerId") REFERENCES "Screener"("id") ON DELETE CASCADE ON UPDATE CASCADE;
