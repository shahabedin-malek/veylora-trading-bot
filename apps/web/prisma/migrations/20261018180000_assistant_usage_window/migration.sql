-- Phase 26: per-user assistant accounting.
--
-- The assistant spends a provider's tokens on every question, so its limit has to be
-- durable: an in-memory counter is reset by a deploy, which is exactly when a client
-- retries. One row per (user, window kind, window floor) is incremented with an
-- upsert, so two server processes counting the same hour land on the same row.
--
-- `requests` is incremented before the provider is called (a request that fails still
-- cost something); `inputTokens` / `outputTokens` and `costMicros` are written when the
-- provider reports its usage. Cost is micro-dollars in an integer, like every other
-- money column here.
--
-- Rollback: drop the table. The assistant keeps its per-process guard and the rest of
-- the product is unaffected; no other table references it.

-- CreateTable
CREATE TABLE "AssistantUsageWindow" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "windowKind" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantUsageWindow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AssistantUsageWindow_userId_windowKind_windowStart_key" ON "AssistantUsageWindow"("userId", "windowKind", "windowStart");

-- CreateIndex
CREATE INDEX "AssistantUsageWindow_windowStart_idx" ON "AssistantUsageWindow"("windowStart");

-- AddForeignKey
ALTER TABLE "AssistantUsageWindow" ADD CONSTRAINT "AssistantUsageWindow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
