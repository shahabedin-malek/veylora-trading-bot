import type { MarketAlertCondition } from "@/lib/alerts/conditions";
import { MAX_ACTIVE_ALERTS_PER_USER } from "@/lib/alerts/limits";
import { prisma } from "@/lib/db";
import { runMarketIngest, type MarketIngestSummary } from "@/lib/market-data/ingest";
import { evaluateScreen, type ScreenEvaluation, type ScreenerCandle, type ScreenerRow } from "@/lib/screener/evaluate";
import { screenAlertInputs, type ScreenerDefinition } from "@/lib/screener/model";
import { auditCreate } from "@/lib/audit/record";

/**
 * Saved screens, their recorded runs, and the alert translation (phase 19).
 *
 * This module is the only place that reads or writes `Screener` rows. It keeps
 * three things true:
 *
 *  - **An evaluation always has an as-of time.** The caller may pass one (a
 *    replay) or the service captures one now; either way it is stored with the
 *    result, because a result without the moment it was asked cannot be compared
 *    to anything.
 *  - **A screen re-run is a new result row, never an overwrite.** The previous
 *    run stays readable, which is what lets the view say what changed.
 *  - **Alert creation uses the screen's own condition and threshold.** It cannot
 *    submit a different threshold from the one that produced the matches.
 */

const SCREENER_CANDLE_LIMIT = 4_000;
const SCREEN_STALE_AFTER_MS = 30 * 60_000;

export type StoredScreenerResult = {
  id: string;
  asOf: string;
  dataAsOf: string | null;
  providerIds: string[];
  rows: ScreenerRow[];
  resultHash: string;
  matchedCount: number;
  createdAt: string;
};

export type StoredScreener = {
  id: string;
  name: string;
  condition: MarketAlertCondition;
  threshold: string;
  symbols: string[];
  createdAt: string;
  updatedAt: string;
  lastRun: StoredScreenerResult | null;
  previousRun: StoredScreenerResult | null;
};

type StoredScreenerResultRow = {
  id: string;
  asOf: Date;
  dataAsOf: Date | null;
  providerIdsJson: string;
  resultsJson: string;
  resultHash: string;
  matchedCount: number;
  createdAt: Date;
};

type StoredScreenerRow = {
  id: string;
  name: string;
  condition: string;
  threshold: string;
  symbolsJson: string;
  createdAt: Date;
  updatedAt: Date;
  results?: StoredScreenerResultRow[];
};

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function parseRows(value: string): ScreenerRow[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row): row is ScreenerRow => {
      if (typeof row !== "object" || row === null) return false;
      const candidate = row as Partial<ScreenerRow>;
      return (
        typeof candidate.symbol === "string" &&
        (candidate.value === null || typeof candidate.value === "string") &&
        (candidate.observedAt === null || typeof candidate.observedAt === "string") &&
        typeof candidate.matched === "boolean" &&
        (candidate.providerId === null || typeof candidate.providerId === "string")
      );
    });
  } catch {
    return [];
  }
}

export function toStoredResult(row: StoredScreenerResultRow): StoredScreenerResult {
  return {
    id: row.id,
    asOf: row.asOf.toISOString(),
    dataAsOf: row.dataAsOf?.toISOString() ?? null,
    providerIds: parseStringArray(row.providerIdsJson),
    rows: parseRows(row.resultsJson),
    resultHash: row.resultHash,
    matchedCount: row.matchedCount,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toStoredScreener(row: StoredScreenerRow): StoredScreener {
  const runs = (row.results ?? []).map(toStoredResult);
  return {
    id: row.id,
    name: row.name,
    condition: row.condition as MarketAlertCondition,
    threshold: row.threshold,
    symbols: parseStringArray(row.symbolsJson),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastRun: runs[0] ?? null,
    previousRun: runs[1] ?? null,
  };
}

export async function listScreeners(userId: string): Promise<StoredScreener[]> {
  const rows = await prisma.screener.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { results: { orderBy: [{ asOf: "desc" }, { createdAt: "desc" }], take: 2 } },
  });
  return rows.map(toStoredScreener);
}

export async function findScreener(userId: string, screenerId: string): Promise<StoredScreener | null> {
  const row = await prisma.screener.findFirst({
    where: { id: screenerId, userId },
    include: { results: { orderBy: [{ asOf: "desc" }, { createdAt: "desc" }], take: 2 } },
  });
  return row ? toStoredScreener(row) : null;
}

export async function saveScreen(userId: string, definition: ScreenerDefinition): Promise<StoredScreener> {
  const name = definition.name;
  if (!name) throw new Error("A saved screen needs a name.");
  const row = await prisma.$transaction(async (transaction) => {
    const created = await transaction.screener.create({
      data: {
        userId,
        name,
        condition: definition.condition,
        threshold: definition.threshold,
        symbolsJson: JSON.stringify(definition.symbols),
      },
    });
    await auditCreate(transaction, {
      data: {
        actorUserId: userId,
        action: "SCREENER_SAVED",
        objectType: "Screener",
        objectId: created.id,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({
          name: created.name,
          condition: created.condition,
          threshold: created.threshold,
          symbols: definition.symbols,
        }),
      },
    });
    return created;
  });
  return toStoredScreener(row);
}

export async function deleteScreen(userId: string, screenerId: string): Promise<boolean> {
  const screen = await prisma.screener.findFirst({ where: { id: screenerId, userId }, select: { id: true, name: true } });
  if (!screen) return false;
  await prisma.$transaction(async (transaction) => {
    const deleted = await transaction.screener.deleteMany({ where: { id: screenerId, userId } });
    if (deleted.count !== 1) throw new Error("The screen was already deleted.");
    await auditCreate(transaction, {
      data: {
        actorUserId: userId,
        action: "SCREENER_DELETED",
        objectType: "Screener",
        objectId: screen.id,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({ name: screen.name }),
      },
    });
  });
  return true;
}

export async function loadScreenerCandles(input: {
  symbols: readonly string[];
  asOf: Date;
}): Promise<ScreenerCandle[]> {
  return prisma.marketCandleRecord.findMany({
    where: {
      symbol: { in: [...input.symbols] },
      interval: "15m",
      closeTime: { lte: input.asOf },
    },
    orderBy: [{ symbol: "asc" }, { openTime: "asc" }],
    take: SCREENER_CANDLE_LIMIT,
    select: {
      symbol: true,
      interval: true,
      openTime: true,
      closeTime: true,
      close: true,
      providerId: true,
      fetchedAt: true,
    },
  });
}

/**
 * Make sure the symbols a screen asks about have recent stored candles.
 *
 * A screen that silently evaluated stale data would be worse than one that says
 * it could not: the value and its as-of time would look current while the
 * candles were days old. So a missing or stale series is refreshed through the
 * same ingestion path the runner uses, and the refresh's own summary — including
 * any provider failure — travels back with the evaluation.
 *
 * A refresh is bounded to the symbols that need it and to the 15m candle the
 * screen reads. No browser has to be open.
 */
export async function ensureScreenData(input: {
  symbols: readonly string[];
  asOf: Date;
}): Promise<MarketIngestSummary | null> {
  const latest = await prisma.marketCandleRecord.groupBy({
    by: ["symbol"],
    where: {
      symbol: { in: [...input.symbols] },
      interval: "15m",
      closeTime: { lte: input.asOf },
    },
    _max: { closeTime: true },
  });
  const newestBySymbol = new Map(latest.map((row) => [row.symbol, row._max.closeTime?.getTime() ?? 0]));
  const stale = input.symbols.filter((symbol) => {
    const newest = newestBySymbol.get(symbol) ?? 0;
    return newest === 0 || input.asOf.getTime() - newest > SCREEN_STALE_AFTER_MS;
  });
  if (stale.length === 0) return null;

  return runMarketIngest({
    now: input.asOf,
    symbols: stale,
    intervals: ["15m"],
    includeNews: false,
    includeBackfill: true,
  });
}

export async function evaluateDefinition(input: {
  definition: ScreenerDefinition;
  asOf: Date;
  refresh: boolean;
}): Promise<{ evaluation: ScreenEvaluation; ingest: MarketIngestSummary | null }> {
  const ingest = input.refresh ? await ensureScreenData({ symbols: input.definition.symbols, asOf: input.asOf }) : null;
  const candles = await loadScreenerCandles({ symbols: input.definition.symbols, asOf: input.asOf });
  return {
    evaluation: evaluateScreen({
      condition: input.definition.condition,
      threshold: input.definition.threshold,
      symbols: input.definition.symbols,
      candles,
      asOf: input.asOf,
    }),
    ingest,
  };
}

/** How many runs a saved screen keeps, so a frequently re-run screen stays bounded. */
export const SCREENER_RESULT_RETENTION = 20;

export async function recordRun(screenerId: string, evaluation: ScreenEvaluation): Promise<StoredScreenerResult> {
  const row = await prisma.screenerResult.create({
    data: {
      screenerId,
      asOf: new Date(evaluation.asOf),
      dataAsOf: evaluation.dataAsOf ? new Date(evaluation.dataAsOf) : null,
      providerIdsJson: JSON.stringify(evaluation.providerIds),
      resultsJson: JSON.stringify(evaluation.rows),
      resultHash: evaluation.resultHash,
      matchedCount: evaluation.matchedCount,
    },
  });

  const excess = await prisma.screenerResult.findMany({
    where: { screenerId },
    orderBy: [{ asOf: "desc" }, { createdAt: "desc" }],
    skip: SCREENER_RESULT_RETENTION,
    select: { id: true },
  });
  if (excess.length > 0) {
    await prisma.screenerResult.deleteMany({ where: { id: { in: excess.map((entry) => entry.id) } } });
  }
  return toStoredResult(row);
}

export async function runSavedScreener(input: {
  userId: string;
  screenerId: string;
  asOf: Date;
  refresh: boolean;
}): Promise<{
  screen: StoredScreener;
  result: StoredScreenerResult;
  evaluation: ScreenEvaluation;
  ingest: MarketIngestSummary | null;
} | null> {
  const screen = await findScreener(input.userId, input.screenerId);
  if (!screen) return null;

  const { evaluation, ingest } = await evaluateDefinition({
    definition: {
      name: screen.name,
      condition: screen.condition,
      threshold: screen.threshold,
      symbols: screen.symbols,
    },
    asOf: input.asOf,
    refresh: input.refresh,
  });
  const result = await recordRun(screen.id, evaluation);
  const updated = await findScreener(input.userId, input.screenerId);
  return updated ? { screen: updated, result, evaluation, ingest } : null;
}

export type ScreenAlertCreation =
  | {
      status: "created";
      created: number;
      skipped: number;
      symbols: string[];
      screenedAt: string;
    }
  | { status: "no-run" | "no-matches" | "limit-reached" | "not-found"; message: string };

/**
 * Create an alert for every symbol the screen's latest run matched.
 *
 * Duplicates are counted, not written: an active alert with the same symbol,
 * condition and threshold already says the same thing, and creating a second one
 * would make the alert list look like two independent findings. The audit row
 * records which screen produced each alert.
 */
export async function createAlertsFromScreen(input: {
  userId: string;
  screenerId: string;
}): Promise<ScreenAlertCreation> {
  const screen = await findScreener(input.userId, input.screenerId);
  if (!screen) return { status: "not-found", message: "That screen was not found." };
  const latest = screen.lastRun;
  if (!latest) return { status: "no-run", message: "Run the screen before creating alerts from it." };

  const inputs = screenAlertInputs({
    condition: screen.condition,
    threshold: screen.threshold,
    rows: latest.rows,
  });
  if (inputs.length === 0) {
    return { status: "no-matches", message: "The latest run matched no symbols, so there is no alert to create." };
  }

  const activeCount = await prisma.marketAlert.count({ where: { userId: input.userId, status: "ACTIVE" } });
  let remaining = Math.max(0, MAX_ACTIVE_ALERTS_PER_USER - activeCount);
  if (remaining === 0) {
    return {
      status: "limit-reached",
      message: `This account already has ${MAX_ACTIVE_ALERTS_PER_USER} active alerts.`,
    };
  }

  const existing = await prisma.marketAlert.findMany({
    where: {
      userId: input.userId,
      status: "ACTIVE",
      condition: screen.condition,
      threshold: screen.threshold,
      symbol: { in: inputs.map((entry) => entry.symbol) },
    },
    select: { symbol: true },
  });
  const alreadyActive = new Set(existing.map((row) => row.symbol));

  const createdSymbols: string[] = [];
  let skipped = 0;
  for (const entry of inputs) {
    if (alreadyActive.has(entry.symbol)) {
      skipped += 1;
      continue;
    }
    if (remaining <= 0) {
      skipped += 1;
      continue;
    }
    await prisma.$transaction(async (transaction) => {
      const created = await transaction.marketAlert.create({
        data: {
          userId: input.userId,
          symbol: entry.symbol,
          condition: entry.condition,
          threshold: entry.threshold,
        },
      });
      await auditCreate(transaction, {
        data: {
          actorUserId: input.userId,
          action: "MARKET_ALERT_CREATED",
          objectType: "MarketAlert",
          objectId: created.id,
          outcome: "SUCCESS",
          redactedJson: JSON.stringify({
            symbol: created.symbol,
            condition: created.condition,
            threshold: created.threshold,
            screenerId: screen.id,
            screenerResultId: latest.id,
          }),
        },
      });
    });
    createdSymbols.push(entry.symbol);
    remaining -= 1;
  }

  return {
    status: "created",
    created: createdSymbols.length,
    skipped,
    symbols: createdSymbols,
    screenedAt: latest.asOf,
  };
}
