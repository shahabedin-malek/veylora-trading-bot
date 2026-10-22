-- Phase 36: the audit trail's hash chain and retention window.
--
-- The added columns are nullable on purpose: rows written before this phase keep
-- their null chain fields and the verifier treats them as the legacy prefix. No
-- existing row is back-dated with an invented hash.

ALTER TABLE "AuditEvent"
  ADD COLUMN "chainIndex" INTEGER,
  ADD COLUMN "previousHash" TEXT,
  ADD COLUMN "hash" TEXT,
  ADD COLUMN "source" TEXT,
  ADD COLUMN "correlationId" TEXT,
  ADD COLUMN "beforeJson" TEXT,
  ADD COLUMN "afterJson" TEXT;

CREATE UNIQUE INDEX "AuditEvent_chainIndex_key" ON "AuditEvent"("chainIndex");
CREATE UNIQUE INDEX "AuditEvent_hash_key" ON "AuditEvent"("hash");
CREATE INDEX "AuditEvent_correlationId_occurredAt_idx" ON "AuditEvent"("correlationId", "occurredAt");
CREATE INDEX "AuditEvent_chainIndex_idx" ON "AuditEvent"("chainIndex");

CREATE TABLE "AuditRetentionPolicy" (
  "id" TEXT NOT NULL,
  "windowDays" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "updatedByUserId" TEXT,
  CONSTRAINT "AuditRetentionPolicy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditRetentionPolicy_updatedAt_idx" ON "AuditRetentionPolicy"("updatedAt");

-- Append-only is a property of the code path: `AuditEvent` has one writer and no
-- update function anywhere in the application (asserted by tests/audit-log.test.ts).
-- The only deletion is the retention job, which writes an AUDIT_RETENTION_APPLIED
-- marker in the same transaction before removing the rows it names. A row that
-- predates this migration keeps its null chain fields; nothing is back-dated.
