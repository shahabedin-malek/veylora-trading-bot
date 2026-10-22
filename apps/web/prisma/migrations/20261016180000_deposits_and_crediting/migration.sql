-- Phase 12: deposits and crediting.
--
-- Three tables, and the constraints are the substance of the phase.
--
--   * `DepositAddress` — one address per account per network. `(userId, network)`
--     unique means an account cannot end up with two addresses on one chain, and
--     `(network, address)` unique means one address cannot be issued to two
--     accounts: a derivation collision has to be visible, because the address is
--     a pure function of the seed and the account id, so re-deriving a different
--     one would break the stability of the first account's address.
--
--   * `Deposit` — one row per transfer observed on chain. `(network, txHash,
--     logIndex)` is the *chain's own* identity for a transfer, and making it the
--     unique key is what makes detection idempotent: a restart, a re-scan or a
--     second runner re-reading the same block range can only ever produce the
--     row that already exists, so nothing can be credited twice. `userId` is
--     nullable because an arrival we cannot attribute (UNMATCHED) is a state the
--     product has to be able to show, not one to force onto an account.
--
--   * `DepositScanCursor` — how far each network has been read. Written in the
--     same transaction as the deposits found in that range, so a crash re-reads
--     the range rather than skipping it.
--
-- `status` is a plain string (PENDING, CREDITED, REVERTED, BELOW_DUST,
-- TOKEN_DISABLED, UNMATCHED) because the set lives in
-- `src/lib/deposits/states.ts` — one place that decides what a state means and
-- which of them counts as money — and `scripts/dev-database.mjs` refuses to
-- derive the SQLite development schema from a file containing an enum.
--
-- Rollback: drop the three tables. No balance is affected: crediting is the only
-- writer this phase introduces, and nothing else reads these rows.

-- CreateTable
CREATE TABLE "DepositAddress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "derivationIndex" INTEGER NOT NULL,
    "tokenSymbol" TEXT,
    "tokenAddress" TEXT,
    "tokenDecimals" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepositAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deposit" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "depositAddressId" TEXT,
    "network" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "tokenSymbol" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "decimals" INTEGER NOT NULL,
    "amount" TEXT NOT NULL,
    "rawAmount" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL DEFAULT -1,
    "blockNumber" INTEGER NOT NULL,
    "blockHash" TEXT NOT NULL,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reasonCode" TEXT,
    "reasonMessage" TEXT,
    "evidenceJson" TEXT NOT NULL DEFAULT '{}',
    "origin" TEXT NOT NULL DEFAULT 'WATCHER',
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creditedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "revertedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositScanCursor" (
    "network" TEXT NOT NULL,
    "lastScannedBlock" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositScanCursor_pkey" PRIMARY KEY ("network")
);

-- CreateIndex
CREATE UNIQUE INDEX "DepositAddress_userId_network_key" ON "DepositAddress"("userId", "network");

-- CreateIndex
CREATE UNIQUE INDEX "DepositAddress_network_address_key" ON "DepositAddress"("network", "address");

-- CreateIndex
CREATE INDEX "DepositAddress_userId_createdAt_idx" ON "DepositAddress"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_network_txHash_logIndex_key" ON "Deposit"("network", "txHash", "logIndex");

-- CreateIndex
CREATE INDEX "Deposit_userId_status_observedAt_idx" ON "Deposit"("userId", "status", "observedAt");

-- CreateIndex
CREATE INDEX "Deposit_status_network_observedAt_idx" ON "Deposit"("status", "network", "observedAt");

-- CreateIndex
CREATE INDEX "Deposit_depositAddressId_observedAt_idx" ON "Deposit"("depositAddressId", "observedAt");

-- AddForeignKey
ALTER TABLE "DepositAddress" ADD CONSTRAINT "DepositAddress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_depositAddressId_fkey" FOREIGN KEY ("depositAddressId") REFERENCES "DepositAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;
