import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CHAINGPT_FEATURE_SETTINGS } from "../src/lib/chaingpt/features";
import {
  selectChainGPTFeatureSettings,
  validateChainGPTFeatureSettings,
} from "../src/lib/chaingpt/settings";

test("ChainGPT feature defaults enable hosted links only", () => {
  assert.equal(Object.values(DEFAULT_CHAINGPT_FEATURE_SETTINGS).every(Boolean), true);
});

test("ChainGPT settings accept only the declared boolean toggles", () => {
  const result = validateChainGPTFeatureSettings(DEFAULT_CHAINGPT_FEATURE_SETTINGS);
  assert.equal(result.valid, true);
});

test("ChainGPT settings reject unknown fields and non-boolean values", () => {
  assert.equal(validateChainGPTFeatureSettings({ ...DEFAULT_CHAINGPT_FEATURE_SETTINGS, apiKey: "secret" }).valid, false);
  assert.equal(validateChainGPTFeatureSettings({ ...DEFAULT_CHAINGPT_FEATURE_SETTINGS, chatbotEnabled: "yes" }).valid, false);
});

test("persisted rows project only feature toggles before validation", () => {
  const row = {
    id: "global",
    updatedByUserId: "admin",
    updatedAt: new Date(),
    ...DEFAULT_CHAINGPT_FEATURE_SETTINGS,
  };

  const settings = selectChainGPTFeatureSettings(row);
  assert.deepEqual(settings, DEFAULT_CHAINGPT_FEATURE_SETTINGS);
  assert.equal(validateChainGPTFeatureSettings(settings).valid, true);
});