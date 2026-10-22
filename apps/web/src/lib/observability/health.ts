import { formatMarketAlertInterval, formatRunnerCadence } from "@/lib/alerts/scheduler-config";
import { isDevelopmentMode, type EnvironmentLike } from "@/lib/dev-mode/mode";
import {
  countProviderCallRecords,
  getProviderCallHealth,
  listRecentProviderFailures,
  PROVIDER_CALL_RETENTION,
  type ProviderCallHealth,
  type ProviderCallRecord,
} from "@/lib/observability/provider-call";
import { readLedgerHealth, type LedgerHealth } from "@/lib/ledger/invariants";
import { ledgerStore } from "@/lib/ledger/store";
import { readWithdrawalHealth, type WithdrawalHealth } from "@/lib/withdrawals/service";
import { isReasonCode, reason, serializeReason, type Reason, type SerializedReason } from "@/lib/observability/reason";
import {
  dueGraceMs,
  isDue,
  leaseIsActive,
  runnerStore,
  type RunnerInvocationRecord,
  type RunnerJobState,
} from "@/lib/runner/claim";
import { RUNNER_JOBS, type RunnerJobDefinition } from "@/lib/runner/registry";
import type { RunnerJobStatus } from "@/lib/runner/heartbeat";
import { listRpcNetworkSlugs } from "@/lib/rpc/networks";

/**
 * "Is it up right now, and if not, which one and why?"
 *
 * This is the read half of phase 04. It answers, in one shape the admin panel
 * and the health endpoint both render:
 *
 *  - the **database**, probed rather than assumed;
 *  - the **runner** (the scheduled alert evaluation), from what it last wrote;
 *  - the **ledger of record**, from its own invariants — because a ledger whose
 *    book does not add up is unhealthy in a way no provider status can express
 *    (phase 13);
 *  - **withdrawals**, from how many are stuck and whether the transfers are real —
 *    because a withdrawal that was refused by the network and one that was simulated
 *    both need to be visible, and neither shows up in a provider's call history (phase 14);
 *  - every **provider** this app talks to, from the records its calls left.
 *
 * Two rules keep it honest. A component is never called reachable without
 * evidence: an integration with no recorded call says "no call recorded yet",
 * which is a different sentence from "reachable" or "broken". And when the
 * database itself is unreachable, everything is reported as unknown *with a
 * reason naming DATABASE_URL* — never as an empty list that reads like health.
 */

export type HealthStatus = "reachable" | "degraded" | "unreachable" | "unconfigured" | "unknown";

export type Reachability = {
  id: string;
  label: string;
  status: HealthStatus;
  /** One sentence a non-engineer can act on. */
  detail: string;
  /** The exact variable to set, when configuration is the cause. */
  variable?: string;
};

export type ProviderHealth = Reachability & {
  providerId: string;
  lastCallAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failureCount: number;
  totalCount: number;
  lastStatusCode: number | null;
  lastSafeMessage: string | null;
};

/**
 * One scheduled job, as the owner sees it: last success, last failure, next due
 * and — when it did nothing — why.
 */
export type RunnerJobHealth = {
  jobId: string;
  label: string;
  description: string;
  status: HealthStatus;
  detail: string;
  variable?: string;
  /** The status of the most recent attempt: worked, idle or failed. Null before the first run. */
  lastStatus: RunnerJobStatus | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastRanAt: string | null;
  nextDueAt: string | null;
  /** Would the next invocation run this job? */
  dueNow: boolean;
  /** True while another invocation holds the job's lease. */
  runningNow: boolean;
  attempts: number;
  intervalMinutes: number;
  cadence: string;
  /** Why the last attempt did no work, or why it failed. */
  reason: SerializedReason | null;
};

export type RunnerInvocationHealth = {
  invocationId: string;
  owner: string;
  selector: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  jobsDue: number;
  jobsRan: number;
  jobsSkipped: number;
  jobsFailed: number;
  outcome: string;
  reason: SerializedReason | null;
};

export type RunnerHealth = Reachability & {
  configured: boolean;
  /** The cadence the host delivers, in words. */
  cadence: string;
  /** Every job the runner knows about, whether or not it has ever run. */
  jobs: RunnerJobHealth[];
  /** The newest invocation summary, as the heartbeat view reads it. */
  lastInvocation: RunnerInvocationHealth | null;
  activeAlerts: number;
  alertsWithEvaluationError: number;
  lastEvaluationAt: string | null;
};

export type FailureEntry = {
  providerId: string;
  route: string | null;
  requestId: string | null;
  code: string;
  outcome: string;
  statusCode: number | null;
  message: string;
  occurredAt: string;
};

export type ObservabilitySnapshot = {
  /**
   * The shared reason type, when this snapshot itself could not be completed.
   * Null when every component below was read.
   */
  reason: SerializedReason | null;
  database: Reachability;
  runner: RunnerHealth;
  /** The ledger of record: healthy means its invariants hold (phase 13). */
  ledger: LedgerHealth;
  /** Withdrawals: healthy means nothing is stuck, and it says whether they are real (phase 14). */
  withdrawals: WithdrawalHealth;
  providers: ProviderHealth[];
  recentFailures: FailureEntry[];
  retention: { limit: number; retained: number };
  readAt: string;
};

function hasValue(value: string | undefined): boolean {
  const normalized = value?.trim();
  return Boolean(normalized && !/^(?:replace|change.?me|example|your.?)/i.test(normalized));
}

/**
 * Every integration this app calls out to, and what would enable it.
 *
 * The ids match the `providerId` each client passes to `instrumentFetch`, which
 * is what lets a recorded call become a statement about its provider.
 */
type ProviderDefinition = {
  providerId: string;
  label: string;
  /** In an environment with no configuration at all, can this be called? */
  configured: (env: NodeJS.ProcessEnv) => boolean;
  /** Named when it is not configured. */
  variable?: string;
  unconfiguredDetail: string;
};

const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    providerId: "coinbase-exchange",
    label: "Coinbase Exchange (quotes, candles)",
    configured: () => true,
    unconfiguredDetail: "",
  },
  {
    providerId: "cointelegraph-rss",
    label: "Cointelegraph news feed",
    configured: () => true,
    unconfiguredDetail: "",
  },
  {
    providerId: "alchemy-rpc",
    label: "Alchemy multi-network RPC",
    configured: (env) => hasValue(env.ALCHEMY_API_KEY) || listRpcNetworkSlugs(env).length > 0,
    variable: "ALCHEMY_API_KEY",
    unconfiguredDetail: "No Alchemy endpoint is configured, so RPC and portfolio reads have nowhere to go.",
  },
  {
    providerId: "tavily",
    label: "Tavily Search and Extract",
    configured: () => true,
    unconfiguredDetail: "",
  },
  {
    providerId: "wundertrading",
    label: "WunderTrading venue API",
    // The venue needs a per-account API key, not a deployment variable: an
    // account with no connected credential is a state, not a missing setting.
    configured: () => true,
    unconfiguredDetail: "",
  },
  {
    providerId: "ai-gateway",
    label: "Assistant model gateway",
    configured: (env) => hasValue(env.AI_GATEWAY_API_KEY) && hasValue(env.AI_GATEWAY_MODEL),
    variable: "AI_GATEWAY_API_KEY",
    unconfiguredDetail: "The assistant has no model gateway key, so a message cannot be answered.",
  },
];

function providerStatus(
  definition: ProviderDefinition,
  env: NodeJS.ProcessEnv,
  health: ProviderCallHealth | undefined,
  evidenceUnavailable: boolean,
): ProviderHealth {
  const base = {
    id: definition.providerId,
    providerId: definition.providerId,
    label: definition.label,
    lastCallAt: health?.lastCallAt ?? null,
    lastSuccessAt: health?.lastSuccessAt ?? null,
    lastFailureAt: health?.lastFailureAt ?? null,
    failureCount: health?.failureCount ?? 0,
    totalCount: health?.totalCount ?? 0,
    lastStatusCode: health?.lastStatusCode ?? null,
    lastSafeMessage: health?.lastSafeMessage ?? null,
  };

  if (!definition.configured(env)) {
    return {
      ...base,
      status: "unconfigured",
      detail: definition.unconfiguredDetail,
      ...(definition.variable ? { variable: definition.variable } : {}),
    };
  }
  if (evidenceUnavailable) {
    return {
      ...base,
      status: "unknown",
      detail: "No call history could be read while the database was unavailable.",
    };
  }
  if (!health || health.lastCallAt === null) {
    return { ...base, status: "unknown", detail: "No call recorded yet; nothing has been asserted about reachability." };
  }
  if (health.lastOutcome === "ok") {
    return {
      ...base,
      status: "reachable",
      detail: `Last call answered ${health.lastStatusCode ?? 200} at ${health.lastCallAt}.`,
    };
  }
  if (health.lastStatusCode === null) {
    return {
      ...base,
      status: "unreachable",
      detail: `Last call did not connect at ${health.lastCallAt}. ${health.lastSafeMessage ?? ""}`.trim(),
    };
  }
  return {
    ...base,
    status: "degraded",
    detail: `Last call answered ${health.lastStatusCode} at ${health.lastCallAt}. ${health.lastSafeMessage ?? ""}`.trim(),
  };
}

/**
 * How much of a database failure a reader is told.
 *
 * The unreachable-database answer is rendered *before* authorization, because a
 * stopped database cannot authorize anybody, so the raw driver message (paths,
 * hosts, versions) is a development affordance only — the same rule the rest of
 * the app applies to error text. Production names the variable and stops there.
 */
export function describeDatabaseProbeFailure(message: string, environment: EnvironmentLike = process.env): string {
  if (!isDevelopmentMode(environment)) return "The database did not answer a probe query.";
  const detail = message.trim() ? message.trim().slice(0, 300) : "the probe failed without a message";
  return `The database did not answer a probe query: ${detail}`;
}

/**
 * Ask the database whether it is there, right now. Exported because the health
 * endpoint has to answer *before* it authorizes anyone: when the database is
 * down, sign-in cannot work either, and "401" would send the owner to a door
 * that cannot open.
 */
export async function probeDatabase(): Promise<{ reachable: boolean; detail: string; variable?: string }> {
  try {
    const { prisma } = await import("@/lib/db");
    await prisma.$queryRaw`SELECT 1`;
    return { reachable: true, detail: "The database answered a probe query." };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return {
      reachable: false,
      detail: describeDatabaseProbeFailure(message),
      variable: "DATABASE_URL",
    };
  }
}

function unreadableRunner(detail: string, variable?: string): RunnerHealth {
  return {
    id: "scheduled-runner",
    label: "Scheduled runner",
    status: variable ? "unconfigured" : "unknown",
    detail,
    ...(variable ? { variable } : {}),
    configured: false,
    cadence: formatRunnerCadence(),
    jobs: [],
    lastInvocation: null,
    activeAlerts: 0,
    alertsWithEvaluationError: 0,
    lastEvaluationAt: null,
  };
}

/**
 * One job's health, from its own stored row.
 *
 * The rules are the same ones the provider rows use: nothing is called healthy
 * without evidence. A job with no row has never run — that is "no evidence", not
 * "reachable" and not "broken" — and a job whose last run failed is degraded with
 * the reason that run recorded.
 */
export function describeRunnerJob(input: {
  definition: RunnerJobDefinition;
  state: RunnerJobState | undefined;
  env: NodeJS.ProcessEnv;
  now: number;
}): RunnerJobHealth {
  const { definition, state, env, now } = input;
  const intervalMinutes = state?.intervalMinutes ?? definition.intervalMinutes(env);
  const cadence = formatMarketAlertInterval(intervalMinutes);
  const base = {
    jobId: definition.id,
    label: definition.label,
    description: definition.description,
    intervalMinutes,
    cadence,
    attempts: state?.attempts ?? 0,
    lastStatus: state?.lastOutcome ?? null,
    lastSuccessAt: state?.lastSuccessAt ? new Date(state.lastSuccessAt).toISOString() : null,
    lastFailureAt: state?.lastFailureAt ? new Date(state.lastFailureAt).toISOString() : null,
    lastRanAt: state?.lastFinishedAt ? new Date(state.lastFinishedAt).toISOString() : null,
    nextDueAt: state ? new Date(state.nextDueAt).toISOString() : null,
    dueNow: state ? isDue(state, now) : true,
    runningNow: state ? leaseIsActive(state, now) : false,
    reason: null as SerializedReason | null,
  };

  if (!state) {
    return {
      ...base,
      status: "unknown",
      detail: "This job has never been invoked, so nothing has been asserted about it. The next call runs it.",
    };
  }

  if (state.lastOutcome === "failed") {
    const code = state.lastReasonCode && isReasonCode(state.lastReasonCode) ? state.lastReasonCode : "UNKNOWN";
    const failure = reason(code, {
      ...(state.lastReasonMessage ? { message: state.lastReasonMessage } : {}),
      // A stored reason that named a variable or a provider keeps naming it: the
      // owner needs the exact variable to set, not a paraphrase of it.
      ...(code === "DATABASE_UNAVAILABLE" ? { variable: "DATABASE_URL" } : {}),
    });
    return {
      ...base,
      status: "degraded",
      detail: `The last run failed at ${base.lastFailureAt}: ${failure.message}`,
      ...(failure.variable ? { variable: failure.variable } : {}),
      reason: serializeReason(failure),
    };
  }

  // A run older than twice the interval means the schedule stopped delivering,
  // which is a different fact from a job that failed and must say so.
  const newest = state.lastFinishedAt ?? state.lastStartedAt;
  const stale = newest !== null && now - newest > intervalMinutes * 60_000 * 2 + dueGraceMs(intervalMinutes);
  if (stale) {
    const stalled = reason("NOT_YET_DUE", {
      message: `The last run finished at ${new Date(newest as number).toISOString()}, more than twice the ${cadence} interval ago.`,
      detail: "The schedule may have stopped delivering invocations.",
    });
    return {
      ...base,
      status: "degraded",
      detail: `${stalled.message} ${stalled.detail}`,
      reason: serializeReason(stalled),
    };
  }

  const idleReason = state.lastReasonCode
    ? serializeReason(reason(state.lastReasonCode, { message: state.lastReasonMessage ?? "The last run recorded a reason." }))
    : null;
  const running = leaseIsActive(state, now);
  return {
    ...base,
    status: "reachable",
    detail: running
      ? `An invocation holds this job's lease until ${new Date(state.leaseExpiresAt as number).toISOString()}.`
      : `${state.lastOutcome ?? "ran"} at ${base.lastRanAt}; next due ${base.nextDueAt}.`,
    reason: idleReason,
  };
}

type RunnerStoreState = {
  jobs: RunnerJobState[];
  lastInvocation: RunnerInvocationRecord | null;
};

async function readRunnerStoreState(): Promise<RunnerStoreState> {
  const store = runnerStore();
  const [jobs, lastInvocation] = await Promise.all([
    store.listJobs(RUNNER_JOBS.map((job) => job.id)),
    store.latestInvocation(),
  ]);
  return { jobs, lastInvocation };
}

export async function getObservabilitySnapshot(env: NodeJS.ProcessEnv = process.env): Promise<ObservabilitySnapshot> {
  const readAt = new Date().toISOString();
  const probe = await probeDatabase();

  if (!probe.reachable) {
    const database: Reachability = {
      id: "database",
      label: "PostgreSQL database",
      status: "unreachable",
      detail: probe.detail,
      ...(probe.variable ? { variable: probe.variable } : {}),
    };
    return {
      reason: serializeReason(
        reason("DATABASE_UNAVAILABLE", { variable: probe.variable, detail: "The health view could not read the database." }),
      ),
      database,
      runner: unreadableRunner(
        "The runner's heartbeat lives in the database, which could not be read, so no job can be reported on.",
      ),
      ledger: {
        id: "ledger",
        label: "Ledger of record",
        status: "unknown",
        detail: "The ledger's invariants cannot be checked while the database is unavailable, so nothing is asserted about the book.",
        counts: { accounts: 0, transactions: 0, entries: 0 },
        totals: [],
        violations: [],
        checks: [],
        checkedAt: null,
        reason: null,
      },
      withdrawals: {
        id: "withdrawals",
        label: "Withdrawals",
        status: "unknown",
        detail: "The withdrawal rows cannot be read while the database is unavailable, so nothing is asserted about them.",
        broadcastMode: "onchain",
        counts: {},
        reason: null,
      },
      providers: PROVIDER_DEFINITIONS.map((definition) =>
        providerStatus(definition, env, undefined, true),
      ),
      recentFailures: [],
      retention: { limit: PROVIDER_CALL_RETENTION, retained: 0 },
      readAt,
    };
  }

  const database: Reachability = { id: "database", label: "PostgreSQL database", status: "reachable", detail: probe.detail };

  const [callHealth, recentFailures, retained, alertState, runnerState, ledger, withdrawals] = await Promise.all([
    getProviderCallHealth(),
    listRecentProviderFailures(10),
    countProviderCallRecords(),
    readRunnerState(),
    readRunnerStoreState(),
    // The ledger check reads the book rather than sampling it, so it reports how
    // much it looked at along with its verdict.
    readLedgerHealth(ledgerStore),
    // Counted in the database, so this answer stays cheap on a table with history in it.
    readWithdrawalHealth({ env }),
  ]);

  const healthByProvider = new Map(callHealth.map((row) => [row.providerId, row]));
  const providers = PROVIDER_DEFINITIONS.map((definition) =>
    providerStatus(definition, env, healthByProvider.get(definition.providerId), false),
  );
  // Nothing recorded is ever hidden: an integration that is not in the list
  // above (a news feed, a provider added later) still gets a row from its own
  // calls, labelled by the id it recorded them under.
  const declared = new Set(PROVIDER_DEFINITIONS.map((definition) => definition.providerId));
  for (const row of callHealth) {
    if (declared.has(row.providerId)) continue;
    providers.push(
      providerStatus(
        { providerId: row.providerId, label: row.providerId, configured: () => true, unconfiguredDetail: "" },
        env,
        row,
        false,
      ),
    );
  }
  providers.sort((left, right) => left.providerId.localeCompare(right.providerId));

  const cronConfigured = hasValue(env.CRON_SECRET);
  const lastEvaluationAt = alertState.lastEvaluationAt;
  const nowMs = Date.now();
  const stateByJob = new Map(runnerState.jobs.map((state) => [state.jobId, state]));

  // Every declared job gets a row, whether or not it has ever run: a job that has
  // never been invoked is "no evidence", and a job that is missing from this list
  // would read as a job that does not exist.
  const jobs = RUNNER_JOBS.map((definition) =>
    describeRunnerJob({ definition, state: stateByJob.get(definition.id), env, now: nowMs }),
  );
  const lastInvocation: RunnerInvocationHealth | null = runnerState.lastInvocation
    ? {
        invocationId: runnerState.lastInvocation.invocationId,
        owner: runnerState.lastInvocation.owner,
        selector: runnerState.lastInvocation.selector,
        startedAt: new Date(runnerState.lastInvocation.startedAt).toISOString(),
        finishedAt: new Date(runnerState.lastInvocation.finishedAt).toISOString(),
        durationMs: runnerState.lastInvocation.durationMs,
        jobsDue: runnerState.lastInvocation.jobsDue,
        jobsRan: runnerState.lastInvocation.jobsRan,
        jobsSkipped: runnerState.lastInvocation.jobsSkipped,
        jobsFailed: runnerState.lastInvocation.jobsFailed,
        outcome: runnerState.lastInvocation.outcome,
        reason:
          runnerState.lastInvocation.reasonCode && isReasonCode(runnerState.lastInvocation.reasonCode)
            ? serializeReason(
                reason(runnerState.lastInvocation.reasonCode, {
                  ...(runnerState.lastInvocation.reasonMessage ? { message: runnerState.lastInvocation.reasonMessage } : {}),
                }),
              )
            : null,
      }
    : null;

  let runner: RunnerHealth;
  if (!cronConfigured) {
    runner = {
      ...unreadableRunner(
        "CRON_SECRET is not configured, so the runner cannot be called and no scheduled job runs.",
        "CRON_SECRET",
      ),
      jobs,
      lastInvocation,
      lastEvaluationAt,
      activeAlerts: alertState.activeAlerts,
      alertsWithEvaluationError: alertState.alertsWithEvaluationError,
    };
  } else {
    // The row for a job has two sources of truth and both matter: the job's own
    // last outcome, and whether the schedule is still delivering at all.
    const failing = jobs.find((job) => job.lastStatus === "failed");
    const stalled = jobs.find((job) => job.status === "degraded" && job.lastStatus !== "failed");
    const neverRun = jobs.filter((job) => job.lastStatus === null).length;
    const newestRun =
      jobs
        .map((job) => job.lastRanAt)
        .filter((value): value is string => value !== null)
        .sort()
        .at(-1) ?? null;
    const status: HealthStatus = failing || stalled ? "degraded" : neverRun === jobs.length ? "unknown" : "reachable";
    const detail = failing
      ? `${failing.label} last failed at ${failing.lastFailureAt}: ${failing.reason?.message ?? "no reason was recorded"}.`
      : stalled
        ? `${stalled.label} has not finished since ${stalled.lastRanAt}, which is longer than twice its ${stalled.cadence} interval; the schedule may have stopped.`
        : neverRun === jobs.length
          ? `The runner is configured on a ${formatRunnerCadence()} schedule and has never been invoked, so nothing has been asserted about its jobs yet.`
          : `${jobs.length} scheduled job(s) tracked on a ${formatRunnerCadence()} schedule; the newest run finished at ${newestRun ?? "never"}.`;
    runner = {
      id: "scheduled-runner",
      label: "Scheduled runner",
      status,
      detail,
      configured: true,
      cadence: formatRunnerCadence(),
      jobs,
      lastInvocation,
      activeAlerts: alertState.activeAlerts,
      alertsWithEvaluationError: alertState.alertsWithEvaluationError,
      lastEvaluationAt,
    };
  }

  // A provider that has never been called is not a failure; a provider whose
  // last call did not connect is, and it is the reason this snapshot exists.
  const reasonForSnapshot: Reason | null = providers.some((provider) => provider.status === "unreachable")
    ? reason("VENUE_UNAVAILABLE", {
        detail: `${providers.filter((provider) => provider.status === "unreachable").map((provider) => provider.providerId).join(", ")} did not answer the most recent call.`,
      })
    : null;

  return {
    reason: reasonForSnapshot ? serializeReason(reasonForSnapshot) : null,
    database,
    runner,
    ledger,
    withdrawals,
    providers,
    recentFailures: recentFailures.map(toFailureEntry),
    retention: { limit: PROVIDER_CALL_RETENTION, retained },
    readAt,
  };
}

function toFailureEntry(record: ProviderCallRecord): FailureEntry {
  return {
    providerId: record.providerId,
    route: record.route,
    requestId: record.requestId,
    code: record.reasonCode ?? record.outcome.toUpperCase().replaceAll("-", "_"),
    outcome: record.outcome,
    statusCode: record.statusCode,
    message: record.safeMessage ?? "The provider call failed without a recorded message.",
    occurredAt: record.occurredAt,
  };
}

type RunnerState = {
  activeAlerts: number;
  alertsWithEvaluationError: number;
  lastEvaluationAt: string | null;
};

async function readRunnerState(): Promise<RunnerState> {
  const { prisma } = await import("@/lib/db");
  const [activeAlerts, alertsWithEvaluationError, newest] = await Promise.all([
    prisma.marketAlert.count({ where: { status: "ACTIVE" } }),
    prisma.marketAlert.count({ where: { status: "ACTIVE", lastEvaluationError: { not: null } } }),
    prisma.marketAlert.findFirst({
      where: { lastEvaluatedAt: { not: null } },
      orderBy: { lastEvaluatedAt: "desc" },
      select: { lastEvaluatedAt: true },
    }),
  ]);
  return {
    activeAlerts,
    alertsWithEvaluationError,
    lastEvaluationAt: newest?.lastEvaluatedAt?.toISOString() ?? null,
  };
}
