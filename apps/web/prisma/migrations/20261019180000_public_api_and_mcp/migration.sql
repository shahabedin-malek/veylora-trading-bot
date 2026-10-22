-- Phase 32: scoped public API keys, their fixed-minute counters, the dedicated account an
-- agent key may trade, and the approval records that make a held order visible.

CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopesJson" TEXT NOT NULL DEFAULT '["read"]',
    "agentAccountId" TEXT,
    "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 60,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApiRateWindow" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ApiRateWindow_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentAccount" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "ledgerUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "approvalThresholdUsdCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentApproval" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "agentAccountId" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestJson" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "quantity" TEXT NOT NULL,
    "notionalUsdCents" INTEGER NOT NULL,
    "orderId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentApproval_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
CREATE INDEX "ApiKey_userId_createdAt_idx" ON "ApiKey"("userId", "createdAt");
CREATE UNIQUE INDEX "ApiRateWindow_keyId_windowStart_key" ON "ApiRateWindow"("keyId", "windowStart");
CREATE INDEX "ApiRateWindow_windowStart_idx" ON "ApiRateWindow"("windowStart");
CREATE UNIQUE INDEX "AgentAccount_ledgerUserId_key" ON "AgentAccount"("ledgerUserId");
CREATE UNIQUE INDEX "AgentAccount_ownerUserId_name_key" ON "AgentAccount"("ownerUserId", "name");
CREATE INDEX "AgentAccount_ownerUserId_createdAt_idx" ON "AgentAccount"("ownerUserId", "createdAt");
CREATE INDEX "AgentApproval_ownerUserId_status_createdAt_idx" ON "AgentApproval"("ownerUserId", "status", "createdAt");
CREATE INDEX "AgentApproval_agentAccountId_createdAt_idx" ON "AgentApproval"("agentAccountId", "createdAt");
CREATE INDEX "AgentApproval_expiresAt_idx" ON "AgentApproval"("expiresAt");

ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_agentAccountId_fkey" FOREIGN KEY ("agentAccountId") REFERENCES "AgentAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ApiRateWindow" ADD CONSTRAINT "ApiRateWindow_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentAccount" ADD CONSTRAINT "AgentAccount_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentAccount" ADD CONSTRAINT "AgentAccount_ledgerUserId_fkey" FOREIGN KEY ("ledgerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentApproval" ADD CONSTRAINT "AgentApproval_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentApproval" ADD CONSTRAINT "AgentApproval_agentAccountId_fkey" FOREIGN KEY ("agentAccountId") REFERENCES "AgentAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentApproval" ADD CONSTRAINT "AgentApproval_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentApproval" ADD CONSTRAINT "AgentApproval_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
