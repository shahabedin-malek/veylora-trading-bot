import assert from "node:assert/strict";
import test from "node:test";
import { handleBacktestPost, startBacktestWindow } from "./route";

const requestBody = {
  symbol: "BTC-USD",
  initialCapitalUsd: "10000",
  feeBps: "10",
  slippageBps: "5",
  buyRsiBelow: "30",
  sellRsiAbove: "70",
};

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