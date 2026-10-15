import { validateBotConfiguration } from "@/lib/bot-builder/state-machine";
import { getPaperTradingView } from "@/lib/paper-trading/engine";
import { isExactObject, isPaperRuntimeAvailable, isPaperSessionId, isSameOriginPaperWrite, paperJson, readPaperJson } from "@/lib/paper-trading/api";
import { paperTradingStore, usdToIntegerCents } from "@/lib/paper-trading/store";

export async function GET(request: Request) {
  if (!isPaperRuntimeAvailable()) return paperJson({ error: "PAPER store is process-local and is disabled in production." }, 503);
  const paperSessionId = new URL(request.url).searchParams.get("paperSessionId");
  if (!isPaperSessionId(paperSessionId)) return paperJson({ error: "A valid paper session is required." }, 400);
  const bots = await paperTradingStore.listPaperBots(paperSessionId);
  const paperBots = await Promise.all(bots.map((bot) => getPaperTradingView(paperSessionId, bot.paperBotId)));
  return paperJson({ paperMode: "PAPER", paperBots: paperBots.filter((bot) => bot !== null) });
}

export async function POST(request: Request) {
  if (!isPaperRuntimeAvailable()) return paperJson({ error: "PAPER store is process-local and is disabled in production." }, 503);
  if (!isSameOriginPaperWrite(request)) return paperJson({ error: "Paper writes must be same-origin." }, 403);
  const parsed = await readPaperJson(request);
  if ("response" in parsed) return parsed.response;
  if (!isExactObject(parsed.body, ["paperSessionId", "paperConfig"]) || !isPaperSessionId(parsed.body.paperSessionId)) {
    return paperJson({ error: "A valid paper session and strategy configuration are required." }, 400);
  }
  const validation = validateBotConfiguration(parsed.body.paperConfig);
  if (!validation.valid) return paperJson({ paperMode: "PAPER", error: `Paper configuration rejected: ${validation.error}` }, 400);
  if (usdToIntegerCents(validation.value.budgetCapUsd) === null) {
    return paperJson({ error: "Paper budget must be an exact whole-cent amount." }, 400);
  }
  try {
    const bot = await paperTradingStore.createPaperBot(parsed.body.paperSessionId, validation.value);
    const paperView = await getPaperTradingView(parsed.body.paperSessionId, bot.paperBotId);
    return paperJson({ paperMode: "PAPER", paperBot: paperView }, 201);
  } catch {
    return paperJson({ error: "Paper draft could not be created." }, 400);
  }
}