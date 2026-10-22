import assert from "node:assert/strict";
import test from "node:test";
import {
  aiProviders,
  describeProviders,
  providerCostMicros,
  providerUnitKind,
  type AiProvider,
} from "@/lib/ai/provider";
import {
  AiRouteUnavailableError,
  createRoutedAssistantTransport,
  planAiRoute,
  runAiTextTask,
  runResearchExtract,
  runResearchSearch,
  validateAiRoutingSettings,
  type AiRoutingSettings,
} from "@/lib/ai/router";
import {
  readAiUsageReport,
  summarizeAiUsage,
  type AiMeterStore,
  type AiRequestInput,
  type AiRequestRow,
} from "@/lib/ai/meter";

/**
 * Phase 27's claims, as arithmetic rather than adjectives.
 *
 * Three things are asserted here that a screenshot cannot prove: a retryable failure moves to
 * the next target *and says so in the meter*, the costs page's total is the sum of the rows
 * it was built from, and a key is never present in anything the settings surface can return.
 * The provider `fetch` is replaced, so this runs without a network or a provider account.
 */

function inMemoryMeter() {
  const rows: AiRequestRow[] = [];
  let sequence = 0;
  const store: AiMeterStore = {
    async insert(input: AiRequestInput) {
      sequence += 1;
      rows.push({ ...input, id: `row-${sequence}`, createdAt: new Date(Date.UTC(2026, 9, 19, 12, 0, sequence)) });
    },
    async list(from, to) {
      return rows.filter((row) => row.createdAt >= from && row.createdAt <= to);
    },
  };
  return { store, rows };
}

const ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  CHAINGPT_API_KEY: "chain-key-value",
  AI_GATEWAY_API_KEY: "gateway-key-value",
  AI_GATEWAY_INPUT_USD_PER_MTOK: "1",
  AI_GATEWAY_OUTPUT_USD_PER_MTOK: "2",
  CHAINGPT_USD_PER_REQUEST: "0.01",
};

const SETTINGS: AiRoutingSettings = {
  currency: "USD",
  usdPerCurrencyUnit: "1",
  monthlyBudgetUsd: null,
  routes: {
    assistant: [{ providerId: "ai-gateway", model: "gateway-model" }],
    research: [{ providerId: "tavily", model: null }],
    strategy: [
      { providerId: "chaingpt", model: "general_assistant" },
      { providerId: "ai-gateway", model: "gateway-model" },
    ],
    "admin-probe": [
      { providerId: "chaingpt", model: "general_assistant" },
      { providerId: "ai-gateway", model: "gateway-model" },
    ],
  },
};

function gatewayBody(text: string, inputTokens = 100, outputTokens = 50) {
  return {
    choices: [{ message: { role: "assistant", content: text } }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("a retryable failure falls back in order and the fallback is recorded", async () => {
  const meter = inMemoryMeter();
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("chaingpt.org")) return jsonResponse({ error: "upstream exploded" }, 500);
    return jsonResponse(gatewayBody("answered by the fallback"));
  };

  const run = await runAiTextTask({
    feature: "admin-probe",
    userId: "user-1",
    messages: [{ role: "user", content: "Is the venue open?" }],
    settings: SETTINGS,
    env: ENV,
    fetcher,
    store: meter.store,
  });

  assert.equal(run.providerId, "ai-gateway");
  assert.equal(run.text, "answered by the fallback");
  assert.equal(run.fallbackFrom, "chaingpt:general_assistant");
  assert.deepEqual(calls.map((url) => new URL(url).host), ["api.chaingpt.org", "ai-gateway.vercel.sh"]);

  // Two attempts, two rows: the failure that says why, and the success that names it.
  assert.equal(meter.rows.length, 2);
  assert.equal(meter.rows[0].providerId, "chaingpt");
  assert.equal(meter.rows[0].outcome, "FAILED");
  assert.equal(meter.rows[0].errorCode, "server");
  assert.equal(meter.rows[0].costMicrosUsd, null);
  assert.equal(meter.rows[1].providerId, "ai-gateway");
  assert.equal(meter.rows[1].outcome, "SUCCESS");
  assert.equal(meter.rows[1].fallbackFrom, "chaingpt:general_assistant");
  assert.equal(meter.rows[1].feature, "admin-probe");
  assert.equal(meter.rows[1].userId, "user-1");
  // 100 input tokens at $1/Mtok + 50 output at $2/Mtok = 200 micro-dollars.
  assert.equal(meter.rows[1].costMicrosUsd, 200);
});

test("the usage report's totals are the sum of the recorded per-request costs", async () => {
  const meter = inMemoryMeter();
  let call = 0;
  const fetcher: typeof fetch = async () => {
    call += 1;
    return jsonResponse(gatewayBody(`answer ${call}`, 1_000, 500));
  };

  for (const feature of ["admin-probe", "strategy"] as const) {
    await runAiTextTask({
      feature,
      userId: "user-1",
      messages: [{ role: "user", content: "question" }],
      settings: {
        ...SETTINGS,
        // Both features answered by one provider, so the sum is comparable row by row.
        routes: { ...SETTINGS.routes, [feature]: [{ providerId: "ai-gateway", model: "gateway-model" }] },
      },
      env: ENV,
      fetcher,
      store: meter.store,
    });
  }

  const from = new Date(Date.UTC(2026, 9, 1));
  const to = new Date(Date.UTC(2026, 10, 1));
  const report = await readAiUsageReport({
    from,
    to,
    currency: "USD",
    usdPerCurrencyUnit: "1",
    monthlyBudgetUsd: null,
    store: meter.store,
  });

  assert.ok(report);
  const expected = meter.rows.reduce((sum, row) => sum + (row.costMicrosUsd ?? 0), 0);
  assert.equal(report.totals.costMicrosUsd, expected);
  assert.equal(report.totals.requests, 2);
  assert.equal(report.totals.pricedRequests, 2);
  assert.equal(report.totals.unpricedRequests, 0);
  assert.equal(report.byFeature.length, 2);
  assert.equal(report.byFeature.reduce((sum, entry) => sum + entry.costMicrosUsd, 0), expected);
  assert.deepEqual(report.byUser.map((entry) => entry.key), ["user-1"]);
});

test("a budget is a reported signal, never an enforced cap", async () => {
  const report = summarizeAiUsage({
    rows: [
      {
        id: "row-1",
        userId: "user-1",
        feature: "assistant",
        task: "text",
        providerId: "ai-gateway",
        model: "gateway-model",
        outcome: "SUCCESS",
        errorCode: null,
        inputTokens: 1_000,
        outputTokens: 500,
        units: 1_500,
        unitKind: "tokens",
        durationMs: 120,
        costMicrosUsd: 2_000,
        currency: "USD",
        fallbackFrom: null,
        createdAt: new Date(Date.UTC(2026, 9, 19)),
      },
    ],
    from: new Date(Date.UTC(2026, 9, 1)),
    to: new Date(Date.UTC(2026, 10, 1)),
    currency: "USD",
    usdPerCurrencyUnit: "1",
    monthlyBudgetUsd: "0.001",
  });

  assert.equal(report.budget.overBudget, true);
  assert.equal(report.budget.monthlyBudgetMicrosUsd, 1_000);
  assert.equal(report.totals.costMicrosUsd, 2_000);
  assert.match(report.budget.note, /never a cap|does not refuse/);
});

test("switching the route's model changes the provider the next request uses", async () => {
  const seen: { host: string; model: string }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {};
    seen.push({ host: new URL(url).host, model: body.model ?? "" });
    if (url.includes("chaingpt.org")) {
      return jsonResponse({ data: { bot: "answered by ChainGPT" } });
    }
    return jsonResponse(gatewayBody("answered by the gateway"));
  };

  const meter = inMemoryMeter();
  const first = await runAiTextTask({
    feature: "strategy",
    userId: "user-1",
    messages: [{ role: "user", content: "draft a plan" }],
    settings: SETTINGS,
    env: ENV,
    fetcher,
    store: meter.store,
  });

  const switched: AiRoutingSettings = {
    ...SETTINGS,
    routes: { ...SETTINGS.routes, strategy: [{ providerId: "ai-gateway", model: "other-gateway-model" }] },
  };
  const second = await runAiTextTask({
    feature: "strategy",
    userId: "user-1",
    messages: [{ role: "user", content: "draft a plan" }],
    settings: switched,
    env: ENV,
    fetcher,
    store: meter.store,
  });

  assert.equal(first.providerId, "chaingpt");
  assert.equal(second.providerId, "ai-gateway");
  assert.equal(second.model, "other-gateway-model");
  assert.deepEqual(seen, [
    { host: "api.chaingpt.org", model: "general_assistant" },
    { host: "ai-gateway.vercel.sh", model: "other-gateway-model" },
  ]);
  assert.equal(meter.rows[1].model, "other-gateway-model");
});

test("with every key absent the failure names the variable to set", async () => {
  const meter = inMemoryMeter();
  const emptyEnv: NodeJS.ProcessEnv = { NODE_ENV: "test" };

  const plan = await planAiRoute("assistant", SETTINGS, emptyEnv);
  assert.equal(plan.candidates.length, 0);
  assert.deepEqual(plan.missingKeys, ["AI_GATEWAY_API_KEY"]);
  assert.match(plan.skipped[0].reason, /AI_GATEWAY_API_KEY is not set/);

  await assert.rejects(
    () =>
      runAiTextTask({
        feature: "assistant",
        userId: "user-1",
        messages: [{ role: "user", content: "hello" }],
        settings: SETTINGS,
        env: emptyEnv,
        store: meter.store,
      }),
    (error: unknown) =>
      error instanceof AiRouteUnavailableError &&
      /AI_GATEWAY_API_KEY/.test(error.message) &&
      error.missingKeys.includes("AI_GATEWAY_API_KEY"),
  );
  assert.equal(meter.rows.length, 0);
});

test("a provider without the required capabilities is skipped, not asked", async () => {
  await assert.rejects(
    async () => {
      const validation = validateAiRoutingSettings({
        ...SETTINGS,
        routes: { ...SETTINGS.routes, assistant: [{ providerId: "chaingpt", model: "general_assistant" }] },
      });
      assert.equal(validation.valid, false);
      if (!validation.valid) throw new Error(validation.error);
    },
    /cannot carry the assistant's tool calls/,
  );

  // A stored document that somehow names it is still skipped at plan time, with a reason.
  const plan = await planAiRoute(
    "assistant",
    { ...SETTINGS, routes: { ...SETTINGS.routes, assistant: [{ providerId: "chaingpt", model: "general_assistant" }] } },
    ENV,
  );
  assert.equal(plan.candidates.length, 0);
  assert.match(plan.skipped[0].reason, /does not support tools/);
});

test("the assistant's transport falls back before the first delta and records both attempts", async () => {
  const meter = inMemoryMeter();
  const answered: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {};
    if (body.model === "primary-model") return jsonResponse({ error: "down" }, 503);
    return jsonResponse(gatewayBody("second provider answered", 20, 10));
  };

  const settings: AiRoutingSettings = {
    ...SETTINGS,
    routes: {
      ...SETTINGS.routes,
      assistant: [
        { providerId: "ai-gateway", model: "primary-model" },
        { providerId: "ai-gateway", model: "backup-model" },
      ],
    },
  };
  const plan = await planAiRoute("assistant", settings, ENV);
  const transport = createRoutedAssistantTransport({
    plan,
    feature: "assistant",
    userId: "user-1",
    settings,
    env: ENV,
    fetcher,
    store: meter.store,
    onAnswered: (target) => answered.push(target.label),
  });

  const round = await transport.complete([{ role: "user", content: "hello" }], []);
  assert.equal(round.content, "second provider answered");
  assert.deepEqual(answered, ["ai-gateway:backup-model"]);
  assert.equal(meter.rows.length, 2);
  assert.equal(meter.rows[0].model, "primary-model");
  assert.equal(meter.rows[0].outcome, "FAILED");
  assert.equal(meter.rows[1].model, "backup-model");
  assert.equal(meter.rows[1].fallbackFrom, "ai-gateway:primary-model");
});

test("a broken primary key falls back, because the key belongs to that provider", async () => {
  const meter = inMemoryMeter();
  const fetcher: typeof fetch = async (input) => {
    if (String(input).includes("ai-gateway")) return jsonResponse({ error: "invalid api key" }, 401);
    return jsonResponse({ data: { bot: "the second provider answered" } });
  };

  const run = await runAiTextTask({
    feature: "admin-probe",
    userId: "user-1",
    messages: [{ role: "user", content: "probe" }],
    settings: {
      ...SETTINGS,
      routes: {
        ...SETTINGS.routes,
        "admin-probe": [
          { providerId: "ai-gateway", model: "gateway-model" },
          { providerId: "chaingpt", model: "general_assistant" },
        ],
      },
    },
    env: ENV,
    fetcher,
    store: meter.store,
  });

  assert.equal(run.providerId, "chaingpt");
  assert.equal(run.fallbackFrom, "ai-gateway:gateway-model");
  assert.equal(meter.rows[0].errorCode, "auth");
  assert.equal(meter.rows[1].fallbackFrom, "ai-gateway:gateway-model");
});

test("a rejected request is not retried at a second provider", async () => {
  const meter = inMemoryMeter();
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return jsonResponse({ error: "bad model id" }, 400);
  };

  await assert.rejects(
    () =>
      runAiTextTask({
        feature: "admin-probe",
        userId: "user-1",
        messages: [{ role: "user", content: "hello" }],
        settings: SETTINGS,
        env: ENV,
        fetcher,
        store: meter.store,
      }),
    AiRouteUnavailableError,
  );

  assert.equal(calls, 1);
  assert.equal(meter.rows.length, 1);
  assert.equal(meter.rows[0].errorCode, "invalid");
  assert.equal(meter.rows[0].fallbackFrom, null);
});

test("no key value appears in what the settings surface returns", async () => {
  const keys = ["chain-key-value", "gateway-key-value"];
  const described = JSON.stringify(describeProviders(ENV));
  for (const key of keys) assert.equal(described.includes(key), false);
  // The variable name is the thing the panel is allowed to say.
  assert.match(described, /AI_GATEWAY_API_KEY/);
  assert.match(described, /CHAINGPT_API_KEY/);

  const meter = inMemoryMeter();
  const fetcher: typeof fetch = async () => jsonResponse(gatewayBody("hello"));
  await runAiTextTask({
    feature: "strategy",
    userId: "user-1",
    messages: [{ role: "user", content: "hi" }],
    settings: { ...SETTINGS, routes: { ...SETTINGS.routes, strategy: [{ providerId: "ai-gateway", model: "m" }] } },
    env: ENV,
    fetcher,
    store: meter.store,
  });
  const serializedRows = JSON.stringify(meter.rows);
  for (const key of keys) assert.equal(serializedRows.includes(key), false);
});

test("research search and extract are metered through the same route", async () => {
  const meter = inMemoryMeter();
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (url.endsWith("/search")) {
      assert.equal(body.query, "bitcoin");
      return jsonResponse({
        results: [{ title: "A source", url: "https://coindesk.com/a", content: "text", score: 0.5, published_date: null }],
      });
    }
    return jsonResponse({ results: [{ url: "https://coindesk.com/a", raw_content: "hello" }], failed_results: [] });
  }) as typeof fetch;

  try {
    const results = await runResearchSearch({
      feature: "research",
      userId: "user-1",
      query: "bitcoin",
      topic: "news",
      settings: SETTINGS,
      env: ENV,
      store: meter.store,
    });
    assert.equal(results.length, 1);

    const extracted = await runResearchExtract({
      feature: "research",
      userId: "user-1",
      urls: ["https://coindesk.com/a"],
      settings: SETTINGS,
      env: ENV,
      store: meter.store,
    });
    assert.equal(extracted.results.length, 1);
  } finally {
    globalThis.fetch = original;
  }

  assert.deepEqual(calls.map((url) => new URL(url).host), ["api.tavily.com", "api.tavily.com"]);
  assert.equal(meter.rows.length, 2);
  assert.equal(meter.rows[0].providerId, "tavily");
  assert.equal(meter.rows[0].feature, "research");
  assert.equal(meter.rows[0].task, "search");
  assert.equal(meter.rows[0].costMicrosUsd, 0);
  assert.equal(meter.rows[1].task, "extract");
  assert.equal(meter.rows[1].units, 1);
  assert.equal(meter.rows[1].userId, "user-1");
});

test("provider cost models price tokens and requests as declared", () => {
  const providers = aiProviders(ENV);
  const gateway = providers.find((provider) => provider.id === "ai-gateway") as AiProvider;
  const chainGpt = providers.find((provider) => provider.id === "chaingpt") as AiProvider;
  const tavily = providers.find((provider) => provider.id === "tavily") as AiProvider;

  assert.equal(providerCostMicros(gateway, { inputTokens: 1_000_000, outputTokens: 0, requests: 1 }), 1_000_000);
  assert.equal(providerCostMicros(chainGpt, { inputTokens: 0, outputTokens: 0, requests: 2 }), 20_000);
  assert.equal(providerCostMicros(tavily, { inputTokens: 0, outputTokens: 0, requests: 3 }), 0);
  assert.equal(providerUnitKind(gateway), "tokens");
  assert.equal(providerUnitKind(chainGpt), "requests");

  // An unconfigured rate is unknown, never zero.
  const unpriced = aiProviders({ NODE_ENV: "test" }).find((provider) => provider.id === "chaingpt") as AiProvider;
  assert.equal(providerCostMicros(unpriced, { inputTokens: 0, outputTokens: 0, requests: 1 }), null);
});
