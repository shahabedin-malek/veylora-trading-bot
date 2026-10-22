import assert from "node:assert/strict";
import test from "node:test";
import type { MarketCandle } from "@/lib/market-data/provider";
import { defaultFeeSchedule } from "@/lib/fees/table";
import { handleBacktestPost, startBacktestWindow } from "./route";

const requestBody = {
  symbol: "BTC-USD",
  initialCapitalUsd: "10000",
  feeBps: "10",
  slippageBps: "5",
  buyRsiBelow: "30",
  sellRsiAbove: "70",
};

const DEFINITION_TEXT = [
  'STRATEGY "Range rider"',
  "MARKET BTC-USD",
  "TIMEFRAME 1d",
  "ENTRY PRICE BELOW 95",
  "EXIT PRICE ABOVE 105",
  "SIZE 25% OF CAPITAL",
  "STOP NONE",
  "DAILY_HALT 20%",
  "LEVERAGE 1x",
].join("\n");

function dailyCandles(count = 60): MarketCandle[] {
  const start = Date.parse("2026-06-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + 12 * Math.sin(index / 8);
    const openTime = new Date(start + index * 86_400_000);
    const closeTime = new Date(openTime.getTime() + 86_400_000);
    return {
      instrument: { id: "BTC-USD", symbol: "BTC-USD", baseAsset: "BTC", quoteAsset: "USD" },
      interval: "1d",
      openTime: openTime.toISOString(),
      closeTime: closeTime.toISOString(),
      open: String(close.toFixed(4)),
      high: String((close + 1).toFixed(4)),
      low: String((close - 1).toFixed(4)),
      close: String(close.toFixed(4)),
      volume: "100",
      provenance: {
        providerId: "coinbase-exchange",
        providerName: "Coinbase Exchange",
        endpointOrigin: "https://api.exchange.coinbase.com",
        observedAt: closeTime.toISOString(),
        fetchedAt: new Date("2026-08-01T00:00:00.000Z").toISOString(),
        freshness: "DELAYED",
        responseHash: "fixture-only",
      },
    };
  });
}

function post(body: unknown, origin = "https://veylora.example"): Request {
  return new Request(`${origin}/api/backtest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  }) as never;
}

const available = async () => ({ status: "available" as const, data: dailyCandles() });

test("backtest route requests a fixed trailing 365-day daily-candle window", async () => {
  const now = new Date("2026-10-15T12:30:00.000Z");
  const window = startBacktestWindow(now);
  assert.ok(Date.parse(window.to) - Date.parse(window.from) >= 365 * 86_400_000 - 1);
  const response = await handleBacktestPost(new Request("https://veylora.example/api/backtest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  }), async (query) => {
    assert.equal(query.instrument, "BTC-USD");
    assert.equal(query.interval, "1d");
    assert.equal(query.from, window.from);
    assert.equal(query.to, window.to);
    return { status: "unavailable", reason: "provider-error", retryable: true };
  }, now);

  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /No backtest was produced/);
});

test("backtest route rejects caller-selected date windows and malformed assumptions", async () => {
  let fetchCalled = false;
  const response = await handleBacktestPost(new Request("https://veylora.example/api/backtest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...requestBody, from: "2026-01-01" }),
  }), async () => {
    fetchCalled = true;
    return { status: "unavailable", reason: "provider-error", retryable: true };
  });
  assert.equal(response.status, 400);
  assert.equal(fetchCalled, false);
});

test("a definition that cannot run is refused with its own problem before anything else happens", async () => {
  const response = await handleBacktestPost(
    post({ mode: "definition", definitionText: DEFINITION_TEXT.replace("PRICE BELOW 95", "MACD(12) BELOW 95"), initialCapitalUsd: "10000" }),
    available,
    new Date(),
  );
  assert.equal(response.status, 422);
  const payload = (await response.json()) as { issues?: string[] };
  assert.ok(payload.issues?.some((issue) => /Unknown indicator "MACD"/.test(issue)), JSON.stringify(payload));
});

test("a definition run without a usable auth configuration is a configuration gap, not a run", async () => {
  const previous = {
    chainIds: process.env.AUTH_EVM_CHAIN_IDS,
    appBaseUrl: process.env.APP_BASE_URL,
    sessionSecret: process.env.SESSION_SECRET,
  };
  delete process.env.AUTH_EVM_CHAIN_IDS;
  delete process.env.APP_BASE_URL;
  delete process.env.SESSION_SECRET;
  try {
    const response = await handleBacktestPost(
      post({ mode: "definition", definitionText: DEFINITION_TEXT, initialCapitalUsd: "10000" }),
      available,
      new Date(),
    );
    assert.equal(response.status, 503);
    assert.match(((await response.json()) as { error: string }).error, /APP_BASE_URL|AUTH_EVM_CHAIN_IDS|SESSION_SECRET/);
  } finally {
    if (previous.chainIds === undefined) delete process.env.AUTH_EVM_CHAIN_IDS;
    else process.env.AUTH_EVM_CHAIN_IDS = previous.chainIds;
    if (previous.appBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous.appBaseUrl;
    if (previous.sessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.sessionSecret;
  }
});

test("a definition run is costed from the fee table, versioned and recorded", async () => {
  const previous = {
    chainIds: process.env.AUTH_EVM_CHAIN_IDS,
    appBaseUrl: process.env.APP_BASE_URL,
    sessionSecret: process.env.SESSION_SECRET,
  };
  process.env.AUTH_EVM_CHAIN_IDS = "1";
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.SESSION_SECRET = "test-session-secret-value-long-enough";

  const persisted: { definitionVersion?: number; kind?: string } = {};
  try {
    const response = await handleBacktestPost(
      post({ mode: "definition", definitionText: DEFINITION_TEXT, initialCapitalUsd: "10000" }, "http://localhost:3000"),
      available,
      new Date("2026-08-01T12:00:00.000Z"),
      {
        authenticate: async () => ({ id: "user-1" }),
        readFeeSchedule: async () => ({
          ...defaultFeeSchedule("2026-07-01T00:00:00.000Z"),
          source: "owner-schedule" as const,
          id: "fee-version-9",
          tradingFeeBps: "42",
          spreadBps: "3",
          slippageBps: "4",
        }),
        persistDefinition: async () => ({ id: "definition-1", version: 7 }),
        persistRun: async (input) => {
          persisted.definitionVersion = input.definitionVersion;
          persisted.kind = input.kind;
        },
      },
    );

    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      kind: string;
      stored: boolean;
      definition: { version: number };
      result: { costs: { feeBps: string }; costAssumptions: string[]; metrics: { tradeCount: number; totalFeesUsd: string } };
    };
    assert.equal(payload.kind, "BACKTEST");
    assert.equal(payload.stored, true);
    assert.equal(payload.definition.version, 7);
    assert.equal(payload.result.costs.feeBps, "42");
    assert.ok(payload.result.costAssumptions.some((line) => line.includes("Fee 42 bps per side")));
    assert.ok(payload.result.costAssumptions.some((line) => line.includes("fee table version in force since 2026-07-01")));
    assert.ok(payload.result.metrics.tradeCount > 0);
    assert.ok(Number(payload.result.metrics.totalFeesUsd) > 0);
    assert.equal(persisted.definitionVersion, 7, "the run is stamped with the version it tested");
    assert.equal(persisted.kind, "BACKTEST");
  } finally {
    if (previous.chainIds === undefined) delete process.env.AUTH_EVM_CHAIN_IDS;
    else process.env.AUTH_EVM_CHAIN_IDS = previous.chainIds;
    if (previous.appBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous.appBaseUrl;
    if (previous.sessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.sessionSecret;
  }
});
