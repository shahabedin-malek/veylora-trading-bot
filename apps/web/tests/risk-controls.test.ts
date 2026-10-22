import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RISK_POLICY,
  capIsSet,
  evaluateOwnerLimits,
  evaluateRiskOrder,
  getRiskControlsStatus,
  type AdjustableRiskPolicy,
  type RiskOrderInput,
} from "../src/lib/risk-controls/policy";
import { describeLimitRefusal } from "../src/lib/risk-controls/enforcement";
import {
  cooldownRemainingMinutes,
  validateRiskPolicyUpdate,
  type RiskPolicySettings,
} from "../src/lib/risk-controls/settings";
import { capLabel, usageRows, type RiskUsageFacts } from "../src/lib/risk-controls/usage";

const approvedPolicy = { ...DEFAULT_RISK_POLICY, approvedSymbols: ["BTC-USD"] };

function approvedOrder(overrides: Partial<RiskOrderInput> = {}): RiskOrderInput {
  return {
    symbol: "BTC-USD",
    allowedSymbols: ["BTC-USD"],
    venueApproved: true,
    liveArmed: true,
    killSwitchActive: false,
    auditAvailable: true,
    hasValidStopLoss: true,
    capitalUsd: "10000",
    verifiedAvailableUsd: "10000",
    requestedNotionalUsd: "100",
    serverComputedMaxLossUsd: "1",
    currentOpenExposureUsd: "100",
    dailyLossUsd: "0",
    tradesToday: 0,
    leverage: "1",
    first24HoursAfterArm: false,
    exposureSinceArmUsd: "0",
    ...overrides,
  };
}

test("risk control module reports the loaded policy and the live switch's state", () => {
  const off = getRiskControlsStatus(approvedPolicy);
  assert.equal(off.status, "Connected");
  assert.match(off.detail, /Admin policy loaded · 1 site symbols · kill switch ready · live execution switched off/);
  assert.equal(off.executionEnabled, false);
  assert.equal(off.policyVersion, "veylora-risk-v1");

  // Phase 22: the line is read from the owner's switch rather than from a constant, so a
  // panel can never say "off" while the deployment places real orders.
  const on = getRiskControlsStatus(approvedPolicy, { liveExecutionEnabled: true });
  assert.match(on.detail, /live execution ON in \/admin\/risk/);
  assert.equal(on.executionEnabled, true);
});

test("admin risk settings accept both tighter and looser values, because the panel is the control", () => {
  const tightened = validateRiskPolicyUpdate({
    ...DEFAULT_RISK_POLICY,
    maxRiskPerTradePercent: "0.5",
    maxOpenExposurePercent: "20",
    approvedSymbols: ["BTC-USD", "ETH-USD"],
    killSwitchActive: true,
    liveExecutionEnabled: false,
  });

  assert.equal(tightened.valid, true);
  if (!tightened.valid) return;
  assert.equal(tightened.value.maxRiskPerTradePercent, "0.5");
  assert.deepEqual(tightened.value.approvedSymbols, ["BTC-USD", "ETH-USD"]);
  assert.equal(tightened.value.killSwitchActive, true);

  const loosened = validateRiskPolicyUpdate({
    ...DEFAULT_RISK_POLICY,
    maxRiskPerTradePercent: "5",
    maxOpenExposurePercent: "40",
    dailyLossHaltPercent: "8",
    maxTradesPerDay: 200,
    defaultMaxLeverage: "3",
    minimumVerifiedBalanceUsd: "1",
    first24HourExposureUsd: "5000",
    approvedSymbols: ["BTC-USD"],
    killSwitchActive: false,
    liveExecutionEnabled: true,
  });

  assert.equal(loosened.valid, true);
  if (!loosened.valid) return;
  assert.equal(loosened.value.maxRiskPerTradePercent, "5");
  assert.equal(loosened.value.maxOpenExposurePercent, "40");
  assert.equal(loosened.value.dailyLossHaltPercent, "8");
  assert.equal(loosened.value.maxTradesPerDay, 200);
  assert.equal(loosened.value.defaultMaxLeverage, "3");
  assert.equal(loosened.value.minimumVerifiedBalanceUsd, "1");
  assert.equal(loosened.value.first24HourExposureUsd, "5000");
  // The real-money switch is part of the same save: loosening the limits and turning live
  // execution on are both the owner's to do, and neither is refused for being consequential.
  assert.equal(loosened.value.liveExecutionEnabled, true);
});

test("the live switch must be stated, and only a boolean is accepted", () => {
  const base = { ...DEFAULT_RISK_POLICY, approvedSymbols: ["BTC-USD"], killSwitchActive: false };
  // Omitted entirely: refused rather than defaulted, so a stale client cannot turn
  // real-money execution off (or leave it on) by not mentioning it.
  assert.equal(validateRiskPolicyUpdate(base).valid, false);
  const missing = validateRiskPolicyUpdate(base);
  if (!missing.valid) assert.match(missing.error, /Live execution must be stated as on or off/);

  for (const value of ["on", 1, null, {}]) {
    assert.equal(validateRiskPolicyUpdate({ ...base, liveExecutionEnabled: value }).valid, false);
  }
  const accepted = validateRiskPolicyUpdate({ ...base, liveExecutionEnabled: false });
  assert.equal(accepted.valid, true);
  if (accepted.valid) assert.equal(accepted.value.liveExecutionEnabled, false);
});

test("admin risk settings reject malformed values, unsupported fields and bad symbols", () => {
  // The live switch is stated in the base so every refusal below is about the field the
  // case names, not about the switch being absent.
  const rejected = (overrides: Record<string, unknown>) =>
    validateRiskPolicyUpdate({
      ...DEFAULT_RISK_POLICY,
      approvedSymbols: [],
      killSwitchActive: false,
      liveExecutionEnabled: false,
      ...overrides,
    });

  const negative = rejected({ maxRiskPerTradePercent: "-1" });
  assert.equal(negative.valid, false);
  if (!negative.valid) assert.match(negative.error, /positive percentage/);

  const zero = rejected({ defaultMaxLeverage: "0" });
  assert.equal(zero.valid, false);
  if (!zero.valid) assert.match(zero.error, /positive multiplier/);

  assert.equal(rejected({ maxRiskPerTradePercent: "abc" }).valid, false);
  assert.equal(rejected({ maxTradesPerDay: 0 }).valid, false);
  assert.equal(rejected({ maxTradesPerDay: 1.5 }).valid, false);
  assert.equal(rejected({ minimumVerifiedBalanceUsd: "-0.01" }).valid, false);
  assert.equal(rejected({ first24HourExposureUsd: "1e6" }).valid, false);
  assert.equal(rejected({ approvedSymbols: ["btc-usd"] }).valid, false);
  assert.equal(rejected({ killSwitchActive: "yes" }).valid, false);
  assert.equal(rejected({ maxLeverageOverride: "1" }).valid, false);
  assert.equal(rejected({ liveExecutionEnabled: "on" }).valid, false);
});

test("risk evaluator allows only a fully approved order within configured limits", () => {
  assert.deepEqual(evaluateRiskOrder(approvedOrder(), approvedPolicy), {
    decision: "ALLOW",
    policyVersion: "veylora-risk-v1",
    reasons: [],
  });
});

test("paper risk path skips live venue, arm, and verified-funds gates only", () => {
  const paperOrder = approvedOrder({
    executionMode: "PAPER",
    paperBotActive: true,
    venueApproved: false,
    liveArmed: false,
    verifiedAvailableUsd: null,
  });
  assert.deepEqual(evaluateRiskOrder(paperOrder, approvedPolicy), {
    decision: "ALLOW",
    policyVersion: "veylora-risk-v1",
    reasons: [],
  });

  const inactive = evaluateRiskOrder({ ...paperOrder, paperBotActive: false }, approvedPolicy);
  assert.equal(inactive.decision, "REFUSE");
  if (inactive.decision === "REFUSE") assert.ok(inactive.reasons.includes("paper-bot-not-active"));

  const halted = evaluateRiskOrder({ ...paperOrder, killSwitchActive: true }, approvedPolicy);
  assert.equal(halted.decision, "REFUSE");
  if (halted.decision === "REFUSE") assert.ok(halted.reasons.includes("kill-switch-active"));

  const capped = evaluateRiskOrder({ ...paperOrder, serverComputedMaxLossUsd: "101" }, approvedPolicy);
  assert.equal(capped.decision, "REFUSE");
  if (capped.decision === "REFUSE") assert.ok(capped.reasons.includes("per-trade-risk-exceeded"));

  const overExposure = evaluateRiskOrder({ ...paperOrder, currentOpenExposureUsd: "2450" }, approvedPolicy);
  assert.equal(overExposure.decision, "REFUSE");
  if (overExposure.decision === "REFUSE") assert.ok(overExposure.reasons.includes("open-exposure-exceeded"));

  const dailyHalt = evaluateRiskOrder({ ...paperOrder, dailyLossUsd: "200" }, approvedPolicy);
  assert.equal(dailyHalt.decision, "REFUSE");
  if (dailyHalt.decision === "REFUSE") assert.ok(dailyHalt.reasons.includes("daily-loss-halt"));

  const tradeCount = evaluateRiskOrder({ ...paperOrder, tradesToday: 10 }, approvedPolicy);
  assert.equal(tradeCount.decision, "REFUSE");
  if (tradeCount.decision === "REFUSE") assert.ok(tradeCount.reasons.includes("trade-count-exceeded"));
});

test("risk evaluator refuses when venue, arm, funds, stop, or symbol gates fail", () => {
  const result = evaluateRiskOrder(approvedOrder({
    venueApproved: false,
    liveArmed: false,
    verifiedAvailableUsd: null,
    hasValidStopLoss: false,
    allowedSymbols: [],
  }), approvedPolicy);

  assert.equal(result.decision, "REFUSE");
  if (result.decision !== "REFUSE") return;
  assert.deepEqual(new Set(result.reasons), new Set([
    "venue-not-approved",
    "trading-not-armed",
    "verified-funds-required",
    "stop-loss-required",
    "symbol-not-allowed",
  ]));
});

test("risk evaluator refuses if the kill switch is active or audit storage is unavailable", () => {
  const result = evaluateRiskOrder(approvedOrder({ killSwitchActive: true, auditAvailable: false }), approvedPolicy);
  assert.equal(result.decision, "REFUSE");
  if (result.decision !== "REFUSE") return;
  assert.ok(result.reasons.includes("kill-switch-active"));
  assert.ok(result.reasons.includes("audit-unavailable"));
});

test("admin policy kill-switch state also refuses an otherwise valid order", () => {
  const result = evaluateRiskOrder(approvedOrder(), { ...approvedPolicy, killSwitchActive: true });
  assert.equal(result.decision, "REFUSE");
  if (result.decision !== "REFUSE") return;
  assert.ok(result.reasons.includes("kill-switch-active"));
});

test("risk evaluator enforces quantitative caps and the first-day exposure limit", () => {
  const result = evaluateRiskOrder(approvedOrder({
    requestedNotionalUsd: "100",
    serverComputedMaxLossUsd: "101",
    currentOpenExposureUsd: "2450",
    dailyLossUsd: "200",
    tradesToday: 10,
    leverage: "2",
    first24HoursAfterArm: true,
    exposureSinceArmUsd: "20",
  }), approvedPolicy);

  assert.equal(result.decision, "REFUSE");
  if (result.decision !== "REFUSE") return;
  assert.deepEqual(new Set(result.reasons), new Set([
    "per-trade-risk-exceeded",
    "open-exposure-exceeded",
    "daily-loss-halt",
    "trade-count-exceeded",
    "leverage-exceeded",
    "first-day-exposure-exceeded",
  ]));
});

// ---------------------------------------------------------------------------------------
// Phase 25: the owner's limits and kill switches
// ---------------------------------------------------------------------------------------

function limited(overrides: Partial<AdjustableRiskPolicy> = {}): AdjustableRiskPolicy {
  return { ...approvedPolicy, ...overrides };
}

function facts(overrides: Partial<RiskUsageFacts> = {}): RiskUsageFacts {
  return {
    now: new Date("2026-10-18T12:00:00.000Z"),
    openPositions: 0,
    openExposureUsd: "0.00",
    tradesInInterval: 0,
    tradesToday: 0,
    strategyOpenNotionalUsd: "0.00",
    strategy: { activationId: "activation-1", strategyId: "rsi-daily-close", switchActive: false, changedAt: null, changedBy: null },
    cooldownRemainingMinutes: 0,
    cooldownUntil: null,
    venueId: "dev-paper",
    ...overrides,
  };
}

function panelPolicy(overrides: Partial<AdjustableRiskPolicy> = {}): RiskPolicySettings {
  return {
    ...limited(overrides),
    liveExecutionEnabled: false,
    liveExecutionChangedByUserId: null,
    liveExecutionChangedAt: null,
    limitsEffectiveFrom: {},
    cooldownUntil: null,
    killSwitchChangedByUserId: null,
    killSwitchChangedAt: null,
  };
}

test("zero is unlimited: a cap of zero refuses nothing", () => {
  const policy = limited();
  assert.equal(capIsSet("0"), false);
  assert.equal(capIsSet(0), false);
  assert.equal(capIsSet("25.5"), true);
  assert.equal(capIsSet(3), true);

  const huge = approvedOrder({ requestedNotionalUsd: "999999", strategyOpenNotionalUsd: "999999", openPositionCount: 50, tradesInInterval: 50 });
  const decision = evaluateRiskOrder(huge, policy);
  assert.equal(decision.decision, "REFUSE", "the phase-20 exposure check still applies, so the fixture must not be within it");

  // What must not happen is a refusal *because* a zero was read as a cap: the phase-25
  // reasons are absent from a zeroed policy no matter how large the order is.
  if (decision.decision === "REFUSE") {
    for (const reason of ["order-notional-exceeded", "strategy-notional-exceeded", "open-positions-exceeded", "interval-trade-count-exceeded", "cooldown-active"]) {
      assert.equal(decision.reasons.includes(reason as never), false, `${reason} must not fire when its cap is zero`);
    }
    assert.equal(decision.limits.length, 0);
  }

  // The same order at a size the phase-20 checks accept is allowed with every cap zeroed.
  assert.equal(evaluateRiskOrder(approvedOrder(), policy).decision, "ALLOW");
});

test("a per-order maximum below the order names the limit and the observed value", () => {
  const policy = limited({ maxOrderNotionalUsd: "50" });
  const decision = evaluateRiskOrder(approvedOrder({ requestedNotionalUsd: "100" }), policy);
  assert.equal(decision.decision, "REFUSE");
  if (decision.decision !== "REFUSE") return;
  assert.ok(decision.reasons.includes("order-notional-exceeded"));
  const breach = decision.limits.find((limit) => limit.reason === "order-notional-exceeded");
  assert.ok(breach);
  assert.equal(breach.limit, "maxOrderNotionalUsd");
  assert.equal(breach.cap, "50.00");
  assert.equal(breach.observed, "100.00");
  assert.equal(breach.scope, "order");

  const sentence = describeLimitRefusal(decision);
  assert.match(sentence, /Refused by a limit you set/);
  assert.match(sentence, /Max notional per order 50\.00/);
  assert.match(sentence, /100\.00/);
});

test("every phase-25 cap refuses with its own name, cap and observed value", () => {
  const cases: { policy: Partial<AdjustableRiskPolicy>; order: Partial<RiskOrderInput>; reason: string; limit: string }[] = [
    { policy: { maxStrategyNotionalUsd: "300" }, order: { strategyOpenNotionalUsd: "280", requestedNotionalUsd: "100" }, reason: "strategy-notional-exceeded", limit: "maxStrategyNotionalUsd" },
    { policy: { maxOpenPositions: 2 }, order: { openPositionCount: 2 }, reason: "open-positions-exceeded", limit: "maxOpenPositions" },
    { policy: { maxTradesPerInterval: 3 }, order: { tradesInInterval: 3 }, reason: "interval-trade-count-exceeded", limit: "maxTradesPerInterval" },
    { policy: { allowedVenues: ["binance"] }, order: { venueId: "dev-paper" }, reason: "venue-not-allowed", limit: "allowedVenues" },
    { policy: { cooldownMinutes: 30 }, order: { cooldownRemainingMinutes: 12 }, reason: "cooldown-active", limit: "cooldownMinutes" },
  ];

  for (const item of cases) {
    const decision = evaluateRiskOrder(approvedOrder(item.order), limited(item.policy));
    assert.equal(decision.decision, "REFUSE", `${item.reason} did not refuse`);
    if (decision.decision !== "REFUSE") continue;
    assert.ok(decision.reasons.includes(item.reason as never), `${item.reason} missing`);
    const breach = decision.limits.find((limit) => limit.limit === item.limit);
    assert.ok(breach, `${item.limit} was not named as the limit that refused`);
    assert.ok(breach.observed.length > 0, `${item.limit} did not record what it saw`);
  }
});

test("a switch refusal names which switch stopped the order", () => {
  const global = evaluateRiskOrder(approvedOrder(), limited({ killSwitchActive: true }));
  assert.equal(global.decision, "REFUSE");
  if (global.decision === "REFUSE") {
    assert.deepEqual(global.limits.map((limit) => limit.limit), ["killSwitchActive"]);
    assert.match(describeLimitRefusal(global), /global kill switch/);
  }

  const strategy = evaluateRiskOrder(approvedOrder({ strategyKillSwitchActive: true }), limited());
  assert.equal(strategy.decision, "REFUSE");
  if (strategy.decision === "REFUSE") {
    assert.deepEqual(strategy.limits.map((limit) => limit.limit), ["strategyKillSwitch"]);
    assert.equal(strategy.limits[0].scope, "strategy");
    assert.match(describeLimitRefusal(strategy), /this strategy's kill switch/);
  }
});

test("a close is not trapped by a cap, but a switch still stops it", () => {
  const closing = approvedOrder({ executionMode: "PAPER", paperBotActive: true, reducePosition: true, requestedNotionalUsd: "900" });
  assert.equal(evaluateRiskOrder(closing, limited({ maxOrderNotionalUsd: "10", maxOpenPositions: 1 })).decision, "ALLOW");
  const halted = evaluateRiskOrder({ ...closing, killSwitchActive: true }, limited({ maxOrderNotionalUsd: "10" }));
  assert.equal(halted.decision, "REFUSE");
});

test("the same limits apply to paper and live, because the caps do not depend on the mode", () => {
  const live = approvedOrder({ executionMode: "LIVE", requestedNotionalUsd: "100" });
  const paper = approvedOrder({ executionMode: "PAPER", paperBotActive: true, requestedNotionalUsd: "100" });
  const policy = limited({ maxOrderNotionalUsd: "50" });
  const liveDecision = evaluateRiskOrder(live, policy);
  const paperDecision = evaluateRiskOrder(paper, policy);
  assert.equal(liveDecision.decision, "REFUSE");
  assert.equal(paperDecision.decision, "REFUSE");
  if (liveDecision.decision === "REFUSE" && paperDecision.decision === "REFUSE") {
    assert.deepEqual(liveDecision.limits, paperDecision.limits);
  }
});

test("the manual-order gate evaluates the owner's limits without the armed path's rules", () => {
  // A manual paper order has no declared capital and no stop-loss obligation, so the full
  // policy would refuse it for reasons that belong to an armed strategy pass. The owner's
  // own caps and switches are what it must obey.
  const policy = limited({ maxOrderNotionalUsd: "25" });
  const manual = approvedOrder({ executionMode: "PAPER", paperBotActive: true, hasValidStopLoss: false, capitalUsd: null, requestedNotionalUsd: "30" });
  assert.equal(evaluateRiskOrder(manual, policy).decision, "REFUSE");
  const ownerOnly = evaluateOwnerLimits(manual, policy);
  assert.equal(ownerOnly.decision, "REFUSE");
  if (ownerOnly.decision === "REFUSE") {
    assert.deepEqual(ownerOnly.reasons, ["order-notional-exceeded"], "only the owner's cap refused it");
  }
  assert.equal(evaluateOwnerLimits({ ...manual, requestedNotionalUsd: "20" }, policy).decision, "ALLOW");
  assert.equal(evaluateOwnerLimits({ ...manual, killSwitchActive: true }, policy).decision, "REFUSE");
});

test("the new limits are validated as data, with their zero documented as unlimited", () => {
  const base = { ...DEFAULT_RISK_POLICY, approvedSymbols: [], killSwitchActive: false, liveExecutionEnabled: false };
  assert.equal(validateRiskPolicyUpdate(base).valid, true);

  const accepted = validateRiskPolicyUpdate({
    ...base,
    maxOrderNotionalUsd: "250.50",
    maxStrategyNotionalUsd: "1000",
    maxOpenPositions: 3,
    maxTradesPerInterval: 5,
    tradeIntervalMinutes: 30,
    cooldownMinutes: 15,
    allowedVenues: ["binance-testnet", "dev-paper"],
  });
  assert.equal(accepted.valid, true);
  if (accepted.valid) {
    assert.equal(accepted.value.maxOrderNotionalUsd, "250.50");
    assert.deepEqual(accepted.value.allowedVenues, ["binance-testnet", "dev-paper"]);
  }

  const rejected = (overrides: Record<string, unknown>) => validateRiskPolicyUpdate({ ...base, ...overrides });
  assert.equal(rejected({ maxOrderNotionalUsd: "-1" }).valid, false);
  assert.equal(rejected({ maxStrategyNotionalUsd: "1e3" }).valid, false);
  assert.equal(rejected({ maxOpenPositions: -1 }).valid, false);
  assert.equal(rejected({ maxOpenPositions: 1.5 }).valid, false);
  assert.equal(rejected({ maxTradesPerInterval: 10_001 }).valid, false);
  assert.equal(rejected({ tradeIntervalMinutes: 0 }).valid, false);
  assert.equal(rejected({ cooldownMinutes: 1_441 }).valid, false);
  assert.equal(rejected({ allowedVenues: ["Binance"] }).valid, false);
  assert.equal(rejected({ allowedVenues: ["binance", "binance"] }).valid, false);
});

test("the panel's usage rows read a zero cap as Unlimited, never as a broken value", () => {
  const policy = panelPolicy();
  const rows = usageRows(policy, facts());
  for (const field of ["maxOrderNotionalUsd", "maxStrategyNotionalUsd", "maxOpenPositions", "maxTradesPerInterval"] as const) {
    const row = rows.find((candidate) => candidate.field === field);
    assert.ok(row, `${field} has no row`);
    assert.equal(row.capLabel, "Unlimited", `${field} did not read as unlimited`);
    assert.equal(row.status, "unlimited");
  }
  assert.equal(capLabel("0"), "Unlimited");
  assert.equal(capLabel(0), "Unlimited");
  assert.equal(capLabel("12.5"), "12.50");
  assert.equal(capLabel(4), "4");
});

test("the panel shows usage against a cap that is set, and the switches' state before they are pressed", () => {
  const policy = panelPolicy({ maxOpenPositions: 2, maxTradesPerInterval: 3, allowedVenues: ["binance"], killSwitchActive: true, cooldownMinutes: 20 });
  const rows = usageRows(policy, facts({ openPositions: 2, tradesInInterval: 1, venueId: "dev-paper", cooldownRemainingMinutes: 7 }));
  const positions = rows.find((row) => row.field === "maxOpenPositions");
  assert.ok(positions);
  assert.equal(positions.used, "2");
  assert.equal(positions.status, "at-cap");

  const trades = rows.find((row) => row.field === "maxTradesPerInterval");
  assert.ok(trades);
  assert.equal(trades.used, "1");
  assert.equal(trades.status, "ok");

  const venues = rows.find((row) => row.field === "allowedVenues");
  assert.ok(venues);
  assert.equal(venues.status, "over-cap", "the current venue is not in the owner's list");

  const global = rows.find((row) => row.field === "killSwitchActive");
  assert.ok(global);
  assert.equal(global.capLabel, "ENGAGED");
  assert.match(global.detail, /every new order, manual or automatic, is refused/);

  const strategySwitch = rows.find((row) => row.field === "strategyKillSwitch");
  assert.ok(strategySwitch);
  assert.equal(strategySwitch.capLabel, "released");

  const cooldown = rows.find((row) => row.field === "cooldownMinutes");
  assert.ok(cooldown);
  assert.equal(cooldown.used, "7 min left");
});

test("the cooldown counts minutes left and never goes negative", () => {
  const now = Date.parse("2026-10-18T12:00:00.000Z");
  assert.equal(cooldownRemainingMinutes(null, now), 0);
  assert.equal(cooldownRemainingMinutes("2026-10-18T12:10:00.000Z", now), 10);
  assert.equal(cooldownRemainingMinutes("2026-10-18T11:00:00.000Z", now), 0);
  assert.equal(cooldownRemainingMinutes("2026-10-18T12:00:30.000Z", now), 1, "a partial minute is still a minute of waiting");
});

test("risk evaluator fails closed on malformed values and insufficient verified funds", () => {
  const result = evaluateRiskOrder(approvedOrder({
    requestedNotionalUsd: "1e9",
    verifiedAvailableUsd: "19.99",
  }), approvedPolicy);

  assert.equal(result.decision, "REFUSE");
  if (result.decision !== "REFUSE") return;
  assert.ok(result.reasons.includes("invalid-order-input"));
  assert.ok(result.reasons.includes("minimum-balance-not-met"));
});