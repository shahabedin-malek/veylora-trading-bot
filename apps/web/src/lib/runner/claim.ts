import type { ReasonCode } from "@/lib/observability/reason";

/**
 * Claiming a job with a lease, and the persistence the runner reads and writes.
 *
 * The host is not a scheduler that keeps promises. Its documented behaviour is
 * that delivery is best effort, that a missed run is simply never executed (and
 * leaves no runtime log), that a run may occasionally be delivered twice for the
 * same time slot, and that a deployment does not interrupt an invocation that is
 * already running. Every one of those facts lands here:
 *
 *  - **A claim is one atomic statement, and it carries the due check.**
 *    `UPDATE … WHERE jobId = ? AND nextDueAt <= ? AND (leaseExpiresAt IS NULL OR
 *    leaseExpiresAt <= now)` either wins the row or returns zero rows. Two
 *    runners started at the same moment cannot both take the same job, and
 *    nothing is locked in process memory — a second serverless instance shares
 *    none. The due condition inside the statement is load-bearing: deciding "is
 *    it due?" from a read and then claiming is *not* enough, because between the
 *    two another invocation can finish the job and move its next due time. The
 *    first version of this module did exactly that, and four concurrent calls to
 *    the local endpoint ran the alert job twice (the second run was harmless,
 *    because that job is idempotent — but "harmless" is not the standard a job
 *    that places an order will be held to).
 *  - **A lease expires.** A runner killed mid-job (deploy, crash, platform
 *    timeout) leaves the lease behind and nothing else; once it lapses the next
 *    invocation reclaims the job and the attempt count says it happened.
 *  - **Timing is best effort, so due-ness is not a clock comparison to a tick.**
 *    Jobs are due when their interval has elapsed, minus the host's documented
 *    invocation window, so a call that lands late still runs the work while a
 *    call that lands twice in one slot does not.
 */

/**
 * How long a claim is held before another invocation may reclaim it. Shorter
 * than the 300-second ceiling the host gives a request on its entry plans, so a
 * job that dies quietly becomes reclaimable within the same hour rather than
 * holding the lease until the platform kills the invocation.
 */
export const DEFAULT_LEASE_MS = 120_000;

/**
 * The window the host documents for delivering a scheduled invocation: on the
 * entry plans a daily job "may be invoked at any point within the specified
 * hour" (±59 minutes). A due check that ignored this would skip work whenever a
 * late delivery landed just before the next interval elapsed, and would run work
 * twice whenever it landed just after. See README, "The runner and the host's
 * real cadence".
 */
export const HOST_INVOCATION_WINDOW_MINUTES = 59;

/** How many invocation summaries are kept. */
export const RUNNER_INVOCATION_RETENTION = 200;

export type RunnerJobOutcome = "worked" | "idle" | "failed";

/** A job row, with times as epoch milliseconds so comparisons stay exact. */
export type RunnerJobState = {
  jobId: string;
  intervalMinutes: number;
  attempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastOutcome: RunnerJobOutcome | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastReasonCode: ReasonCode | null;
  lastReasonMessage: string | null;
  nextDueAt: number;
};

export type RunnerInvocationRecord = {
  invocationId: string;
  owner: string;
  selector: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  jobsDue: number;
  jobsRan: number;
  jobsSkipped: number;
  jobsFailed: number;
  outcome: string;
  reasonCode: ReasonCode | null;
  reasonMessage: string | null;
  /** The per-job heartbeats, as stored JSON: already redacted, no secrets. */
  heartbeats: unknown;
};

/**
 * What the runner needs from storage. Narrow on purpose: any implementation that
 * makes `claimJob` atomic is a valid runner backing store, which is what lets a
 * test prove single-execution without a database.
 */
export type RunnerStore = {
  /** Create the row on first sight, then keep its interval current. Never touches a lease. */
  ensureJob(input: { jobId: string; intervalMinutes: number; now: number }): Promise<RunnerJobState>;
  /**
   * Take the job, if and only if it is due (as of the row itself) and unleased.
   * Null when somebody else holds it or it has already run for this interval.
   */
  claimJob(input: {
    jobId: string;
    owner: string;
    now: number;
    leaseMs: number;
    /** The latest `nextDueAt` this claim may accept, i.e. now plus the delivery grace. */
    dueBefore: number;
  }): Promise<RunnerJobState | null>;
  /** Record the finished run, clear the lease and set the next due time. */
  finishJob(input: {
    jobId: string;
    owner: string;
    now: number;
    outcome: RunnerJobOutcome;
    reasonCode: ReasonCode | null;
    reasonMessage: string | null;
    nextDueAt: number;
  }): Promise<void>;
  recordInvocation(record: RunnerInvocationRecord): Promise<void>;
  listJobs(jobIds?: readonly string[]): Promise<RunnerJobState[]>;
  latestInvocation(): Promise<RunnerInvocationRecord | null>;
};

/**
 * The grace a due check allows for a late delivery, capped at a quarter of the
 * interval so a short interval cannot be widened into double work: a job with a
 * 24-hour interval is due within the host's hour-wide window, and an hourly job
 * is due only in its last 15 minutes.
 */
export function dueGraceMs(intervalMinutes: number): number {
  const hostWindowMs = HOST_INVOCATION_WINDOW_MINUTES * 60_000;
  return Math.min(hostWindowMs, Math.floor((intervalMinutes * 60_000) / 4));
}

/** Is this job's interval elapsed (within the host's delivery window)? */
export function isDue(state: Pick<RunnerJobState, "nextDueAt" | "intervalMinutes">, now: number): boolean {
  return now >= state.nextDueAt - dueGraceMs(state.intervalMinutes);
}

/** Is somebody else's claim still live? */
export function leaseIsActive(state: Pick<RunnerJobState, "leaseOwner" | "leaseExpiresAt">, now: number): boolean {
  return state.leaseOwner !== null && state.leaseExpiresAt !== null && state.leaseExpiresAt > now;
}

export function nextDueFrom(now: number, intervalMinutes: number): number {
  return now + Math.max(1, intervalMinutes) * 60_000;
}

type StoredRunnerJob = {
  jobId: string;
  intervalMinutes: number;
  attempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastOutcome: string | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastReasonCode: string | null;
  lastReasonMessage: string | null;
  nextDueAt: Date;
};

function toMillis(value: Date | null): number | null {
  return value ? value.getTime() : null;
}

function toJobOutcome(value: string | null): RunnerJobOutcome | null {
  return value === "worked" || value === "idle" || value === "failed" ? value : null;
}

/** The row as the runner uses it: times in milliseconds, outcomes narrowed. */
export function toRunnerJobState(row: StoredRunnerJob): RunnerJobState {
  return {
    jobId: row.jobId,
    intervalMinutes: row.intervalMinutes,
    attempts: row.attempts,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: toMillis(row.leaseExpiresAt),
    lastStartedAt: toMillis(row.lastStartedAt),
    lastFinishedAt: toMillis(row.lastFinishedAt),
    lastOutcome: toJobOutcome(row.lastOutcome),
    lastSuccessAt: toMillis(row.lastSuccessAt),
    lastFailureAt: toMillis(row.lastFailureAt),
    lastReasonCode: (row.lastReasonCode as ReasonCode | null) ?? null,
    lastReasonMessage: row.lastReasonMessage,
    nextDueAt: row.nextDueAt.getTime(),
  };
}

/**
 * The Prisma-backed store.
 *
 * `@/lib/db` is imported inside each call rather than at module load, so
 * importing the runner never constructs a database client: a unit test or a
 * script that injects its own store must not need a database to exist.
 */
export function createPrismaRunnerStore(): RunnerStore {
  return {
    async ensureJob({ jobId, intervalMinutes, now }) {
      const { prisma } = await import("@/lib/db");
      const row = await prisma.runnerJob.upsert({
        where: { jobId },
        // The interval is refreshed, nothing else: a re-read of the job list must
        // never clear a lease or push back a due time.
        update: { intervalMinutes },
        create: {
          jobId,
          intervalMinutes,
          nextDueAt: new Date(now - dueGraceMs(intervalMinutes)),
        },
      });
      return toRunnerJobState(row);
    },

    async claimJob({ jobId, owner, now, leaseMs, dueBefore }) {
      const { prisma } = await import("@/lib/db");
      // One statement. The condition and the write are evaluated together by the
      // database, so the winner is decided by the row itself and not by anything
      // this process holds — including the due time, which a stale read in this
      // process can no longer get wrong.
      const claimed = await prisma.runnerJob.updateMany({
        where: {
          jobId,
          nextDueAt: { lte: new Date(dueBefore) },
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date(now) } }],
        },
        data: {
          leaseOwner: owner,
          leaseExpiresAt: new Date(now + leaseMs),
          lastStartedAt: new Date(now),
          attempts: { increment: 1 },
        },
      });
      if (claimed.count === 0) return null;
      const row = await prisma.runnerJob.findUnique({ where: { jobId } });
      return row ? toRunnerJobState(row) : null;
    },

    async finishJob({ jobId, owner, now, outcome, reasonCode, reasonMessage, nextDueAt }) {
      const { prisma } = await import("@/lib/db");
      // The lease is released by clearing the owner, and only the holder may
      // release it: a stale invocation whose lease already lapsed must not
      // finish a job another invocation has since claimed.
      const finished = await prisma.runnerJob.updateMany({
        where: { jobId, leaseOwner: owner },
        data: {
          leaseOwner: null,
          leaseExpiresAt: null,
          lastFinishedAt: new Date(now),
          lastOutcome: outcome,
          lastReasonCode: reasonCode,
          lastReasonMessage: reasonMessage,
          nextDueAt: new Date(nextDueAt),
          lastSuccessAt: outcome === "failed" ? undefined : new Date(now),
          lastFailureAt: outcome === "failed" ? new Date(now) : undefined,
        },
      });
      if (finished.count === 0) {
        // The lease lapsed while the job ran and somebody else has it now. Their
        // attempt count is the truth; this invocation's outcome is already in the
        // log and in the summary record, so nothing is overwritten here.
        return;
      }
    },

    async recordInvocation(record) {
      const { prisma } = await import("@/lib/db");
      await prisma.runnerInvocation.create({
        data: {
          id: record.invocationId,
          owner: record.owner,
          selector: record.selector,
          startedAt: new Date(record.startedAt),
          finishedAt: new Date(record.finishedAt),
          durationMs: record.durationMs,
          jobsDue: record.jobsDue,
          jobsRan: record.jobsRan,
          jobsSkipped: record.jobsSkipped,
          jobsFailed: record.jobsFailed,
          outcome: record.outcome,
          reasonCode: record.reasonCode,
          reasonMessage: record.reasonMessage,
          heartbeatsJson: JSON.stringify(record.heartbeats),
        },
      });
    },

    async listJobs(jobIds) {
      const { prisma } = await import("@/lib/db");
      const rows = await prisma.runnerJob.findMany({
        ...(jobIds && jobIds.length > 0 ? { where: { jobId: { in: [...jobIds] } } } : {}),
        orderBy: { jobId: "asc" },
      });
      return rows.map(toRunnerJobState);
    },

    async latestInvocation() {
      const { prisma } = await import("@/lib/db");
      const row = await prisma.runnerInvocation.findFirst({ orderBy: { startedAt: "desc" } });
      if (!row) return null;
      return {
        invocationId: row.id,
        owner: row.owner,
        selector: row.selector,
        startedAt: row.startedAt.getTime(),
        finishedAt: row.finishedAt.getTime(),
        durationMs: row.durationMs,
        jobsDue: row.jobsDue,
        jobsRan: row.jobsRan,
        jobsSkipped: row.jobsSkipped,
        jobsFailed: row.jobsFailed,
        outcome: row.outcome,
        reasonCode: (row.reasonCode as ReasonCode | null) ?? null,
        reasonMessage: row.reasonMessage,
        heartbeats: parseStoredHeartbeats(row.heartbeatsJson),
      };
    },
  };
}

function parseStoredHeartbeats(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    // A row that cannot be read back is reported as unreadable rather than
    // silently replaced with an empty list that would read like "nothing ran".
    return { unreadable: true };
  }
}

let sharedStore: RunnerStore | null = null;

/**
 * The store the running application uses. The instance holds no connection of
 * its own, so caching it per process is safe and keeps every invocation reading
 * the same rows.
 */
export function runnerStore(): RunnerStore {
  sharedStore ??= createPrismaRunnerStore();
  return sharedStore;
}

/** Trim the invocation summaries to the newest `retain` rows. Returns how many were dropped. */
export async function pruneRunnerInvocations(retain = RUNNER_INVOCATION_RETENTION): Promise<number> {
  const { prisma } = await import("@/lib/db");
  const boundary = await prisma.runnerInvocation.findMany({
    orderBy: { startedAt: "desc" },
    skip: Math.max(0, retain - 1),
    take: 1,
    select: { startedAt: true },
  });
  const oldestKept = boundary[0]?.startedAt;
  if (!oldestKept) return 0;
  const { count } = await prisma.runnerInvocation.deleteMany({ where: { startedAt: { lt: oldestKept } } });
  return count;
}
