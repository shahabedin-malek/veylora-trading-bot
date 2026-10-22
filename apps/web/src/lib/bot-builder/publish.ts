import DecimalJS from "decimal.js";
import type { StrategyDefinition as RunnerStrategyDefinition } from "@/lib/strategies/decide";
import {
  renderStrategyText,
  type StrategyDefinition,
} from "@/lib/strategies/definition";
import { validateStrategyDefinition } from "@/lib/strategies/validate";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";

/**
 * Publishing a bot (phase 30).
 *
 * The builder's form is a bot configuration; the runner executes a phase-28 definition. This
 * module is the one place those two vocabularies meet: `botDefinition` is the mapping,
 * `validateBotConfig` refuses a value with the field it belongs to, and
 * `runnerStrategyForBot` is how a published row becomes something the decision loop loads.
 *
 * Keeping the mapping here — pure, no database — is what makes "publishing validates against
 * the definition schema" a property a test can check without a runner, and what keeps the
 * runner from growing a second definition of what a bot means.
 */

const Decimal = DecimalJS.clone({ precision: 40 });

export const BOT_STATES = ["DRAFT", "PUBLISHED", "DELETED"] as const;
export type BotState = (typeof BOT_STATES)[number];

export const BOT_STRATEGY_PREFIX = "bot:";
const MAX_BUDGET_USD = "1000000000";
const MAX_NAME_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 280;

export type BotConfig = {
  name: string;
  description: string;
  market: string;
  entryRsiBelow: string;
  exitRsiAbove: string;
  /** Percent of the backtest equity committed to one entry. */
  sizePercent: string;
  stopLossPercent: string;
  dailyLossHaltPercent: string;
  /** The notional one entry spends when the runner places a paper order. */
  budgetUsd: string;
  /** Starting capital for the full-period backtest. */
  initialCapitalUsd: string;
};

export const DEFAULT_BOT_CONFIG: BotConfig = {
  name: "",
  description: "",
  market: "BTC-USD",
  entryRsiBelow: "30",
  exitRsiAbove: "70",
  sizePercent: "25",
  stopLossPercent: "4",
  dailyLossHaltPercent: "2",
  budgetUsd: "25",
  initialCapitalUsd: "10000",
};

export type BotConfigProblem = { field: string; message: string };

export type BotConfigValidation =
  | { valid: true; value: BotConfig }
  | { valid: false; problems: BotConfigProblem[]; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value.trim());
}

const CONFIG_KEYS: readonly (keyof BotConfig)[] = [
  "name",
  "description",
  "market",
  "entryRsiBelow",
  "exitRsiAbove",
  "sizePercent",
  "stopLossPercent",
  "dailyLossHaltPercent",
  "budgetUsd",
  "initialCapitalUsd",
];

/** The phase-28 definition a bot's form describes. */
export function botDefinition(config: BotConfig): StrategyDefinition {
  return {
    name: config.name.trim(),
    market: config.market.trim().toUpperCase(),
    timeframe: "1d",
    entry: { indicator: { type: "RSI", period: 14 }, operator: "CROSS_BELOW", threshold: config.entryRsiBelow },
    exit: { indicator: { type: "RSI", period: 14 }, operator: "CROSS_ABOVE", threshold: config.exitRsiAbove },
    sizePercent: config.sizePercent,
    stopLossPercent: config.stopLossPercent,
    dailyLossHaltPercent: config.dailyLossHaltPercent,
    leverage: 1,
  };
}

export function botDefinitionText(config: BotConfig): string {
  return renderStrategyText(botDefinition(config));
}

/**
 * Which form field a definition issue belongs to.
 *
 * The phase-28 validator writes sentences, not field names, because its own panel shows them
 * beside editable text. A bot form needs the field: "ENTRY threshold must be…" is only
 * actionable next to the entry box. The mapping is by the sentence's leading word, and a
 * sentence that matches nothing is reported as `definition` rather than dropped.
 */
function fieldForIssue(issue: string): string {
  if (issue.startsWith("The strategy needs a name")) return "name";
  if (issue.includes("is not a market")) return "market";
  if (issue.startsWith("ENTRY")) return "entryRsiBelow";
  if (issue.startsWith("EXIT")) return "exitRsiAbove";
  if (issue.includes("entry threshold") || issue.includes("entry and exit")) return "entryRsiBelow";
  if (issue.startsWith("The size")) return "sizePercent";
  if (issue.includes("stop-loss")) return "stopLossPercent";
  if (issue.includes("daily-loss")) return "dailyLossHaltPercent";
  if (issue.startsWith("Leverage")) return "definition";
  if (issue.includes("timeframe")) return "market";
  return "definition";
}

/**
 * Validate a builder submission. Every problem names the field it belongs to, and `error`
 * is the first sentence so a route can answer without the caller re-formatting the list.
 */
export function validateBotConfig(value: unknown): BotConfigValidation {
  if (!isRecord(value)) {
    return { valid: false, problems: [{ field: "config", message: "A bot configuration is required." }], error: "A bot configuration is required." };
  }
  const keys = Object.keys(value);
  const unsupported = keys.filter((key) => !(CONFIG_KEYS as readonly string[]).includes(key));
  if (unsupported.length > 0) {
    const message = `Unsupported field(s): ${unsupported.join(", ")}.`;
    return { valid: false, problems: [{ field: unsupported[0]!, message }], error: message };
  }

  const problems: BotConfigProblem[] = [];
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > MAX_NAME_LENGTH) {
    problems.push({ field: "name", message: `Name must be 1–${MAX_NAME_LENGTH} characters.` });
  }
  const description = typeof value.description === "string" ? value.description.trim() : "";
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    problems.push({ field: "description", message: `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters.` });
  }
  if (typeof value.market !== "string" || !USD_WATCHLIST.some(({ productId }) => productId === value.market)) {
    problems.push({ field: "market", message: "Market must be one of the Coinbase USD markets this build has history for." });
  }
  for (const field of ["entryRsiBelow", "exitRsiAbove", "sizePercent", "stopLossPercent", "dailyLossHaltPercent"] as const) {
    if (!isDecimal(value[field])) problems.push({ field, message: `${field} must be a plain decimal.` });
  }
  for (const field of ["budgetUsd", "initialCapitalUsd"] as const) {
    if (!isDecimal(value[field])) {
      problems.push({ field, message: `${field} must be a plain decimal.` });
      continue;
    }
    const amount = new Decimal(value[field] as string);
    if (!amount.isFinite() || amount.lte(0) || amount.gt(MAX_BUDGET_USD)) {
      problems.push({ field, message: `${field} must be greater than zero and no more than ${MAX_BUDGET_USD}.` });
    }
  }
  if (problems.length > 0) {
    return { valid: false, problems, error: problems[0]!.message };
  }

  const config: BotConfig = {
    name,
    description,
    market: value.market as string,
    entryRsiBelow: (value.entryRsiBelow as string).trim(),
    exitRsiAbove: (value.exitRsiAbove as string).trim(),
    sizePercent: (value.sizePercent as string).trim(),
    stopLossPercent: (value.stopLossPercent as string).trim(),
    dailyLossHaltPercent: (value.dailyLossHaltPercent as string).trim(),
    budgetUsd: (value.budgetUsd as string).trim(),
    initialCapitalUsd: (value.initialCapitalUsd as string).trim(),
  };

  // The same schema the runner and the backtester execute. Publishing is not allowed to
  // accept a value that the phase-28 validator would refuse.
  const definition = validateStrategyDefinition(botDefinition(config));
  if (!definition.valid) {
    const mapped = definition.issues.map((issue) => ({ field: fieldForIssue(issue), message: issue }));
    return { valid: false, problems: mapped, error: mapped[0]!.message };
  }

  return { valid: true, value: config };
}

/**
 * The runner's view of a published bot.
 *
 * A daily-close strategy is evaluated once per UTC day: `decisionIntervalMinutes` is 1440, so
 * the window is the day itself and a five-minute runner cadence cannot evaluate it twice.
 * `budgetUsd` is the builder's per-entry notional, which is the amount an entry spends.
 */
export function runnerStrategyForBot(bot: {
  id: string;
  name: string;
  market: string;
  config: BotConfig;
  definitionVersion: number | null;
}): RunnerStrategyDefinition {
  return {
    id: botStrategyId(bot.id),
    label: `${bot.name}${bot.definitionVersion ? ` · v${bot.definitionVersion}` : ""}`,
    market: bot.config.market.toUpperCase(),
    decisionIntervalMinutes: 1_440,
    entryRsiBelow: bot.config.entryRsiBelow,
    exitRsiAbove: bot.config.exitRsiAbove,
    stopLossPercent: bot.config.stopLossPercent,
    budgetUsd: bot.config.budgetUsd,
    detail:
      `A published ${bot.market} bot: buys when RSI-14 on closed daily candles crosses below ` +
      `${bot.config.entryRsiBelow}, exits above ${bot.config.exitRsiAbove} or at the ` +
      `${bot.config.stopLossPercent}% stop, one decision per UTC day.`,
  };
}

export function botStrategyId(botId: string): string {
  return `${BOT_STRATEGY_PREFIX}${botId}`;
}

export function parseBotStrategyId(strategyId: string | null | undefined): string | null {
  if (!strategyId || !strategyId.startsWith(BOT_STRATEGY_PREFIX)) return null;
  const id = strategyId.slice(BOT_STRATEGY_PREFIX.length).trim();
  return id || null;
}

export type BotCapKind = "bots" | "venue connections";

/** The sentence a cap refusal carries: the cap, the tier, the usage, and where to change it. */
export function botCapMessage(kind: BotCapKind, cap: number, usage: number, tierLabel = "current"): string {
  const noun = kind === "bots" ? "bot" : "connected venue";
  const plural = usage === 1 ? noun : `${noun}s`;
  return `This account is at its ${kind} cap on the ${tierLabel} tier: ${usage} of ${cap} ${plural} in use. ` +
    `Delete one or raise the cap in Admin → Fees (tier caps). Nothing was created.`;
}

export function slugifyTemplateName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || "template";
}
