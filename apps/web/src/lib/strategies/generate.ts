import {
  AiRouteUnavailableError,
  runAiTextTask,
  type AiAttempt,
  type AiTextMessage,
} from "@/lib/ai/router";
import { DEFAULT_DEFINITION_TEMPLATE, renderStrategyText, type StrategyDefinition } from "./definition";
import { validateStrategyText } from "./validate";

/**
 * Plain English in, a definition the owner can read and edit out — with the whole
 * conversation kept.
 *
 * Generation is transparent by construction, not by policy: the prompt the model received,
 * the answer it returned and the validated definition are one object, and the caller stores
 * all three with the version. So "why does this rule exist" has an answer that is a
 * sentence and an output rather than a shrug, and a rule that looks wrong can be traced to
 * the wording that produced it.
 *
 * Two rules shape the answer:
 *
 *  1. **The model writes the editable text, nothing else.** It is asked for the same lines
 *     the panel edits, so its output is what the owner will actually run — no hidden JSON
 *     that a renderer summarises.
 *  2. **Generation never validates its own work.** The model's text goes through exactly
 *     the parser and validator a hand edit does, and an output that fails is returned as a
 *     refusal with the specific problems — never as a silently coerced strategy.
 *
 * A missing provider key is not a generation failure: it is surfaced as
 * {@link AiRouteUnavailableError} with the variable names, which is what the owner needs to
 * fix it.
 */

export const STRATEGY_PROMPT_VERSION = "strategy-definition-v1";
export const MIN_DESCRIPTION_LENGTH = 3;
export const MAX_DESCRIPTION_LENGTH = 500;

export type StrategyTextRun = {
  text: string;
  providerId: string;
  model: string | null;
  fallbackFrom: string | null;
  attempts: readonly AiAttempt[];
};

/** Injected in tests, and the seam that keeps generation free of network in a test run. */
export type StrategyTextRunner = (input: {
  userId: string | null;
  messages: readonly AiTextMessage[];
}) => Promise<StrategyTextRun>;

export type GenerationTrace = {
  promptVersion: string;
  system: string;
  user: string;
  rawOutput: string;
  providerId: string | null;
  model: string | null;
  fallbackFrom: string | null;
};

export type StrategyGeneration =
  | { ok: true; definition: StrategyDefinition; text: string; trace: GenerationTrace }
  | { ok: false; issues: string[]; trace: GenerationTrace | null };

export function strategySystemPrompt(): string {
  return [
    "You write trading strategy definitions for a backtesting tool.",
    "Answer with the definition text only: no prose, no markdown fence, no JSON.",
    `Use exactly these keywords, one per line, in this order: STRATEGY "name", MARKET, TIMEFRAME, ENTRY, EXIT, SIZE, STOP, DAILY_HALT, LEVERAGE.`,
    "An ENTRY or EXIT rule is an indicator, an operator and a threshold: e.g. RSI(14) CROSS_BELOW 30.",
    "Indicators: RSI(n), SMA(n), EMA(n), PRICE. Operators: CROSS_BELOW, CROSS_ABOVE, BELOW, ABOVE.",
    "TIMEFRAME must be 1d. SIZE looks like 25% OF CAPITAL. STOP is a percentage or NONE. DAILY_HALT is a percentage. LEVERAGE is 1x to 5x.",
    "A leveraged definition (LEVERAGE above 1x) must set a STOP.",
    "Choose MARKET from BTC-USD, ETH-USD, SOL-USD and the other Coinbase USD markets this tool lists.",
    `Example of the exact shape:\n${DEFAULT_DEFINITION_TEMPLATE}`,
  ].join("\n");
}

export function strategyUserPrompt(description: string): string {
  return `Write the definition for this strategy:\n${description.trim()}`;
}

/** The runner the route uses: the metered, router-backed text task for the strategy feature. */
export const aiTextStrategyRunner: StrategyTextRunner = async ({ userId, messages }) => {
  const run = await runAiTextTask({ feature: "strategy", userId, messages });
  return {
    text: run.text,
    providerId: run.providerId,
    model: run.model,
    fallbackFrom: run.fallbackFrom,
    attempts: run.attempts,
  };
};

/** Strip a markdown fence or a stray label the model may have added around the definition. */
export function extractDefinitionText(raw: string): string {
  const fenced = /```(?:[a-zA-Z]+)?\s*([\s\S]*?)```/.exec(raw);
  const body = (fenced?.[1] ?? raw).trim();
  return body
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:definition|strategy text|text)\s*:?\s*$/i.test(line))
    .join("\n")
    .trim();
}

function invalid(description: string): string | null {
  const trimmed = description.trim();
  if (trimmed.length < MIN_DESCRIPTION_LENGTH || trimmed.length > MAX_DESCRIPTION_LENGTH) {
    return `Describe the strategy in ${MIN_DESCRIPTION_LENGTH}–${MAX_DESCRIPTION_LENGTH} characters.`;
  }
  return null;
}

/**
 * Ask for a definition and validate what comes back.
 *
 * A provider that cannot be reached at all throws {@link AiRouteUnavailableError}; an answer
 * that does not validate returns `ok: false` with the parser's own problems and the raw
 * output, so the panel can show what the model wrote beside what is wrong with it.
 */
export async function generateStrategyFromDescription(input: {
  description: string;
  userId: string | null;
  runText?: StrategyTextRunner;
}): Promise<StrategyGeneration> {
  const problem = invalid(input.description);
  if (problem) return { ok: false, issues: [problem], trace: null };

  const system = strategySystemPrompt();
  const user = strategyUserPrompt(input.description);
  const runner = input.runText ?? aiTextStrategyRunner;
  const run = await runner({ userId: input.userId, messages: [{ role: "system", content: system }, { role: "user", content: user }] });

  const rawOutput = run.text;
  const trace: GenerationTrace = {
    promptVersion: STRATEGY_PROMPT_VERSION,
    system,
    user,
    rawOutput,
    providerId: run.providerId,
    model: run.model,
    fallbackFrom: run.fallbackFrom,
  };

  const candidate = extractDefinitionText(rawOutput);
  const validation = validateStrategyText(candidate);
  if (!validation.valid) return { ok: false, issues: validation.issues, trace };

  return { ok: true, definition: validation.definition, text: renderStrategyText(validation.definition), trace };
}

export { AiRouteUnavailableError };
