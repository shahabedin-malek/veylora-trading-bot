-- Phase 29: delivery channels, the delivery log, and a re-armable alert rule.
--
-- `MarketAlert` gains two columns. `conditionMet` makes a fire a *crossing* (false → true)
-- instead of every check while the condition stays true, and `cooldownMinutes` is the
-- shortest gap between two fires of that rule. Both are read by the atomic claim in
-- `claimAndAuditAlertTrigger`, so two overlapping runner invocations cannot both win.
--
-- `MarketAlertEvent` stops being one row per alert: a rule that fires again after its
-- cooldown appends another event. The old unique constraint on `alertId` has to go, and
-- `windowStart` (the cooldown bucket) with a unique index on (alertId, windowStart) takes
-- over the deduplication job. Existing rows are placed in the window they were created in;
-- the default is only needed while the column is added.
--
-- `NotificationChannelSettings` is the one global switchboard: three channels, quiet hours
-- in UTC (which may wrap midnight) and the cooldown a new rule starts with. It stores no
-- credential — provider keys and chat ids stay environment variables.
--
-- `NotificationDelivery` is append-only. A retry is another row rather than an overwrite,
-- so the provider response id, status, error and duration of every attempt survive. The
-- unique index on (dedupeKey, channel, attempt) is what makes a duplicate evaluation fail
-- to send twice: `dedupeKey` is (rule, condition, cooldown window).
--
-- Rollback: drop the two tables, the three indexes and the two `MarketAlert` columns,
-- delete the second-and-later `MarketAlertEvent` rows for any alert (the old schema allows
-- one), restore the unique constraint on `alertId`, and drop `windowStart`. Alerts then
-- behave as phase 19 left them, in-app only.
--
-- Verified statement for statement against the DDL Prisma derives from
-- `prisma/schema.prisma` (`prisma migrate diff --from-empty --to-schema-datamodel`), not
-- executed against Postgres, because no Postgres is reachable from this machine. The
-- development pipeline derives its SQLite schema from the same models (`db:setup`).

-- AlterTable
ALTER TABLE "MarketAlert" ADD COLUMN     "conditionMet" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cooldownMinutes" INTEGER NOT NULL DEFAULT 60;

-- AlterTable
DROP INDEX "MarketAlertEvent_alertId_key";
ALTER TABLE "MarketAlertEvent" ADD COLUMN     "windowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "NotificationChannelSettings" (
    "id" TEXT NOT NULL,
    "inAppEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "telegramEnabled" BOOLEAN NOT NULL DEFAULT false,
    "quietHoursEnabled" BOOLEAN NOT NULL DEFAULT false,
    "quietHoursStart" TEXT NOT NULL DEFAULT '22:00',
    "quietHoursEnd" TEXT NOT NULL DEFAULT '07:00',
    "defaultCooldownMinutes" INTEGER NOT NULL DEFAULT 60,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationChannelSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "alertId" TEXT,
    "channel" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerId" TEXT,
    "providerMessageId" TEXT,
    "error" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "durationMs" INTEGER,
    "dedupeKey" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "queuedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketAlertEvent_alertId_windowStart_key" ON "MarketAlertEvent"("alertId", "windowStart");

-- CreateIndex
CREATE INDEX "MarketAlertEvent_alertId_triggeredAt_idx" ON "MarketAlertEvent"("alertId", "triggeredAt");

-- CreateIndex
CREATE INDEX "NotificationChannelSettings_updatedByUserId_idx" ON "NotificationChannelSettings"("updatedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_dedupeKey_channel_attempt_key" ON "NotificationDelivery"("dedupeKey", "channel", "attempt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_userId_createdAt_idx" ON "NotificationDelivery"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_status_queuedAt_idx" ON "NotificationDelivery"("status", "queuedAt");

-- AddForeignKey
ALTER TABLE "NotificationChannelSettings" ADD CONSTRAINT "NotificationChannelSettings_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "MarketAlert"("id") ON DELETE SET NULL ON UPDATE CASCADE;
