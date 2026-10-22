import DecimalJS from "decimal.js";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";

const Decimal = DecimalJS.clone({ precision: 40 });

export const MARKET_ALERT_CONDITIONS = [
  "PRICE_ABOVE",
  "PRICE_BELOW",
  "RSI_14_ABOVE",
  "RSI_14_BELOW",
] as const;

export type MarketAlertCondition = (typeof MARKET_ALERT_CONDITIONS)[number];

export type NewMarketAlert = {
  symbol: string;
  condition: MarketAlertCondition;
  threshold: string;
  /**
   * The shortest gap between two fires of this rule, in minutes (phase 29). Optional so
   * every caller written before phase 29 keeps the server default rather than having to
   * know about cooldowns; the panel sends the owner's value explicitly.
   */
  cooldownMinutes?: number;
};

/** One week. Longer than the slowest evaluation cadence this build supports. */
export const MAX_ALERT_COOLDOWN_MINUTES = 10_080;
export const DEFAULT_ALERT_COOLDOWN_MINUTES = 60;

export type MarketAlertValidation =
  | { valid: true; value: NewMarketAlert }
  | { valid: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}

/**
 * The one threshold rule, shared by market alerts and the screener (phase 19).
 *
 * A screener condition and an alert condition are the same thing: a metric, a
 * direction and a threshold. The screener evaluates the condition across many
 * symbols; creating an alert from a screen must not be able to accept a
 * threshold the alert endpoint would refuse, so both call this function rather
 * than keeping two copies of the bounds.
 */
export type ThresholdValidation =
  | { valid: true; condition: MarketAlertCondition; threshold: string }
  | { valid: false; error: string };

export function validateConditionThreshold(condition: unknown, thresholdText: unknown): ThresholdValidation {
  if (typeof condition !== "string" || !MARKET_ALERT_CONDITIONS.includes(condition as MarketAlertCondition)) {
    return { valid: false, error: "Choose a supported price or RSI-14 condition." };
  }
  if (!isDecimal(thresholdText)) return { valid: false, error: "Threshold must be a plain decimal value." };

  const threshold = new Decimal(thresholdText);
  if (!threshold.isFinite()) return { valid: false, error: "Threshold is invalid." };
  if (condition.startsWith("PRICE_") && (!threshold.greaterThan(0) || threshold.greaterThan("1000000000000"))) {
    return { valid: false, error: "Price threshold must be greater than zero and no more than 1,000,000,000,000 USD." };
  }
  if (condition.startsWith("RSI_") && (threshold.lessThan(0) || threshold.greaterThan(100))) {
    return { valid: false, error: "RSI-14 threshold must be between 0 and 100." };
  }

  return { valid: true, condition: condition as MarketAlertCondition, threshold: threshold.toFixed() };
}

export function validateNewMarketAlert(value: unknown): MarketAlertValidation {
  if (!isRecord(value)) return { valid: false, error: "Only symbol, condition, threshold, and cooldownMinutes are accepted." };
  const keys = Object.keys(value);
  const allowed = ["symbol", "condition", "threshold", "cooldownMinutes"];
  if (keys.some((key) => !allowed.includes(key)) ||
    !Object.hasOwn(value, "symbol") || !Object.hasOwn(value, "condition") || !Object.hasOwn(value, "threshold")) {
    return { valid: false, error: "Only symbol, condition, threshold, and cooldownMinutes are accepted." };
  }
  if (typeof value.symbol !== "string" || !USD_WATCHLIST.some(({ productId }) => productId === value.symbol)) {
    return { valid: false, error: "Choose a supported Coinbase USD market." };
  }
  const threshold = validateConditionThreshold(value.condition, value.threshold);
  if (!threshold.valid) return threshold;

  const cooldown = validateCooldownMinutes(value.cooldownMinutes);
  if (!cooldown.valid) return cooldown;

  return {
    valid: true,
    value: {
      symbol: value.symbol,
      condition: threshold.condition,
      threshold: threshold.threshold,
      ...(cooldown.minutes === null ? {} : { cooldownMinutes: cooldown.minutes }),
    },
  };
}

/**
 * A cooldown is a whole number of minutes, at least one: a zero-minute cooldown would make
 * every evaluation that observes the same crossing a new notification, which is the exact
 * repetition the phase forbids. The upper bound is a week, longer than any cadence this
 * build can deliver.
 */
export function validateCooldownMinutes(value: unknown):
  | { valid: true; minutes: number | null }
  | { valid: false; error: string } {
  if (value === undefined || value === null) return { valid: true, minutes: null };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_ALERT_COOLDOWN_MINUTES) {
    return { valid: false, error: `Cooldown must be a whole number of minutes between 1 and ${MAX_ALERT_COOLDOWN_MINUTES}.` };
  }
  return { valid: true, minutes: value };
}

export function doesAlertTrigger(condition: MarketAlertCondition, thresholdText: string, observedText: string): boolean {
  const threshold = new Decimal(thresholdText);
  const observed = new Decimal(observedText);
  if (!threshold.isFinite() || !observed.isFinite() || observed.isNegative()) return false;
  if (condition.endsWith("ABOVE")) return observed.greaterThanOrEqualTo(threshold);
  return observed.lessThanOrEqualTo(threshold);
}

export function formatAlertCondition(condition: MarketAlertCondition, threshold: string): string {
  switch (condition) {
    case "PRICE_ABOVE": return `Price at or above $${threshold}`;
    case "PRICE_BELOW": return `Price at or below $${threshold}`;
    case "RSI_14_ABOVE": return `15m RSI-14 at or above ${threshold}`;
    case "RSI_14_BELOW": return `15m RSI-14 at or below ${threshold}`;
  }
}