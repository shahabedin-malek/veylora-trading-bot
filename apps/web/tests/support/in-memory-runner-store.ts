import {
  dueGraceMs,
  type RunnerInvocationRecord,
  type RunnerJobOutcome,
  type RunnerJobState,
  type RunnerStore,
} from "@/lib/runner/claim";
import type { ReasonCode } from "@/lib/observability/reason";

/**
 * A runner store that keeps its rows in memory.
 *
 * It exists so the scheduler's guarantees can be tested without a database:
 * single execution under concurrency, lease expiry, attempt counting and the
 * heartbeat record. The semantics below deliberately mirror the Prisma store row
 * for row — in particular `claimJob`, whose whole body runs without an `await`
 * so the check and the write cannot be interleaved, which is the in-process
 * equivalent of the single conditional UPDATE the real store issues.
 */
export class InMemoryRunnerStore implements RunnerStore {
  readonly jobs = new Map<string, RunnerJobState>();
  readonly invocations: RunnerInvocationRecord[] = [];

  /** Set when a test wants to simulate a run that died without writing anything. */
  readonly abandonedLeases = new Set<string>();

  async ensureJob({ jobId, intervalMinutes, now }: { jobId: string; intervalMinutes: number; now: number }) {
    const existing = this.jobs.get(jobId);
    if (existing) {
      existing.intervalMinutes = intervalMinutes;
      return { ...existing };
    }
    // A job the runner has never seen is due immediately: `nextDueAt` sits one
    // grace window in the past, so the very first invocation runs it.
    const created: RunnerJobState = {
      jobId,
      intervalMinutes,
      attempts: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastOutcome: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastReasonCode: null,
      lastReasonMessage: null,
      nextDueAt: now - dueGraceMs(intervalMinutes),
    };
    this.jobs.set(jobId, created);
    return { ...created };
  }

  async claimJob({
    jobId,
    owner,
    now,
    leaseMs,
    dueBefore,
  }: {
    jobId: string;
    owner: string;
    now: number;
    leaseMs: number;
    dueBefore: number;
  }) {
    const row = this.jobs.get(jobId);
    if (!row) return null;
    // Mirrors the Prisma store's single statement: the row's own due time and
    // lease are both re-checked here, so a caller holding a stale read cannot
    // take a job another invocation has already run for this interval.
    if (row.nextDueAt > dueBefore) return null;
    const claimable = row.leaseExpiresAt === null || row.leaseExpiresAt <= now;
    if (!claimable) return null;
    row.leaseOwner = owner;
    row.leaseExpiresAt = now + leaseMs;
    row.lastStartedAt = now;
    row.attempts += 1;
    this.abandonedLeases.delete(jobId);
    return { ...row };
  }

  async finishJob({
    jobId,
    owner,
    now,
    outcome,
    reasonCode,
    reasonMessage,
    nextDueAt,
  }: {
    jobId: string;
    owner: string;
    now: number;
    outcome: RunnerJobOutcome;
    reasonCode: ReasonCode | null;
    reasonMessage: string | null;
    nextDueAt: number;
  }) {
    const row = this.jobs.get(jobId);
    // Only the holder may finish a job: a stale invocation whose lease lapsed
    // must not overwrite the row another invocation has since claimed.
    if (!row || row.leaseOwner !== owner) return;
    row.leaseOwner = null;
    row.leaseExpiresAt = null;
    row.lastFinishedAt = now;
    row.lastOutcome = outcome;
    row.lastReasonCode = reasonCode;
    row.lastReasonMessage = reasonMessage;
    row.nextDueAt = nextDueAt;
    if (outcome === "failed") row.lastFailureAt = now;
    else row.lastSuccessAt = now;
  }

  async recordInvocation(record: RunnerInvocationRecord) {
    this.invocations.push(record);
  }

  async listJobs(jobIds?: readonly string[]) {
    const rows = [...this.jobs.values()].filter((row) => !jobIds || jobIds.includes(row.jobId));
    return rows.map((row) => ({ ...row })).sort((left, right) => left.jobId.localeCompare(right.jobId));
  }

  async latestInvocation() {
    return this.invocations.at(-1) ?? null;
  }

  /**
   * Leave a job in the state a killed invocation leaves behind: claimed, never
   * finished, and with a lease that has already lapsed.
   */
  simulateKilledRun(jobId: string, input: { now: number }) {
    const row = this.jobs.get(jobId);
    if (!row) throw new Error(`cannot abandon a job that does not exist: ${jobId}`);
    // The killed invocation claimed the job — that attempt happened — and then
    // died before finishing it, so the count goes up and nothing is written back.
    row.attempts += 1;
    row.leaseOwner = "invocation-that-was-killed";
    row.leaseExpiresAt = input.now - 1_000;
    row.lastStartedAt = input.now - 60_000;
    row.lastFinishedAt = null;
    row.lastOutcome = null;
    this.abandonedLeases.add(jobId);
  }
}
