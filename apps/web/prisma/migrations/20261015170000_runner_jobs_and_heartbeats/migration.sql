-- Phase 05: a runner that survives a closed browser, a sleeping laptop and a
-- deploy landing mid-flight.
--
-- `RunnerJob` holds the claim (leaseOwner + leaseExpiresAt), the attempt count
-- and the times the admin surface reads. The claim is a single conditional
-- UPDATE (`WHERE jobId = ? AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= now)`),
-- which is why the lease columns are on the job row rather than in a separate
-- lock table: one statement decides the winner, and no process memory is
-- involved, so a second serverless instance shares the same answer.
--
-- `RunnerInvocation` is the heartbeat: one row per invocation, with the per-job
-- heartbeats as redacted JSON. Retention keeps the newest rows
-- (src/lib/runner/claim.ts, `pruneRunnerInvocations`), so the index on
-- `startedAt` stays small.
--
-- Rollback: drop both tables. Nothing else references them, and the phases that
-- add work to the runner (orders, strategies) own their own tables.
-- CreateTable
CREATE TABLE "RunnerJob" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "intervalMinutes" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastStartedAt" TIMESTAMP(3),
    "lastFinishedAt" TIMESTAMP(3),
    "lastOutcome" TEXT,
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastReasonCode" TEXT,
    "lastReasonMessage" TEXT,
    "nextDueAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunnerJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunnerInvocation" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "selector" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "jobsDue" INTEGER NOT NULL,
    "jobsRan" INTEGER NOT NULL,
    "jobsSkipped" INTEGER NOT NULL,
    "jobsFailed" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "reasonCode" TEXT,
    "reasonMessage" TEXT,
    "heartbeatsJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunnerInvocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RunnerJob_jobId_key" ON "RunnerJob"("jobId");

-- CreateIndex
CREATE INDEX "RunnerJob_nextDueAt_idx" ON "RunnerJob"("nextDueAt");

-- CreateIndex
CREATE INDEX "RunnerInvocation_startedAt_idx" ON "RunnerInvocation"("startedAt");
