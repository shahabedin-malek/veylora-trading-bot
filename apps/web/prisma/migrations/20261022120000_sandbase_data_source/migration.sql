-- SandBase data source for the assistant (tool `search_social_posts`).
--
-- One admin switch beside the Tavily pair. The tool calls a third-party data API on this
-- deployment's SandBase key and balance, so the owner must be able to stop it without
-- touching the secret store. It defaults off: an existing row keeps the default, and the
-- assistant then refuses the tool by name instead of guessing.
--
-- Rollback: drop the column. `getIntegrationFeatureSettings` reads the declared switches as
-- a closed set, so the tool's gate fails closed and nothing else on the row changes.

-- AlterTable
ALTER TABLE "IntegrationFeatureSettings" ADD COLUMN "sandbaseDataEnabled" BOOLEAN NOT NULL DEFAULT false;
