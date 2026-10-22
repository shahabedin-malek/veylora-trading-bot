-- Phase 14: withdrawals and their failure paths.
--
-- Three tables, and the shape of each is the guarantee it carries.
--
--   * `Withdrawal` — one request, from reservation to settlement. The three
--     amounts are exact integer strings of the asset's smallest unit, the same way
--     a ledger amount is: `amountMinor` is what the owner asked for,
--     `feeMinor` is what the platform keeps, and `netMinor` is what leaves for the
--     destination. `nonce` is allocated once per (network, fromAddress) and the
--     unique index below is what makes that true — two withdrawals cannot take the
--     same nonce, so the second one is refused as a conflict rather than signing a
--     transaction that could replace the first. `rawTransaction` and
--     `cancelRawTransaction` hold the signed bytes, so a retry re-sends the same
--     transaction instead of building a second one, and `idempotencyKey` is unique
--     so one request cannot become two withdrawals.
--     `holdUntil` is the owner's own configured new-address window (null when that
--     window is zero, which holds nothing), `expiresAt` bounds how long an
--     unexecuted request may wait, and `timeoutAt` is when a still-unconfirmed
--     broadcast may be cancelled.
--
--   * `WithdrawalAddress` — the destinations this account has used before, per
--     network. It exists so the new-address window has a fact to read rather than
--     a judgement to make: a destination absent from this table is a first-time
--     destination, and a window of zero minutes holds nothing.
--
--   * `LedgerAccountLock` — a mutex on one ledger account for the length of one
--     transaction. A balance is the sum of its entries, so there is no balance row
--     to lock; two reservations that each read the same available balance and then
--     each insert their own entries are individually valid and together spend the
--     same money. The lock is inserted before the balance is read inside the same
--     transaction, so the second request re-reads after the first has committed;
--     `expiresAt` lets a request killed mid-flight be taken over rather than
--     wedging an account forever.
--
-- Rollback: drop the three tables. The reservation writer is removed with the
-- code, so nothing is left reserved: the ledger keeps the movements that were
-- posted, and a withdrawal that was mid-flight cannot be advanced.

-- CreateTable
CREATE TABLE "Withdrawal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "asset" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "amountMinor" TEXT NOT NULL,
    "feeMinor" TEXT NOT NULL,
    "netMinor" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "destinationDisplay" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reasonCode" TEXT,
    "reasonMessage" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "fromAddress" TEXT,
    "nonce" INTEGER,
    "rawTransaction" TEXT,
    "txHash" TEXT,
    "cancelRawTransaction" TEXT,
    "cancelTxHash" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "confirmationsRequired" INTEGER,
    "holdUntil" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "timeoutAt" TIMESTAMP(3),
    "broadcastAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Withdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WithdrawalAddress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "addressDisplay" TEXT NOT NULL,
    "useCount" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WithdrawalAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerAccountLock" (
    "key" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerAccountLock_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Withdrawal_idempotencyKey_key" ON "Withdrawal"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Withdrawal_userId_createdAt_idx" ON "Withdrawal"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Withdrawal_status_idx" ON "Withdrawal"("status");

-- CreateIndex
CREATE INDEX "Withdrawal_expiresAt_idx" ON "Withdrawal"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Withdrawal_network_fromAddress_nonce_key" ON "Withdrawal"("network", "fromAddress", "nonce");

-- CreateIndex
CREATE INDEX "WithdrawalAddress_userId_idx" ON "WithdrawalAddress"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WithdrawalAddress_userId_network_address_key" ON "WithdrawalAddress"("userId", "network", "address");

-- CreateIndex
CREATE INDEX "LedgerAccountLock_expiresAt_idx" ON "LedgerAccountLock"("expiresAt");

-- AddForeignKey
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithdrawalAddress" ADD CONSTRAINT "WithdrawalAddress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
