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
};

export type MarketAlertValidation =
  | { valid: true; value: NewMarketAlert }
  | { valid: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}

export function validateNewMarketAlert(value: unknown): MarketAlertValidation {
  if (!isRecord(value) || Object.keys(value).length !== 3 ||
    !Object.hasOwn(value, "symbol") || !Object.hasOwn(value, "condition") || !Object.hasOwn(value, "threshold")) {
    return { valid: false, error: "Only symbol, condition, and threshold are accepted." };
  }
  if (typeof value.symbol !== "string" || !USD_WATCHLIST.some(({ productId }) => productId === value.symbol)) {
    return { valid: false, error: "Choose a supported Coinbase USD market." };
  }
  if (typeof value.condition !== "string" || !MARKET_ALERT_CONDITIONS.includes(value.condition as MarketAlertCondition)) {
    return { valid: false, error: "Choose a supported price or RSI-14 condition." };
  }
  if (!isDecimal(value.threshold)) return { valid: false, error: "Threshold must be a plain decimal value." };

  const threshold = new Decimal(value.threshold);
  if (!threshold.isFinite()) return { valid: false, error: "Threshold is invalid." };
  if (value.condition.startsWith("PRICE_") && (!threshold.greaterThan(0) || threshold.greaterThan("1000000000000"))) {
    return { valid: false, error: "Price threshold must be greater than zero and no more than 1,000,000,000,000 USD." };
  }
  if (value.condition.startsWith("RSI_") && (threshold.lessThan(0) || threshold.greaterThan(100))) {
    return { valid: false, error: "RSI-14 threshold must be between 0 and 100." };
  }

  return {
    valid: true,
    value: {
      symbol: value.symbol,
      condition: value.condition as MarketAlertCondition,
      threshold: threshold.toFixed(),
    },
  };
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