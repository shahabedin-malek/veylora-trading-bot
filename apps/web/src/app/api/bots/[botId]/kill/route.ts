import { getPaperTradingView } from "@/lib/paper-trading/engine";
import { isExactObject, isPaperRuntimeAvailable, isPaperSessionId, isSameOriginPaperWrite, paperJson, readPaperJson } from "@/lib/paper-trading/api";
import { paperTradingStore } from "@/lib/paper-trading/store";

export async function POST(request: Request, { params }: RouteContext<"/api/bots/[botId]/kill">) {
  if (!isPaperRuntimeAvailable()) return paperJson({ error: "The PAPER store is process-local, so it is not available on this deployment." }, 503);
  if (!isSameOriginPaperWrite(request)) return paperJson({ error: "Paper writes must be same-origin." }, 403);
  const { botId } = await params;
  const parsed = await readPaperJson(request);
  if ("response" in parsed) return parsed.response;
  if (!isExactObject(parsed.body, ["paperSessionId"]) || !isPaperSessionId(parsed.body.paperSessionId)) {
    return paperJson({ error: "A valid paper session is required." }, 400);
  }
  const killed = await paperTradingStore.killPaperBot(parsed.body.paperSessionId, botId);
  if (!killed) return paperJson({ error: "Paper bot was not found." }, 404);
  const paperView = await getPaperTradingView(parsed.body.paperSessionId, botId);
  return paperJson({ paperMode: "PAPER", paperState: "KILLED", paperView });
}