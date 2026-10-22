import {
  MAX_DEFINITION_NAME_LENGTH,
  STRATEGY_INDICATOR_TYPES,
  STRATEGY_OPERATORS,
  SUPPORTED_TIMEFRAMES,
  definitionFingerprint,
  isStrategyRecord,
  parseStrategyText,
  renderStrategyText,
  supportedMarkets,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyIndicatorType,
  type StrategyOperator,
} from "./definition";

/**
 * Whether a definition can actually run, and if not, what is wrong with it.
 *
 * The rule this module exists to keep: **a refusal names the specific problem**. "Invalid
 * strategy" tells the owner nothing they can act on, so every issue here is a sentence
 * about one value — which indicator is unknown, which two thresholds are inverted, which
 * size is zero. The panel renders the list as-is.
 *
 * Validation is also where "never accept a strategy whose rules cannot be shown" lives.
 * A definition must survive a render-then-parse round trip producing the same text;
 * otherwise the owner would be running rules the screen cannot display, and a later edit
 * could silently change them.
 */

export type DefinitionValidation =
  | { valid: true; definition: StrategyDefinition }
  | { valid: false; issues: string[] };

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/;
const LOWER_SIDE: readonly StrategyOperator[] = ["CROSS_BELOW", "BELOW"];
const UPPER_SIDE: readonly StrategyOperator[] = ["CROSS_ABOVE", "ABOVE"];
const MAX_LEVERAGE = 5;

export function isDecimalText(value: unknown): value is string {
  return typeof value === "string" && DECIMAL.test(value.trim());
}

function numeric(value: string): number {
  return Number(value);
}

function validateCondition(
  value: unknown,
  label: "ENTRY" | "EXIT",
  issues: string[],
): StrategyCondition | null {
  if (!isStrategyRecord(value)) {
    issues.push(`${label} must be a rule with an indicator, an operator and a threshold.`);
    return null;
  }
  const indicator = value.indicator;
  if (!isStrategyRecord(indicator)) {
    issues.push(`${label} needs an indicator such as RSI(14).`);
    return null;
  }
  const type = indicator.type;
  if (typeof type !== "string" || !(STRATEGY_INDICATOR_TYPES as readonly string[]).includes(type)) {
    issues.push(
      `${label} uses an unknown indicator "${String(type)}". This build supports ${STRATEGY_INDICATOR_TYPES.join(", ")}.`,
    );
    return null;
  }
  const period = indicator.period;
  if (type === "PRICE") {
    if (period !== null && period !== undefined) {
      issues.push(`${label}: PRICE takes no window; write PRICE rather than PRICE(${String(period)}).`);
      return null;
    }
  } else if (typeof period !== "number" || !Number.isInteger(period) || period < 2 || period > 200) {
    issues.push(`${label}: ${type} needs a whole period between 2 and 200, such as ${type}(14).`);
    return null;
  }
  const operator = value.operator;
  if (typeof operator !== "string" || !(STRATEGY_OPERATORS as readonly string[]).includes(operator)) {
    issues.push(`${label} uses an unknown operator "${String(operator)}". Use ${STRATEGY_OPERATORS.join(", ")}.`);
    return null;
  }
  if (!isDecimalText(value.threshold) || numeric(value.threshold as string) <= 0) {
    issues.push(`${label} threshold must be a decimal greater than zero.`);
    return null;
  }
  return {
    indicator: { type: type as StrategyIndicatorType, period: type === "PRICE" ? null : (period as number) },
    operator: operator as StrategyOperator,
    threshold: String(value.threshold).trim(),
  };
}

function sameIndicator(left: StrategyCondition, right: StrategyCondition): boolean {
  return left.indicator.type === right.indicator.type && left.indicator.period === right.indicator.period;
}

/**
 * The inverted-range check, which is the one a person makes by accident.
 *
 * When both rules watch the same indicator, the entry and exit must be on opposite sides
 * and in the direction the operator implies: an entry that fires *below* 30 followed by an
 * exit *above* 70 is coherent, while an entry below 70 with an exit above 30 would re-enter
 * the moment it exited. The message prints both numbers.
 */
function checkRange(entry: StrategyCondition, exit: StrategyCondition, issues: string[]): void {
  if (!sameIndicator(entry, exit)) return;
  const entryLower = LOWER_SIDE.includes(entry.operator);
  const exitUpper = UPPER_SIDE.includes(exit.operator);
  if (entryLower && exitUpper) {
    if (numeric(entry.threshold) >= numeric(exit.threshold)) {
      issues.push(
        `The entry threshold (${entry.threshold}) must be below the exit threshold (${exit.threshold}) for a strategy that buys low and sells high.`,
      );
    }
    return;
  }
  if (UPPER_SIDE.includes(entry.operator) && LOWER_SIDE.includes(exit.operator)) {
    if (numeric(entry.threshold) <= numeric(exit.threshold)) {
      issues.push(
        `The entry threshold (${entry.threshold}) must be above the exit threshold (${exit.threshold}) for a strategy that sells high and buys back low.`,
      );
    }
  }
}

export function validateStrategyDefinition(value: unknown): DefinitionValidation {
  if (!isStrategyRecord(value)) return { valid: false, issues: ["The definition must be an object."] };

  const allowed = new Set([
    "name",
    "market",
    "timeframe",
    "entry",
    "exit",
    "sizePercent",
    "stopLossPercent",
    "dailyLossHaltPercent",
    "leverage",
  ]);
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) {
    return { valid: false, issues: [`The definition carries unsupported field(s): ${unsupported.join(", ")}.`] };
  }

  const issues: string[] = [];

  const name = typeof value.name === "string" ? value.name.trim().replace(/^"(.*)"$/, "$1").trim() : "";
  if (!name || name.length > MAX_DEFINITION_NAME_LENGTH) {
    issues.push(`The strategy needs a name of 1–${MAX_DEFINITION_NAME_LENGTH} characters.`);
  }

  const market = typeof value.market === "string" ? value.market.trim().toUpperCase() : "";
  if (!supportedMarkets().includes(market)) {
    issues.push(`"${market || "no market"}" is not a market this build has history for. Choose one from the market list.`);
  }

  const timeframe = typeof value.timeframe === "string" ? value.timeframe.trim().toLowerCase() : "";
  if (!(SUPPORTED_TIMEFRAMES as readonly string[]).includes(timeframe)) {
    issues.push(`"${timeframe || "no timeframe"}" is not supported; this build backtests ${SUPPORTED_TIMEFRAMES.join(", ")} candles.`);
  }

  const entry = validateCondition(value.entry, "ENTRY", issues);
  const exit = validateCondition(value.exit, "EXIT", issues);
  if (entry && exit) {
    if (
      entry.operator === exit.operator &&
      entry.threshold === exit.threshold &&
      sameIndicator(entry, exit)
    ) {
      issues.push("The entry and exit rules are identical, so there would be no exit to take.");
    } else {
      checkRange(entry, exit, issues);
    }
  }

  const sizePercent = typeof value.sizePercent === "string" ? value.sizePercent.trim() : "";
  if (!isDecimalText(sizePercent) || numeric(sizePercent) <= 0 || numeric(sizePercent) > 100) {
    issues.push("The size must be a percentage of equity greater than zero and no more than 100%.");
  }

  const stopLossPercent =
    value.stopLossPercent === null || value.stopLossPercent === undefined
      ? null
      : typeof value.stopLossPercent === "string"
        ? value.stopLossPercent.trim()
        : "";
  if (stopLossPercent !== null && (!isDecimalText(stopLossPercent) || numeric(stopLossPercent) <= 0 || numeric(stopLossPercent) > 50)) {
    issues.push("The stop-loss must be a percentage greater than zero and no more than 50%, or NONE.");
  }

  const dailyLossHaltPercent = typeof value.dailyLossHaltPercent === "string" ? value.dailyLossHaltPercent.trim() : "";
  if (!isDecimalText(dailyLossHaltPercent) || numeric(dailyLossHaltPercent) <= 0 || numeric(dailyLossHaltPercent) > 20) {
    issues.push("The daily-loss halt must be a percentage greater than zero and no more than 20%.");
  }

  const leverage = value.leverage;
  if (typeof leverage !== "number" || !Number.isInteger(leverage) || leverage < 1 || leverage > MAX_LEVERAGE) {
    issues.push(`Leverage must be a whole number from 1 to ${MAX_LEVERAGE}.`);
  } else if (leverage > 1 && stopLossPercent === null) {
    issues.push("A leveraged position needs a stop-loss: set STOP to a percentage, or keep leverage at 1x.");
  }

  if (issues.length > 0) return { valid: false, issues };

  const definition: StrategyDefinition = {
    name,
    market,
    timeframe: timeframe as StrategyDefinition["timeframe"],
    entry: entry!,
    exit: exit!,
    sizePercent,
    stopLossPercent,
    dailyLossHaltPercent,
    leverage: leverage as number,
  };

  // The round trip is the "rules can be shown" guarantee. A value that renders and parses
  // back to itself is one the owner can read, edit and re-run without the meaning moving.
  const reparsed = parseStrategyText(renderStrategyText(definition));
  if (!reparsed.ok) {
    return {
      valid: false,
      issues: [
        `The rules cannot be shown in the editable form: ${reparsed.problems.map((problem) => problem.message).join(" ")}`,
      ],
    };
  }
  if (definitionFingerprint(reparsed.definition) !== definitionFingerprint(definition)) {
    return {
      valid: false,
      issues: ["The rules cannot be shown in the editable form: the text does not read back to the same definition."],
    };
  }

  return { valid: true, definition };
}

/**
 * Validate the editable text: parse it, then validate what it produced.
 *
 * The two failure modes stay distinct on purpose — a syntax problem names its line, while
 * a value problem names the value — and both are returned as a flat list the panel prints.
 */
export function validateStrategyText(text: string): DefinitionValidation {
  const parsed = parseStrategyText(text);
  if (!parsed.ok) {
    return { valid: false, issues: parsed.problems.map((problem) => (problem.line ? `Line ${problem.line}: ${problem.message}` : problem.message)) };
  }
  return validateStrategyDefinition(parsed.definition);
}
