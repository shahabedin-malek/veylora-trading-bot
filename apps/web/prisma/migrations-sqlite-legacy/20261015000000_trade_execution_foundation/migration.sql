CREATE TABLE "TradingVenueCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "credentialCiphertext" TEXT NOT NULL,
    "credentialIv" TEXT NOT NULL,
    "credentialAuthTag" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "permissionStatus" TEXT NOT NULL DEFAULT 'READ_ONLY',
    "tradingApprovedAt" DATETIME,
    "verifiedAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TradingVenueCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TradingVenueCredential_userId_venue_fingerprint_key" ON "TradingVenueCredential"("userId", "venue", "fingerprint");
CREATE INDEX "TradingVenueCredential_userId_revokedAt_idx" ON "TradingVenueCredential"("userId", "revokedAt");
CREATE INDEX "TradingVenueCredential_venue_revokedAt_idx" ON "TradingVenueCredential"("venue", "revokedAt");

CREATE TABLE "TradeOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "orderType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "clientOrderId" TEXT NOT NULL,
    "venueOrderId" TEXT,
    "requestedAmount" TEXT NOT NULL,
    "limitPrice" TEXT,
    "stopLossPrice" TEXT NOT NULL,
    "notionalUsdCents" INTEGER NOT NULL,
    "verifiedBalanceCents" INTEGER NOT NULL,
    "submittedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "redactedResultJson" TEXT NOT NULL DEFAULT '{}',
    CONSTRAINT "TradeOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TradeOrder_clientOrderId_key" ON "TradeOrder"("clientOrderId");
CREATE INDEX "TradeOrder_userId_createdAt_idx" ON "TradeOrder"("userId", "createdAt");
CREATE INDEX "TradeOrder_venue_venueOrderId_idx" ON "TradeOrder"("venue", "venueOrderId");
CREATE INDEX "TradeOrder_status_createdAt_idx" ON "TradeOrder"("status", "createdAt");