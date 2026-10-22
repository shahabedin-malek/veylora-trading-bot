import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSISTANT_LIMITS,
  assistantCostMicros,
  assistantPricingConfigured,
  evaluateAssistantQuota,
  windowFor,
} from "@/lib/assistant/limits";

/**
 * The assistant's own limits, as arithmetic.
 *
 * These are the numbers a person is refused by, so the boundaries are asserted exactly:
 * the cap is inclusive, the reset time is the end of the window that refused, and the
 * sentence names the limit and the moment it lifts. Cost is asserted to be *absent* when
 * no price is configured — a metering panel that invents a price is worse than one that
 * says it has none.
 */

const MOMENT = new Date("2026-10-18T03:41:12.345Z");

test("windows are the UTC floor of the hour and of the day, with the reset at their end", () => {
  const hour = windowFor("HOUR", MOMENT);
  assert.equal(hour.start.toISOString(), "2026-10-18T03:00:00.000Z");
  assert.equal(hour.end.toISOString(), "2026-10-18T04:00:00.000Z");

  const day = windowFor("DAY", MOMENT);
  assert.equal(day.start.toISOString(), "2026-10-18T00:00:00.000Z");
  assert.equal(day.end.toISOString(), "2026-10-19T00:00:00.000Z");

  // Two moments in the same hour land on the same row, wherever the server is.
  assert.equal(windowFor("HOUR", new Date("2026-10-18T03:59:59.999Z")).start.toISOString(), hour.start.toISOString());
  assert.equal(windowFor("HOUR", new Date("2026-10-18T04:00:00.000Z")).start.toISOString(), "2026-10-18T04:00:00.000Z");
});

test("the cap is inclusive and a refusal names the limit and the reset time", () => {
  const atCap = evaluateAssistantQuota({ hourRequests: ASSISTANT_LIMITS.requestsPerHour, dayRequests: 5, dayTokens: 0 }, MOMENT);
  assert.equal(atCap.allowed, true, "the 30th question in an hour is allowed");

  const overCap = evaluateAssistantQuota({ hourRequests: ASSISTANT_LIMITS.requestsPerHour + 1, dayRequests: 5, dayTokens: 0 }, MOMENT);
  assert.equal(overCap.allowed, false);
  if (overCap.allowed) return;
  assert.equal(overCap.code, "RATE_LIMITED");
  assert.equal(overCap.status, 429);
  assert.equal(overCap.limit, "requestsPerHour");
  assert.equal(overCap.cap, ASSISTANT_LIMITS.requestsPerHour);
  assert.equal(overCap.observed, ASSISTANT_LIMITS.requestsPerHour + 1);
  assert.equal(overCap.resetAt, "2026-10-18T04:00:00.000Z");
  assert.match(overCap.sentence, /30 questions per hour/);
  assert.match(overCap.sentence, /2026-10-18T04:00:00\.000Z/);
});

test("the daily request cap and the token budget are separate refusals", () => {
  const daily = evaluateAssistantQuota({ hourRequests: 1, dayRequests: ASSISTANT_LIMITS.requestsPerDay + 1, dayTokens: 10 }, MOMENT);
  assert.equal(daily.allowed, false);
  if (!daily.allowed) {
    assert.equal(daily.limit, "requestsPerDay");
    assert.equal(daily.resetAt, "2026-10-19T00:00:00.000Z");
    assert.match(daily.sentence, /200 questions per day/);
  }

  const tokens = evaluateAssistantQuota({ hourRequests: 1, dayRequests: 2, dayTokens: ASSISTANT_LIMITS.tokensPerDay + 1 }, MOMENT);
  assert.equal(tokens.allowed, false);
  if (!tokens.allowed) {
    assert.equal(tokens.limit, "tokensPerDay");
    assert.match(tokens.sentence, /150000 tokens/);
    assert.match(tokens.sentence, /2026-10-19T00:00:00\.000Z/);
  }

  // At the budget exactly, the next question is still allowed: the cap is a cap, not a
  // "one below" rule that would confuse the panel's own numbers.
  assert.equal(evaluateAssistantQuota({ hourRequests: 1, dayRequests: 2, dayTokens: ASSISTANT_LIMITS.tokensPerDay }, MOMENT).allowed, true);
});

test("cost is computed from configured prices and is absent when there are none", () => {
  const usage = { inputTokens: 1_000, outputTokens: 500 };

  // Both prices are dollars per million tokens.
  const priced = assistantCostMicros(usage, { NODE_ENV: "test", AI_GATEWAY_INPUT_USD_PER_MTOK: "3", AI_GATEWAY_OUTPUT_USD_PER_MTOK: "15" } as NodeJS.ProcessEnv);
  // 1000 tokens at $3/Mtok = $0.003 = 3000 micros; 500 at $15/Mtok = $0.0075 = 7500 micros.
  assert.equal(priced, 10_500);
  assert.equal(assistantPricingConfigured({ NODE_ENV: "test", AI_GATEWAY_INPUT_USD_PER_MTOK: "3" } as NodeJS.ProcessEnv), true);

  assert.equal(assistantCostMicros(usage, { NODE_ENV: "test" } as NodeJS.ProcessEnv), null);
  assert.equal(assistantPricingConfigured({ NODE_ENV: "test" } as NodeJS.ProcessEnv), false);
  // A price that is not a number is not a price.
  assert.equal(assistantCostMicros(usage, { NODE_ENV: "test", AI_GATEWAY_INPUT_USD_PER_MTOK: "free" } as NodeJS.ProcessEnv), null);
});
