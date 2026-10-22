-- Phase 25: the owner's limits and kill switches, as data.
--
-- Every cap on `RiskPolicySettings` defaults to its "no limit" value, so applying this
-- migration to an existing deployment changes no behaviour: nothing an owner had configured
-- starts refusing orders. The evaluator treats `0` (and `[]` for the venue list) as
-- unlimited, which is why zero is the default rather than an arbitrary small number.
--
-- `limitsEffectiveFromJson` records, per limit, when it was last changed — the phase asks
-- for an effective-from time on each, and one column of `{field: iso}` is the smallest thing
-- that answers "since when?" per limit without a second table. `cooldownUntil` is the
-- post-halt cooldown: while it is in the future the evaluator holds new intents back and
-- names the cooldown and the minutes left. It is started by a halt — a daily-loss refusal,
-- or the owner releasing the global kill switch — and `cooldownMinutes` of 0 starts nothing.
--
-- Rollback: drop the added columns and the `StrategyKillSwitch` table. Behaviour returns to
-- the phase-24 baseline — the runner trades with no limit beyond the phase-20 policy, and the
-- global kill switch still works because its column predates this migration.

-- AlterTable
ALTER TABLE "RiskPolicySettings" ADD COLUMN "maxOrderNotionalUsd" TEXT NOT NULL DEFAULT '0';
ALTER TABLE "RiskPolicySettings" ADD COLUMN "maxStrategyNotionalUsd" TEXT NOT NULL DEFAULT '0';
ALTER TABLE "RiskPolicySettings" ADD COLUMN "maxOpenPositions" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RiskPolicySettings" ADD COLUMN "maxTradesPerInterval" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RiskPolicySettings" ADD COLUMN "tradeIntervalMinutes" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "RiskPolicySettings" ADD COLUMN "cooldownMinutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RiskPolicySettings" ADD COLUMN "allowedVenuesJson" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "RiskPolicySettings" ADD COLUMN "limitsEffectiveFromJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "RiskPolicySettings" ADD COLUMN "cooldownUntil" TIMESTAMP(3);
ALTER TABLE "RiskPolicySettings" ADD COLUMN "killSwitchChangedByUserId" TEXT;
ALTER TABLE "RiskPolicySettings" ADD COLUMN "killSwitchChangedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "StrategyKillSwitch" (
    "activationId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "changedByUserId" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StrategyKillSwitch_pkey" PRIMARY KEY ("activationId")
);

-- CreateIndex
CREATE INDEX "StrategyKillSwitch_active_idx" ON "StrategyKillSwitch"("active");

-- AddForeignKey
ALTER TABLE "StrategyKillSwitch" ADD CONSTRAINT "StrategyKillSwitch_activationId_fkey" FOREIGN KEY ("activationId") REFERENCES "StrategyActivation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
