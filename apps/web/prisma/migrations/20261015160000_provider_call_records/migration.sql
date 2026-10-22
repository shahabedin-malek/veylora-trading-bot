-- Phase 04: one persisted record per outbound provider call, so the owner can
-- read what happened after the fact from /admin/data.
--
-- `url` stores the request URL after the redaction pass, never the raw one: an
-- Alchemy endpoint carries its key in the path. `requestId` and `route` join the
-- row to the server log lines of the request that made the call. Retention is
-- enforced by the writer (see src/lib/observability/provider-call.ts), which
-- trims the table to the newest PROVIDER_CALL_RETENTION rows, so the indexes
-- below stay small.
-- CreateTable
CREATE TABLE "ProviderCallRecord" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "statusCode" INTEGER,
    "outcome" TEXT NOT NULL,
    "reasonCode" TEXT,
    "durationMs" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL,
    "requestId" TEXT,
    "route" TEXT,
    "safeMessage" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderCallRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderCallRecord_providerId_occurredAt_idx" ON "ProviderCallRecord"("providerId", "occurredAt");

-- CreateIndex
CREATE INDEX "ProviderCallRecord_outcome_occurredAt_idx" ON "ProviderCallRecord"("outcome", "occurredAt");

-- CreateIndex
CREATE INDEX "ProviderCallRecord_occurredAt_idx" ON "ProviderCallRecord"("occurredAt");
