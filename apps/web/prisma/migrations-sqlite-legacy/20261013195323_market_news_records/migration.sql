-- CreateTable
CREATE TABLE "MarketNewsRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "publishedAt" DATETIME,
    "fetchedAt" DATETIME NOT NULL,
    "contentHash" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "MarketNewsRecord_publishedAt_idx" ON "MarketNewsRecord"("publishedAt");

-- CreateIndex
CREATE INDEX "MarketNewsRecord_fetchedAt_idx" ON "MarketNewsRecord"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketNewsRecord_providerId_url_key" ON "MarketNewsRecord"("providerId", "url");
