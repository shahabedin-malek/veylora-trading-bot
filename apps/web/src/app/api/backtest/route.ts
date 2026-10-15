import { Buffer } from "node:buffer";
import { coinbaseMarketData } from "@/lib/market-data/coinbase-service";
import type { CandleRequest } from "@/lib/market-data/provider";
import {
  BACKTEST_WINDOW_DAYS,
  runRsiBacktest,
  validateBacktestRequest,
} from "@/lib/backtesting/rsi-backtester";

const MAX_BODY_BYTES = 4_096;
const DAY_MS = 86_400_000;

type CandleReader = (request: CandleRequest) => ReturnType<typeof coinbaseMarketData.getCandles>;

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

export async function handleBacktestPost(
  request: Request,
  readCandles: CandleReader = coinbaseMarketData.getCandles.bind(coinbaseMarketData),
  now = new Date(),
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

export async function POST(request: Request) {
  return handleBacktestPost(request);
}