import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MARKET_ALERT_INTERVAL_MINUTES,
  formatMarketAlertInterval,
  getEffectiveMarketAlertIntervalMinutes,
  getMarketAlertIntervalMinutes,
  MARKET_ALERT_CRON_INTERVAL_MINUTES,
} from "@/lib/alerts/scheduler-config";

test("alert interval defaults to daily and accepts only documented values", () => {
  assert.equal(getMarketAlertIntervalMinutes({} as NodeJS.ProcessEnv), DEFAULT_MARKET_ALERT_INTERVAL_MINUTES);
  assert.equal(getMarketAlertIntervalMinutes({ NODE_ENV: "test", MARKET_ALERT_EVALUATION_INTERVAL_MINUTES: "60" } as NodeJS.ProcessEnv), 60);
  assert.equal(getMarketAlertIntervalMinutes({ NODE_ENV: "test", MARKET_ALERT_EVALUATION_INTERVAL_MINUTES: "7" } as NodeJS.ProcessEnv), DEFAULT_MARKET_ALERT_INTERVAL_MINUTES);
  assert.equal(getMarketAlertIntervalMinutes({ NODE_ENV: "test", MARKET_ALERT_EVALUATION_INTERVAL_MINUTES: "2880" } as NodeJS.ProcessEnv), 2_880);
  assert.equal(getMarketAlertIntervalMinutes({ NODE_ENV: "test", MARKET_ALERT_EVALUATION_INTERVAL_MINUTES: "10080" } as NodeJS.ProcessEnv), 10_080);
});

test("effective alert cadence never claims faster than the deployed Vercel schedule", () => {
  assert.equal(MARKET_ALERT_CRON_INTERVAL_MINUTES, 1_440);
  assert.equal(getEffectiveMarketAlertIntervalMinutes({ NODE_ENV: "test", MARKET_ALERT_EVALUATION_INTERVAL_MINUTES: "1" } as NodeJS.ProcessEnv), 1_440);
  assert.equal(getEffectiveMarketAlertIntervalMinutes({ NODE_ENV: "test", MARKET_ALERT_EVALUATION_INTERVAL_MINUTES: "1440" } as NodeJS.ProcessEnv), 1_440);
  assert.equal(formatMarketAlertInterval(1_440), "24 hours");
  assert.equal(getEffectiveMarketAlertIntervalMinutes({ NODE_ENV: "test", MARKET_ALERT_EVALUATION_INTERVAL_MINUTES: "2880" } as NodeJS.ProcessEnv), 2_880);
});