import DecimalJS from "decimal.js";
import { prisma } from "@/lib/db";
import {
  evaluateRiskOrder,
  RISK_POLICY_VERSION,
  type AdjustableRiskPolicy,
  type RiskDecision,
  type RiskOrderInput,
} from "@/lib/risk-controls/policy";

const Decimal = DecimalJS.clone({ precision: 100 });
const SINGLETON_ID = "global";

export type RiskPolicyUpdate = AdjustableRiskPolicy & { killSwitchActive: boolean };

export type RiskPolicyValidation =
  | { valid: true; value: RiskPolicyUpdate }
  | { valid: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decimalAtLeast(value: unknown, minimum: string): value is string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return false;
  const parsed = new Decimal(value);
  return parsed.isFinite() && parsed.greaterThanOrEqualTo(minimum);
}

// Ratios are validated for form only (a plain positive decimal). How tight the owner
// sets them is configuration, not something this module decides: the admin panel is
// the control, the evaluator is the enforcement, and every change is audited.
function positiveDecimal(value: unknown): value is string {
  return decimalAtLeast(value, "0") && new Decimal(value).greaterThan(0);
}

export function validateRiskPolicyUpdate(value: unknown): RiskPolicyValidation {
  if (!isRecord(value)) return { valid: false, error: "Risk settings must be an object." };

  const allowedKeys = new Set([
    "maxRiskPerTradePercent",
    "maxOpenExposurePercent",
    "dailyLossHaltPercent",
    "maxTradesPerDay",
    "defaultMaxLeverage",
    "minimumVerifiedBalanceUsd",
    "first24HourExposureUsd",
    "approvedSymbols",
    "killSwitchActive",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return { valid: false, error: "One or more submitted fields are unsupported." };
  }

  if (!positiveDecimal(value.maxRiskPerTradePercent)) {
    return { valid: false, error: "Per-trade risk must be a positive percentage of configured capital." };
  }
  if (!positiveDecimal(value.maxOpenExposurePercent)) {
    return { valid: false, error: "Open exposure must be a positive percentage of configured capital." };
  }
  if (!positiveDecimal(value.dailyLossHaltPercent)) {
    return { valid: false, error: "Daily-loss halt must be a positive percentage of configured capital." };
  }
  if (typeof value.maxTradesPerDay !== "number" || !Number.isSafeInteger(value.maxTradesPerDay) || value.maxTradesPerDay < 1) {
    return { valid: false, error: "Trades per day must be a whole number of at least 1." };
  }
  if (!positiveDecimal(value.defaultMaxLeverage)) {
    return { valid: false, error: "Leverage must be a positive multiplier." };
  }
  if (!decimalAtLeast(value.minimumVerifiedBalanceUsd, "0")) {
    return { valid: false, error: "Minimum verified balance must be a non-negative USD amount." };
  }
  if (!decimalAtLeast(value.first24HourExposureUsd, "0")) {
    return { valid: false, error: "First-day exposure must be a non-negative USD amount." };
  }
  if (!Array.isArray(value.approvedSymbols) || value.approvedSymbols.length > 100) {
    return { valid: false, error: "Approved symbols must be a list of at most 100 product IDs." };
  }
  if (value.approvedSymbols.some((symbol) => typeof symbol !== "string" || !/^[A-Z0-9]+-[A-Z0-9]+$/.test(symbol))) {
    return { valid: false, error: "Symbols must use uppercase BASE-QUOTE product IDs." };
  }
  if (new Set(value.approvedSymbols).size !== value.approvedSymbols.length) {
    return { valid: false, error: "Approved symbols must be unique." };
  }
  if (typeof value.killSwitchActive !== "boolean") {
    return { valid: false, error: "Kill-switch state must be a boolean." };
  }

  return {
    valid: true,
    value: {
      maxRiskPerTradePercent: value.maxRiskPerTradePercent,
      maxOpenExposurePercent: value.maxOpenExposurePercent,
      dailyLossHaltPercent: value.dailyLossHaltPercent,
      maxTradesPerDay: value.maxTradesPerDay,
      defaultMaxLeverage: value.defaultMaxLeverage,
      minimumVerifiedBalanceUsd: value.minimumVerifiedBalanceUsd,
      first24HourExposureUsd: value.first24HourExposureUsd,
      approvedSymbols: value.approvedSymbols,
      killSwitchActive: value.killSwitchActive,
    },
  };
}

function decodeSymbols(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string" && /^[A-Z0-9]+-[A-Z0-9]+$/.test(item))
      ? parsed
      : [];
  } catch {
    return [];
  }
}

export async function getRiskPolicySettings(): Promise<RiskPolicyUpdate> {
  const row = await prisma.riskPolicySettings.findUnique({ where: { id: SINGLETON_ID } });
  if (!row) throw new Error("Risk policy settings are not configured.");
  const candidate = {
    maxRiskPerTradePercent: row.maxRiskPerTradePercent,
    maxOpenExposurePercent: row.maxOpenExposurePercent,
    dailyLossHaltPercent: row.dailyLossHaltPercent,
    maxTradesPerDay: row.maxTradesPerDay,
    defaultMaxLeverage: row.defaultMaxLeverage,
    minimumVerifiedBalanceUsd: row.minimumVerifiedBalanceUsd,
    first24HourExposureUsd: row.first24HourExposureUsd,
    approvedSymbols: decodeSymbols(row.approvedSymbolsJson),
    killSwitchActive: row.killSwitchActive,
  };
  const validation = validateRiskPolicyUpdate(candidate);
  if (!validation.valid) throw new Error("Stored risk policy failed validation.");
  return validation.value;
}

export async function saveRiskPolicySettings(settings: RiskPolicyUpdate, actorUserId: string): Promise<RiskPolicyUpdate> {
  const validation = validateRiskPolicyUpdate(settings);
  if (!validation.valid) throw new Error("Risk policy update failed validation.");
  const safeSettings = validation.value;

  return prisma.$transaction(async (transaction) => {
    const before = await transaction.riskPolicySettings.findUnique({ where: { id: SINGLETON_ID } });
    const data = {
      maxRiskPerTradePercent: safeSettings.maxRiskPerTradePercent,
      maxOpenExposurePercent: safeSettings.maxOpenExposurePercent,
      dailyLossHaltPercent: safeSettings.dailyLossHaltPercent,
      maxTradesPerDay: safeSettings.maxTradesPerDay,
      defaultMaxLeverage: safeSettings.defaultMaxLeverage,
      minimumVerifiedBalanceUsd: safeSettings.minimumVerifiedBalanceUsd,
      first24HourExposureUsd: safeSettings.first24HourExposureUsd,
      approvedSymbolsJson: JSON.stringify(safeSettings.approvedSymbols),
      killSwitchActive: safeSettings.killSwitchActive,
      updatedByUserId: actorUserId,
    };
    const saved = await transaction.riskPolicySettings.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...data },
      update: data,
    });
    await transaction.auditEvent.create({
      data: {
        actorUserId,
        action: "RISK_POLICY_UPDATED",
        objectType: "RiskPolicySettings",
        objectId: SINGLETON_ID,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({
          policyVersion: RISK_POLICY_VERSION,
          before: before ? { ...before, approvedSymbols: decodeSymbols(before.approvedSymbolsJson) } : null,
          after: safeSettings,
        }),
      },
    });
    return {
      maxRiskPerTradePercent: saved.maxRiskPerTradePercent,
      maxOpenExposurePercent: saved.maxOpenExposurePercent,
      dailyLossHaltPercent: saved.dailyLossHaltPercent,
      maxTradesPerDay: saved.maxTradesPerDay,
      defaultMaxLeverage: saved.defaultMaxLeverage,
      minimumVerifiedBalanceUsd: saved.minimumVerifiedBalanceUsd,
      first24HourExposureUsd: saved.first24HourExposureUsd,
      approvedSymbols: decodeSymbols(saved.approvedSymbolsJson),
      killSwitchActive: saved.killSwitchActive,
    };
  });
}

export async function evaluateCurrentRiskOrder(input: RiskOrderInput): Promise<RiskDecision> {
  return evaluateRiskOrder(input, await getRiskPolicySettings());
}