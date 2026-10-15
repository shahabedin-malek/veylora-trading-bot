import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_WUNDERTRADING_FEATURE_SETTINGS } from "@/lib/wundertrading/features";
import {
  selectWunderTradingFeatureSettings,
  validateWunderTradingFeatureSettings,
} from "@/lib/wundertrading/settings";

test("WunderTrading functions default off", () => {
  assert.equal(Object.values(DEFAULT_WUNDERTRADING_FEATURE_SETTINGS).every((enabled) => !enabled), true);
});

test("WunderTrading settings accept only declared boolean switches", () => {
  assert.equal(validateWunderTradingFeatureSettings(DEFAULT_WUNDERTRADING_FEATURE_SETTINGS).valid, true);
  assert.equal(validateWunderTradingFeatureSettings({
    ...DEFAULT_WUNDERTRADING_FEATURE_SETTINGS,
    apiSecret: "should-not-be-a-setting",
  }).valid, false);
  assert.equal(validateWunderTradingFeatureSettings({
    ...DEFAULT_WUNDERTRADING_FEATURE_SETTINGS,
    openTradesEnabled: "yes",
  }).valid, false);
});

test("persisted rows project only feature switches before validation", () => {
  const row = {
    id: "global",
    updatedByUserId: "admin",
    updatedAt: new Date(),
    ...DEFAULT_WUNDERTRADING_FEATURE_SETTINGS,
  };
  const settings = selectWunderTradingFeatureSettings(row);
  assert.deepEqual(settings, DEFAULT_WUNDERTRADING_FEATURE_SETTINGS);
  assert.equal(validateWunderTradingFeatureSettings(settings).valid, true);
});