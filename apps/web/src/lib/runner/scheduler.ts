import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { redactString } from "@/lib/observability/logger";
import { parseReason, reason, serializeReason, type Reason, type ReasonCode } from "@/lib/observability/reason";
import { loggerFor } from "@/lib/observability/request-context";
import {
  DEFAULT_LEASE_MS,
  dueGraceMs,
  isDue,
  leaseIsActive,
  nextDueFrom,
  runnerStore,
  type RunnerJobOutcome,
  type RunnerJobState,
  type RunnerStore,
} from "@/lib/runner/claim";
import {
  buildInvocationSummary,
  heartbeatReason,
  type RunnerHeartbeat,
  type RunnerInvocationSummary,
} from "@/lib/runner/heartbeat";
import { ALL_JOBS, resolveJobSelection, RUNNER_JOBS, type RunnerJobDefinition } from "@/lib/runner/registry";

/**
 * The runner entry point: what runs when the host calls.
 *
 * One invocation walks the job list, and for each job it decides in this order:
 *
 *  1. **Is it due?** A job whose interval has not elapsed is skipped with a
 *     `NOT_YET_DUE` reason that names the next due time. This is what makes a
 *     second call in the same slot cheap instead of duplicate work.
 *  2. **Is somebody already running it?** A live lease means another invocation
 *     holds the job; this one leaves it alone with an `ALREADY_RUNNING` reason.
 *  3. **Claim it.** The claim is a single atomic write (see `claim.ts`). Losing
 *     the race is a normal outcome, reported the same way as an active lease.
 *  4. **Run it, then write it down.** Success, idle and failure all end in a
 *     heartbeat, and a failure is turned into a specific reason rather than a
 *     bare "something went wrong".
 *
 * A job that throws does not stop the others: the loop continues, and the
 * summary says how many failed. That matters because the jobs that will be added
 * here later (orders, strategies) must not be blocked by one unhealthy provider.
 *
 * The whole invocation ends by writing one summary record, so "what did the
 * runner do at 00:00, and why did nothing happen?" is answered from stored data.
 */

export type RunRunnerInput = {
  /** The selector from the URL: `all`, one job id, or a comma-separated list. */
  selector?: string | null;
  /** Which process this is, recorded on the heartbeat. Defaults to host + pid + a random suffix. */
  owner?: string;
  invocationId?: string;
  /** A fixed clock, for a test that must not depend on wall time. */
  now?: Date;
  store?: RunnerStore;
  jobs?: readonly RunnerJobDefinition[];
  leaseMs?: number;
  env?: NodeJS.ProcessEnv;
};

/**
 * Turn a thrown job into the shared reason type.
 *
 * A reason the job *carried* is kept as it is: a job that knows exactly what went
 * wrong (the ledger does not balance, and here is the row) should not have its
 * answer flattened into `UNKNOWN`, because the code is what a surface branches on
 * and the message is what the owner reads. A thrown error that carries no reason
 * is mapped: a database that cannot be reached is named as such — that is the
 * failure the owner can act on, and it names the variable — and anything else is
 * `UNKNOWN`, whose own sentence points at the server log, where the error (with
 * its stack in development) was already written. No branch invents a cause.
 */
export function reasonForJobFailure(error: unknown): Reason {
  const carried = parseReason((error as { reason?: unknown } | null | undefined)?.reason);
  if (carried) return carried;
  const message = error instanceof Error ? error.message : String(error ?? "");
  const detail = message ? redactString(message).slice(0, 300) : undefined;
  const databaseShaped =
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|P1001|P1002|P1017|SQLITE_|database server|Can't reach database/i.test(message);
  if (databaseShaped) {
    return reason("DATABASE_UNAVAILABLE", {
      variable: "DATABASE_URL",
      ...(detail ? { detail } : {}),
    });
  }
  return reason("UNKNOWN", detail ? { detail } : {});
}

function defaultOwner(): string {
  return `${hostname()}#${process.pid}-${randomUUID().slice(0, 8)}`;
}

/** The log route every runner line is attributed to. */
export const RUNNER_ROUTE = "/api/cron/[job]";

export async function runRunner(input: RunRunnerInput = {}): Promise<RunnerInvocationSummary> {
  const clock = input.now ? () => input.now!.getTime() : () => Date.now();
  const startedAt = clock();
  const store = input.store ?? runnerStore();
  const jobs = input.jobs ?? RUNNER_JOBS;
  const env = input.env ?? process.env;
  const selector = (input.selector ?? ALL_JOBS).trim() || ALL_JOBS;
  const selection = resolveJobSelection(selector, jobs);
  const owner = input.owner ?? defaultOwner();
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  const logger = loggerFor(RUNNER_ROUTE).configure("owner", owner);
  const heartbeats: RunnerHeartbeat[] = [];

  for (const job of selection.selected) {
    const intervalMinutes = job.intervalMinutes(env);
    const cadence = job.cadence(env);
    const state = await store.ensureJob({ jobId: job.id, intervalMinutes, now: startedAt });

    if (!isDue(state, startedAt)) {
      heartbeats.push(
        skippedHeartbeat({
          job,
          state,
          intervalMinutes,
          cadence,
          status: "not-due",
          summary: `Not due until ${new Date(state.nextDueAt).toISOString()}; the cadence is ${cadence}.`,
          reasonCode: "NOT_YET_DUE",
          reasonMessage: `This job ran or became due ${cadence} apart; the next due time is ${new Date(state.nextDueAt).toISOString()}.`,
        }),
      );
      logger.debug("runner job is not due", { jobId: job.id, nextDueAt: new Date(state.nextDueAt).toISOString() });
      continue;
    }

    const heldUntil = state.leaseExpiresAt;
    const hadLiveLease = leaseIsActive(state, startedAt);
    if (hadLiveLease) {
      heartbeats.push(leaseHeldHeartbeat({ job, state, intervalMinutes, cadence, heldUntil, owner: state.leaseOwner }));
      logger.debug("runner job is leased by another invocation", { jobId: job.id, leaseOwner: state.leaseOwner });
      continue;
    }

    const expiredLease = state.leaseOwner !== null && state.leaseExpiresAt !== null;
    // The claim re-checks due-ness against the row itself: the read above may be
    // older than another invocation's finished run, and this is the statement
    // that cannot be fooled by that.
    const claimed = await store.claimJob({
      jobId: job.id,
      owner,
      now: startedAt,
      leaseMs,
      dueBefore: startedAt + dueGraceMs(intervalMinutes),
    });
    if (!claimed) {
      // Losing the claim is not one thing, so it is not reported as one: re-read
      // the row and say which it is — a live lease, or a job that has since run.
      const [fresh] = await store.listJobs([job.id]);
      if (fresh && leaseIsActive(fresh, startedAt)) {
        heartbeats.push(
          leaseHeldHeartbeat({
            job,
            state: fresh,
            intervalMinutes,
            cadence,
            heldUntil: fresh.leaseExpiresAt,
            owner: fresh.leaseOwner,
          }),
        );
      } else {
        const current = fresh ?? state;
        heartbeats.push(
          skippedHeartbeat({
            job,
            state: current,
            intervalMinutes,
            cadence,
            status: "not-due",
            summary: `Not due until ${new Date(current.nextDueAt).toISOString()}; another invocation ran it for this ${cadence} interval.`,
            reasonCode: "NOT_YET_DUE",
            reasonMessage: `This job ran for the current ${cadence} interval, so this invocation left it alone. Next due ${new Date(current.nextDueAt).toISOString()}.`,
          }),
        );
      }
      logger.debug("runner job was claimed by another invocation first", { jobId: job.id });
      continue;
    }

    // The claim either follows a lease that was still held (impossible here) or
    // one that had lapsed: an invocation that died mid-job, which is exactly the
    // case the attempt count and this flag exist to make visible.
    const reclaimed = expiredLease || claimed.attempts > 1;
    try {
      const result = await job.run();
      const finishedAt = clock();
      const outcome: RunnerJobOutcome = result.worked ? "worked" : "idle";
      // A job that did no work must carry a reason. A job definition supplies its
      // own where it knows better (nothing to trim, nothing due); when it leaves
      // this empty the runner still refuses to record a silent idle, naming the
      // job and the sentence the job itself reported.
      const jobReason = result.worked
        ? null
        : result.reason ?? reason("NO_ENTRY_CONDITION", { message: `${job.label} did no work: ${result.summary}` });
      await store.finishJob({
        jobId: job.id,
        owner,
        now: finishedAt,
        outcome,
        reasonCode: jobReason?.code ?? null,
        reasonMessage: jobReason?.message ?? null,
        nextDueAt: nextDueFrom(finishedAt, intervalMinutes),
      });
      heartbeats.push({
        jobId: job.id,
        label: job.label,
        status: outcome,
        summary: result.summary,
        reason: heartbeatReason(jobReason),
        attempts: claimed.attempts,
        reclaimed,
        intervalMinutes,
        cadence,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        durationMs: Math.max(0, finishedAt - startedAt),
        nextDueAt: new Date(nextDueFrom(finishedAt, intervalMinutes)).toISOString(),
        detail: result.detail,
      });
      (outcome === "worked" ? logger.info : logger.debug)("runner job finished", {
        jobId: job.id,
        outcome,
        attempts: claimed.attempts,
        reclaimed,
        durationMs: finishedAt - startedAt,
        ...(jobReason ? { reason: serializeReason(jobReason) } : {}),
      });
    } catch (error) {
      const finishedAt = clock();
      const failure = reasonForJobFailure(error);
      await store.finishJob({
        jobId: job.id,
        owner,
        now: finishedAt,
        outcome: "failed",
        reasonCode: failure.code,
        reasonMessage: failure.message,
        nextDueAt: nextDueFrom(finishedAt, intervalMinutes),
      });
      heartbeats.push({
        jobId: job.id,
        label: job.label,
        status: "failed",
        summary: `${job.label} failed: ${failure.message}`,
        reason: heartbeatReason(failure),
        attempts: claimed.attempts,
        reclaimed,
        intervalMinutes,
        cadence,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        durationMs: Math.max(0, finishedAt - startedAt),
        nextDueAt: new Date(nextDueFrom(finishedAt, intervalMinutes)).toISOString(),
        detail: {},
      });
      logger.error("runner job failed", {
        jobId: job.id,
        attempts: claimed.attempts,
        reason: serializeReason(failure),
        error,
      });
    }
  }

  const finishedAt = clock();
  const summary = buildInvocationSummary({
    invocationId: input.invocationId ?? randomUUID(),
    owner,
    selector,
    startedAt,
    finishedAt,
    heartbeats,
  });

  await store.recordInvocation({
    invocationId: summary.invocationId,
    owner: summary.owner,
    selector: summary.selector,
    startedAt,
    finishedAt,
    durationMs: summary.durationMs,
    jobsDue: summary.jobsDue,
    jobsRan: summary.jobsRan,
    jobsSkipped: summary.jobsSkipped,
    jobsFailed: summary.jobsFailed,
    outcome: summary.outcome,
    reasonCode: (summary.reason?.code as ReasonCode | undefined) ?? null,
    reasonMessage: summary.reason?.message ?? null,
    heartbeats: summary.heartbeats,
  });

  logger.info("runner invocation finished", {
    invocationId: summary.invocationId,
    selector: summary.selector,
    outcome: summary.outcome,
    jobsDue: summary.jobsDue,
    jobsRan: summary.jobsRan,
    jobsSkipped: summary.jobsSkipped,
    jobsFailed: summary.jobsFailed,
    ...(summary.reason ? { reason: summary.reason } : {}),
  });

  return summary;
}

function skippedHeartbeat(input: {
  job: RunnerJobDefinition;
  state: RunnerJobState;
  intervalMinutes: number;
  cadence: string;
  status: "not-due";
  summary: string;
  reasonCode: ReasonCode;
  reasonMessage: string;
}): RunnerHeartbeat {
  return {
    jobId: input.job.id,
    label: input.job.label,
    status: input.status,
    summary: input.summary,
    reason: heartbeatReason(reason(input.reasonCode, { message: input.reasonMessage, retryable: true })),
    attempts: input.state.attempts,
    reclaimed: false,
    intervalMinutes: input.intervalMinutes,
    cadence: input.cadence,
    startedAt: null,
    finishedAt: input.state.lastFinishedAt === null ? null : new Date(input.state.lastFinishedAt).toISOString(),
    durationMs: null,
    nextDueAt: new Date(input.state.nextDueAt).toISOString(),
    detail: {},
  };
}

function leaseHeldHeartbeat(input: {
  job: RunnerJobDefinition;
  state: RunnerJobState;
  intervalMinutes: number;
  cadence: string;
  heldUntil: number | null;
  owner: string | null;
}): RunnerHeartbeat {
  const heldUntil = input.heldUntil === null ? "an unspecified time" : new Date(input.heldUntil).toISOString();
  return {
    jobId: input.job.id,
    label: input.job.label,
    status: "already-running",
    summary: `Another invocation holds this job's lease until ${heldUntil}.`,
    reason: heartbeatReason(
      reason("ALREADY_RUNNING", {
        message: `Another runner holds this job's lease until ${heldUntil}, so this invocation did not start it.`,
        detail: input.owner ? `Lease owner ${input.owner}.` : undefined,
      }),
    ),
    attempts: input.state.attempts,
    reclaimed: false,
    intervalMinutes: input.intervalMinutes,
    cadence: input.cadence,
    startedAt: input.state.lastStartedAt === null ? null : new Date(input.state.lastStartedAt).toISOString(),
    finishedAt: input.state.lastFinishedAt === null ? null : new Date(input.state.lastFinishedAt).toISOString(),
    durationMs: null,
    nextDueAt: new Date(input.state.nextDueAt).toISOString(),
    detail: {},
  };
}
