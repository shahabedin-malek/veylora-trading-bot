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

test("risk control module reports loaded policy while execution remains disabled", () => {
  const status = getRiskControlsStatus(approvedPolicy);
  assert.equal(status.status, "Connected");
  assert.match(status.detail, /Admin policy loaded · 1 site symbols · kill switch ready · order execution disabled/);
  assert.equal(status.executionEnabled, false);
  assert.equal(status.policyVersion, "veylora-risk-v1");
});

test("admin risk settings can tighten caps, edit symbols, and engage the kill switch", () => {
  const result = validateRiskPolicyUpdate({
    ...DEFAULT_RISK_POLICY,
    maxRiskPerTradePercent: "0.5",
    maxOpenExposurePercent: "20",
    approvedSymbols: ["BTC-USD", "ETH-USD"],
    killSwitchActive: true,
  });

  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.value.maxRiskPerTradePercent, "0.5");
  assert.deepEqual(result.value.approvedSymbols, ["BTC-USD", "ETH-USD"]);
  assert.equal(result.value.killSwitchActive, true);
});

test("admin risk settings reject looser caps, unsupported fields, and malformed symbols", () => {
  assert.equal(validateRiskPolicyUpdate({
    ...DEFAULT_RISK_POLICY,
    approvedSymbols: [],
    killSwitchActive: false,
    maxRiskPerTradePercent: "1.01",
  }).valid, false);
  assert.equal(validateRiskPolicyUpdate({
    ...DEFAULT_RISK_POLICY,
    approvedSymbols: [],
    killSwitchActive: false,
    minimumVerifiedBalanceUsd: "19.99",
  }).valid, false);
  assert.equal(validateRiskPolicyUpdate({
    ...DEFAULT_RISK_POLICY,
    approvedSymbols: ["btc-usd"],
    killSwitchActive: false,
  }).valid, false);
  assert.equal(validateRiskPolicyUpdate({
    ...DEFAULT_RISK_POLICY,
    approvedSymbols: [],
    killSwitchActive: false,
    maxLeverageOverride: "1",
  }).valid, false);
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