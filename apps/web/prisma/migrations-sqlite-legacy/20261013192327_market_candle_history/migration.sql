-- CreateTable
CREATE TABLE "MarketCandleRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "openTime" DATETIME NOT NULL,
    "closeTime" DATETIME NOT NULL,
    "open" TEXT NOT NULL,
    "high" TEXT NOT NULL,
    "low" TEXT NOT NULL,
    "close" TEXT NOT NULL,
    "volume" TEXT NOT NULL,
    "providerObservedAt" DATETIME,
    "fetchedAt" DATETIME NOT NULL,
    "freshness" TEXT NOT NULL,
    "responseHash" TEXT
);

-- CreateIndex
CREATE INDEX "MarketCandleRecord_symbol_interval_openTime_idx" ON "MarketCandleRecord"("symbol", "interval", "openTime");

-- CreateIndex
CREATE INDEX "MarketCandleRecord_fetchedAt_idx" ON "MarketCandleRecord"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketCandleRecord_providerId_symbol_interval_openTime_key" ON "MarketCandleRecord"("providerId", "symbol", "interval", "openTime");
