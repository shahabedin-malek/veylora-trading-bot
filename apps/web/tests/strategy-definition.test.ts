import assert from "node:assert/strict";
import test from "node:test";
import { AiRouteUnavailableError } from "@/lib/ai/router";
import {
  DEFAULT_DEFINITION_TEMPLATE,
  definitionRules,
  parseStrategyText,
  renderStrategyText,
  type StrategyDefinition,
} from "@/lib/strategies/definition";
import { generateStrategyFromDescription, type StrategyTextRunner } from "@/lib/strategies/generate";
import { validateStrategyDefinition, validateStrategyText } from "@/lib/strategies/validate";

/**
 * Phase 28, graded on the properties its acceptance criteria name:
 *
 *  1. A definition is typed and renders to text that parses back to the same value — which
 *     is what "the rules are visible and editable" means in code rather than in prose.
 *  2. A refusal names the specific problem: the unknown indicator, the inverted range, the
 *     zero size. Each test asserts the sentence names the value.
 *  3. Generation keeps the prompt and the model's raw output beside the validated
 *     definition, and an answer that does not validate is a refusal that still shows both.
 */

const definition: StrategyDefinition = {
  name: "Oversold bounce",
  market: "BTC-USD",
  timeframe: "1d",
  entry: { indicator: { type: "RSI", period: 14 }, operator: "CROSS_BELOW", threshold: "30" },
  exit: { indicator: { type: "RSI", period: 14 }, operator: "CROSS_ABOVE", threshold: "70" },
  sizePercent: "25",
  stopLossPercent: "4",
  dailyLossHaltPercent: "2",
  leverage: 1,
};

test("a definition renders to editable text that parses back to the same rules", () => {
  const text = renderStrategyText(definition);
  const parsed = parseStrategyText(text);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.definition, definition);
  assert.equal(renderStrategyText(parsed.definition), text);
  assert.equal(validateStrategyDefinition(definition).valid, true);

  // The template the panel starts from and the prompt teaches with is itself valid.
  assert.equal(validateStrategyText(DEFAULT_DEFINITION_TEMPLATE).valid, true);
  const rules = definitionRules(definition);
  assert.ok(rules.some((rule) => rule.includes("RSI(14) crosses below 30")));
  assert.ok(rules.some((rule) => rule.includes("25% of equity")));
});

test("an unknown indicator is refused with its name", () => {
  const text = DEFAULT_DEFINITION_TEMPLATE.replace("RSI(14) CROSS_BELOW 30", "MACD(12) CROSS_BELOW 30");
  const result = validateStrategyText(text);
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.ok(result.issues.some((issue) => /Unknown indicator "MACD"/.test(issue)), result.issues.join(" | "));
  assert.ok(result.issues.some((issue) => issue.startsWith("Line 4:")), "the problem carries its line");
});

test("an inverted entry and exit range is refused with both numbers", () => {
  const result = validateStrategyDefinition({ ...definition, entry: { ...definition.entry, threshold: "80" } });
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.ok(
    result.issues.some((issue) => issue.includes("entry threshold (80)") && issue.includes("exit threshold (70)")),
    result.issues.join(" | "),
  );
});

test("a zero size, a leveraged definition with no stop, and an unknown market are each named", () => {
  const zero = validateStrategyDefinition({ ...definition, sizePercent: "0" });
  assert.equal(zero.valid, false);
  if (!zero.valid) assert.ok(zero.issues.some((issue) => /size must be a percentage/.test(issue)));

  const leveraged = validateStrategyDefinition({ ...definition, leverage: 3, stopLossPercent: null });
  assert.equal(leveraged.valid, false);
  if (!leveraged.valid) assert.ok(leveraged.issues.some((issue) => /leveraged position needs a stop-loss/.test(issue)));

  const market = validateStrategyDefinition({ ...definition, market: "DOGE-XYZ" });
  assert.equal(market.valid, false);
  if (!market.valid) assert.ok(market.issues.some((issue) => /DOGE-XYZ\" is not a market/.test(issue)));

  const identical = validateStrategyDefinition({ ...definition, exit: { ...definition.entry } });
  assert.equal(identical.valid, false);
  if (!identical.valid) assert.ok(identical.issues.some((issue) => /entry and exit rules are identical/.test(issue)));
});

test("generation validates the model's answer and stores the prompt and raw output beside it", async () => {
  const answer = 'STRATEGY "Bounce"\nMARKET ETH-USD\nTIMEFRAME 1d\n\nENTRY SMA(20) CROSS_ABOVE 1500\nEXIT SMA(50) BELOW 1400\nSIZE 10% OF CAPITAL\nSTOP NONE\nDAILY_HALT 3%\nLEVERAGE 1x';
  const runner: StrategyTextRunner = async ({ messages }) => {
    assert.ok(messages.some((message) => message.role === "system" && message.content.includes("CROSS_BELOW")));
    assert.ok(messages.some((message) => message.role === "user" && message.content.includes("ethereum")));
    return { text: `Sure!\n\`\`\`\n${answer}\n\`\`\``, providerId: "chaingpt", model: "general_assistant", fallbackFrom: null, attempts: [] };
  };

  const generation = await generateStrategyFromDescription({
    description: "buy ethereum when it starts climbing and exit when it falls back",
    userId: "user-1",
    runText: runner,
  });
  assert.equal(generation.ok, true);
  if (!generation.ok) return;
  assert.equal(generation.definition.market, "ETH-USD");
  assert.equal(generation.definition.entry.indicator.type, "SMA");
  assert.equal(generation.text, renderStrategyText(generation.definition));
  assert.equal(generation.trace.providerId, "chaingpt");
  assert.equal(generation.trace.model, "general_assistant");
  assert.ok(generation.trace.rawOutput.includes("```"), "the raw answer is kept verbatim");
  assert.ok(generation.trace.system.length > 0 && generation.trace.user.includes("ethereum"));
});

test("an answer that cannot run is refused with the specific problem and the raw output", async () => {
  const runner: StrategyTextRunner = async () => ({
    text: renderStrategyText(definition).replace("RSI(14) CROSS_BELOW 30", "RSI(14) CROSS_BELOW 700"),
    providerId: "ai-gateway",
    model: "gpt-x",
    fallbackFrom: "chaingpt",
    attempts: [],
  });
  const generation = await generateStrategyFromDescription({ description: "buy RSI dips", userId: "user-1", runText: runner });
  assert.equal(generation.ok, false);
  if (generation.ok) return;
  assert.ok(generation.issues.some((issue) => /must be below the exit threshold/.test(issue)), generation.issues.join(" | "));
  assert.equal(generation.trace?.providerId, "ai-gateway");
  assert.equal(generation.trace?.fallbackFrom, "chaingpt");
  assert.ok((generation.trace?.rawOutput ?? "").includes("700"), "the owner sees what the model actually wrote");
});

test("a provider that cannot be reached surfaces the missing key names rather than a generic failure", async () => {
  const runner: StrategyTextRunner = async () => {
    throw new AiRouteUnavailableError("No provider can serve strategy right now. Set CHAINGPT_API_KEY.", ["CHAINGPT_API_KEY"], []);
  };
  await assert.rejects(
    () => generateStrategyFromDescription({ description: "buy the dip", userId: "user-1", runText: runner }),
    (error: unknown) => error instanceof AiRouteUnavailableError && error.missingKeys.includes("CHAINGPT_API_KEY"),
  );
});

test("a description that is too short is refused before any provider is called", async () => {
  let called = false;
  const generation = await generateStrategyFromDescription({
    description: "x",
    userId: "user-1",
    runText: async () => {
      called = true;
      throw new Error("must not be called");
    },
  });
  assert.equal(generation.ok, false);
  assert.equal(called, false);
});
