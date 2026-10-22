-- Phase 27: AI provider routing and per-request metering.
--
-- Two tables, both new and both independent of the rest of the schema:
--
--   * AiProviderSettings is the deployment's singleton routing document. `routesJson`
--     is the ordered target list per feature, validated as a whole before it is
--     stored, so a save either changes every route or none. No row means "use the
--     environment defaults", which is the behaviour of an install that never opens
--     the panel.
--
--   * AiRequestRecord is one row per provider attempt. A fallback writes two: the
--     failed attempt and the success that names it in `fallbackFrom`. `costMicrosUsd`
--     is nullable on purpose — an unpriced provider has an unknown cost, and the
--     report counts those separately instead of pretending they are free.
--
-- Neither table has a column for a prompt, an answer or a request body: this is
-- accounting, not a transcript.
--
-- Rollback: drop both tables. The ChainGPT settings route and the assistant's own
-- usage window are unaffected; the assistant keeps working with the environment
-- defaults because the routing read falls back when the table is absent.

-- CreateTable
CREATE TABLE "AiProviderSettings" (
    "id" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "usdPerCurrencyUnit" TEXT NOT NULL DEFAULT '1',
    "monthlyBudgetUsd" TEXT,
    "routesJson" TEXT NOT NULL DEFAULT '{}',
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiProviderSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiRequestRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "feature" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "model" TEXT,
    "outcome" TEXT NOT NULL,
    "errorCode" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "units" INTEGER NOT NULL DEFAULT 0,
    "unitKind" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "costMicrosUsd" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "fallbackFrom" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiRequestRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiProviderSettings_updatedByUserId_idx" ON "AiProviderSettings"("updatedByUserId");

-- CreateIndex
CREATE INDEX "AiRequestRecord_createdAt_idx" ON "AiRequestRecord"("createdAt");

-- CreateIndex
CREATE INDEX "AiRequestRecord_feature_createdAt_idx" ON "AiRequestRecord"("feature", "createdAt");

-- CreateIndex
CREATE INDEX "AiRequestRecord_userId_createdAt_idx" ON "AiRequestRecord"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiRequestRecord_providerId_createdAt_idx" ON "AiRequestRecord"("providerId", "createdAt");

-- AddForeignKey
ALTER TABLE "AiProviderSettings" ADD CONSTRAINT "AiProviderSettings_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRequestRecord" ADD CONSTRAINT "AiRequestRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
