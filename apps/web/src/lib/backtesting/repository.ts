import { prisma } from "@/lib/db";
import type { BacktestCosts } from "./costs";
import type { BacktestMetrics, BacktestResult, SweepResult } from "./engine";

/**
 * Runs are history: written once, read many, never edited.
 *
 * Each row records the definition version it tested, the parameters it varied, the exact
 * cost assumptions and the result — so a number on the comparison table can always be
 * traced to the rules and the assumptions that produced it. `listBacktestRuns` returns a
 * summary (metrics, costs, parameters) and deliberately drops the trade list and the equity
 * curve, because the comparison table does not need them and a list of full results would
 * be megabytes of JSON to render ten numbers.
 */

export type RunKind = "BACKTEST" | "SWEEP" | "PAPER";

export type StoredRunSummary = {
  id: string;
  definitionId: string;
  definitionVersion: number;
  kind: RunKind;
  sweepId: string | null;
  symbol: string;
  strategyText: string;
  parameters: Record<string, unknown>;
  costs: BacktestCosts;
  metrics: BacktestMetrics;
  createdAt: string;
};

function decodeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

type PrismaRunRow = {
  id: string;
  definitionId: string;
  definitionVersion: number;
  kind: string;
  sweepId: string | null;
  symbol: string;
  strategyText: string;
  parametersJson: string;
  costAssumptionsJson: string;
  metricsJson: string;
  resultJson: string;
  createdAt: Date;
};

function kindOf(value: string): RunKind {
  return value === "SWEEP" || value === "PAPER" ? value : "BACKTEST";
}

function summaryOf(row: PrismaRunRow): StoredRunSummary {
  const costRecord = asRecord(decodeJson(row.costAssumptionsJson));
  const metrics = asRecord(decodeJson(row.metricsJson)) as unknown as BacktestMetrics;
  return {
    id: row.id,
    definitionId: row.definitionId,
    definitionVersion: row.definitionVersion,
    kind: kindOf(row.kind),
    sweepId: row.sweepId,
    symbol: row.symbol,
    strategyText: row.strategyText,
    parameters: asRecord(decodeJson(row.parametersJson)),
    costs: {
      feeBps: String(costRecord.feeBps ?? "0"),
      spreadBps: String(costRecord.spreadBps ?? "0"),
      slippageBps: String(costRecord.slippageBps ?? "0"),
      fundingBpsPerDay: String(costRecord.fundingBpsPerDay ?? "0"),
      source: costRecord.source === "owner-fee-table" ? "owner-fee-table" : "defaults",
      scheduleId: typeof costRecord.scheduleId === "string" ? costRecord.scheduleId : null,
      appliedFrom: typeof costRecord.appliedFrom === "string" ? costRecord.appliedFrom : null,
    },
    metrics,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function saveBacktestRun(input: {
  userId: string;
  definitionId: string;
  definitionVersion: number;
  kind: RunKind;
  sweepId?: string | null;
  parameters?: Record<string, unknown>;
  costs: BacktestCosts;
  result: BacktestResult;
}): Promise<{ id: string }> {
  const row = await prisma.backtestRun.create({
    data: {
      userId: input.userId,
      definitionId: input.definitionId,
      definitionVersion: input.definitionVersion,
      kind: input.kind,
      sweepId: input.sweepId ?? null,
      symbol: input.result.symbol,
      strategyText: input.result.definitionText,
      parametersJson: JSON.stringify(input.parameters ?? {}),
      costAssumptionsJson: JSON.stringify(input.costs),
      metricsJson: JSON.stringify(input.result.metrics),
      resultJson: JSON.stringify(input.result),
    },
    select: { id: true },
  });
  return row;
}

/** One row per swept value, sharing a `sweepId` so the sweep stays one event. */
export async function saveSweepRuns(input: {
  userId: string;
  definitionId: string;
  definitionVersion: number;
  costs: BacktestCosts;
  sweep: SweepResult;
}): Promise<{ sweepId: string; runIds: string[] }> {
  const sweepId = `sweep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const runIds: string[] = [];
  for (const run of input.sweep.runs) {
    const saved = await prisma.backtestRun.create({
      data: {
        userId: input.userId,
        definitionId: input.definitionId,
        definitionVersion: input.definitionVersion,
        kind: "SWEEP",
        sweepId,
        symbol: input.sweep.symbol,
        strategyText: input.sweep.definitionText,
        parametersJson: JSON.stringify({
          parameter: input.sweep.parameter,
          parameterLabel: input.sweep.parameterLabel,
          value: run.value,
          isBest: run.isBest,
          bestValue: input.sweep.bestValue,
        }),
        costAssumptionsJson: JSON.stringify(input.costs),
        metricsJson: JSON.stringify(run.metrics),
        resultJson: JSON.stringify({ value: run.value, metrics: run.metrics, warning: input.sweep.warning }),
      },
      select: { id: true },
    });
    runIds.push(saved.id);
  }
  return { sweepId, runIds };
}

export async function listBacktestRuns(userId: string, limit = 25): Promise<StoredRunSummary[]> {
  const rows = await prisma.backtestRun.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }],
    take: Math.min(Math.max(limit, 1), 100),
  });
  return rows.map((row) => summaryOf(row));
}

export async function readBacktestRun(
  userId: string,
  id: string,
): Promise<(StoredRunSummary & { result: unknown }) | null> {
  const row = await prisma.backtestRun.findFirst({ where: { id, userId } });
  if (!row) return null;
  return { ...summaryOf(row), result: decodeJson(row.resultJson) };
}
