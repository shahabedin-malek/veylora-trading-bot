import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_INTEGRATION_FEATURE_SETTINGS } from "@/lib/integrations/features";
import {
  selectIntegrationFeatureSettings,
  validateIntegrationFeatureSettings,
} from "@/lib/integrations/settings";

test("external integration switches default off", () => {
  assert.equal(Object.values(DEFAULT_INTEGRATION_FEATURE_SETTINGS).every((enabled) => !enabled), true);
});

test("integration settings accept only declared boolean switches", () => {
  assert.equal(validateIntegrationFeatureSettings(DEFAULT_INTEGRATION_FEATURE_SETTINGS).valid, true);
  assert.equal(validateIntegrationFeatureSettings({
    ...DEFAULT_INTEGRATION_FEATURE_SETTINGS,
    apiKey: "must-not-be-stored-here",
  }).valid, false);
  assert.equal(validateIntegrationFeatureSettings({
    ...DEFAULT_INTEGRATION_FEATURE_SETTINGS,
    tavilySearchEnabled: "yes",
  }).valid, false);
});

test("persisted integration rows project only declared switches", () => {
  const row = {
    id: "global",
    updatedByUserId: "admin",
    updatedAt: new Date(),
    ...DEFAULT_INTEGRATION_FEATURE_SETTINGS,
  };
  assert.deepEqual(selectIntegrationFeatureSettings(row), DEFAULT_INTEGRATION_FEATURE_SETTINGS);
});