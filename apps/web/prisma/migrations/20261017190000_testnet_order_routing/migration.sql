-- Phase 21: the one switch that can move an order off the paper venue.
--
-- `testnetOrdersEnabled` is admin data, like the other integration switches, because
-- "should this deployment place orders on a sandbox?" is a decision about the whole
-- installation rather than a per-request choice. Off (the default) means the
-- development paper venue; on means the signed-in account's own Binance Spot Testnet
-- key is used, and a missing or read-only key refuses the order instead of falling
-- back to paper.
--
-- It is a boolean column rather than a nullable string naming a venue because there is
-- exactly one order venue in this build that may place. A live venue has no `place`
-- capability in `src/lib/venues/types.ts`, so `resolveOrderVenue` cannot select one,
-- and phase 22 adds the real-money switch in its own column rather than overloading
-- this one.
--
-- Rollback: drop the column. Order routing returns to the paper venue, which is what
-- every row meant before this phase.
--
-- Verified against the DDL Prisma derives from `prisma/schema.prisma` (the local SQLite
-- development database is built from that schema by `pnpm db:setup`); this machine has
-- no Postgres server to execute the migration against.

-- AlterTable
ALTER TABLE "IntegrationFeatureSettings"
  ADD COLUMN "testnetOrdersEnabled" BOOLEAN NOT NULL DEFAULT false;
