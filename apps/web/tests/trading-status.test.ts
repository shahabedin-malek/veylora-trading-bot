import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RISK_POLICY } from "@/lib/risk-controls/policy";
import { getTradingStatus } from "@/lib/trading/status";

test("trading status reports no order route and risk unavailable when policy loading fails", async () => {
  const status = await getTradingStatus(async () => {
    throw new Error("database unavailable");
  });

  assert.equal(status.trading.enabled, false);
  assert.equal(status.trading.status, "NO ORDER ROUTE");
  assert.equal(status.trading.execution, "NOT WIRED");
  assert.equal(status.riskControls.status, "UNAVAILABLE");
  assert.equal(status.riskControls.detail, "Database unavailable; risk settings were not loaded");
  assert.equal(status.riskControls.failClosed, true);
  assert.equal(status.riskControls.executionEnabled, false);
});

test("trading status reports the same unwired order route once the risk policy loads", async () => {
  const status = await getTradingStatus(async () => DEFAULT_RISK_POLICY);

  assert.equal(status.trading.enabled, false);
  assert.equal(status.trading.execution, "NOT WIRED");
  assert.equal(status.riskControls.status, "AVAILABLE");
  assert.equal(status.riskControls.failClosed, true);
  assert.equal(status.riskControls.executionEnabled, false);
});
