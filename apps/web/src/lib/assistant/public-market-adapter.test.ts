import assert from "node:assert/strict";
import test from "node:test";
import {
  askMarketAssistant,
  createMarketAssistantTransport,
  getMarketAssistantStatus,
  runMarketAssistant,
} from "@/lib/assistant/public-market-adapter";
import { AssistantStreamError } from "@/lib/assistant/loop";
import { withRedactedToolResults } from "@/lib/assistant/citations";

/**
 * The model adapter: what it will do without configuration, what it sends when it has it,
 * and what a broken stream looks like.
 *
 * The streaming tests drive the same transport the route uses (`createGatewayTransport`
 * through `createMarketAssistantTransport`) with a stub `fetch` that speaks the gateway's
 * own server-sent events, so the parser is exercised against the wire format rather than
 * against a shape invented here.
 */

const CONFIGURED = {
  NODE_ENV: "test",
  AI_GATEWAY_API_KEY: "test-only-placeholder",
  AI_GATEWAY_MODEL: "provider/public-model",
} as NodeJS.ProcessEnv;

function sse(chunks: readonly string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function delta(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** One fragment of a streamed tool call, as the gateway sends them. */
function toolDelta(index: number, fn: { name?: string; arguments?: string }, id?: string): string {
  return delta({
    choices: [{ delta: { tool_calls: [{ index, ...(id ? { id } : {}), function: fn }] } }],
  });
}

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
  const payloads: Record<string, unknown>[] = [];
  const executed: string[] = [];
  let call = 0;

  const result = await askMarketAssistant([{ role: "user", content: "What is the BTC-USD RSI-14?" }], async (name, args) => {
    executed.push(name);
    assert.deepEqual(args, { symbol: "BTC-USD" });
    return { ok: true, data: { symbol: "BTC-USD", interval: "1d", rsi14: 44.5 } };
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
              function: { name: "get_market_indicator", arguments: JSON.stringify({ symbol: "BTC-USD" }) },
            }],
          },
        }],
        usage: { prompt_tokens: 120, completion_tokens: 20 },
      });
    }
    return Response.json({ choices: [{ message: { content: "RSI-14 is 44.5." } }], usage: { prompt_tokens: 200, completion_tokens: 30 } });
  }, CONFIGURED);

  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.reply, "RSI-14 is 44.5.");
  assert.deepEqual(result.toolCalls, ["get_market_indicator"]);
  assert.deepEqual(executed, ["get_market_indicator"]);
  assert.deepEqual(result.usage, { inputTokens: 320, outputTokens: 50 });
  assert.equal(Array.isArray(payloads[0]!.tools), true);
  assert.equal(payloads[0]!.tool_choice, "auto");
  assert.equal(payloads[0]!.stream, false);
  const secondRoundMessages = payloads[1]!.messages as Array<{ role: string }>;
  assert.equal(secondRoundMessages.some((message) => message.role === "tool"), true);
  assert.equal(payloads[0]!.messages && JSON.stringify(payloads[0]!.messages).includes("No tools are available"), false);
});

test("the streaming transport reports text as it arrives, executes the tool, then finishes", async () => {
  let call = 0;
  const seen: { name: string; args: Record<string, unknown> }[] = [];
  const deltas: string[] = [];
  const events: string[] = [];

  const transport = createMarketAssistantTransport({
    model: "provider/public-model",
    authorization: "test-only-placeholder",
    env: CONFIGURED,
    fetcher: (async (_input: string | URL | Request, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        // The tool call arrives the way the gateway sends it: the name whole in the first
        // chunk, then the arguments in fragments that have to be joined.
        return sse([
          toolDelta(0, { name: "get_market_indicator" }, "call_1"),
          toolDelta(0, { arguments: '{"symbol":' }),
          toolDelta(0, { arguments: '"BTC-USD"}' }),
          delta({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 60, completion_tokens: 12 } }),
          "data: [DONE]\n\n",
        ]);
      }
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string }>; stream: boolean; stream_options?: unknown };
      assert.equal(body.stream, true);
      assert.equal(JSON.stringify(body.stream_options), JSON.stringify({ include_usage: true }));
      // The tool result reached the second round, as a tool message.
      assert.equal(body.messages.some((message) => message.role === "tool"), true);
      return sse([
        delta({ choices: [{ delta: { content: "RSI-14 is " } }] }),
        delta({ choices: [{ delta: { content: "44.5." } }] }),
        delta({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 90, completion_tokens: 8 } }),
        "data: [DONE]\n\n",
      ]);
    }) as typeof fetch,
  });

  const result = await runMarketAssistant({
    messages: [{ role: "user", content: "What is the BTC-USD RSI-14?" }],
    transport,
    executeTool: async (name, args) => {
      seen.push({ name, args });
      return { ok: true, data: { symbol: "BTC-USD", interval: "1d", rsi14: 44.5 } };
    },
    onEvent: (event) => {
      events.push(event.type);
      if (event.type === "delta") deltas.push(event.text);
    },
  });

  assert.equal(result.reply, "RSI-14 is 44.5.");
  assert.deepEqual(deltas, ["RSI-14 is ", "44.5."], "each chunk was reported as it arrived");
  assert.deepEqual(seen, [{ name: "get_market_indicator", args: { symbol: "BTC-USD" } }]);
  assert.deepEqual(events.slice(0, 3), ["usage", "tool", "tool"], "the round's cost is reported, then the tool it asked for");
  assert.equal(events.indexOf("delta") > events.lastIndexOf("tool"), true, "the answer's text comes after the tool ran");
  assert.equal(events.filter((type) => type === "usage").length, 2, "each round's usage was reported");
  assert.deepEqual(result.usage, { inputTokens: 150, outputTokens: 20 });
});

test("a stream that breaks mid-answer keeps what arrived and says the answer is incomplete", async () => {
  const transport = createMarketAssistantTransport({
    model: "provider/public-model",
    authorization: "test-only-placeholder",
    env: CONFIGURED,
    fetcher: (async () => sse([
      delta({ choices: [{ delta: { content: "Your balance is " } }] }),
      delta({ choices: [{ delta: { content: "20" } }] }),
      // The provider dies here: no finish_reason, no [DONE].
    ])) as typeof fetch,
  });

  const deltas: string[] = [];
  await assert.rejects(
    () => runMarketAssistant({
      messages: [{ role: "user", content: "What is my balance?" }],
      transport,
      executeTool: async () => ({ ok: true, data: {} }),
      onEvent: (event) => {
        if (event.type === "delta") deltas.push(event.text);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AssistantStreamError, "a broken stream is its own error type");
      assert.match(error.message, /before the answer was complete/);
      assert.equal(error.partial, "Your balance is 20", "the text that arrived is carried out with the error");
      return true;
    },
  );
  assert.deepEqual(deltas, ["Your balance is ", "20"], "the reader already saw the partial answer");
});

test("a credential pasted into a message is redacted before it is sent, and a tool result too", async () => {
  const secret = "sk-live-abcdefghijklmnopqrstuvwxyz";
  const payloads: string[] = [];
  const call = { count: 0 };

  await askMarketAssistant(
    [{ role: "user", content: `My key is ${secret} — what is my balance?` }],
    // The same wrapper the route applies, so this test covers the composition rather
    // than a redaction the test itself performed.
    withRedactedToolResults(async () => ({
      ok: true,
      // A tool result that happens to carry a token-shaped value, as a provider echo might.
      data: { memo: `paid with Bearer ${secret}`, asset: "USDT" },
    })),
    async (_input, init) => {
      payloads.push(String(init?.body));
      call.count += 1;
      if (call.count === 1) {
        return Response.json({
          choices: [{ message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_account_balance", arguments: "{}" } }] } }],
        });
      }
      return Response.json({ choices: [{ message: { content: "I could not state a balance from that." } }] });
    },
    CONFIGURED,
  );

  assert.equal(payloads.length, 2);
  for (const payload of payloads) {
    assert.equal(payload.includes(secret), false, "no key reached the provider");
  }
  assert.match(payloads[0]!, /\[redacted\]/);
  // Both halves: the user's message and the tool result that went back to the model.
  assert.match(payloads[1]!, /\[redacted\]/);
  assert.equal(payloads[1]!.includes("paid with"), true, "the rest of the result survived");
});

test("a model that asks for tools forever is stopped with a sentence", async () => {
  let call = 0;
  const result = await askMarketAssistant([{ role: "user", content: "loop forever" }], async () => ({ ok: true, data: {} }), async () => {
    call += 1;
    return Response.json({
      choices: [{ message: { content: null, tool_calls: [{ id: `call_${call}`, type: "function", function: { name: "get_market_quote", arguments: '{"symbol":"BTC-USD"}' } }] } }],
    });
  }, CONFIGURED).catch((error: unknown) => error);

  assert.ok(result instanceof Error);
  assert.match(result.message, /more than 4 times/);
  assert.equal(call, 4, "the provider was asked four times and no more");
});
