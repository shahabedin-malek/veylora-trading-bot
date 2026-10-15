import assert from "node:assert/strict";
import test from "node:test";
import { handleMarketAlertsCron } from "./route";

test("alert cron refuses requests when the cron secret is not configured", async () => {
  const previous = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    let evaluated = false;
    const response = await handleMarketAlertsCron(new Request("https://veylora.example/api/cron/market-alerts"), async () => {
      evaluated = true;
      return { evaluated: 0, triggered: 0, failed: 0, skipped: 0, batchFull: false, cadence: "1 minute" };
    });
    assert.equal(response.status, 503);
    assert.equal(evaluated, false);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test("alert cron requires the exact bearer secret before evaluating", async () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "test-only-placeholder";
  let evaluated = false;
  try {
    const denied = await handleMarketAlertsCron(new Request("https://veylora.example/api/cron/market-alerts"), async () => {
      evaluated = true;
      return { evaluated: 0, triggered: 0, failed: 0, skipped: 0, batchFull: false, cadence: "1 minute" };
    });
    assert.equal(denied.status, 401);
    assert.equal(evaluated, false);

    const accepted = await handleMarketAlertsCron(new Request("https://veylora.example/api/cron/market-alerts", {
      headers: { Authorization: "Bearer test-only-placeholder" },
    }), async () => {
      evaluated = true;
      return { evaluated: 1, triggered: 0, failed: 0, skipped: 1, batchFull: false, cadence: "1 minute" };
    });
    assert.equal(accepted.status, 200);
    assert.equal(evaluated, true);
    assert.equal((await accepted.json()).cadence, "1 minute");
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});