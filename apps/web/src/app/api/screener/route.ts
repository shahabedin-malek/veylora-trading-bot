import { Buffer } from "node:buffer";
import { NextRequest } from "next/server";
import { getAccessRefusal } from "@/lib/auth/access-gate";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { requireUser } from "@/lib/auth/session-store";
import { runMarketIngest } from "@/lib/market-data/ingest";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";
import { loadScreenerPayload } from "@/lib/screener/payload";
import { validateScreenerDefinition } from "@/lib/screener/model";
import {
  createAlertsFromScreen,
  deleteScreen,
  evaluateDefinition,
  runSavedScreener,
  saveScreen,
} from "@/lib/screener/service";

/**
 * The screener surface (phase 19): evaluate a condition, save it as a screen,
 * re-run and compare it, and turn its matches into market alerts.
 *
 * The read half is public because everything it reads is public market data. The
 * write half — saving, ingesting, deleting, creating alerts — requires a session
 * and a same-origin request, because those actions write rows the owner owns.
 *
 * Evaluation is not gated by a confirmation step: clicking RUN is the request.
 * It does refresh stale candles first, through the same ingestion path the
 * runner uses, because a screen over day-old candles that presents itself as
 * current would be worse than one that reported no data.
 */

export const maxDuration = 60;

const MAX_BODY_BYTES = 4_096;
const MAX_REPLAY_AGE_MS = 400 * 86_400_000;
const MAX_FUTURE_SKEW_MS = 60_000;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authError(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal ? json({ error: refusal.error }, refusal.status) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(request: Request): Promise<{ body: unknown } | { response: Response }> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return { response: json({ error: "Content-Type must be application/json." }, 415) };
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { response: json({ error: "Invalid request body." }, 400) };
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return { response: json({ error: "Request is too large." }, 413) };
  try {
    return { body: JSON.parse(raw) as unknown };
  } catch {
    return { response: json({ error: "Invalid JSON body." }, 400) };
  }
}

function parseAsOf(value: unknown, now: Date): { date: Date } | { error: string } {
  if (value === undefined || value === null) return { date: now };
  if (typeof value !== "string") return { error: "asOf must be an ISO timestamp." };
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return { error: "asOf must be a valid ISO timestamp." };
  if (date.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) {
    return { error: "asOf cannot be in the future." };
  }
  if (date.getTime() < now.getTime() - MAX_REPLAY_AGE_MS) {
    return { error: "asOf is older than the stored market-data window." };
  }
  return { date };
}

export async function GET() {
  return json(await loadScreenerPayload());
}

function requireScreenerId(body: Record<string, unknown>): { id: string } | { error: string } {
  if (typeof body.screenerId !== "string" || body.screenerId.trim().length === 0) {
    return { error: "A screenerId is required." };
  }
  return { id: body.screenerId.trim() };
}

export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) {
    return json(
      {
        error:
          "Screener actions are unavailable because authentication is not configured. Set AUTH_EVM_CHAIN_IDS, APP_BASE_URL and SESSION_SECRET.",
      },
      503,
    );
  }
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  const parsed = await readBody(request);
  if ("response" in parsed) return parsed.response;
  if (!isRecord(parsed.body)) return json({ error: "Request body must be an object." }, 400);
  const body = parsed.body;
  const action = typeof body.action === "string" ? body.action : "";
  const now = new Date();

  if (action === "evaluate") {
    const validation = validateScreenerDefinition(body);
    if (!validation.valid) return json({ error: validation.error }, 400);
    const asOf = parseAsOf(body.asOf, now);
    if ("error" in asOf) return json({ error: asOf.error }, 400);

    try {
      const { evaluation, ingest } = await evaluateDefinition({
        definition: validation.value,
        asOf: asOf.date,
        // A replay reads what is stored; a fresh screen refreshes stale candles.
        refresh: body.asOf === undefined,
      });
      return json({ result: evaluation, ingest });
    } catch {
      return json({ error: "Stored market data could not be read, so the screen did not run." }, 503);
    }
  }

  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authError(error) ?? json({ error: "User authorization is unavailable." }, 503);
  }

  if (action === "ingest") {
    if (body.symbols !== undefined) {
      if (!Array.isArray(body.symbols) || body.symbols.length === 0 ||
        body.symbols.some((symbol) => typeof symbol !== "string" || !USD_WATCHLIST.some(({ productId }) => productId === symbol))) {
        return json({ error: "Provide at least one supported Coinbase USD market." }, 400);
      }
    }
    try {
      const summary = await runMarketIngest({
        now,
        ...(body.symbols !== undefined ? { symbols: body.symbols as string[] } : {}),
        intervals: ["15m", "1d"],
        includeNews: true,
      });
      return json({ ingest: summary });
    } catch {
      return json({ error: "Market data ingestion could not run." }, 503);
    }
  }

  if (action === "save") {
    const validation = validateScreenerDefinition(body, { requireName: true });
    if (!validation.valid) return json({ error: validation.error }, 400);
    try {
      const screen = await saveScreen(user.id, validation.value);
      return json({ screen }, 201);
    } catch (error) {
      if (isRecord(error) && error.code === "P2002") {
        return json({ error: "A screen with that name already exists." }, 409);
      }
      return json({ error: "The screen could not be saved." }, 503);
    }
  }

  if (action === "run") {
    const id = requireScreenerId(body);
    if ("error" in id) return json({ error: id.error }, 400);
    const asOf = parseAsOf(body.asOf, now);
    if ("error" in asOf) return json({ error: asOf.error }, 400);
    try {
      const run = await runSavedScreener({
        userId: user.id,
        screenerId: id.id,
        asOf: asOf.date,
        refresh: body.asOf === undefined,
      });
      if (!run) return json({ error: "That screen was not found." }, 404);
      return json(run);
    } catch {
      return json({ error: "The screen could not be run over stored market data." }, 503);
    }
  }

  if (action === "create-alerts") {
    const id = requireScreenerId(body);
    if ("error" in id) return json({ error: id.error }, 400);
    try {
      const creation = await createAlertsFromScreen({ userId: user.id, screenerId: id.id });
      switch (creation.status) {
        case "created":
          return json(creation, 201);
        case "not-found":
          return json({ error: creation.message }, 404);
        default:
          return json({ error: creation.message }, 409);
      }
    } catch {
      return json({ error: "Alerts could not be created from this screen." }, 503);
    }
  }

  if (action === "delete") {
    const id = requireScreenerId(body);
    if ("error" in id) return json({ error: id.error }, 400);
    try {
      const deleted = await deleteScreen(user.id, id.id);
      return deleted ? json({ deleted: true }) : json({ error: "That screen was not found." }, 404);
    } catch {
      return json({ error: "The screen could not be deleted." }, 503);
    }
  }

  return json({ error: "Choose one of: evaluate, ingest, save, run, create-alerts, delete." }, 400);
}

export async function DELETE(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) {
    return json(
      {
        error:
          "Screener changes are unavailable because authentication is not configured. Set AUTH_EVM_CHAIN_IDS, APP_BASE_URL and SESSION_SECRET.",
      },
      503,
    );
  }
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authError(error) ?? json({ error: "User authorization is unavailable." }, 503);
  }

  const parsed = await readBody(request);
  if ("response" in parsed) return parsed.response;
  if (!isRecord(parsed.body)) return json({ error: "Request body must be an object." }, 400);
  const id = requireScreenerId(parsed.body);
  if ("error" in id) return json({ error: id.error }, 400);

  try {
    const deleted = await deleteScreen(user.id, id.id);
    return deleted ? json({ deleted: true }) : json({ error: "That screen was not found." }, 404);
  } catch {
    return json({ error: "The screen could not be deleted." }, 503);
  }
}
