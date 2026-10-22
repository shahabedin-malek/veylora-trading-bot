-- Phase 30: published bots, shared strategy templates and the owner's tier caps.
--
-- `Bot` is the persistent thing the builder produces. A draft is a row from the moment the
-- form is submitted; publishing attaches the phase-28 definition version (`definitionId`,
-- `definitionVersion`) and snapshots its text and JSON, so the bot keeps the exact rules it
-- was published with. `state` is DRAFT, PUBLISHED or DELETED; "running" lives on the
-- account's `StrategyActivation`, which names the bot as `bot:<id>`.
--
-- `StrategyTemplate` is a snapshot too: cloning copies `configJson` and the definition text,
-- so changing the source bot never rewrites a template somebody already cloned. Author is a
-- label for display plus the optional account id, not a wallet address.
--
-- Caps are not a table here: they are the `maxBots` and `maxVenueConnections` values on the
-- owner-editable fee tiers phase 16 introduced, so `/admin/fees` is the one place a limit is
-- changed and this phase's create/clone path and the existing venue-key path read the same
-- numbers.
--
-- Rollback: drop the two tables and their indexes. Existing bots stop being scheduled
-- because the runner's resolver can no longer read them; their decisions remain on
-- `StrategyDecision`, and orders are untouched.

-- CreateTable
CREATE TABLE "Bot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "market" TEXT NOT NULL,
    "configJson" TEXT NOT NULL,
    "definitionId" TEXT,
    "definitionVersion" INTEGER,
    "definitionText" TEXT,
    "definitionJson" TEXT,
    "templateSlug" TEXT,
    "publishedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyTemplate" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "authorUserId" TEXT,
    "authorLabel" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "configJson" TEXT NOT NULL,
    "definitionText" TEXT NOT NULL,
    "definitionJson" TEXT NOT NULL,
    "sourceBotId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Bot_userId_state_createdAt_idx" ON "Bot"("userId", "state", "createdAt");

-- CreateIndex
CREATE INDEX "Bot_templateSlug_idx" ON "Bot"("templateSlug");

-- CreateIndex
CREATE UNIQUE INDEX "StrategyTemplate_slug_key" ON "StrategyTemplate"("slug");

-- CreateIndex
CREATE INDEX "StrategyTemplate_authorUserId_createdAt_idx" ON "StrategyTemplate"("authorUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "Bot" ADD CONSTRAINT "Bot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "StrategyTemplate" ADD CONSTRAINT "StrategyTemplate_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
