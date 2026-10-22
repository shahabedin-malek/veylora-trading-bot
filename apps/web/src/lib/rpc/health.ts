/**
 * Per-network RPC health, in process.
 *
 * Health here answers one question the registry cannot: has *this process*
 * recently managed to talk to the network? It is deliberately in-memory — a
 * restart forgets it, which is correct, because the record is evidence about
 * this process's calls, not a durable assertion about the chain.
 *
 * One dead network must never fail a request that another network can answer, so
 * {@link networkSkipDecision} lets a caller skip a network that has failed
 * repeatedly, for a bounded cooldown, and say how long until it is tried again.
 * The cooldown is what keeps a recovered network from staying skipped forever.
 */

export const NETWORK_SKIP_THRESHOLD = 3;
export const NETWORK_SKIP_COOLDOWN_MS = 60_000;

type MutableRecord = {
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastLatencyMs: number | null;
  consecutiveFailures: number;
  lastProblem: string | null;
  requests: number;
};

const MAX_RECORDS = 1_000;
const records = new Map<string, MutableRecord>();

export type NetworkHealthRecord = {
  slug: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastLatencyMs: number | null;
  consecutiveFailures: number;
  lastProblem: string | null;
  requests: number;
};

export type NetworkSkipDecision = {
  skip: boolean;
  retryAfterMs: number;
  reason: string | null;
};

function recordFor(slug: string): MutableRecord {
  const existing = records.get(slug);
  if (existing) return existing;
  if (records.size >= MAX_RECORDS) {
    // Bounded: the least recently touched network is the one forgotten.
    const oldest = [...records.entries()].sort(([, left], [, right]) =>
      (left.lastSuccessAt ?? 0) + (left.lastFailureAt ?? 0) - ((right.lastSuccessAt ?? 0) + (right.lastFailureAt ?? 0)),
    )[0];
    if (oldest) records.delete(oldest[0]);
  }
  const created: MutableRecord = {
    lastSuccessAt: null,
    lastFailureAt: null,
    lastLatencyMs: null,
    consecutiveFailures: 0,
    lastProblem: null,
    requests: 0,
  };
  records.set(slug, created);
  return created;
}

export function recordNetworkSuccess(slug: string, latencyMs: number, now = Date.now()): void {
  const record = recordFor(slug);
  record.lastSuccessAt = now;
  record.lastLatencyMs = Math.max(0, Math.round(latencyMs));
  record.consecutiveFailures = 0;
  record.lastProblem = null;
  record.requests += 1;
}

export function recordNetworkFailure(slug: string, problem: string, now = Date.now()): void {
  const record = recordFor(slug);
  record.lastFailureAt = now;
  record.consecutiveFailures += 1;
  record.lastProblem = problem;
  record.requests += 1;
}

/**
 * Whether a caller should skip this network rather than wait on it.
 *
 * Skips only after repeated failures and only for the cooldown: a single
 * transient error is retried immediately, and a skipped network is retried on
 * its own once the cooldown passes.
 */
export function networkSkipDecision(slug: string, now = Date.now()): NetworkSkipDecision {
  const record = records.get(slug);
  if (!record || record.consecutiveFailures < NETWORK_SKIP_THRESHOLD || record.lastFailureAt === null) {
    return { skip: false, retryAfterMs: 0, reason: null };
  }
  const elapsed = Math.max(0, now - record.lastFailureAt);
  if (elapsed >= NETWORK_SKIP_COOLDOWN_MS) return { skip: false, retryAfterMs: 0, reason: null };
  const retryAfterMs = NETWORK_SKIP_COOLDOWN_MS - elapsed;
  return {
    skip: true,
    retryAfterMs,
    reason: `${slug} was skipped after ${record.consecutiveFailures} consecutive failures` +
      `${record.lastProblem ? ` (${record.lastProblem})` : ""}; retrying in ${Math.ceil(retryAfterMs / 1_000)}s.`,
  };
}

export function networkHealthSnapshot(): NetworkHealthRecord[] {
  return [...records.entries()]
    .map(([slug, record]) => ({
      slug,
      lastSuccessAt: record.lastSuccessAt === null ? null : new Date(record.lastSuccessAt).toISOString(),
      lastFailureAt: record.lastFailureAt === null ? null : new Date(record.lastFailureAt).toISOString(),
      lastLatencyMs: record.lastLatencyMs,
      consecutiveFailures: record.consecutiveFailures,
      lastProblem: record.lastProblem,
      requests: record.requests,
    }))
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

/** Drop every record. For tests, and for a caller that has deliberately reset. */
export function resetNetworkHealth(): void {
  records.clear();
}
