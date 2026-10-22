-- Phase 22: the owner's real-money switch.
--
-- It is a column on the risk-policy row rather than a setting of its own because it is
-- edited in /admin/risk beside the limits and the kill switch, and because the same save
-- path (with its audit row) is what changes it. Off is the default and the only value a
-- deployment has until the owner turns it on.
--
-- `liveExecutionChangedByUserId` / `liveExecutionChangedAt` are written only when the
-- boolean actually moves, so the pair answers "who turned real-money execution on, and
-- when" without reading an audit diff. The audit trail carries the same change again as
-- its own event (`LIVE_EXECUTION_ENABLED` / `LIVE_EXECUTION_DISABLED`).
--
-- Verified against the DDL Prisma derives from `prisma/schema.prisma`
-- (`prisma migrate diff --from-empty --to-schema-datamodel`): `BOOLEAN NOT NULL DEFAULT
-- false`, then two nullables (`TEXT`, `TIMESTAMP(3)`). This machine has no Postgres server
-- to execute it against; the local SQLite development database is rebuilt from the same
-- schema by `pnpm db:setup`, and the migration only adds columns.

-- AlterTable
ALTER TABLE "RiskPolicySettings"
  ADD COLUMN "liveExecutionEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "liveExecutionChangedByUserId" TEXT,
  ADD COLUMN "liveExecutionChangedAt" TIMESTAMP(3);
