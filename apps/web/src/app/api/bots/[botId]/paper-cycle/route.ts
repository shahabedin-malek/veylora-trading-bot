import { coinbaseMarketData } from "@/lib/market-data/coinbase-service";
import { runPaperCycle } from "@/lib/paper-trading/engine";
import { isExactObject, isPaperRuntimeAvailable, isPaperSessionId, isSameOriginPaperWrite, paperJson, readPaperJson } from "@/lib/paper-trading/api";
import { paperTradingStore } from "@/lib/paper-trading/store";

export async function POST(request: Request, { params }: RouteContext<"/api/bots/[botId]/paper-cycle">) {
  if (!isPaperRuntimeAvailable()) return paperJson({ error: "The PAPER store is process-local, so it is not available on this deployment." }, 503);
  if (!isSameOriginPaperWrite(request)) return paperJson({ error: "Paper writes must be same-origin." }, 403);
  const { botId } = await params;
  const parsed = await readPaperJson(request);
  if ("response" in parsed) return parsed.response;
  if (!isExactObject(parsed.body, ["paperSessionId"]) || !isPaperSessionId(parsed.body.paperSessionId)) {
    return paperJson({ error: "A valid paper session is required." }, 400);
  }
  const paperSessionId = parsed.body.paperSessionId;
  const bot = await paperTradingStore.getPaperBot(paperSessionId, botId);
  if (!bot) return paperJson({ error: "Paper bot was not found." }, 404);
  const now = new Date();
  const [quotes, candles] = await Promise.all([
    coinbaseMarketData.getQuotes({ instruments: [bot.paperConfig.symbol] }),
    coinbaseMarketData.getCandles({
      instrument: bot.paperConfig.symbol,
      interval: "1d",
      from: new Date(now.getTime() - 40 * 86_400_000).toISOString(),
      to: now.toISOString(),
    }),
  ]);
  if (quotes.status !== "available" || !quotes.data[0]) {
    return paperJson({ paperMode: "PAPER", paperStatus: "PAPER_MARKET_UNAVAILABLE", error: "Fresh Coinbase public quote unavailable; no paper fill was produced." }, 503);
  }
  const paperResult = await runPaperCycle(paperSessionId, botId, quotes.data[0], candles.status === "available" ? candles.data : [], now);
  if (!paperResult) return paperJson({ paperMode: "PAPER", paperStatus: "PAPER_MARKET_UNAVAILABLE", error: "Coinbase public quote was stale or invalid; no paper fill was produced." }, 503);
  return paperJson(paperResult);
}