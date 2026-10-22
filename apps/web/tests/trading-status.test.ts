import assert from "node:assert/strict";
import test from "node:test";
import { ORDER_STATUSES } from "@/lib/orders/state-machine";
import { DEFAULT_RISK_POLICY } from "@/lib/risk-controls/policy";
import { getTradingStatus } from "@/lib/trading/status";

test("trading status states the paper order path and risk unavailable when policy loading fails", async () => {
  const status = await getTradingStatus(async () => {
    throw new Error("database unavailable");
  });

  assert.equal(status.trading.enabled, true);
  assert.equal(status.trading.status, "PAPER ORDERS");
  assert.equal(status.trading.execution, "PAPER VENUE");
  assert.equal(status.trading.venue.paper, true);
  assert.match(status.trading.detail, /no real funds move/);
  assert.equal(status.riskControls.status, "UNAVAILABLE");
  assert.equal(status.riskControls.detail, "Database unavailable; risk settings were not loaded");
  assert.equal(status.riskControls.failClosed, true);
  // Live execution stays off; paper execution is what this build has.
  assert.equal(status.riskControls.executionEnabled, false);
  assert.equal(status.riskControls.paperExecutionEnabled, true);
});

test("trading status explains every lifecycle status it can report", async () => {
  const status = await getTradingStatus(async () => DEFAULT_RISK_POLICY);

  assert.equal(status.riskControls.status, "AVAILABLE");
  // The UI renders whatever a row carries, so the status endpoint has to be able
  // to explain every status the lifecycle defines — no status is a surprise.
  assert.deepEqual(
    status.trading.lifecycle.map((entry) => entry.status).sort(),
    [...ORDER_STATUSES].sort(),
  );
  for (const entry of status.trading.lifecycle) {
    assert.ok(entry.label.length > 0, `${entry.status} needs a label`);
    assert.ok(entry.detail.length > 20, `${entry.status} needs an explanatory sentence`);
    assert.equal(typeof entry.terminal, "boolean");
  }
  assert.match(status.trading.retry, /same idempotency key/);
  assert.match(status.trading.reconciliation.detail, /both values/);
});
