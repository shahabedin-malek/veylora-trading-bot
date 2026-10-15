CREATE TABLE "MarketAlert" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "threshold" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastEvaluatedAt" TIMESTAMP(3),
    "lastObservedValue" TEXT,
    "lastEvaluationError" TEXT,
    "triggeredAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MarketAlert_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketAlertEvent" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "observedValue" TEXT NOT NULL,
    "sourceObservedAt" TIMESTAMP(3) NOT NULL,
    "providerId" TEXT NOT NULL,
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MarketAlertEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MarketAlertEvent_alertId_key" ON "MarketAlertEvent"("alertId");
CREATE INDEX "MarketAlert_userId_status_createdAt_idx" ON "MarketAlert"("userId", "status", "createdAt");
CREATE INDEX "MarketAlert_status_lastEvaluatedAt_createdAt_idx" ON "MarketAlert"("status", "lastEvaluatedAt", "createdAt");
CREATE INDEX "MarketAlertEvent_actorUserId_triggeredAt_idx" ON "MarketAlertEvent"("actorUserId", "triggeredAt");

ALTER TABLE "MarketAlert" ADD CONSTRAINT "MarketAlert_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketAlertEvent" ADD CONSTRAINT "MarketAlertEvent_alertId_fkey"
FOREIGN KEY ("alertId") REFERENCES "MarketAlert"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketAlertEvent" ADD CONSTRAINT "MarketAlertEvent_actorUserId_fkey"
FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;