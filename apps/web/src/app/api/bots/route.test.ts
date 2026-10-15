import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { GET, POST } from "@/app/api/bots/route";
import { POST as killBot } from "@/app/api/bots/[botId]/kill/route";

const config = {
  name: "API paper test",
  description: "Session isolation",
  symbol: "BTC-USD",
  schedule: "DAILY_CLOSE",
  budgetCapUsd: "10000.29",
  maxTradeSizeUsd: "2500",
  stopLossPercent: "4",
  dailyLossHaltPercent: "2",
  feeBps: "10",
  slippageBps: "5",
  buyRsiBelow: "30",
  sellRsiAbove: "70",
  maxDrawdownGatePercent: "20",
  minWinRateGatePercent: "0",
  minProfitFactorGate: "0.1",
};

test("paper bot API isolates sessions and requires same-origin mutation requests", async () => {
  const paperSessionId = randomUUID();
  const createResponse = await POST(new Request("https://veylora.example/api/bots", {
    method: "POST",
    headers: { Origin: "https://veylora.example", "Content-Type": "application/json" },
    body: JSON.stringify({ paperSessionId, paperConfig: config }),
  }));
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as { paperMode: string; paperBot: { paperMode: string; paperBotId: string; paperConfig: Record<string, unknown>; paperCashBalanceCents: number | null } };
  assert.equal(created.paperMode, "PAPER");
  assert.equal(created.paperBot.paperMode, "PAPER");
  assert.equal(created.paperBot.paperCashBalanceCents, null);
  assert.ok(Object.keys(created.paperBot.paperConfig).every((key) => key.startsWith("paper")));

  const listed = await GET(new Request(`https://veylora.example/api/bots?paperSessionId=${paperSessionId}`));
  const listBody = await listed.json() as { paperBots: Array<{ paperBotId: string }> };
  assert.equal(listBody.paperBots.length, 1);
  assert.equal(listBody.paperBots[0]?.paperBotId, created.paperBot.paperBotId);

  const hidden = await GET(new Request(`https://veylora.example/api/bots?paperSessionId=${randomUUID()}`));
  assert.deepEqual((await hidden.json()).paperBots, []);

  const crossOriginWrite = await POST(new Request("https://veylora.example/api/bots", {
    method: "POST",
    headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: JSON.stringify({ paperSessionId, paperConfig: config }),
  }));
  assert.equal(crossOriginWrite.status, 403);

  const killed = await killBot(new Request(`https://veylora.example/api/bots/${created.paperBot.paperBotId}/kill`, {
    method: "POST",
    headers: { Origin: "https://veylora.example", "Content-Type": "application/json" },
    body: JSON.stringify({ paperSessionId }),
  }), { params: Promise.resolve({ botId: created.paperBot.paperBotId }) });
  assert.equal(killed.status, 200);
  assert.equal((await killed.json()).paperState, "KILLED");
});