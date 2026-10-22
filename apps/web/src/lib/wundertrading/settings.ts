import { prisma } from "@/lib/db";
import {
  DEFAULT_WUNDERTRADING_FEATURE_SETTINGS,
  WUNDERTRADING_FEATURES,
  type WunderTradingFeatureSettings,
} from "./features";
import { auditCreate } from "@/lib/audit/record";

const SINGLETON_ID = "global";
const featureKeys = WUNDERTRADING_FEATURES.map(({ key }) => key);

export type WunderTradingSettingsValidation =
  | { valid: true; value: WunderTradingFeatureSettings }
  | { valid: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function selectWunderTradingFeatureSettings(value: Record<string, unknown>): WunderTradingFeatureSettings {
  return Object.fromEntries(featureKeys.map((key) => [key, value[key]])) as WunderTradingFeatureSettings;
}

export function validateWunderTradingFeatureSettings(value: unknown): WunderTradingSettingsValidation {
  if (!isRecord(value)) return { valid: false, error: "WunderTrading settings must be an object." };
  if (Object.keys(value).some((key) => !featureKeys.includes(key as (typeof featureKeys)[number]))) {
    return { valid: false, error: "One or more WunderTrading settings are unsupported." };
  }
  if (featureKeys.some((key) => typeof value[key] !== "boolean")) {
    return { valid: false, error: "Every WunderTrading setting must be enabled or disabled." };
  }
  return { valid: true, value: selectWunderTradingFeatureSettings(value) };
}

export async function getWunderTradingFeatureSettings(): Promise<WunderTradingFeatureSettings> {
  const row = await prisma.wunderTradingFeatureSettings.findUnique({ where: { id: SINGLETON_ID } });
  if (!row) return { ...DEFAULT_WUNDERTRADING_FEATURE_SETTINGS };
  const validation = validateWunderTradingFeatureSettings(selectWunderTradingFeatureSettings(row));
  if (!validation.valid) throw new Error("Stored WunderTrading settings failed validation.");
  return validation.value;
}

export async function saveWunderTradingFeatureSettings(
  settings: WunderTradingFeatureSettings,
  actorUserId: string,
): Promise<WunderTradingFeatureSettings> {
  const validation = validateWunderTradingFeatureSettings(settings);
  if (!validation.valid) throw new Error("WunderTrading settings failed validation.");
  const safeSettings = validation.value;

  return prisma.$transaction(async (transaction) => {
    const before = await transaction.wunderTradingFeatureSettings.findUnique({ where: { id: SINGLETON_ID } });
    const saved = await transaction.wunderTradingFeatureSettings.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...safeSettings, updatedByUserId: actorUserId },
      update: { ...safeSettings, updatedByUserId: actorUserId },
    });

    await auditCreate(transaction, {
      data: {
        actorUserId,
        action: "WUNDERTRADING_FEATURES_UPDATED",
        objectType: "WunderTradingFeatureSettings",
        objectId: SINGLETON_ID,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({
          before: before ? selectWunderTradingFeatureSettings(before) : null,
          after: safeSettings,
        }),
      },
    });

    return selectWunderTradingFeatureSettings(saved);
  });
}