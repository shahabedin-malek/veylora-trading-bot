-- Phase 20: what a key asked for, what the venue said it got, and how the last check went.
--
-- `requestedPermissions` is the owner's own statement, as a JSON array over the closed
-- vocabulary in `src/lib/venues/types.ts`. It mirrors `readOnly` for every row this
-- build writes (`["read"]` for a read-only key, `["read","trade"]` for one connected to
-- trade), and it exists because "what did I ask for?" is a different question from "what
-- can this key do at the venue?" — the second one is `reportedPermissions`.
--
-- `reportedPermissions` is null when the venue does not answer a permission question.
-- Null is load-bearing: it is the difference between "the venue says this key can only
-- read" and "this venue does not report key permissions", and the panel prints those as
-- two different sentences rather than collapsing them.
--
-- The three `lastCheck*` columns record the most recent verification attempt, including
-- a failed one. `verifiedAt` keeps its previous meaning — the last time the key was
-- proved to work — so a key that worked yesterday and is broken today keeps that date
-- while `lastCheckError` says what happened since. The default for a new
-- `requestedPermissions` is the empty array, which reads as "not recorded" for rows
-- written before this phase; nothing is backfilled from `readOnly`, because deriving a
-- statement the owner never made would be inventing it.
--
-- Rollback: drop the five columns. Every connection keeps working through `readOnly`
-- and `verifiedAt`, which is what it used before this phase.
--
-- Verified statement for statement against the DDL Prisma derives from
-- `prisma/schema.prisma` rather than executed against Postgres, which this machine has
-- no server for; the same migration is applied to the local SQLite development database
-- through `pnpm db:setup`, which derives its schema from this one.

-- AlterTable
ALTER TABLE "TradingVenueCredential"
  ADD COLUMN "requestedPermissions" TEXT NOT NULL DEFAULT '[]',
  ADD COLUMN "reportedPermissions" TEXT,
  ADD COLUMN "lastCheckedAt" TIMESTAMP(3),
  ADD COLUMN "lastCheckLatencyMs" INTEGER,
  ADD COLUMN "lastCheckError" TEXT;
