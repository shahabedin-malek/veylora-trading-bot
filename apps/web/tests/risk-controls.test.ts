import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RISK_POLICY,
  evaluateRiskOrder,
  getRiskControlsStatus,
  type RiskOrderInput,
} from "../src/lib/risk-controls/policy";
import { validateRiskPolicyUpdate } from "../src/lib/risk-controls/settings";

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

test("risk control module reports the loaded policy and the unwired order route", () => {
  const status = getRiskControlsStatus(approvedPolicy);
  assert.equal(status.status, "Connected");
  assert.match(status.detail, /Admin policy loaded · 1 site symbols · kill switch ready · no order route configured/);
  assert.equal(status.executionEnabled, false);
  assert.equal(status.policyVersion, "veylora-risk-v1");
});

test("admin risk settings accept both tighter and looser values, because the panel is the control", () => {
  const tightened = validateRiskPolicyUpdate({
    ...DEFAULT_RISK_POLICY,
    maxRiskPerTradePercent: "0.5",
    maxOpenExposurePercent: "20",
    approvedSymbols: ["BTC-USD", "ETH-USD"],
    killSwitchActive: true,
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
});

test("admin risk settings reject malformed values, unsupported fields and bad symbols", () => {
  const rejected = (overrides: Record<string, unknown>) =>
    validateRiskPolicyUpdate({ ...DEFAULT_RISK_POLICY, approvedSymbols: [], killSwitchActive: false, ...overrides });

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