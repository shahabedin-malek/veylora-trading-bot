import { Buffer } from "node:buffer";
import { accessRefusalPayload, authenticationGapResponse, getAccessRefusal } from "@/lib/auth/access-gate";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { requireUser } from "@/lib/auth/session-store";
import { readEffectiveFeeSchedule } from "@/lib/fees/table";
import { runStrategyBacktest, runParameterSweep, SWEEP_PARAMETERS, validateInitialCapital, type BacktestResult, type SweepParameter, type SweepResult } from "@/lib/backtesting/engine";
import { costsFromFeeSchedule, validateCostOverrides, type BacktestCosts } from "@/lib/backtesting/costs";
import { saveBacktestRun, saveSweepRuns } from "@/lib/backtesting/repository";
import { coinbaseMarketData } from "@/lib/market-data/coinbase-service";
import type { CandleRequest, MarketCandle } from "@/lib/market-data/provider";
import {
  BACKTEST_WINDOW_DAYS,
  runRsiBacktest,
  validateBacktestRequest,
} from "@/lib/backtesting/rsi-backtester";
import { readStrategyDefinition, ensureStrategyVersion } from "@/lib/strategies/repository";
import { validateStrategyText } from "@/lib/strategies/validate";
import { renderStrategyText, type StrategyDefinition } from "@/lib/strategies/definition";

/**
 * The backtest surface: the legacy RSI run, plus definitions, sweeps and paper runs.
 *
 * Three properties matter here more than the routing:
 *
 *  - **A run is recorded with the version it tested.** The route resolves the submitted
 *    text to a stored definition version — reusing it when the text already exists, writing
 *    the next version when it has changed — and the row carries that version, the cost
 *    assumptions and the result. So "which rules produced this number" is answerable later.
 *  - **Costs come from the fee table.** The default assumptions are the version in force in
 *    `/admin/fees`; a caller may override them for a what-if run, and the result says which
 *    it used. A fee table that cannot be read is a 503 naming the gap, never a silent zero.
 *  - **The legacy RSI mode is untouched.** Existing callers and the phase-24 panel keep
 *    working against the same request shape and the same validation.
 */

const MAX_BODY_BYTES = 16_384;
const DAY_MS = 86_400_000;
const PAPER_BARS = 60;

type CandleReader = (request: CandleRequest) => ReturnType<typeof coinbaseMarketData.getCandles>;

export type DefinitionBacktestDeps = {
  readFeeSchedule?: () => Promise<Parameters<typeof costsFromFeeSchedule>[0]>;
  authenticate?: () => Promise<{ id: string }>;
  loadDefinition?: (userId: string, id: string) => Promise<{ id: string; version: number; text: string } | null>;
  persistDefinition?: (input: { userId: string; text: string; origin: "generated" | "manual" | "edit" }) => Promise<{ id: string; version: number }>;
  persistRun?: (input: {
    userId: string;
    definitionId: string;
    definitionVersion: number;
    kind: "BACKTEST" | "SWEEP" | "PAPER";
    costs: BacktestCosts;
    result: BacktestResult;
  }) => Promise<unknown>;
  persistSweep?: (input: {
    userId: string;
    definitionId: string;
    definitionVersion: number;
    costs: BacktestCosts;
    sweep: SweepResult;
  }) => Promise<unknown>;
};

export function startBacktestWindow(now = new Date()) {
  const end = new Date(now);
  end.setUTCHours(23, 59, 59, 999);
  const start = new Date(end.getTime() - BACKTEST_WINDOW_DAYS * DAY_MS);
  start.setUTCHours(0, 0, 0, 0);
  return { from: start.toISOString(), to: end.toISOString() };
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authErrorResponse(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal ? json(accessRefusalPayload(refusal), refusal.status) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DEFINITION_MODES = ["definition", "sweep", "paper"] as const;

export async function handleBacktestPost(
  request: Request,
  readCandles: CandleReader = coinbaseMarketData.getCandles.bind(coinbaseMarketData),
  now = new Date(),
  deps: DefinitionBacktestDeps = {},
): Promise<Response> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415);
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return json({ error: "Invalid backtest request." }, 400);
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413);

  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return json({ error: "Invalid JSON request." }, 400);
  }

  if (isRecord(body) && body.mode !== undefined) {
    if (typeof body.mode !== "string" || !(DEFINITION_MODES as readonly string[]).includes(body.mode)) {
      return json({ error: `Unknown mode. Use ${DEFINITION_MODES.join(", ")} or the RSI request shape.` }, 400);
    }
    return handleDefinitionBacktest(request, body, readCandles, now, deps);
  }

  return handleLegacyRsiBacktest(body, readCandles, now);
}

// ─────────────────────────────────────────────────────────────────────────────
// The legacy RSI run
// ─────────────────────────────────────────────────────────────────────────────

async function handleLegacyRsiBacktest(body: unknown, readCandles: CandleReader, now: Date): Promise<Response> {
  const validation = validateBacktestRequest(body);
  if (!validation.valid) return json({ error: validation.error }, 400);

  const window = startBacktestWindow(now);
  try {
    const history = await readCandles({
      instrument: validation.value.symbol,
      interval: "1d",
      from: window.from,
      to: window.to,
    });
    if (history.status !== "available") {
      return json({ error: `Coinbase historical data is unavailable (${history.reason}). No backtest was produced.` }, 503);
    }

    try {
      const result = runRsiBacktest(validation.value, history.data, now);
      return json(result);
    } catch (error) {
      if (error instanceof Error && error.message === "INSUFFICIENT_HISTORY") {
        return json({ error: "A complete trailing-year history is unavailable. No shortened-period backtest was produced." }, 422);
      }
      if (error instanceof Error && error.message === "HISTORY_STALE") {
        return json({ error: "The latest daily candle is stale. No backtest was produced." }, 422);
      }
      return json({ error: "Coinbase candle history failed validation. No backtest was produced." }, 422);
    }
  } catch {
    return json({ error: "Coinbase historical data is unavailable. No backtest was produced." }, 503);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Definitions, sweeps and paper runs
// ─────────────────────────────────────────────────────────────────────────────

type DefinitionRequest = {
  mode: (typeof DEFINITION_MODES)[number];
  definitionId: string | null;
  definitionText: string | null;
  definition: StrategyDefinition | null;
  initialCapitalUsd: string;
  parameter: SweepParameter | null;
  values: string[];
  costsOverride: unknown;
};

function readDefinitionRequest(body: Record<string, unknown>): { valid: true; value: DefinitionRequest } | { valid: false; response: Response } {
  const mode = body.mode as DefinitionRequest["mode"];
  const definitionId = typeof body.definitionId === "string" && body.definitionId.trim() ? body.definitionId.trim() : null;
  const definitionText = typeof body.definitionText === "string" && body.definitionText.trim() ? body.definitionText : null;
  if (!definitionId && !definitionText) {
    return { valid: false, response: json({ error: "Provide definitionText or the id of a stored definition." }, 400) };
  }

  const capital = validateInitialCapital(body.initialCapitalUsd);
  if (!capital.valid) return { valid: false, response: json({ error: capital.error }, 400) };

  let definition: StrategyDefinition | null = null;
  if (definitionText) {
    const validation = validateStrategyText(definitionText);
    if (!validation.valid) {
      // The specific problems, before authorization: a strategy that cannot run is refused
      // with the value that is wrong rather than with a generic failure.
      return { valid: false, response: json({ error: "The definition cannot run as written.", issues: validation.issues }, 422) };
    }
    definition = validation.definition;
  }

  let parameter: SweepParameter | null = null;
  let values: string[] = [];
  if (mode === "sweep") {
    if (typeof body.parameter !== "string" || !(SWEEP_PARAMETERS as readonly string[]).includes(body.parameter)) {
      return { valid: false, response: json({ error: `parameter must be one of ${SWEEP_PARAMETERS.join(", ")}.` }, 400) };
    }
    parameter = body.parameter as SweepParameter;
    if (!Array.isArray(body.values) || body.values.length < 2 || body.values.length > 8 || body.values.some((value) => typeof value !== "string")) {
      return { valid: false, response: json({ error: "Provide between 2 and 8 string values to sweep." }, 400) };
    }
    values = body.values as string[];
  }

  const costsOverride = body.costs;
  if (costsOverride !== undefined && !isRecord(costsOverride)) {
    return { valid: false, response: json({ error: "Cost assumptions must be an object of basis-point values." }, 400) };
  }

  return {
    valid: true,
    value: {
      mode,
      definitionId,
      definitionText,
      definition,
      initialCapitalUsd: capital.value,
      parameter,
      values,
      costsOverride,
    },
  };
}

async function handleDefinitionBacktest(
  request: Request,
  body: Record<string, unknown>,
  readCandles: CandleReader,
  now: Date,
  deps: DefinitionBacktestDeps,
): Promise<Response> {
  const parsed = readDefinitionRequest(body);
  if (!parsed.valid) return parsed.response;
  const input = parsed.value;

  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) {
    return json({ error: "Request origin is not allowed." }, 403);
  }

  let user: { id: string };
  try {
    user = deps.authenticate ? await deps.authenticate() : await requireUser();
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "User authorization is unavailable." }, 503);
  }

  // The text the run will actually evaluate. A stored id wins only when no text was sent,
  // so editing and running in one step is the draft that was submitted.
  let definitionText = input.definitionText;
  let stored: { id: string; version: number } | null = null;
  if (input.definitionId) {
    const load = deps.loadDefinition ?? readStrategyDefinition;
    const row = await load(user.id, input.definitionId).catch(() => null);
    if (!row) return json({ error: "No definition with that id belongs to this account." }, 404);
    if (!definitionText) definitionText = row.text;
  }
  if (!definitionText) return json({ error: "Provide definitionText or the id of a stored definition." }, 400);
  const validation = validateStrategyText(definitionText);
  if (!validation.valid) {
    return json({ error: "The definition cannot run as written.", issues: validation.issues }, 422);
  }
  const definition = validation.definition;

  let costs: BacktestCosts;
  try {
    const readSchedule = deps.readFeeSchedule ?? readEffectiveFeeSchedule;
    const schedule = await readSchedule();
    const overrides = validateCostOverrides(input.costsOverride, costsFromFeeSchedule(schedule));
    if (!overrides.valid) return json({ error: overrides.error }, 400);
    costs = overrides.costs;
  } catch {
    return json({ error: "The fee table could not be read, so no backtest was produced." }, 503);
  }

  const window = startBacktestWindow(now);
  let history: MarketCandle[];
  try {
    const candles = await readCandles({ instrument: definition.market, interval: "1d", from: window.from, to: window.to });
    if (candles.status !== "available") {
      return json({ error: `Coinbase historical data is unavailable (${candles.reason}). No backtest was produced.` }, 503);
    }
    history = [...candles.data];
  } catch {
    return json({ error: "Coinbase historical data is unavailable. No backtest was produced." }, 503);
  }

  try {
    const persistDefinition =
      deps.persistDefinition ??
      (async (value: { userId: string; text: string; origin: "generated" | "manual" | "edit" }) => {
        const row = await ensureStrategyVersion(value);
        return { id: row.id, version: row.version };
      });
    const row = await persistDefinition({ userId: user.id, text: definitionText, origin: "manual" });
    stored = row;

    if (input.mode === "sweep") {
      const sweep = runParameterSweep({
        definition,
        candles: history,
        costs,
        initialCapitalUsd: input.initialCapitalUsd,
        parameter: input.parameter as SweepParameter,
        values: input.values,
        now,
      });
      await persistSweepRun(deps, { userId: user.id, stored, costs, sweep });
      return json({
        kind: "SWEEP",
        stored: true,
        definition: { id: stored.id, version: stored.version, text: renderStrategyText(definition) },
        sweep,
      });
    }

    const candlesForRun = input.mode === "paper" ? history.slice(-PAPER_BARS) : history;
    const result = runStrategyBacktest({
      definition,
      candles: candlesForRun,
      costs,
      initialCapitalUsd: input.initialCapitalUsd,
      now,
    });
    const kind = input.mode === "paper" ? "PAPER" : "BACKTEST";
    await persistSingleRun(deps, { userId: user.id, stored, kind, costs, result });
    return json({
      kind,
      stored: true,
      paperBars: input.mode === "paper" ? candlesForRun.length : null,
      definition: { id: stored.id, version: stored.version, text: result.definitionText },
      result,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("INVALID_SWEEP")) {
      return json({ error: error.message.replace("INVALID_SWEEP: ", "") }, 400);
    }
    if (error instanceof Error && error.message.startsWith("INVALID_DEFINITION")) {
      return json({ error: error.message.replace("INVALID_DEFINITION: ", "") }, 422);
    }
    if (error instanceof Error && error.message === "INSUFFICIENT_HISTORY") {
      return json({ error: "There is not enough complete daily history for this market to backtest it." }, 422);
    }
    if (error instanceof Error && (error.message === "INVALID_CANDLE_SOURCE" || error.message === "INVALID_CANDLE_DATA")) {
      return json({ error: "Coinbase candle history failed validation. No backtest was produced." }, 422);
    }
    return json({ error: "The run could not be completed or recorded. No result was produced." }, 503);
  }
}

async function persistSingleRun(
  deps: DefinitionBacktestDeps,
  input: {
    userId: string;
    stored: { id: string; version: number };
    kind: "BACKTEST" | "PAPER";
    costs: BacktestCosts;
    result: BacktestResult;
  },
): Promise<void> {
  const persist =
    deps.persistRun ??
    (async (value: Parameters<NonNullable<DefinitionBacktestDeps["persistRun"]>>[0]) => {
      await saveBacktestRun({ ...value, parameters: { timeframe: value.result.timeframe } });
    });
  await persist({
    userId: input.userId,
    definitionId: input.stored.id,
    definitionVersion: input.stored.version,
    kind: input.kind,
    costs: input.costs,
    result: input.result,
  });
}

async function persistSweepRun(
  deps: DefinitionBacktestDeps,
  input: { userId: string; stored: { id: string; version: number }; costs: BacktestCosts; sweep: SweepResult },
): Promise<void> {
  const persist =
    deps.persistSweep ??
    (async (value: Parameters<NonNullable<DefinitionBacktestDeps["persistSweep"]>>[0]) => {
      await saveSweepRuns(value);
    });
  await persist({
    userId: input.userId,
    definitionId: input.stored.id,
    definitionVersion: input.stored.version,
    costs: input.costs,
    sweep: input.sweep,
  });
}

export async function POST(request: Request) {
  return handleBacktestPost(request);
}
