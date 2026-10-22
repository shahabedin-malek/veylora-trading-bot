import assert from "node:assert/strict";
import test from "node:test";
import { createLogger, type LogRecord } from "@/lib/observability/logger";
import {
  buildProviderCallRecord,
  getProviderCallSink,
  instrumentFetch,
  outcomeForStatus,
  reasonForProviderResponse,
  reasonForThrownCall,
  setProviderCallSink,
  type ProviderCallRecord,
} from "@/lib/observability/provider-call";
import { describeReason } from "@/lib/observability/reason";
import { contextFrom, runWithRequestContext } from "@/lib/observability/request-context";
import { describeDatabaseProbeFailure } from "@/lib/observability/health";

const ALCHEMY_KEY = "Zx9QwErTyUiOpAsDfGhJkLzXcVbNm123";
const ENDPOINT = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

function collectingLogger(records: LogRecord[]) {
  return createLogger({ level: "debug", sink: (record) => records.push(record) });
}

test("a successful call is recorded once, with the redacted URL and its timing", async () => {
  const records: ProviderCallRecord[] = [];
  const request = instrumentFetch({
    providerId: "alchemy-rpc",
    fetcher: async () => new Response("{}", { status: 200 }),
    record: (record) => { records.push(record); },
  });

  const response = await request(ENDPOINT, { method: "post" });

  assert.equal(response.status, 200);
  assert.equal(records.length, 1);
  const [record] = records as [ProviderCallRecord];
  assert.equal(record.providerId, "alchemy-rpc");
  assert.equal(record.method, "POST");
  assert.equal(record.statusCode, 200);
  assert.equal(record.outcome, "ok");
  assert.equal(record.reasonCode, null);
  assert.equal(record.attempts, 1);
  assert.ok(record.durationMs >= 0);
  assert.ok(!record.url.includes(ALCHEMY_KEY), `the key reached the record: ${record.url}`);
  assert.equal(record.requestId, null, "no request context means no invented id");
});

test("a call made inside a request context carries that request's id and route", async () => {
  const records: ProviderCallRecord[] = [];
  const request = instrumentFetch({
    providerId: "coinbase-exchange",
    fetcher: async () => new Response("[]", { status: 200 }),
    record: (record) => { records.push(record); },
  });

  await runWithRequestContext(contextFrom({ requestId: "request-1234", route: "/markets" }), async () => {
    await request("https://api.exchange.coinbase.com/products/BTC-USD/book");
  });

  assert.equal(records[0]?.requestId, "request-1234");
  assert.equal(records[0]?.route, "/markets");
});

test("a failed call is recorded before the error is rethrown, and never hides the cause", async () => {
  const records: ProviderCallRecord[] = [];
  const logs: LogRecord[] = [];
  const request = instrumentFetch({
    providerId: "tavily",
    fetcher: async () => { throw Object.assign(new Error("connect ETIMEDOUT"), { name: "TimeoutError" }); },
    record: (record) => { records.push(record); },
    logger: collectingLogger(logs),
  });

  await assert.rejects(() => request("https://api.tavily.com/search", { method: "POST" }));
  assert.equal(records.length, 1);
  assert.equal(records[0]?.outcome, "network-error");
  assert.equal(records[0]?.statusCode, null);
  assert.equal(records[0]?.reasonCode, "VENUE_UNAVAILABLE");
  assert.match(records[0]?.safeMessage ?? "", /TimeoutError/);
  const failureLine = logs.find((line) => line.message === "provider call failed");
  assert.equal(failureLine?.level, "warn");
});

test("an error answer names the reason the client should act on", async () => {
  const records: ProviderCallRecord[] = [];
  const request = instrumentFetch({
    providerId: "wundertrading",
    fetcher: async () => new Response("denied", { status: 403 }),
    record: (record) => { records.push(record); },
    logger: collectingLogger([]),
  });

  await request("https://wundertrading.com/open_api/strategies/live", { method: "GET" });

  assert.equal(records[0]?.outcome, "provider-error");
  assert.equal(records[0]?.reasonCode, "INVALID_CREDENTIAL");
  assert.equal(records[0]?.safeMessage, "The provider answered 403.");
});

test("the status-to-reason mapping separates the cases an owner must tell apart", () => {
  assert.equal(outcomeForStatus(200), "ok");
  assert.equal(outcomeForStatus(204), "ok");
  assert.equal(outcomeForStatus(429), "rate-limited");
  assert.equal(outcomeForStatus(500), "provider-error");
  assert.equal(reasonForProviderResponse("coinbase-exchange", 429).code, "PROVIDER_RATE_LIMITED");
  assert.equal(reasonForProviderResponse("coinbase-exchange", 401).code, "INVALID_CREDENTIAL");
  assert.equal(reasonForProviderResponse("coinbase-exchange", 503).retryable, true);
  assert.equal(reasonForProviderResponse("coinbase-exchange", 404).retryable, false);
  assert.equal(reasonForThrownCall("coinbase-exchange", new Error("nope")).code, "VENUE_UNAVAILABLE");
  assert.equal(describeReason(reasonForThrownCall("tavily", Object.assign(new Error("x"), { name: "AbortError" }))).includes("timed out"), true);
});

test("the record builder is safe on its own, so a caller cannot store a raw key", () => {
  const record = buildProviderCallRecord({
    providerId: "alchemy-rpc",
    method: "post",
    url: `${ENDPOINT}?trace=1`,
    statusCode: 200,
    outcome: "ok",
    durationMs: 12.4,
    attempts: 0,
  });
  assert.equal(record.method, "POST");
  assert.equal(record.durationMs, 12);
  assert.equal(record.attempts, 1, "a call that happened is at least one attempt");
  assert.ok(!record.url.includes(ALCHEMY_KEY));
  assert.match(record.occurredAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(record.safeMessage, null);
});

test("a database failure names the variable in production and the driver message in development", () => {
  const raw = "Invalid `prisma.$queryRaw()` invocation: Error code 14: Unable to open the database file";
  const development = describeDatabaseProbeFailure(raw, { NODE_ENV: "development" });
  assert.ok(development.includes("Unable to open the database file"), "development should carry the driver message");
  const production = describeDatabaseProbeFailure(raw, { NODE_ENV: "production" });
  assert.equal(production, "The database did not answer a probe query.");
  const empty = describeDatabaseProbeFailure("", { NODE_ENV: "development" });
  assert.match(empty, /without a message/);
});

test("the sink registry lives on the process, so every bundle sees the same one", () => {
  const previous = getProviderCallSink();
  const sink = () => undefined;
  try {
    setProviderCallSink(sink);
    assert.equal(getProviderCallSink(), sink);
    assert.equal((globalThis as Record<string, unknown>).__veyloraProviderCallSink, sink);
    setProviderCallSink(null);
    assert.equal(getProviderCallSink(), null, "a process with no sink keeps no history rather than failing");
  } finally {
    setProviderCallSink(previous);
  }
});
