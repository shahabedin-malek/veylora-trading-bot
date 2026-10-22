-- Phase 14 follow-on: the owner's own withdrawal window, as admin data.
--
-- One number: how long a first withdrawal to an address this account has never used
-- waits before it is queued. It lives in a table rather than only in the environment
-- because it is a control the owner changes for their own money, and changing it should
-- not mean a redeploy. The environment value stays as the fallback for a deployment
-- whose row has never been written, which is what `WITHDRAWAL_NEW_ADDRESS_WINDOW_MINUTES`
-- means; a stored row always wins over it.
--
-- Nothing else is in this table, and that is deliberate. There is no approval flag, no
-- review state and no switch that could stop a withdrawal the owner asked for: the
-- product has no gate of that kind, and a column here would be the place one would
-- appear. Zero is a complete answer — it holds nothing — and it is the value that makes
-- this table's absence equivalent to "no hold at all".
--
-- Rollback: drop the table. Nothing reads the stored window once the overlay that
-- applies it is gone, so the deployment falls back to the environment value, and
-- withdrawals already held keep the `holdUntil` they were created with.

-- CreateTable
CREATE TABLE "WithdrawalSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "newAddressWindowMinutes" INTEGER NOT NULL DEFAULT 60,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WithdrawalSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WithdrawalSettings_updatedByUserId_idx" ON "WithdrawalSettings"("updatedByUserId");

-- AddForeignKey
ALTER TABLE "WithdrawalSettings" ADD CONSTRAINT "WithdrawalSettings_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
