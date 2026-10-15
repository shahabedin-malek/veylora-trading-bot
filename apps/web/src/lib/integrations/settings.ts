import { prisma } from "@/lib/db";
import {
  DEFAULT_INTEGRATION_FEATURE_SETTINGS,
  INTEGRATION_FEATURES,
  type IntegrationFeatureSettings,
} from "./features";

const SINGLETON_ID = "global";
const featureKeys = INTEGRATION_FEATURES.map(({ key }) => key);

export type IntegrationSettingsValidation =
  | { valid: true; value: IntegrationFeatureSettings }
  | { valid: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function selectIntegrationFeatureSettings(value: Record<string, unknown>): IntegrationFeatureSettings {
  return Object.fromEntries(featureKeys.map((key) => [key, value[key]])) as IntegrationFeatureSettings;
}

export function validateIntegrationFeatureSettings(value: unknown): IntegrationSettingsValidation {
  if (!isRecord(value)) return { valid: false, error: "Integration settings must be an object." };
  if (Object.keys(value).some((key) => !featureKeys.includes(key as (typeof featureKeys)[number]))) {
    return { valid: false, error: "One or more integration settings are unsupported." };
  }
  if (featureKeys.some((key) => typeof value[key] !== "boolean")) {
    return { valid: false, error: "Every integration setting must be enabled or disabled." };
  }
  return { valid: true, value: selectIntegrationFeatureSettings(value) };
}

export async function getIntegrationFeatureSettings(): Promise<IntegrationFeatureSettings> {
  const row = await prisma.integrationFeatureSettings.findUnique({ where: { id: SINGLETON_ID } });
  if (!row) return { ...DEFAULT_INTEGRATION_FEATURE_SETTINGS };
  const validation = validateIntegrationFeatureSettings(selectIntegrationFeatureSettings(row));
  if (!validation.valid) throw new Error("Stored integration settings failed validation.");
  return validation.value;
}

export async function saveIntegrationFeatureSettings(
  settings: IntegrationFeatureSettings,
  actorUserId: string,
): Promise<IntegrationFeatureSettings> {
  const validation = validateIntegrationFeatureSettings(settings);
  if (!validation.valid) throw new Error("Integration settings failed validation.");
  const safeSettings = validation.value;

  return prisma.$transaction(async (transaction) => {
    const before = await transaction.integrationFeatureSettings.findUnique({ where: { id: SINGLETON_ID } });
    const saved = await transaction.integrationFeatureSettings.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...safeSettings, updatedByUserId: actorUserId },
      update: { ...safeSettings, updatedByUserId: actorUserId },
    });
    await transaction.auditEvent.create({
      data: {
        actorUserId,
        action: "INTEGRATION_FEATURES_UPDATED",
        objectType: "IntegrationFeatureSettings",
        objectId: SINGLETON_ID,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({
          before: before ? selectIntegrationFeatureSettings(before) : null,
          after: safeSettings,
        }),
      },
    });
    return selectIntegrationFeatureSettings(saved);
  });
}