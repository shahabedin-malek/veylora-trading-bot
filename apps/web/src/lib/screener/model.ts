import { createHash } from "node:crypto";
import {
  type MarketAlertCondition,
  type NewMarketAlert,
  validateConditionThreshold,
  validateNewMarketAlert,
} from "@/lib/alerts/conditions";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";

/**
 * A saved screen is an alert condition plus the symbols it is asked about
 * (phase 19).
 *
 * That is deliberately the same shape as `MarketAlert`: `condition` and
 * `threshold` come from `MARKET_ALERT_CONDITIONS`, and both sides use
 * `validateConditionThreshold`. A screen therefore cannot express a condition the
 * alert endpoint would refuse, and "create an alert from this screen" is a
 * translation of the same two fields rather than a second model that has to be
 * kept in step.
 */

export const MAX_SCREEN_SYMBOLS = USD_WATCHLIST.length;
export const MAX_SCREEN_NAME_LENGTH = 60;

export type ScreenerDefinition = {
  name: string | null;
  condition: MarketAlertCondition;
  threshold: string;
  symbols: string[];
};

export type ScreenerValidation =
  | { valid: true; value: ScreenerDefinition }
  | { valid: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeName(value: unknown, required: boolean): string | null | { error: string } {
  if (value === undefined || value === null) {
    return required ? { error: "A screen name is required." } : null;
  }
  if (typeof value !== "string") return { error: "A screen name must be text." };
  const name = value.trim();
  if (name.length === 0) return required ? { error: "A screen name is required." } : null;
  if (name.length > MAX_SCREEN_NAME_LENGTH) {
    return { error: `A screen name may be at most ${MAX_SCREEN_NAME_LENGTH} characters.` };
  }
  // A name is rendered under `textContent`, but a control character still makes
  // an unreadable row; refuse it rather than store something the owner cannot
  // recognize in the saved list.
  if (/[\u0000-\u001f\u007f]/.test(name)) return { error: "A screen name cannot contain control characters." };
  return name;
}

/**
 * Validate one screen definition.
 *
 * `requireName` is true when the screen is being saved; an unsaved evaluation
 * has no name and is not asked for one. Symbols must be a non-empty, unique
 * subset of the curated USD watchlist, which is the same set the alert endpoint
 * accepts.
 */
export function validateScreenerDefinition(value: unknown, options: { requireName?: boolean } = {}): ScreenerValidation {
  if (!isRecord(value)) return { valid: false, error: "A screen definition must be an object." };
  if (!Object.hasOwn(value, "condition") || !Object.hasOwn(value, "threshold") || !Object.hasOwn(value, "symbols")) {
    return { valid: false, error: "A screen needs a condition, a threshold and at least one symbol." };
  }

  const threshold = validateConditionThreshold(value.condition, value.threshold);
  if (!threshold.valid) return threshold;

  if (!Array.isArray(value.symbols) || value.symbols.length === 0) {
    return { valid: false, error: "Choose at least one supported Coinbase USD market." };
  }
  if (value.symbols.length > MAX_SCREEN_SYMBOLS) {
    return { valid: false, error: `A screen can include at most ${MAX_SCREEN_SYMBOLS} symbols.` };
  }
  const symbols = value.symbols.map((symbol) => (typeof symbol === "string" ? symbol : ""));
  if (symbols.some((symbol) => !USD_WATCHLIST.some(({ productId }) => productId === symbol))) {
    return { valid: false, error: "Choose only supported Coinbase USD markets." };
  }
  const uniqueSymbols = [...new Set(symbols)];
  if (uniqueSymbols.length !== symbols.length) {
    return { valid: false, error: "Each symbol may appear only once in a screen." };
  }

  const name = normalizeName(value.name, options.requireName === true);
  if (name !== null && typeof name === "object") return { valid: false, error: name.error };

  return {
    valid: true,
    value: {
      name,
      condition: threshold.condition,
      threshold: threshold.threshold,
      symbols: uniqueSymbols,
    },
  };
}

/**
 * The alert rows a screen would create from its matched symbols.
 *
 * Only matching rows become alerts: creating one for a symbol that did not meet
 * the condition would make the alert fire immediately and would misrepresent
 * what the screen found. Each entry is validated by the same function the alert
 * endpoint uses, so the created rows cannot carry a threshold that endpoint
 * would have refused.
 */
export function screenAlertInputs(
  result: {
    condition: MarketAlertCondition;
    threshold: string;
    rows: readonly { symbol: string; matched: boolean }[];
  },
): NewMarketAlert[] {
  const inputs: NewMarketAlert[] = [];
  for (const row of result.rows) {
    if (!row.matched) continue;
    const validation = validateNewMarketAlert({
      symbol: row.symbol,
      condition: result.condition,
      threshold: result.threshold,
    });
    if (validation.valid) inputs.push(validation.value);
  }
  return inputs.sort((left, right) => left.symbol.localeCompare(right.symbol));
}

export type ScreenResultFingerprintRow = {
  symbol: string;
  value: string | null;
  observedAt: string | null;
  matched: boolean;
  providerId: string | null;
  reason?: string | null;
};

/**
 * A stable hash of what a screen found.
 *
 * It covers the rows and the condition that produced them, not the run time: two
 * runs over the same stored candles therefore produce the same hash, and the
 * saved-screen view can say "identical" without comparing prose. `asOf` is
 * stored beside the hash on the result row, which is what makes "same data and
 * same as-of time" a checkable claim rather than a remembered one.
 */
export function screenResultHash(input: {
  condition: MarketAlertCondition;
  threshold: string;
  rows: readonly ScreenResultFingerprintRow[];
}): string {
  const canonical = {
    condition: input.condition,
    threshold: input.threshold,
    rows: [...input.rows]
      .map((row) => ({
        symbol: row.symbol,
        value: row.value,
        observedAt: row.observedAt,
        matched: row.matched,
        providerId: row.providerId,
        reason: row.reason ?? null,
      }))
      .sort((left, right) => left.symbol.localeCompare(right.symbol)),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
