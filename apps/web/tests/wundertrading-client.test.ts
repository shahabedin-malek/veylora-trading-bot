import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  WUNDERTRADING_BASE_URL,
  WUNDERTRADING_RECV_WINDOW_MS,
  buildWunderTradingSignaturePayload,
  listWunderTradingApiProfiles,
  sanitizeWunderTradingResponse,
  signWunderTradingPayload,
} from "@/lib/wundertrading/client";

test("WunderTrading HMAC payload matches the documented newline format", () => {
  const payload = buildWunderTradingSignaturePayload({
    method: "GET",
    path: "/open_api/api_profiles?page=1&limit=100",
    timestamp: "1770990729000",
    recvWindow: WUNDERTRADING_RECV_WINDOW_MS,
    body: "",
  });
  assert.equal(payload, "GET\n/open_api/api_profiles?page=1&limit=100\n1770990729000\n30000\n");
  const expected = createHmac("sha256", "test-secret").update(payload, "utf8").digest("base64");
  assert.equal(signWunderTradingPayload("test-secret", payload), expected);
});

test("profile reads use the fixed HTTPS host and redact secret-like response fields", async () => {
  const previousFetch = globalThis.fetch;
  let observedUrl = "";
  let observedHeaders: Headers | undefined;
  globalThis.fetch = async (input, init) => {
    observedUrl = String(input);
    observedHeaders = new Headers(init?.headers);
    return Response.json({ items: [{
      id: "profile-1",
      exchange: "BINANCE",
      apiKey: "must-not-return",
      accessKey: "must-not-return",
      authorization: "must-not-return",
      key: "must-not-return",
      nested: { secret: "hidden", status: "active" },
    }] });
  };

  try {
    const profiles = await listWunderTradingApiProfiles({ apiKey: "test-key", apiSecret: "test-secret" });
    assert.equal(new URL(observedUrl).origin, WUNDERTRADING_BASE_URL);
    assert.equal(new URL(observedUrl).pathname, "/open_api/api_profiles");
    assert.equal(new URL(observedUrl).search, "?page=1&limit=100");
    assert.equal(observedHeaders?.get("X-API-Key"), "test-key");
    assert.equal(observedHeaders?.get("X-Timestamp")?.length, 13);
    assert.deepEqual(profiles, [{ id: "profile-1", exchange: "BINANCE", nested: { status: "active" } }]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("response sanitization bounds nested data and removes sensitive fields", () => {
  const result = sanitizeWunderTradingResponse({
    token: "secret",
    list: Array.from({ length: 105 }, (_, id) => ({ id })),
  }) as { list: unknown[] };
  assert.equal("token" in result, false);
  assert.equal(result.list.length, 100);
});

test("provider responses larger than the limit are rejected", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("x".repeat(1_048_577));
  try {
    await assert.rejects(
      listWunderTradingApiProfiles({ apiKey: "test-key", apiSecret: "test-secret" }),
      /response exceeded the allowed size/,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});