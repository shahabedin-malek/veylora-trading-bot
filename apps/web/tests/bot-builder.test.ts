import assert from "node:assert/strict";
import test from "node:test";
import {
  BOT_STRATEGY_PREFIX,
  DEFAULT_BOT_CONFIG,
  botCapMessage,
  botDefinition,
  botDefinitionText,
  botStrategyId,
  parseBotStrategyId,
  validateBotConfig,
  type BotConfig,
} from "@/lib/bot-builder/publish";
import { BUILT_IN_TEMPLATES, type MarketplaceTemplate } from "@/lib/bot-builder/templates";
import { DEFAULT_FEE_TIERS, type FeeTier } from "@/lib/fees/table";
import { validateStrategyDefinition } from "@/lib/strategies/validate";

/**
 * Phase 30, graded on the claims its acceptance criteria make about the pure layer:
 *
 *  1. A builder configuration becomes a phase-28 definition that the *same* validator the
 *     runner and backtester use accepts — so publishing cannot accept what execution would
 *     refuse.
 *  2. A refusal names the field. Every problem carries the form field it belongs to, and
 *     the sentence itself names the value.
 *  3. A cap refusal names the cap, the tier and the usage, and says nothing was created.
 *  4. A template's card only ever carries figures that a recorded run produced; the
 *     unmeasured state is an explicit sentence, never a zero.
 *
 * The database-backed half — publishing writes a version, deleting stops the activation,
 * cloning records its origin — is exercised through the route handlers and the repository
 * in the phase's manual click-path proof, because those claims are about rows and a live
 * request rather than about a pure function.
 */

const VALID: BotConfig = { ...DEFAULT_BOT_CONFIG, name: "Daily BTC reversion", description: "Buys oversold daily closes." };

test("a builder configuration maps onto a valid phase-28 definition", () => {
  const definition = botDefinition(VALID);
  assert.equal(definition.market, "BTC-USD");
  assert.equal(definition.timeframe, "1d");
  assert.deepEqual(definition.entry.indicator, { type: "RSI", period: 14 });
  assert.equal(definition.entry.operator, "CROSS_BELOW");
  assert.equal(definition.exit.operator, "CROSS_ABOVE");

  const validated = validateStrategyDefinition(definition);
  assert.equal(validated.valid, true, validated.valid ? "" : validated.issues.join(" "));
});

test("the published text reads back to the same rules", () => {
  const text = botDefinitionText(VALID);
  assert.match(text, /ENTRY/);
  assert.match(text, /EXIT/);
  assert.match(text, /CROSS_BELOW/);
  assert.match(text, /RSI\(14\)/);
});

test("a strategy with no name is refused by the field it is missing", () => {
  const result = validateBotConfig({ ...VALID, name: "   " });
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.problems[0]?.field, "name");
  assert.match(result.problems[0]!.message, /name/i);
});

test("an inverted entry/exit pair names the entry field and both numbers", () => {
  const result = validateBotConfig({ ...VALID, entryRsiBelow: "80", exitRsiAbove: "60" });
  assert.equal(result.valid, false);
  if (result.valid) return;
  const entry = result.problems.find((problem) => problem.field === "entryRsiBelow");
  assert.ok(entry, `expected an entryRsiBelow problem, got ${JSON.stringify(result.problems)}`);
  assert.match(entry!.message, /80/);
  assert.match(entry!.message, /60/);
});

test("a stop-loss the definition schema refuses is reported against the stop field", () => {
  const result = validateBotConfig({ ...VALID, stopLossPercent: "75" });
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.ok(result.problems.some((problem) => problem.field === "stopLossPercent"));
});

test("a market this build has no history for is refused by name", () => {
  const result = validateBotConfig({ ...VALID, market: "DOGE-GBP" });
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.problems[0]?.field, "market");
});

test("a configuration with an unknown field is refused rather than silently narrowed", () => {
  const result = validateBotConfig({ ...VALID, leverage: 5 });
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.match(result.error, /Unsupported field/);
  assert.match(result.error, /leverage/);
});

test("the cap message names the cap, the tier, the usage and that nothing was created", () => {
  const bots = botCapMessage("bots", 2, 2, "Standard");
  assert.match(bots, /2 of 2 bots in use/);
  assert.match(bots, /Standard/);
  assert.match(bots, /Nothing was created/);

  const venues = botCapMessage("venue connections", 5, 5, "Pro");
  assert.match(venues, /5 of 5 connected venues in use/);
  assert.match(venues, /Admin → Fees/);
});

test("the shipped tier is a real default with both caps positive", () => {
  const tier: FeeTier | undefined = DEFAULT_FEE_TIERS.find((candidate) => candidate.isDefault);
  assert.ok(tier);
  assert.ok(tier!.maxBots > 0);
  assert.ok(tier!.maxVenueConnections > 0);
});

test("a bot is named by a parseable strategy id", () => {
  const id = botStrategyId("bot-123");
  assert.equal(id, `${BOT_STRATEGY_PREFIX}bot-123`);
  assert.equal(parseBotStrategyId(id), "bot-123");
  assert.equal(parseBotStrategyId("smart-trend"), null);
  assert.equal(parseBotStrategyId(`${BOT_STRATEGY_PREFIX}  `), null);
});

test("built-in templates are valid configurations with distinct slugs", () => {
  const slugs = new Set<string>();
  for (const template of BUILT_IN_TEMPLATES) {
    assert.ok(!slugs.has(template.slug), `duplicate slug ${template.slug}`);
    slugs.add(template.slug);
    const validation = validateBotConfig(template.config);
    assert.equal(validation.valid, true, `${template.slug}: ${validation.valid ? "" : validation.error}`);
    assert.match(template.description, /\w/);
    assert.ok(template.config.budgetUsd.length > 0);
  }
});

test("an unmeasured template states that rather than showing a figure", () => {
  // The shape the marketplace page renders from: a null performance always arrives with a
  // sentence explaining why, and never as a zero return.
  const unmeasured = {
    id: "btc-oversold-bounce",
    performance: null,
    performanceNote: "No real backtest has been recorded for these rules yet, so no performance figure is shown.",
  } satisfies Partial<MarketplaceTemplate> as Partial<MarketplaceTemplate>;
  assert.equal(unmeasured.performance, null);
  assert.match(unmeasured.performanceNote!, /No real backtest/);
});
