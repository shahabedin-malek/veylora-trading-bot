import { USD_WATCHLIST } from "@/lib/market-data/watchlist";

/**
 * A strategy as data, and as the lines of text the owner can edit.
 *
 * This is the phase's central claim made structural: a strategy is a typed value that
 * *renders* to the exact text the owner reads, and the text *parses* back to the same
 * value. There is no summary holding rules the definition does not contain, because the
 * rules are the definition and the text is a view of it.
 *
 * Three consequences follow from that one decision:
 *
 *  - **A rule can always be shown.** {@link validateStrategyDefinition} refuses a value it
 *    cannot round-trip through {@link renderStrategyText}/{@link parseStrategyText}, so
 *    "never accept a strategy whose rules cannot be shown" is a check rather than a
 *    promise.
 *  - **A problem names itself and its line.** Parsing reports `Line 4: unknown indicator
 *    "MACD"` rather than a generic rejection, which is what the owner needs to fix it.
 *  - **The format is small and legible.** Indicators, two conditions, a size, a stop, a
 *    daily halt and leverage — no expression language for a person to debug.
 *
 * The supported indicators are the ones the shared indicator math can compute exactly;
 * the market is the product list the data provider actually serves; and the only
 * timeframe is the daily candle this build fetches. Anything else is refused with the
 * name of what is missing, not silently approximated.
 */

export const STRATEGY_INDICATOR_TYPES = ["RSI", "SMA", "EMA", "PRICE"] as const;
export type StrategyIndicatorType = (typeof STRATEGY_INDICATOR_TYPES)[number];

export const STRATEGY_OPERATORS = ["CROSS_BELOW", "CROSS_ABOVE", "BELOW", "ABOVE"] as const;
export type StrategyOperator = (typeof STRATEGY_OPERATORS)[number];

export const SUPPORTED_TIMEFRAMES = ["1d"] as const;
export type StrategyTimeframe = (typeof SUPPORTED_TIMEFRAMES)[number];

export type StrategyIndicator = {
  type: StrategyIndicatorType;
  /** Null for `PRICE`, which has no window. */
  period: number | null;
};

export type StrategyCondition = {
  indicator: StrategyIndicator;
  operator: StrategyOperator;
  threshold: string;
};

export type StrategyDefinition = {
  name: string;
  market: string;
  timeframe: StrategyTimeframe;
  entry: StrategyCondition;
  exit: StrategyCondition;
  /** Percent of equity committed to one entry. */
  sizePercent: string;
  /** Distance below the entry fill, or null for no stop. */
  stopLossPercent: string | null;
  dailyLossHaltPercent: string;
  leverage: number;
};

export const MAX_DEFINITION_TEXT_LENGTH = 4_000;
export const MAX_DEFINITION_NAME_LENGTH = 80;

/** The keywords the editable form understands, in the order the renderer writes them. */
export const DEFINITION_KEYWORDS = [
  "STRATEGY",
  "MARKET",
  "TIMEFRAME",
  "ENTRY",
  "EXIT",
  "SIZE",
  "STOP",
  "DAILY_HALT",
  "LEVERAGE",
] as const;

/**
 * The example the panel starts from and the prompt teaches the model with.
 *
 * Rendered from a real definition rather than typed out twice, so the template cannot
 * drift from the parser: if the format changes, this text changes with it.
 */
export const DEFAULT_DEFINITION_TEMPLATE = renderStrategyText({
  name: "Oversold bounce",
  market: "BTC-USD",
  timeframe: "1d",
  entry: { indicator: { type: "RSI", period: 14 }, operator: "CROSS_BELOW", threshold: "30" },
  exit: { indicator: { type: "RSI", period: 14 }, operator: "CROSS_ABOVE", threshold: "70" },
  sizePercent: "25",
  stopLossPercent: "4",
  dailyLossHaltPercent: "2",
  leverage: 1,
});

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `RSI(14)`, `SMA(20)`, `EMA(12)` or `PRICE`. */
export function indicatorLabel(indicator: StrategyIndicator): string {
  return indicator.period === null ? indicator.type : `${indicator.type}(${indicator.period})`;
}

export function conditionLabel(condition: StrategyCondition): string {
  return `${indicatorLabel(condition.indicator)} ${condition.operator} ${condition.threshold}`;
}

export function operatorLabel(operator: StrategyOperator): string {
  switch (operator) {
    case "CROSS_BELOW":
      return "crosses below";
    case "CROSS_ABOVE":
      return "crosses above";
    case "BELOW":
      return "is below";
    case "ABOVE":
      return "is above";
  }
}

/**
 * The rules, one line each, for the panel's read-only list.
 *
 * The same values {@link renderStrategyText} writes, phrased for reading rather than for
 * editing — so a person can confirm what will run without parsing the edit box.
 */
export function definitionRules(definition: StrategyDefinition): string[] {
  return [
    `Market ${definition.market} on ${definition.timeframe} candles.`,
    `Entry when ${indicatorLabel(definition.entry.indicator)} ${operatorLabel(definition.entry.operator)} ${definition.entry.threshold}.`,
    `Exit when ${indicatorLabel(definition.exit.indicator)} ${operatorLabel(definition.exit.operator)} ${definition.exit.threshold}.`,
    `Size ${definition.sizePercent}% of equity per entry.`,
    definition.stopLossPercent
      ? `Stop-loss ${definition.stopLossPercent}% below the entry fill.`
      : "No stop-loss is configured on this definition.",
    `Daily-loss halt ${definition.dailyLossHaltPercent}%.`,
    definition.leverage > 1
      ? `Leverage ${definition.leverage}x, so daily funding is charged on the position.`
      : "Leverage 1x: no borrowed notional and no funding.",
  ];
}

/** The canonical editable text. Every parser input that validates renders back to this. */
export function renderStrategyText(definition: StrategyDefinition): string {
  return [
    `STRATEGY "${definition.name}"`,
    `MARKET ${definition.market}`,
    `TIMEFRAME ${definition.timeframe}`,
    `ENTRY ${conditionLabel(definition.entry)}`,
    `EXIT ${conditionLabel(definition.exit)}`,
    `SIZE ${definition.sizePercent}% OF CAPITAL`,
    `STOP ${definition.stopLossPercent === null ? "NONE" : `${definition.stopLossPercent}%`}`,
    `DAILY_HALT ${definition.dailyLossHaltPercent}%`,
    `LEVERAGE ${definition.leverage}x`,
  ].join("\n");
}

export type ParseProblem = { line: number; message: string };

export type ParseResult =
  | { ok: true; definition: StrategyDefinition }
  | { ok: false; problems: ParseProblem[] };

function parseIndicator(token: string): StrategyIndicator | string {
  const upper = token.trim().toUpperCase();
  if (upper === "PRICE") return { type: "PRICE", period: null };
  const match = /^(RSI|SMA|EMA)\((\d{1,3})\)$/.exec(upper);
  if (!match) {
    const bare = /^([A-Z]+)/.exec(upper)?.[1];
    if (bare && !/^(RSI|SMA|EMA|PRICE)$/.test(bare)) {
      return `Unknown indicator "${bare}". This build supports RSI, SMA, EMA and PRICE.`;
    }
    return `"${token.trim()}" is not an indicator. Write RSI(14), SMA(20), EMA(12) or PRICE.`;
  }
  return { type: match[1] as StrategyIndicatorType, period: Number(match[2]) };
}

function parseCondition(value: string): StrategyCondition | string {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 3) return "Write the rule as \"RSI(14) CROSS_BELOW 30\".";
  const indicator = parseIndicator(parts[0]!);
  if (typeof indicator === "string") return indicator;
  const operator = parts[1]!.toUpperCase();
  if (!(STRATEGY_OPERATORS as readonly string[]).includes(operator)) {
    return `Unknown operator "${parts[1]}". Use ${STRATEGY_OPERATORS.join(", ")}.`;
  }
  const threshold = parts[2]!;
  if (!DECIMAL.test(threshold)) return `"${threshold}" is not a decimal threshold.`;
  return { indicator, operator: operator as StrategyOperator, threshold };
}

/**
 * Parse the editable text. Every problem carries the line it was found on.
 *
 * Parsing is deliberately separate from validation: this function says whether the text
 * is well-formed and which keyword failed, while {@link validateStrategyDefinition} says
 * whether the rules can actually run. The owner sees both, in that order.
 */
export function parseStrategyText(text: string): ParseResult {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, problems: [{ line: 0, message: "Describe the strategy as one keyword per line." }] };
  }
  if (text.length > MAX_DEFINITION_TEXT_LENGTH) {
    return {
      ok: false,
      problems: [{ line: 0, message: `A definition is at most ${MAX_DEFINITION_TEXT_LENGTH} characters.` }],
    };
  }

  const fields: Record<string, { line: number; value: string }> = {};
  const problems: ParseProblem[] = [];

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = index + 1;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const spaceIndex = trimmed.search(/\s/);
    const keyword = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).toUpperCase();
    const value = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex).trim();
    if (!(DEFINITION_KEYWORDS as readonly string[]).includes(keyword)) {
      problems.push({
        line,
        message: `Unknown line "${keyword}". This build understands ${DEFINITION_KEYWORDS.join(", ")}.`,
      });
      return;
    }
    if (fields[keyword]) {
      problems.push({ line, message: `${keyword} appears more than once.` });
      return;
    }
    if (!value) {
      problems.push({ line, message: `${keyword} needs a value.` });
      return;
    }
    fields[keyword] = { line, value };
  });

  if (problems.length > 0) return { ok: false, problems };

  for (const keyword of DEFINITION_KEYWORDS) {
    if (!fields[keyword]) problems.push({ line: 0, message: `The strategy is missing ${keyword}.` });
  }
  if (problems.length > 0) return { ok: false, problems };

  const nameRaw = fields.STRATEGY!.value;
  const name = nameRaw.replace(/^"(.*)"$/, "$1").trim();
  const entry = parseCondition(fields.ENTRY!.value);
  if (typeof entry === "string") problems.push({ line: fields.ENTRY!.line, message: `ENTRY: ${entry}` });
  const exit = parseCondition(fields.EXIT!.value);
  if (typeof exit === "string") problems.push({ line: fields.EXIT!.line, message: `EXIT: ${exit}` });

  const sizeMatch = /^(\d+(?:\.\d{1,8})?)\s*%(?:\s+OF\s+CAPITAL)?$/i.exec(fields.SIZE!.value);
  if (!sizeMatch) {
    problems.push({ line: fields.SIZE!.line, message: "SIZE must look like \"25% OF CAPITAL\"." });
  }

  const stopRaw = fields.STOP!.value.trim();
  let stopLossPercent: string | null = null;
  if (/^NONE$/i.test(stopRaw)) stopLossPercent = null;
  else {
    const stopMatch = /^(\d+(?:\.\d{1,8})?)\s*%$/.exec(stopRaw);
    if (!stopMatch) {
      problems.push({ line: fields.STOP!.line, message: "STOP must be a percentage such as \"4%\" or NONE." });
    } else {
      stopLossPercent = stopMatch[1]!;
    }
  }

  const haltMatch = /^(\d+(?:\.\d{1,8})?)\s*%$/.exec(fields.DAILY_HALT!.value.trim());
  if (!haltMatch) {
    problems.push({ line: fields.DAILY_HALT!.line, message: "DAILY_HALT must be a percentage such as \"2%\"." });
  }

  const leverageMatch = /^(\d{1,2})\s*x?$/i.exec(fields.LEVERAGE!.value.trim());
  if (!leverageMatch) {
    problems.push({ line: fields.LEVERAGE!.line, message: "LEVERAGE must be a whole number such as \"1x\"." });
  }

  const timeframe = fields.TIMEFRAME!.value.trim().toLowerCase();
  if (!(SUPPORTED_TIMEFRAMES as readonly string[]).includes(timeframe)) {
    problems.push({
      line: fields.TIMEFRAME!.line,
      message: `TIMEFRAME "${fields.TIMEFRAME!.value.trim()}" is not supported. This build backtests ${SUPPORTED_TIMEFRAMES.join(", ")} candles.`,
    });
  }

  if (problems.length > 0 || typeof entry === "string" || typeof exit === "string") {
    return { ok: false, problems };
  }

  return {
    ok: true,
    definition: {
      name,
      market: fields.MARKET!.value.trim().toUpperCase(),
      timeframe: timeframe as StrategyTimeframe,
      entry,
      exit,
      sizePercent: sizeMatch![1]!,
      stopLossPercent,
      dailyLossHaltPercent: haltMatch![1]!,
      leverage: Number(leverageMatch![1]!),
    },
  };
}

export function supportedMarkets(): string[] {
  return USD_WATCHLIST.map(({ productId }) => productId);
}

/** Stable string for comparison, so a round-trip can be checked field by field. */
export function definitionFingerprint(definition: StrategyDefinition): string {
  return JSON.stringify(renderStrategyText(definition));
}

export { isRecord as isStrategyRecord };
