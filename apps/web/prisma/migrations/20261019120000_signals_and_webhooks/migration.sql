-- Phase 31: signals in, webhooks out.
--
-- Four tables, and one idea that shapes all of them: the evidence survives the attempt.
-- A rejected signature and a replayed signal are rows as much as an accepted one, a webhook
-- retry is another attempt row rather than an overwrite, and no table stores a secret in a
-- form any surface may return.
--
-- `SignalToken.tokenHash` is the lookup key, not the token: the URL credential is never
-- stored, only its SHA-256, so a dump of this table cannot be replayed against the endpoint.
-- The signing secret is sealed with AES-256-GCM (ciphertext/iv/authTag), under a different
-- AAD from venue keys and webhook secrets.
--
-- `SignalEvent.dedupeKey` is unique but nullable, which is the whole replay rule: the first
-- attempt for a signal id stores `${tokenId}:${signalId}` and wins the insert; every later
-- attempt is refused as a duplicate, stored with a null key and pointing at the original.
--
-- `WebhookDelivery` is one row per attempt with `@@unique([deliveryKey, attempt])`, so the
-- panel can show the first failure, the wait, and the second answer without a status column
-- erasing the first one. `nextAttemptAt` is the bounded-backoff schedule.
--
-- Rollback: revert the phase commit and drop these four tables. Existing strategies keep
-- running without signal input, and undelivered webhooks simply stop being sent.

-- CreateTable
CREATE TABLE "SignalToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "secretCiphertext" TEXT NOT NULL,
    "secretIv" TEXT NOT NULL,
    "secretAuthTag" TEXT NOT NULL,
    "replayWindowSeconds" INTEGER NOT NULL DEFAULT 300,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignalToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignalEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenId" TEXT,
    "signalId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "signatureStatus" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "reasonMessage" TEXT NOT NULL,
    "action" TEXT,
    "market" TEXT,
    "notionalUsd" TEXT,
    "bodyHash" TEXT NOT NULL,
    "orderId" TEXT,
    "duplicateOfId" TEXT,
    "dedupeKey" TEXT,

    CONSTRAINT "SignalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "secretCiphertext" TEXT NOT NULL,
    "secretIv" TEXT NOT NULL,
    "secretAuthTag" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "health" TEXT NOT NULL DEFAULT 'HEALTHY',
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "deliveryKey" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "responseStatus" INTEGER,
    "error" TEXT,
    "durationMs" INTEGER,
    "nextAttemptAt" TIMESTAMP(3),
    "attemptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SignalToken_tokenHash_key" ON "SignalToken"("tokenHash");

-- CreateIndex
CREATE INDEX "SignalToken_userId_createdAt_idx" ON "SignalToken"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SignalEvent_dedupeKey_key" ON "SignalEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "SignalEvent_userId_receivedAt_idx" ON "SignalEvent"("userId", "receivedAt");

-- CreateIndex
CREATE INDEX "SignalEvent_decision_receivedAt_idx" ON "SignalEvent"("decision", "receivedAt");

-- CreateIndex
CREATE INDEX "SignalEvent_tokenId_receivedAt_idx" ON "SignalEvent"("tokenId", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookSubscription_userId_eventType_idx" ON "WebhookSubscription"("userId", "eventType");

-- CreateIndex
CREATE INDEX "WebhookSubscription_active_health_idx" ON "WebhookSubscription"("active", "health");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_deliveryKey_attempt_key" ON "WebhookDelivery"("deliveryKey", "attempt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_userId_createdAt_idx" ON "WebhookDelivery"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_subscriptionId_createdAt_idx" ON "WebhookDelivery"("subscriptionId", "createdAt");

-- AddForeignKey
ALTER TABLE "SignalToken" ADD CONSTRAINT "SignalToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalEvent" ADD CONSTRAINT "SignalEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalEvent" ADD CONSTRAINT "SignalEvent_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "SignalToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "WebhookSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
