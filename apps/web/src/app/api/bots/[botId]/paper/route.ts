import { evaluateBacktestGate } from "@/lib/bot-builder/state-machine";
import { BACKTEST_WINDOW_DAYS, runRsiBacktest, validateBacktestRequest } from "@/lib/backtesting/rsi-backtester";
import { coinbaseMarketData } from "@/lib/market-data/coinbase-service";
import { getPaperTradingView } from "@/lib/paper-trading/engine";
import { isExactObject, isPaperRuntimeAvailable, isPaperSessionId, isSameOriginPaperWrite, paperJson, readPaperJson } from "@/lib/paper-trading/api";
import { paperTradingStore } from "@/lib/paper-trading/store";

export async function POST(request: Request, { params }: RouteContext<"/api/bots/[botId]/paper">) {
  if (!isPaperRuntimeAvailable()) return paperJson({ error: "PAPER store is process-local and is disabled in production." }, 503);
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
  if (bot.paperState !== "DRAFT") return paperJson({ error: "Only a draft strategy can enter paper mode." }, 409);

  const now = new Date();
  const windowEnd = new Date(now);
  windowEnd.setUTCHours(23, 59, 59, 999);
  const windowStart = new Date(windowEnd.getTime() - BACKTEST_WINDOW_DAYS * 86_400_000);
  windowStart.setUTCHours(0, 0, 0, 0);
  const assumptions = validateBacktestRequest({
    symbol: bot.paperConfig.symbol,
    initialCapitalUsd: bot.paperConfig.budgetCapUsd,
    maxTradeSizeUsd: bot.paperConfig.maxTradeSizeUsd,
    stopLossPercent: bot.paperConfig.stopLossPercent,
    dailyLossHaltPercent: bot.paperConfig.dailyLossHaltPercent,
    feeBps: bot.paperConfig.feeBps,
    slippageBps: bot.paperConfig.slippageBps,
    buyRsiBelow: bot.paperConfig.buyRsiBelow,
    sellRsiAbove: bot.paperConfig.sellRsiAbove,
  });
  if (!assumptions.valid) return paperJson({ error: "Paper strategy assumptions failed server validation." }, 400);

  try {
    const history = await coinbaseMarketData.getCandles({
      instrument: bot.paperConfig.symbol,
      interval: "1d",
      from: windowStart.toISOString(),
      to: windowEnd.toISOString(),
    });
    if (history.status !== "available") return paperJson({ error: "Full-period public Coinbase history is unavailable; paper state was not changed." }, 503);
    const backtest = runRsiBacktest(assumptions.value, history.data, now);
    const gate = evaluateBacktestGate(bot.paperConfig, backtest);
    if (!gate.passed) return paperJson({ paperMode: "PAPER", paperBacktestPassed: false, paperBacktestReasons: gate.reasons }, 422);

    const activated = await paperTradingStore.activatePaperBot(paperSessionId, botId, now);
    if (!activated) return paperJson({ error: "Paper bot was not found." }, 404);
    const paperView = await getPaperTradingView(paperSessionId, botId);
    return paperJson({ paperMode: "PAPER", paperBacktestPassed: true, paperState: "PAPER", paperView }, 200);
  } catch {
    return paperJson({ error: "Full-period paper backtest could not be verified; paper state was not changed." }, 422);
  }
}