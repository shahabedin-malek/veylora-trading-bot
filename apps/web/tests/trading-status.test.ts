import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RISK_POLICY } from "@/lib/risk-controls/policy";
import { getTradingStatus } from "@/lib/trading/status";

test("trading status stays disabled and reports risk unavailable when policy loading fails", async () => {
  const status = await getTradingStatus(async () => {
    throw new Error("database unavailable");
  });

  assert.equal(status.trading.enabled, false);
  assert.equal(status.trading.status, "TRADING DISABLED");
  assert.equal(status.trading.execution, "OFF");
  assert.equal(status.riskControls.status, "UNAVAILABLE");
  assert.equal(status.riskControls.detail, "Database unavailable; risk settings were not loaded");
  assert.equal(status.riskControls.failClosed, true);
  assert.equal(status.riskControls.executionEnabled, false);
});

test("trading status remains disabled even when risk policy loads", async () => {
  const status = await getTradingStatus(async () => DEFAULT_RISK_POLICY);

  assert.equal(status.trading.enabled, false);
  assert.equal(status.trading.execution, "OFF");
  assert.equal(status.riskControls.status, "AVAILABLE");
  assert.equal(status.riskControls.failClosed, true);
  assert.equal(status.riskControls.executionEnabled, false);
});