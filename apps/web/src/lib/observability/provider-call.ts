import { createLogger, redactUrl, serializeError, type Logger } from "@/lib/observability/logger";
import { reason, serializeReason, type Reason, type ReasonCode } from "@/lib/observability/reason";
import { resolveRequestContext } from "@/lib/observability/request-context";

/**
 * One record per outbound provider call.
 *
 * Every integration in this app talks to somebody else's server, and until now
 * the only evidence of a failed call was whatever reached the browser. This
 * module wraps the `fetch` each client uses, so a call is recorded where it
 * happens: which provider, which method, which (redacted) URL, what status, how
 * long it took, how many attempts, which request it belonged to, and — for a
 * failure — a reason code and a safe sentence.
 *
 * Two details are load-bearing:
 *
 *  - **The URL is stored redacted.** An Alchemy endpoint carries its key in the
 *    path, so the raw URL is never written anywhere. See `redactUrl`.
 *  - **A record never fails the request it describes.** Observability that can
 *    break the thing it observes is worse than none: the write is
 *    fire-and-forget, its failure is logged at debug, and a request that has no
 *    context records `null` rather than inventing an id.
 *
 * The table is bounded. Retention keeps the newest {@link PROVIDER_CALL_RETENTION}
 * rows and trims the rest on a sampled fraction of writes, so a busy afternoon
 * cannot turn one row per call into an unbounded table.
 */

export const PROVIDER_CALL_RETENTION = 1_000;

/**
 * Every integration this app calls out to, named once. A provider id is the
 * key that turns a recorded call into a statement about its provider, so it
 * lives where the recording happens rather than beside each client.
 */
export const PROVIDER_IDS = {
  coinbase: "coinbase-exchange",
  cointelegraph: "cointelegraph-rss",
  alternativeMe: "alternative-me",
  alchemyRpc: "alchemy-rpc",
  tavily: "tavily",
  sandbase: "sandbase",
  wundertrading: "wundertrading",
  aiGateway: "ai-gateway",
  chaingpt: "chaingpt",
} as const;

/** How often a write also trims the table: 1 in 32. */
const PRUNE_ONE_IN = 32;

export type ProviderOutcome = "ok" | "rate-limited" | "provider-error" | "network-error" | "invalid-response";

export type ProviderCallInput = {
  providerId: string;
  method: string;
  /** The URL as requested; it is redacted before it is stored or logged. */
  url: string;
  statusCode?: number | null;
  outcome: ProviderOutcome;
  durationMs: number;
  /**
   * What the call cost in attempts. There is no retry policy yet, so this is 1
   * per instrumented call; the field exists because "how many attempts" is part
   * of what a provider call has to be able to answer.
   */
  attempts: number;
  error?: unknown;
  reasonCode?: ReasonCode;
};

export type ProviderCallRecord = {
  providerId: string;
  method: string;
  url: string;
  statusCode: number | null;
  outcome: ProviderOutcome;
  reasonCode: ReasonCode | null;
  durationMs: number;
  attempts: number;
  requestId: string | null;
  route: string | null;
  safeMessage: string | null;
  occurredAt: string;
};

export type ProviderCallSink = (record: ProviderCallRecord) => void | Promise<void>;

/**
 * The sink lives on `globalThis`, not in a module variable, and that is
 * deliberate: Next compiles `src/instrumentation.ts` and each route into
 * separate module graphs, so the sink registered at boot would be set in one
 * copy of this module and read from another as null — records would be built,
 * logged and silently dropped. The process is the shared thing, so the process
 * holds the sink. `src/lib/db.ts` caches its Prisma client the same way, for the
 * same reason.
 */
type SinkGlobal = typeof globalThis & { __veyloraProviderCallSink?: ProviderCallSink | null };

/**
 * Install the persistence sink. Called once per server process from
 * `src/instrumentation.ts`, and by a test that wants to see records.
 *
 * A process with no sink still builds and logs records; it simply keeps no
 * history, which is the honest state for a script or a unit test that never
 * claimed to have a database.
 */
export function setProviderCallSink(next: ProviderCallSink | null): void {
  (globalThis as SinkGlobal).__veyloraProviderCallSink = next;
}

/** The installed sink, or null when this process keeps no history. */
export function getProviderCallSink(): ProviderCallSink | null {
  return (globalThis as SinkGlobal).__veyloraProviderCallSink ?? null;
}

/** The reason for a provider's HTTP answer. */
export function reasonForProviderResponse(providerId: string, statusCode: number): Reason {
  if (statusCode === 429) return reason("PROVIDER_RATE_LIMITED", { providerId });
  if (statusCode === 401 || statusCode === 403) {
    return reason("INVALID_CREDENTIAL", {
      providerId,
      detail: `The provider answered ${statusCode}.`,
    });
  }
  if (statusCode >= 500) {
    return reason("PROVIDER_ERROR", { providerId, retryable: true, detail: `The provider answered ${statusCode}.` });
  }
  return reason("PROVIDER_ERROR", {
    providerId,
    retryable: false,
    detail: `The provider answered ${statusCode}.`,
  });
}

/** The reason for a call that never produced a response. */
export function reasonForThrownCall(providerId: string, error: unknown): Reason {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out/i.test(message)) {
    return reason("VENUE_UNAVAILABLE", { providerId, detail: "The call timed out." });
  }
  return reason("VENUE_UNAVAILABLE", { providerId });
}

/** The outcome a status code means, for a call that got an answer. */
export function outcomeForStatus(statusCode: number): ProviderOutcome {
  if (statusCode === 429) return "rate-limited";
  return statusCode >= 200 && statusCode < 300 ? "ok" : "provider-error";
}

function safeMessageFor(input: ProviderCallInput): string | null {
  if (input.error !== undefined) {
    const serialized = serializeError(input.error);
    return `${serialized.name}: ${serialized.message}`.slice(0, 500);
  }
  if (input.statusCode !== null && input.statusCode !== undefined && input.outcome !== "ok") {
    return `The provider answered ${input.statusCode}.`;
  }
  return null;
}

/**
 * Turn a measured call into the record that is logged and stored. The raw URL
 * is redacted here, so no caller can accidentally store one with a key in it.
 */
export function buildProviderCallRecord(
  input: ProviderCallInput,
  context: { requestId: string | null; route: string | null } | null = null,
): ProviderCallRecord {
  return {
    providerId: input.providerId,
    method: input.method.toUpperCase(),
    url: redactUrl(input.url),
    statusCode: input.statusCode ?? null,
    outcome: input.outcome,
    reasonCode: input.reasonCode ?? null,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    attempts: Math.max(1, Math.trunc(input.attempts)),
    requestId: context?.requestId ?? null,
    route: context?.route ?? null,
    safeMessage: safeMessageFor(input),
    occurredAt: new Date().toISOString(),
  };
}

/** Log a built record and hand it to the sink. Awaitable, and never throwing. */
export async function persistProviderCallRecord(record: ProviderCallRecord, logger?: Logger): Promise<void> {
  (logger ?? createLogger()).debug("provider call", { ...record });
  const sink = getProviderCallSink();
  if (!sink) return;
  try {
    await sink(record);
  } catch (error) {
    // Losing a record must never be visible to the caller. Debug, not warn: in
    // production this would otherwise be one line per call while the database
    // is down, and the request itself already reported the failure.
    (logger ?? createLogger()).debug("provider call record was not stored", { providerId: record.providerId, error });
  }
}

/**
 * Record a call: resolve this request's context, build the record, then log and
 * store it. This is the entry point for code that is not wrapping a `fetch`.
 */
export async function recordProviderCall(input: ProviderCallInput, logger?: Logger): Promise<ProviderCallRecord> {
  const context = await resolveRequestContext();
  const record = buildProviderCallRecord(input, context);
  await persistProviderCallRecord(record, logger ?? context?.logger);
  return record;
}

export type InstrumentFetchOptions = {
  providerId: string;
  /** The fetch to wrap. Defaults to the global one. */
  fetcher?: typeof fetch;
  /** Overrides the sink for this wrapper. Used by tests. */
  record?: (record: ProviderCallRecord) => void | Promise<void>;
  now?: () => number;
  logger?: Logger;
};

export type ProviderFetch = typeof fetch;

/**
 * Wrap a provider's `fetch` so every call it makes is recorded.
 *
 * The returned function has the same signature as `fetch`, so a client only has
 * to swap the function it was given. A response is returned unchanged; nothing
 * about the call's behaviour depends on the recorder.
 */
export function instrumentFetch(options: InstrumentFetchOptions): typeof fetch {
  const inner = options.fetcher ?? fetch;
  const clock = options.now ?? (() => Date.now());

  return async function instrumentedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const startedAt = clock();
    const providerId = options.providerId;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const url = input instanceof Request ? input.url : String(input);
    const context = await resolveRequestContext();
    const logger = options.logger ?? context?.logger ?? createLogger();

    /**
     * Build this call's record and hand it on.
     *
     * With no `record` callback the write is fire-and-forget, so observing a
     * call never slows the call down. With one (a test) it is awaited before the
     * response is returned, so the assertion cannot race the recorder.
     */
    async function finish(
      partial: Omit<ProviderCallInput, "providerId" | "method" | "url" | "durationMs" | "attempts">,
    ): Promise<ProviderCallRecord> {
      const record = buildProviderCallRecord(
        { providerId, method, url, durationMs: clock() - startedAt, attempts: 1, ...partial },
        context,
      );
      if (options.record) {
        try {
          await options.record(record);
        } catch {
          // A record callback is a listener, not a participant in the request.
        }
        return record;
      }
      await persistProviderCallRecord(record, logger);
      return record;
    }

    let response: Response;
    try {
      response = await inner(input, init);
    } catch (error) {
      const failure = reasonForThrownCall(providerId, error);
      logger.warn("provider call failed", {
        providerId,
        method,
        url: redactUrl(url),
        outcome: "network-error",
        reason: serializeReason(failure),
        error,
      });
      await finish({ statusCode: null, outcome: "network-error", reasonCode: failure.code, error });
      throw error;
    }

    const outcome = outcomeForStatus(response.status);
    const failure = outcome === "ok" ? null : reasonForProviderResponse(providerId, response.status);
    await finish({
      statusCode: response.status,
      outcome,
      ...(failure ? { reasonCode: failure.code } : {}),
    });

    if (failure) {
      logger.warn("provider call answered with an error", {
        providerId,
        method,
        url: redactUrl(url),
        statusCode: response.status,
        outcome,
        reason: serializeReason(failure),
      });
    }
    return response;
  };
}

/**
 * Register the Prisma sink. Called from `src/instrumentation.ts` for every Node
 * server process, so records are kept wherever the app is actually serving, and
 * never from a code path that only imports a provider client.
 */
export function registerPrismaProviderCallSink(): void {
  setProviderCallSink(async (record) => {
    const { prisma } = await import("@/lib/db");
    await prisma.providerCallRecord.create({
      data: {
        providerId: record.providerId,
        method: record.method,
        url: record.url,
        statusCode: record.statusCode,
        outcome: record.outcome,
        reasonCode: record.reasonCode,
        durationMs: record.durationMs,
        attempts: record.attempts,
        requestId: record.requestId,
        route: record.route,
        safeMessage: record.safeMessage,
        occurredAt: new Date(record.occurredAt),
      },
    });
    if (Math.random() < 1 / PRUNE_ONE_IN) await pruneProviderCallRecords();
  });
}

/** Trim the table to the newest `retain` rows. Returns how many were dropped. */
export async function pruneProviderCallRecords(retain = PROVIDER_CALL_RETENTION): Promise<number> {
  const { prisma } = await import("@/lib/db");
  const boundary = await prisma.providerCallRecord.findMany({
    orderBy: { occurredAt: "desc" },
    skip: Math.max(0, retain - 1),
    take: 1,
    select: { occurredAt: true },
  });
  const oldestKept = boundary[0]?.occurredAt;
  if (!oldestKept) return 0;
  const { count } = await prisma.providerCallRecord.deleteMany({ where: { occurredAt: { lt: oldestKept } } });
  return count;
}

// ── Reads, for the admin surface ──────────────────────────────────────────────

type StoredProviderCall = Awaited<ReturnType<typeof prismaFindRows>>[number];

async function prismaFindRows(args: { where?: { outcome: { not: string } }; limit: number }) {
  const { prisma } = await import("@/lib/db");
  return prisma.providerCallRecord.findMany({
    ...(args.where ? { where: args.where } : {}),
    orderBy: { occurredAt: "desc" },
    take: args.limit,
  });
}

function toProviderCallRecord(row: StoredProviderCall): ProviderCallRecord {
  return {
    providerId: row.providerId,
    method: row.method,
    url: row.url,
    statusCode: row.statusCode,
    outcome: row.outcome as ProviderOutcome,
    reasonCode: (row.reasonCode as ReasonCode | null) ?? null,
    durationMs: row.durationMs,
    attempts: row.attempts,
    requestId: row.requestId,
    route: row.route,
    safeMessage: row.safeMessage,
    occurredAt: row.occurredAt.toISOString(),
  };
}

/** The most recent calls, newest first. */
export async function listProviderCalls(limit = 50): Promise<ProviderCallRecord[]> {
  const rows = await prismaFindRows({ limit: Math.min(Math.max(1, limit), 500) });
  return rows.map(toProviderCallRecord);
}

export type ProviderCallHealth = {
  providerId: string;
  totalCount: number;
  failureCount: number;
  lastCallAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastOutcome: ProviderOutcome | null;
  lastStatusCode: number | null;
  lastReasonCode: ReasonCode | null;
  lastSafeMessage: string | null;
  lastRequestId: string | null;
  lastRoute: string | null;
  /**
   * The four numbers a health table needs (phase 19): how slow this source has
   * been, and how often it has failed, over the records still retained. They are
   * computed from the same rows as everything above, so they cannot disagree
   * with the last-outcome fields.
   */
  averageDurationMs: number | null;
  maxDurationMs: number | null;
  /** Failures divided by calls, 0..1. Zero when no call is retained. */
  errorRate: number;
};

/**
 * Per-provider health, aggregated from the retained records (newest first).
 *
 * Pure, and exported, so the table a screen renders and the test that asserts
 * latency and error rate are reading the same arithmetic rather than two
 * approximations of it. Aggregating in the process rather than in raw SQL keeps
 * this correct on both databases the app runs against, over a table that is
 * bounded by design.
 */
export function summarizeProviderCalls(calls: readonly ProviderCallRecord[]): ProviderCallHealth[] {
  const byProvider = new Map<string, ProviderCallHealth>();
  const durations = new Map<string, number>();

  for (const call of calls) {
    const existing = byProvider.get(call.providerId) ?? {
      providerId: call.providerId,
      totalCount: 0,
      failureCount: 0,
      lastCallAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastOutcome: null,
      lastStatusCode: null,
      lastReasonCode: null,
      lastSafeMessage: null,
      lastRequestId: null,
      lastRoute: null,
      averageDurationMs: null,
      maxDurationMs: null,
      errorRate: 0,
    };
    existing.totalCount += 1;
    // The list is newest first, so the first row of a provider is its latest.
    if (existing.lastCallAt === null) {
      existing.lastCallAt = call.occurredAt;
      existing.lastOutcome = call.outcome;
      existing.lastStatusCode = call.statusCode;
      existing.lastReasonCode = call.reasonCode;
      existing.lastSafeMessage = call.safeMessage;
      existing.lastRequestId = call.requestId;
      existing.lastRoute = call.route;
    }
    if (call.outcome === "ok") {
      existing.lastSuccessAt ??= call.occurredAt;
    } else {
      existing.failureCount += 1;
      existing.lastFailureAt ??= call.occurredAt;
    }
    durations.set(call.providerId, (durations.get(call.providerId) ?? 0) + call.durationMs);
    byProvider.set(call.providerId, existing);
  }

  for (const [providerId, total] of durations) {
    const health = byProvider.get(providerId);
    if (!health || health.totalCount === 0) continue;
    health.averageDurationMs = Math.round(total / health.totalCount);
    health.maxDurationMs = calls
      .filter((call) => call.providerId === providerId)
      .reduce((maximum, call) => Math.max(maximum, call.durationMs), 0);
    health.errorRate = Number((health.failureCount / health.totalCount).toFixed(4));
  }

  return [...byProvider.values()].sort((left, right) => left.providerId.localeCompare(right.providerId));
}

export async function getProviderCallHealth(windowSize = PROVIDER_CALL_RETENTION): Promise<ProviderCallHealth[]> {
  return summarizeProviderCalls(await listProviderCalls(Math.min(windowSize, 500)));
}

/** The failures worth showing the owner, newest first. */
export async function listRecentProviderFailures(limit = 10): Promise<ProviderCallRecord[]> {
  const rows = await prismaFindRows({ where: { outcome: { not: "ok" } }, limit: Math.min(Math.max(1, limit), 100) });
  return rows.map(toProviderCallRecord);
}

/** How many records are being kept. */
export async function countProviderCallRecords(): Promise<number> {
  const { prisma } = await import("@/lib/db");
  return prisma.providerCallRecord.count();
}
