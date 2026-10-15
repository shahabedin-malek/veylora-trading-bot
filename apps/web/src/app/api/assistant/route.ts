import { Buffer } from "node:buffer";
import { coinbaseMarketData } from "@/lib/market-data/coinbase-service";
import { calculateRsi } from "@/lib/market-data/indicators";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";
import {
  askMarketAssistant,
  getMarketAssistantStatus,
  type AssistantMessage,
} from "@/lib/assistant/public-market-adapter";

const MAX_BODY_BYTES = 16_384;
const MAX_MESSAGES = 12;
const MAX_MESSAGE_CHARACTERS = 2_000;
const RSI_WINDOW_MS = 45 * 86_400_000;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  return json(getMarketAssistantStatus());
}

function parseMessages(value: unknown): AssistantMessage[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) return null;
  const messages: AssistantMessage[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    if (record.role !== "user" && record.role !== "assistant") return null;
    if (typeof record.content !== "string" || !record.content.trim() || record.content.length > MAX_MESSAGE_CHARACTERS) return null;
    messages.push({ role: record.role, content: record.content });
  }
  return messages;
}

/** Server-side tool executor: bound to public Coinbase data only. */
async function executeAssistantTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const symbol = typeof args.symbol === "string" ? args.symbol : null;
  if (!symbol || !USD_WATCHLIST.some(({ productId }) => productId === symbol)) {
    return { error: "Unsupported public Coinbase USD symbol." };
  }
  const now = new Date();

  if (name === "get_public_quote") {
    const result = await coinbaseMarketData.getQuotes({ instruments: [symbol] });
    if (result.status !== "available") return { error: "Public Coinbase quote is unavailable." };
    const quote = result.data[0];
    if (!quote) return { error: "Public Coinbase quote is unavailable." };
    return {
      symbol,
      providerId: "coinbase-exchange",
      freshness: quote.provenance.freshness,
      observedAt: quote.provenance.observedAt,
      bid: quote.bid,
      ask: quote.ask,
    };
  }

  if (name === "get_public_rsi") {
    const candles = await coinbaseMarketData.getCandles({
      instrument: symbol,
      interval: "1d",
      from: new Date(now.getTime() - RSI_WINDOW_MS).toISOString(),
      to: now.toISOString(),
    });
    if (candles.status !== "available") return { error: "Public Coinbase history is unavailable." };
    const closed = candles.data.filter((candle) => Date.parse(candle.closeTime) <= now.getTime());
    const latest = closed.at(-1);
    if (!latest) return { error: "Public Coinbase daily candles are unavailable." };
    const rsi14 = calculateRsi(closed.map((candle) => Number(candle.close)), 14);
    if (rsi14 === null || !Number.isFinite(rsi14)) return { error: "RSI-14 is unavailable." };
    return { symbol, interval: "1d", observedAt: latest.closeTime, rsi14: Number(rsi14.toFixed(4)) };
  }

  return { error: `Unknown tool: ${name}` };
}

export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415);
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return json({ error: "Invalid assistant request." }, 400);
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413);

  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return json({ error: "Invalid JSON request." }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ error: "A messages array is required." }, 400);
  }
  const messages = parseMessages((body as Record<string, unknown>).messages);
  if (!messages) return json({ error: "Provide 1–12 chat messages of up to 2000 characters each." }, 400);

  const configuration = getMarketAssistantStatus();
  if (!configuration.modelConfigured) return json({ status: "unconfigured", configuration }, 503);

  try {
    return json(await askMarketAssistant(messages, executeAssistantTool));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "The assistant request failed." }, 502);
  }
}
