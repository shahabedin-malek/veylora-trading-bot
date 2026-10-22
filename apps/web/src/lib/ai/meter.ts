import type { AiProviderId, AiTask, AiUnitKind } from "@/lib/ai/provider";

/**
 * Per-request accounting for every AI call this product makes.
 *
 * A metered product answers three questions from one table: what did this feature cost,
 * what did this account cost, and is a provider healthy. Each call therefore writes a row
 * with the provider, the model, the units actually reported, the wall-clock duration, the
 * outcome and the price computed from the provider's declared cost model — and nothing
 * else. There is no prompt, no answer and no request body in the row, because a transcript
 * is not accounting and an accounting table must not become a place a credential can land.
 *
 * Two rules are applied here rather than left to callers:
 *
 *  - **Recording never fails the request.** The answer has already been produced by the
 *    time the row is written; a database that cannot take the row is a gap in the report,
 *    not a reason to fail a person's question. The failure is logged, and the next report
 *    counts the rows it can see rather than inventing the ones it cannot.
 *  - **A price is never invented.** A provider with no configured rate writes a null cost;
 *    the report counts priced and unpriced rows separately instead of treating unknown as
 *    zero. That is what lets the panel say "12 of 14 requests priced".
 */

export type AiRequestOutcome = "SUCCESS" | "FAILED" | "SKIPPED";

export type AiRequestInput = {
  userId: string | null;
  feature: string;
  task: AiTask;
  providerId: AiProviderId;
  model: string | null;
  outcome: AiRequestOutcome;
  errorCode: string | null;
  inputTokens: number;
  outputTokens: number;
  units: number;
  unitKind: AiUnitKind;
  durationMs: number;
  costMicrosUsd: number | null;
  /** The display currency at the moment of the call, for the record's own context. */
  currency: string;
  /** The provider that failed immediately before this one answered, if any. */
  fallbackFrom: string | null;
};

export type AiRequestRow = AiRequestInput & { id: string; createdAt: Date };

export type AiMeterStore = {
  insert(input: AiRequestInput): Promise<void>;
  list(from: Date, to: Date): Promise<AiRequestRow[]>;
};

/** The database-backed store, imported lazily so reporting stays testable without it. */
export function createPrismaMeterStore(): AiMeterStore {
  return {
    async insert(input) {
      const { prisma } = await import("@/lib/db");
      await prisma.aiRequestRecord.create({
        data: {
          userId: input.userId,
          feature: input.feature,
          task: input.task,
          providerId: input.providerId,
          model: input.model,
          outcome: input.outcome,
          errorCode: input.errorCode,
          inputTokens: Math.max(0, Math.round(input.inputTokens)),
          outputTokens: Math.max(0, Math.round(input.outputTokens)),
          units: Math.max(0, Math.round(input.units)),
          unitKind: input.unitKind,
          durationMs: Math.max(0, Math.round(input.durationMs)),
          costMicrosUsd: input.costMicrosUsd === null ? null : Math.max(0, Math.round(input.costMicrosUsd)),
          currency: input.currency,
          fallbackFrom: input.fallbackFrom,
        },
      });
    },
    async list(from, to) {
      const { prisma } = await import("@/lib/db");
      const rows = await prisma.aiRequestRecord.findMany({
        where: { createdAt: { gte: from, lte: to } },
        orderBy: { createdAt: "desc" },
        take: 5_000,
      });
      return rows.map((row) => ({ ...row, providerId: row.providerId as AiProviderId, task: row.task as AiTask, unitKind: row.unitKind as AiUnitKind, outcome: row.outcome as AiRequestOutcome }));
    },
  };
}

let cachedStore: AiMeterStore | null = null;
function defaultStore(): AiMeterStore {
  cachedStore ??= createPrismaMeterStore();
  return cachedStore;
}

/**
 * Write one row. Returns whether it was written; a false result is a gap in the report,
 * and the caller has no reason to change its answer because of it.
 */
export async function recordAiRequest(
  input: AiRequestInput,
  store: AiMeterStore = defaultStore(),
): Promise<boolean> {
  try {
    await store.insert(input);
    return true;
  } catch {
    return false;
  }
}

export type AiUsageTotals = {
  requests: number;
  success: number;
  failed: number;
  skipped: number;
  inputTokens: number;
  outputTokens: number;
  units: number;
  /** Only the rows that carried a price; `pricedRequests` says how many that was. */
  costMicrosUsd: number;
  pricedRequests: number;
  unpricedRequests: number;
};

export type AiUsageBreakdown = AiUsageTotals & {
  key: string;
  /** How many of these requests arrived after a fallback. */
  requestsFallback: number;
};

export type AiProviderHealth = {
  providerId: string;
  requests: number;
  successes: number;
  failures: number;
  failureRate: number;
  averageLatencyMs: number | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
};

export type AiUsageReport = {
  period: { from: string; to: string };
  currency: string;
  usdPerCurrencyUnit: string;
  totals: AiUsageTotals & {
    requestsFallback: number;
    /** The same total expressed in the owner's currency, at their configured rate. */
    costDisplay: string;
  };
  byFeature: AiUsageBreakdown[];
  byUser: AiUsageBreakdown[];
  byProvider: AiUsageBreakdown[];
  health: AiProviderHealth[];
  budget: {
    monthlyBudgetUsd: string | null;
    monthlyBudgetMicrosUsd: number | null;
    overBudget: boolean;
    remainingMicrosUsd: number | null;
    note: string;
  };
  /** How many rows the report was built from, so a truncated read is visible. */
  rowCount: number;
};

type AiUsageAccumulator = AiUsageTotals & { requestsFallback: number };

function emptyTotals(): AiUsageAccumulator {
  return {
    requests: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    inputTokens: 0,
    outputTokens: 0,
    units: 0,
    costMicrosUsd: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
    requestsFallback: 0,
  };
}

function addRow(totals: AiUsageAccumulator, row: AiRequestRow): void {
  totals.requests += 1;
  if (row.outcome === "SUCCESS") totals.success += 1;
  else if (row.outcome === "FAILED") totals.failed += 1;
  else totals.skipped += 1;
  totals.inputTokens += row.inputTokens;
  totals.outputTokens += row.outputTokens;
  totals.units += row.units;
  if (row.fallbackFrom !== null) totals.requestsFallback += 1;
  if (row.costMicrosUsd === null) totals.unpricedRequests += 1;
  else {
    totals.costMicrosUsd += row.costMicrosUsd;
    totals.pricedRequests += 1;
  }
}

function breakdown(rows: readonly AiRequestRow[], keyOf: (row: AiRequestRow) => string): Map<string, AiUsageAccumulator> {
  const map = new Map<string, AiUsageAccumulator>();
  for (const row of rows) {
    const key = keyOf(row);
    const totals = map.get(key) ?? emptyTotals();
    addRow(totals, row);
    map.set(key, totals);
  }
  return map;
}

/** Micro-dollars into a readable amount in the owner's currency. */
export function formatMicros(micros: number, currency: string, usdPerCurrencyUnit: number): string {
  const amount = usdPerCurrencyUnit > 0 ? micros / 1_000_000 / usdPerCurrencyUnit : micros / 1_000_000;
  return `${amount.toFixed(6)} ${currency}`;
}

export function healthOf(rows: readonly AiRequestRow[]): AiProviderHealth[] {
  const map = new Map<string, { successes: number; failures: number; latencies: number[]; lastSuccess: Date | null; lastFailure: Date | null }>();
  for (const row of rows) {
    const entry = map.get(row.providerId) ?? { successes: 0, failures: 0, latencies: [], lastSuccess: null, lastFailure: null };
    entry.latencies.push(row.durationMs);
    if (row.outcome === "SUCCESS") {
      entry.successes += 1;
      if (!entry.lastSuccess || row.createdAt > entry.lastSuccess) entry.lastSuccess = row.createdAt;
    } else if (row.outcome === "FAILED") {
      entry.failures += 1;
      if (!entry.lastFailure || row.createdAt > entry.lastFailure) entry.lastFailure = row.createdAt;
    }
    map.set(row.providerId, entry);
  }
  return [...map.entries()]
    .map(([providerId, entry]) => {
      const requests = entry.successes + entry.failures;
      return {
        providerId,
        requests,
        successes: entry.successes,
        failures: entry.failures,
        failureRate: requests === 0 ? 0 : Number((entry.failures / requests).toFixed(4)),
        averageLatencyMs: entry.latencies.length === 0 ? null : Math.round(entry.latencies.reduce((sum, value) => sum + value, 0) / entry.latencies.length),
        lastSuccessAt: entry.lastSuccess?.toISOString() ?? null,
        lastFailureAt: entry.lastFailure?.toISOString() ?? null,
      };
    })
    .sort((left, right) => right.requests - left.requests || left.providerId.localeCompare(right.providerId));
}

/**
 * The report, from rows and the owner's settings.
 *
 * Pure, so the costs page's totals can be asserted against the rows a test inserted —
 * "the totals match the recorded per-request costs" is arithmetic, not a rendering claim.
 * The budget is a signal: `overBudget` is reported, and nothing here refuses a request.
 */
export function summarizeAiUsage(input: {
  rows: readonly AiRequestRow[];
  from: Date;
  to: Date;
  currency: string;
  usdPerCurrencyUnit: string;
  monthlyBudgetUsd: string | null;
}): AiUsageReport {
  const totals = emptyTotals();
  for (const row of input.rows) addRow(totals, row);

  const rate = Number(input.usdPerCurrencyUnit);
  const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const budgetUsd = input.monthlyBudgetUsd === null ? null : Number(input.monthlyBudgetUsd);
  const budgetMicros = budgetUsd !== null && Number.isFinite(budgetUsd) && budgetUsd >= 0 ? Math.round(budgetUsd * 1_000_000) : null;

  const toBreakdown = (entries: [string, AiUsageAccumulator][]): AiUsageBreakdown[] =>
    entries
      .map(([key, value]) => ({ key, ...value }))
      .sort((left, right) => right.costMicrosUsd - left.costMicrosUsd || right.requests - left.requests);

  const featureMap = breakdown(input.rows, (row) => row.feature);
  const userMap = breakdown(input.rows, (row) => row.userId ?? "system");
  const providerMap = breakdown(input.rows, (row) => row.providerId);

  return {
    period: { from: input.from.toISOString(), to: input.to.toISOString() },
    currency: input.currency,
    usdPerCurrencyUnit: String(safeRate),
    totals: {
      ...totals,
      costDisplay: formatMicros(totals.costMicrosUsd, input.currency, safeRate),
    },
    byFeature: toBreakdown([...featureMap.entries()]),
    byUser: toBreakdown([...userMap.entries()]),
    byProvider: toBreakdown([...providerMap.entries()]),
    health: healthOf(input.rows),
    budget: {
      monthlyBudgetUsd: input.monthlyBudgetUsd,
      monthlyBudgetMicrosUsd: budgetMicros,
      overBudget: budgetMicros !== null && totals.costMicrosUsd > budgetMicros,
      remainingMicrosUsd: budgetMicros === null ? null : Math.max(0, budgetMicros - totals.costMicrosUsd),
      note:
        budgetMicros === null
          ? "No monthly budget is set. This is a signal, never a cap: nothing is refused when it is exceeded."
          : "The monthly budget is a signal. Exceeding it is reported here and does not refuse a request.",
    },
    rowCount: input.rows.length,
  };
}

/** The report for one month-to-date window, read from the store. */
export async function readAiUsageReport(input: {
  from: Date;
  to: Date;
  currency: string;
  usdPerCurrencyUnit: string;
  monthlyBudgetUsd: string | null;
  store?: AiMeterStore;
}): Promise<AiUsageReport | null> {
  try {
    const rows = await (input.store ?? defaultStore()).list(input.from, input.to);
    return summarizeAiUsage({
      rows,
      from: input.from,
      to: input.to,
      currency: input.currency,
      usdPerCurrencyUnit: input.usdPerCurrencyUnit,
      monthlyBudgetUsd: input.monthlyBudgetUsd,
    });
  } catch {
    return null;
  }
}
