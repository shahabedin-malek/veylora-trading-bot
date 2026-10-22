/**
 * In-process health for the market-data sources, and the cooldown that makes a
 * failing source skip rather than block a run (phase 19).
 *
 * There are two records of a provider's health, and they answer different
 * questions. `ProviderCallRecord` is the durable one: every outbound call is
 * written down, so a restart does not forget the last success or failure, and
 * `getProviderCallHealth` turns those rows into the table the owner reads. This
 * registry is the run-local one: it sees the *result* of an ingest operation —
 * including a provider that answered 200 with an unreadable body, which is a
 * failure the HTTP record cannot see — and it can refuse to keep calling a
 * source that has failed three times in a row.
 *
 * Keeping the two apart is deliberate. The registry is allowed to be lost on
 * restart (its cooldown is an optimization, not a fact), while the durable rows
 * are what a later page reads; neither is allowed to invent the other's answer.
 */

export const MARKET_DATA_FAILURE_THRESHOLD = 3;
export const MARKET_DATA_COOLDOWN_MS = 60_000;
/** How many recent operation durations a source keeps for its average. */
const MAX_LATENCY_SAMPLES = 50;

export type MarketDataSourceHealth = {
  sourceId: string;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  lastOutcome: "ok" | "failed" | null;
  lastReason: string | null;
  lastDurationMs: number | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  averageDurationMs: number | null;
  /** Failures divided by operations, 0..1. Zero when nothing has run. */
  errorRate: number;
  cooldownUntil: string | null;
};

type HealthRecord = {
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  lastOutcome: "ok" | "failed" | null;
  lastReason: string | null;
  lastDurationMs: number | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  latencies: number[];
  cooldownUntil: Date | null;
};

function emptyRecord(): HealthRecord {
  return {
    successCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
    lastOutcome: null,
    lastReason: null,
    lastDurationMs: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    latencies: [],
    cooldownUntil: null,
  };
}

function validDuration(durationMs: number): number {
  return Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : 0;
}

export class MarketDataHealthRegistry {
  private readonly records = new Map<string, HealthRecord>();

  recordSuccess(sourceId: string, durationMs: number, at: Date = new Date()): void {
    const record = this.records.get(sourceId) ?? emptyRecord();
    const duration = validDuration(durationMs);
    record.successCount += 1;
    record.consecutiveFailures = 0;
    record.lastOutcome = "ok";
    record.lastReason = null;
    record.lastDurationMs = duration;
    record.lastSuccessAt = at;
    record.cooldownUntil = null;
    record.latencies.push(duration);
    if (record.latencies.length > MAX_LATENCY_SAMPLES) record.latencies.shift();
    this.records.set(sourceId, record);
  }

  recordFailure(sourceId: string, reason: string, durationMs: number, at: Date = new Date()): void {
    const record = this.records.get(sourceId) ?? emptyRecord();
    const duration = validDuration(durationMs);
    record.failureCount += 1;
    record.consecutiveFailures += 1;
    record.lastOutcome = "failed";
    record.lastReason = reason;
    record.lastDurationMs = duration;
    record.lastFailureAt = at;
    record.latencies.push(duration);
    if (record.latencies.length > MAX_LATENCY_SAMPLES) record.latencies.shift();
    if (record.consecutiveFailures >= MARKET_DATA_FAILURE_THRESHOLD) {
      record.cooldownUntil = new Date(at.getTime() + MARKET_DATA_COOLDOWN_MS);
    }
    this.records.set(sourceId, record);
  }

  /**
   * Whether this source should be left alone for now.
   *
   * A cooldown is reset by a success or by time passing, never by asking again:
   * that is the difference between "the source is failing" and "nobody has tried
   * since it failed", and it is why a broken provider costs one call per minute
   * instead of one call per symbol per run.
   */
  isCoolingDown(sourceId: string, at: Date = new Date()): boolean {
    const until = this.records.get(sourceId)?.cooldownUntil;
    return until !== null && until !== undefined && until.getTime() > at.getTime();
  }

  snapshot(): MarketDataSourceHealth[] {
    return [...this.records.entries()]
      .map(([sourceId, record]) => ({
        sourceId,
        successCount: record.successCount,
        failureCount: record.failureCount,
        consecutiveFailures: record.consecutiveFailures,
        lastOutcome: record.lastOutcome,
        lastReason: record.lastReason,
        lastDurationMs: record.lastDurationMs,
        lastSuccessAt: record.lastSuccessAt?.toISOString() ?? null,
        lastFailureAt: record.lastFailureAt?.toISOString() ?? null,
        averageDurationMs:
          record.latencies.length > 0
            ? Math.round(record.latencies.reduce((sum, value) => sum + value, 0) / record.latencies.length)
            : null,
        errorRate:
          record.successCount + record.failureCount > 0
            ? Number((record.failureCount / (record.successCount + record.failureCount)).toFixed(4))
            : 0,
        cooldownUntil: record.cooldownUntil?.toISOString() ?? null,
      }))
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  }
}

/**
 * The registry lives on `globalThis` for the same reason the provider-call sink
 * does: Next compiles the runner, a route and a page into separate module
 * graphs, and a module-level singleton would give each graph its own health.
 */
type HealthGlobal = typeof globalThis & { __veyloraMarketDataHealth?: MarketDataHealthRegistry };

export function marketDataHealth(): MarketDataHealthRegistry {
  const scope = globalThis as HealthGlobal;
  scope.__veyloraMarketDataHealth ??= new MarketDataHealthRegistry();
  return scope.__veyloraMarketDataHealth;
}

/** Drop the process-wide registry. Only a test should call this. */
export function resetMarketDataHealth(): void {
  (globalThis as HealthGlobal).__veyloraMarketDataHealth = new MarketDataHealthRegistry();
}
