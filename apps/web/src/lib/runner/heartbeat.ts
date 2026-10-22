import { serializeReason, type Reason, type SerializedReason } from "@/lib/observability/reason";

/**
 * The heartbeat: what every runner invocation leaves behind.
 *
 * One invocation writes one summary record and one heartbeat per job it looked
 * at. That is the whole point of this module — after the fact, "did anything
 * run, and if not, why not?" is answered from stored state rather than from a
 * console nobody kept.
 *
 * The status values are deliberately narrow. `not-due` and `already-running` are
 * *not* idle jobs: they are jobs the runner declined to start, and each carries
 * the shared reason that says which. A run that found nothing to do is `idle`
 * and carries a working-specific reason (no entry condition, nothing to trim).
 * Only a thrown job is `failed`.
 */

export type RunnerJobStatus = "worked" | "idle" | "failed" | "not-due" | "already-running";

export type RunnerHeartbeat = {
  jobId: string;
  label: string;
  status: RunnerJobStatus;
  /** One sentence: what happened. Never a bare "ok". */
  summary: string;
  /** Why this job did no work, when it did none. */
  reason: SerializedReason | null;
  /** Attempts recorded for this job, including this one. */
  attempts: number;
  /** True when the claim that produced this heartbeat followed an expired lease. */
  reclaimed: boolean;
  intervalMinutes: number;
  cadence: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  nextDueAt: string;
  /** Counts the job reported, redacted like everything else on the record. */
  detail: Record<string, number | string | boolean | null>;
};

export type RunnerInvocationOutcome = "worked" | "idle" | "failed" | "mixed";

export type RunnerInvocationSummary = {
  invocationId: string;
  /** Which process ran this, so two deployments can be told apart in the record. */
  owner: string;
  /** The selector that was asked for: `all`, a job id, or a list of ids. */
  selector: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  jobsDue: number;
  jobsRan: number;
  jobsSkipped: number;
  jobsFailed: number;
  outcome: RunnerInvocationOutcome;
  /** Why this invocation produced no work, or null when something ran. */
  reason: SerializedReason | null;
  heartbeats: RunnerHeartbeat[];
};

/** A reason, or null: the shape every heartbeat field uses. */
export function heartbeatReason(value: Reason | null | undefined): SerializedReason | null {
  return value ? serializeReason(value) : null;
}

/**
 * The outcome of one invocation.
 *
 * `mixed` exists because the honest answer is often partial: one job triggered an
 * alert while another was not due. Collapsing that into "worked" would hide the
 * idle job, and collapsing it into "idle" would hide the work.
 */
export function invocationOutcome(input: {
  jobsRan: number;
  jobsFailed: number;
  jobsSkipped: number;
  heartbeats: readonly Pick<RunnerHeartbeat, "status">[];
}): RunnerInvocationOutcome {
  if (input.jobsFailed > 0) return input.jobsRan > 0 ? "mixed" : "failed";
  if (input.jobsRan > 0) return input.jobsSkipped > 0 ? "mixed" : "worked";
  return "idle";
}

/**
 * Why the invocation as a whole produced nothing, taken from the jobs that
 * declined. The first heartbeat reason is the answer: when several jobs are idle
 * for different reasons, the summary names one and the per-job heartbeats carry
 * the rest, rather than a sentence that tries to average them.
 */
export function invocationReason(heartbeats: readonly RunnerHeartbeat[]): SerializedReason | null {
  const declined = heartbeats.find((heartbeat) => heartbeat.reason !== null);
  return declined?.reason ?? null;
}

export function buildInvocationSummary(input: {
  invocationId: string;
  owner: string;
  selector: string;
  startedAt: number;
  finishedAt: number;
  heartbeats: RunnerHeartbeat[];
}): RunnerInvocationSummary {
  const heartbeats = [...input.heartbeats];
  const jobsRan = heartbeats.filter((heartbeat) => heartbeat.status === "worked").length;
  const jobsFailed = heartbeats.filter((heartbeat) => heartbeat.status === "failed").length;
  const jobsSkipped = heartbeats.filter(
    (heartbeat) => heartbeat.status === "idle" || heartbeat.status === "not-due" || heartbeat.status === "already-running",
  ).length;
  return {
    invocationId: input.invocationId,
    owner: input.owner,
    selector: input.selector,
    startedAt: new Date(input.startedAt).toISOString(),
    finishedAt: new Date(input.finishedAt).toISOString(),
    durationMs: Math.max(0, input.finishedAt - input.startedAt),
    jobsDue: heartbeats.filter((heartbeat) => heartbeat.status !== "not-due").length,
    jobsRan,
    jobsSkipped,
    jobsFailed,
    outcome: invocationOutcome({ jobsRan, jobsFailed, jobsSkipped, heartbeats }),
    reason: invocationReason(heartbeats),
    heartbeats,
  };
}
