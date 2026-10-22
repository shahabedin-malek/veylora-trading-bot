-- Retire the vestigial credential approval state. `permissionStatus` only ever
-- held 'READ_ONLY' (on create/verify) or 'REVOKED' (on revoke), and
-- `tradingApprovedAt` was never written to a value — it was only selected and
-- reset to NULL. Dropping columns is metadata-only in Postgres.
-- AlterTable
ALTER TABLE "TradingVenueCredential" DROP COLUMN "permissionStatus",
DROP COLUMN "tradingApprovedAt";
