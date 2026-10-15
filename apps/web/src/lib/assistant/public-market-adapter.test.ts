import assert from "node:assert/strict";
import test from "node:test";
import { askMarketAssistant, getMarketAssistantStatus } from "@/lib/assistant/public-market-adapter";

test("adapter is enabled but never calls a model without access configuration", async () => {
  const env = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
  let fetchCalled = false;
  assert.deepEqual(getMarketAssistantStatus(env), {
    adapterEnabled: true,
    target: "Vercel AI Gateway",
    modelConfigured: false,
    model: null,
  });
  const result = await askMarketAssistant([{ role: "user", content: "hi" }], async () => ({}), async () => {
    fetchCalled = true;
    return Response.json({});
  }, env);
  assert.equal(result.status, "unconfigured");
  assert.equal(fetchCalled, false);
});

test("configured assistant offers tools and completes the tool loop before answering", async () => {
  const env = {
    NODE_ENV: "test",
    AI_GATEWAY_API_KEY: "test-only-placeholder",
    AI_GATEWAY_MODEL: "provider/public-model",
  } as NodeJS.ProcessEnv;

  const payloads: Record<string, unknown>[] = [];
  const executed: string[] = [];
  let call = 0;

  const result = await askMarketAssistant([{ role: "user", content: "What is the BTC-USD RSI-14?" }], async (name, args) => {
    executed.push(name);
    assert.deepEqual(args, { symbol: "BTC-USD" });
    return { symbol: "BTC-USD", interval: "1d", rsi14: 44.5 };
  }, async (_input, init) => {
    payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    call += 1;
    if (call === 1) {
      return Response.json({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "get_public_rsi", arguments: JSON.stringify({ symbol: "BTC-USD" }) },
            }],
          },
        }],
      });
    }
    return Response.json({ choices: [{ message: { content: "RSI-14 is 44.5." } }] });
  }, env);

  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.reply, "RSI-14 is 44.5.");
  assert.deepEqual(result.toolCalls, ["get_public_rsi"]);
  assert.deepEqual(executed, ["get_public_rsi"]);
  assert.equal(Array.isArray(payloads[0]!.tools), true);
  assert.equal(payloads[0]!.tool_choice, "auto");
  const secondRoundMessages = payloads[1]!.messages as Array<{ role: string }>;
  assert.equal(secondRoundMessages.some((message) => message.role === "tool"), true);
  assert.equal(payloads[0]!.messages && JSON.stringify(payloads[0]!.messages).includes("No tools are available"), false);
});
