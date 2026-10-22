import { prisma } from "@/lib/db";
import {
  CHAINGPT_FEATURES,
  DEFAULT_CHAINGPT_FEATURE_SETTINGS,
  type ChainGPTFeatureSettings,
} from "./features";
import { auditCreate } from "@/lib/audit/record";

const SINGLETON_ID = "global";
const featureKeys = CHAINGPT_FEATURES.map(({ key }) => key);

export type ChainGPTSettingsValidation =
  | { valid: true; value: ChainGPTFeatureSettings }
  | { valid: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function selectChainGPTFeatureSettings(value: Record<string, unknown>): ChainGPTFeatureSettings {
  return Object.fromEntries(
    featureKeys.map((key) => [key, value[key]]),
  ) as ChainGPTFeatureSettings;
}

export function validateChainGPTFeatureSettings(value: unknown): ChainGPTSettingsValidation {
  if (!isRecord(value)) return { valid: false, error: "ChainGPT settings must be an object." };
  if (Object.keys(value).some((key) => !featureKeys.includes(key as (typeof featureKeys)[number]))) {
    return { valid: false, error: "One or more ChainGPT settings are unsupported." };
  }
  if (featureKeys.some((key) => typeof value[key] !== "boolean")) {
    return { valid: false, error: "Every ChainGPT feature setting must be enabled or disabled." };
  }

  return { valid: true, value: selectChainGPTFeatureSettings(value) };
}

export async function getChainGPTFeatureSettings(): Promise<ChainGPTFeatureSettings> {
  const row = await prisma.chainGPTFeatureSettings.findUnique({ where: { id: SINGLETON_ID } });
  if (!row) return { ...DEFAULT_CHAINGPT_FEATURE_SETTINGS };
  const validation = validateChainGPTFeatureSettings(selectChainGPTFeatureSettings(row));
  if (!validation.valid) throw new Error("Stored ChainGPT settings failed validation.");
  return validation.value;
}

export async function saveChainGPTFeatureSettings(
  settings: ChainGPTFeatureSettings,
  actorUserId: string,
): Promise<ChainGPTFeatureSettings> {
  const validation = validateChainGPTFeatureSettings(settings);
  if (!validation.valid) throw new Error("ChainGPT settings failed validation.");
  const safeSettings = validation.value;

  return prisma.$transaction(async (transaction) => {
    const before = await transaction.chainGPTFeatureSettings.findUnique({ where: { id: SINGLETON_ID } });
    const saved = await transaction.chainGPTFeatureSettings.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...safeSettings, updatedByUserId: actorUserId },
      update: { ...safeSettings, updatedByUserId: actorUserId },
    });

    await auditCreate(transaction, {
      data: {
        actorUserId,
        action: "CHAINGPT_LINKS_UPDATED",
        objectType: "ChainGPTFeatureSettings",
        objectId: SINGLETON_ID,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({
          before: before ? selectChainGPTFeatureSettings(before) : null,
          after: safeSettings,
        }),
      },
    });

    return selectChainGPTFeatureSettings(saved);
  });
}