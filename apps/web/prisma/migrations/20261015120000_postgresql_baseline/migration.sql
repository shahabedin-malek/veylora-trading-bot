-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "sessionVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chainNamespace" TEXT NOT NULL,
    "chainReference" TEXT NOT NULL,
    "addressCanonical" TEXT NOT NULL,
    "addressDisplay" TEXT NOT NULL,
    "proofType" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "WalletIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradingVenueCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "credentialCiphertext" TEXT NOT NULL,
    "credentialIv" TEXT NOT NULL,
    "credentialAuthTag" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "permissionStatus" TEXT NOT NULL DEFAULT 'READ_ONLY',
    "tradingApprovedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingVenueCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeOrder" (
    "id" TEXT NOT NULL,
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
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "redactedResultJson" TEXT NOT NULL DEFAULT '{}',

    CONSTRAINT "TradeOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthNonce" (
    "nonceHash" TEXT NOT NULL,
    "addressCanonical" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "domain" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "AuthNonce_pkey" PRIMARY KEY ("nonceHash")
);

-- CreateTable
CREATE TABLE "RoleAssignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "assignedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "RoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT NOT NULL,
    "redactedJson" TEXT NOT NULL DEFAULT '{}',

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskPolicySettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "maxRiskPerTradePercent" TEXT NOT NULL DEFAULT '1',
    "maxOpenExposurePercent" TEXT NOT NULL DEFAULT '25',
    "dailyLossHaltPercent" TEXT NOT NULL DEFAULT '2',
    "maxTradesPerDay" INTEGER NOT NULL DEFAULT 10,
    "defaultMaxLeverage" TEXT NOT NULL DEFAULT '1',
    "minimumVerifiedBalanceUsd" TEXT NOT NULL DEFAULT '20',
    "first24HourExposureUsd" TEXT NOT NULL DEFAULT '20',
    "approvedSymbolsJson" TEXT NOT NULL DEFAULT '[]',
    "killSwitchActive" BOOLEAN NOT NULL DEFAULT false,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskPolicySettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChainGPTFeatureSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "chatbotEnabled" BOOLEAN NOT NULL DEFAULT true,
    "contractAuditorEnabled" BOOLEAN NOT NULL DEFAULT true,
    "contractGeneratorEnabled" BOOLEAN NOT NULL DEFAULT true,
    "aiTradingAssistantEnabled" BOOLEAN NOT NULL DEFAULT true,
    "aiNewsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "askCryptoPeopleEnabled" BOOLEAN NOT NULL DEFAULT true,
    "nftGeneratorEnabled" BOOLEAN NOT NULL DEFAULT true,
    "cryptoGuardEnabled" BOOLEAN NOT NULL DEFAULT true,
    "aiAgentsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChainGPTFeatureSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WunderTradingFeatureSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "apiProfilesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "liveStrategiesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "strategyHistoryEnabled" BOOLEAN NOT NULL DEFAULT false,
    "openTradesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "closeTradesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WunderTradingFeatureSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationFeatureSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "alternativeMeSentimentEnabled" BOOLEAN NOT NULL DEFAULT false,
    "alchemyRpcEnabled" BOOLEAN NOT NULL DEFAULT false,
    "tavilySearchEnabled" BOOLEAN NOT NULL DEFAULT false,
    "tavilyExtractEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationFeatureSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepartmentTeam" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,

    CONSTRAINT "DepartmentTeam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMembership" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "teamRole" TEXT NOT NULL DEFAULT 'MEMBER',
    "assignedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "TeamMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPermissionGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permissionKey" TEXT NOT NULL,
    "grantedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "UserPermissionGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketCandleRecord" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "openTime" TIMESTAMP(3) NOT NULL,
    "closeTime" TIMESTAMP(3) NOT NULL,
    "open" TEXT NOT NULL,
    "high" TEXT NOT NULL,
    "low" TEXT NOT NULL,
    "close" TEXT NOT NULL,
    "volume" TEXT NOT NULL,
    "providerObservedAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "freshness" TEXT NOT NULL,
    "responseHash" TEXT,

    CONSTRAINT "MarketCandleRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketNewsRecord" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "imageUrl" TEXT,
    "publishedAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "contentHash" TEXT NOT NULL,

    CONSTRAINT "MarketNewsRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WalletIdentity_userId_revokedAt_idx" ON "WalletIdentity"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WalletIdentity_chainNamespace_chainReference_addressCanonic_key" ON "WalletIdentity"("chainNamespace", "chainReference", "addressCanonical");

-- CreateIndex
CREATE INDEX "TradingVenueCredential_userId_revokedAt_idx" ON "TradingVenueCredential"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "TradingVenueCredential_venue_revokedAt_idx" ON "TradingVenueCredential"("venue", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TradingVenueCredential_userId_venue_fingerprint_key" ON "TradingVenueCredential"("userId", "venue", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "TradeOrder_clientOrderId_key" ON "TradeOrder"("clientOrderId");

-- CreateIndex
CREATE INDEX "TradeOrder_userId_createdAt_idx" ON "TradeOrder"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "TradeOrder_venue_venueOrderId_idx" ON "TradeOrder"("venue", "venueOrderId");

-- CreateIndex
CREATE INDEX "TradeOrder_status_createdAt_idx" ON "TradeOrder"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AuthNonce_expiresAt_consumedAt_idx" ON "AuthNonce"("expiresAt", "consumedAt");

-- CreateIndex
CREATE INDEX "RoleAssignment_userId_scope_revokedAt_idx" ON "RoleAssignment"("userId", "scope", "revokedAt");

-- CreateIndex
CREATE INDEX "AuditEvent_occurredAt_idx" ON "AuditEvent"("occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_actorUserId_occurredAt_idx" ON "AuditEvent"("actorUserId", "occurredAt");

-- CreateIndex
CREATE INDEX "RiskPolicySettings_updatedByUserId_idx" ON "RiskPolicySettings"("updatedByUserId");

-- CreateIndex
CREATE INDEX "ChainGPTFeatureSettings_updatedByUserId_idx" ON "ChainGPTFeatureSettings"("updatedByUserId");

-- CreateIndex
CREATE INDEX "WunderTradingFeatureSettings_updatedByUserId_idx" ON "WunderTradingFeatureSettings"("updatedByUserId");

-- CreateIndex
CREATE INDEX "IntegrationFeatureSettings_updatedByUserId_idx" ON "IntegrationFeatureSettings"("updatedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentTeam_slug_key" ON "DepartmentTeam"("slug");

-- CreateIndex
CREATE INDEX "TeamMembership_userId_revokedAt_idx" ON "TeamMembership"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMembership_teamId_userId_key" ON "TeamMembership"("teamId", "userId");

-- CreateIndex
CREATE INDEX "UserPermissionGrant_permissionKey_revokedAt_idx" ON "UserPermissionGrant"("permissionKey", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserPermissionGrant_userId_permissionKey_key" ON "UserPermissionGrant"("userId", "permissionKey");

-- CreateIndex
CREATE INDEX "MarketCandleRecord_symbol_interval_openTime_idx" ON "MarketCandleRecord"("symbol", "interval", "openTime");

-- CreateIndex
CREATE INDEX "MarketCandleRecord_fetchedAt_idx" ON "MarketCandleRecord"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketCandleRecord_providerId_symbol_interval_openTime_key" ON "MarketCandleRecord"("providerId", "symbol", "interval", "openTime");

-- CreateIndex
CREATE INDEX "MarketNewsRecord_publishedAt_idx" ON "MarketNewsRecord"("publishedAt");

-- CreateIndex
CREATE INDEX "MarketNewsRecord_fetchedAt_idx" ON "MarketNewsRecord"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketNewsRecord_providerId_url_key" ON "MarketNewsRecord"("providerId", "url");

-- AddForeignKey
ALTER TABLE "WalletIdentity" ADD CONSTRAINT "WalletIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingVenueCredential" ADD CONSTRAINT "TradingVenueCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeOrder" ADD CONSTRAINT "TradeOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskPolicySettings" ADD CONSTRAINT "RiskPolicySettings_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChainGPTFeatureSettings" ADD CONSTRAINT "ChainGPTFeatureSettings_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WunderTradingFeatureSettings" ADD CONSTRAINT "WunderTradingFeatureSettings_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationFeatureSettings" ADD CONSTRAINT "IntegrationFeatureSettings_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentTeam" ADD CONSTRAINT "DepartmentTeam_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "DepartmentTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermissionGrant" ADD CONSTRAINT "UserPermissionGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermissionGrant" ADD CONSTRAINT "UserPermissionGrant_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

