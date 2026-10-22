-- The owner's stop switch for outbound money.
--
-- It is not an approval gate: it refuses every new withdrawal request and stops the
-- processor sending a reserved one. A transfer already broadcast is still confirmed and
-- settled, because stopping mid-flight would leave the book unable to explain where the
-- money went. The switch is audited on every change with its actor and time.
ALTER TABLE "WithdrawalSettings" ADD COLUMN "paused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WithdrawalSettings" ADD COLUMN "pausedChangedByUserId" TEXT;
ALTER TABLE "WithdrawalSettings" ADD COLUMN "pausedChangedAt" TIMESTAMP(3);

CREATE INDEX "WithdrawalSettings_pausedChangedByUserId_idx" ON "WithdrawalSettings"("pausedChangedByUserId");
