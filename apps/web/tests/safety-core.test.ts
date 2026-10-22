import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RISK_POLICY,
  type RiskOrderInput,
} from "../src/lib/risk-controls/policy";
import {
  evaluateAndAuditOrderAttempt,
  recordRiskCapsChanged,
  setKillSwitch,
} from "../src/lib/risk-controls/safety-core";
import {
  appendIntegerCentLedgerEntry,
  getIntegerCentLedgerSnapshot,
} from "../src/lib/ledger/integer-cent-ledger";
import { InMemorySafetyStore } from "./support/in-memory-safety-store";

const approvedPolicy = { ...DEFAULT_RISK_POLICY, approvedSymbols: ["BTC-USD"] };

function validOrder(overrides: Partial<RiskOrderInput> = {}): RiskOrderInput {
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

const context = (attemptId: string, botId?: string) => ({ actorUserId: "user-1", attemptId, ...(botId ? { botId } : {}) });

test("valid fully gated attempt returns ALLOW and audits the decision without executing an order", async () => {
  const store = new InMemorySafetyStore(approvedPolicy);
  const at = new Date("2026-10-15T12:00:00.000Z");
  const result = await evaluateAndAuditOrderAttempt(store, validOrder(), context("attempt-allow"), at);

  assert.deepEqual(result, { decision: "ALLOW", policyVersion: "veylora-risk-v1", reasons: [] });
  assert.equal(store.auditRecords.length, 2);
  assert.deepEqual(store.auditRecords.map(({ action }) => action), ["ORDER_ATTEMPT", "RISK_DECISION"]);
  assert.equal(store.auditRecords[0]?.actorUserId, "user-1");
  assert.equal(store.auditRecords[0]?.occurredAt, at);
  assert.equal(store.auditRecords[0]?.outcome, "SUCCESS");
});

test("global kill switch refuses all attempts and audits engagement with actor and timestamp", async () => {
  const store = new InMemorySafetyStore(approvedPolicy);
  const at = new Date("2026-10-15T12:01:00.000Z");
  await setKillSwitch(store, { scope: "GLOBAL" }, true, "admin-1", at);

  const first = await evaluateAndAuditOrderAttempt(store, validOrder(), context("attempt-1"), at);
  const second = await evaluateAndAuditOrderAttempt(store, validOrder({ symbol: "ETH-USD" }), context("attempt-2"), at);
  assert.equal(first.decision, "REFUSE");
  assert.equal(second.decision, "REFUSE");
  if (first.decision === "REFUSE") assert.ok(first.reasons.includes("kill-switch-active"));
  assert.equal(store.auditRecords.filter((event) => event.action === "KILL_SWITCH_ENGAGED").length, 1);
  const killSwitchEvent = store.auditRecords.find((event) => event.action === "KILL_SWITCH_ENGAGED");
  assert.equal(killSwitchEvent?.actorUserId, "admin-1");
  assert.equal(killSwitchEvent?.occurredAt, at);
});

test("per-bot kill switch refuses only that bot's attempts", async () => {
  const store = new InMemorySafetyStore(approvedPolicy);
  await setKillSwitch(store, { scope: "BOT", botId: "bot-a" }, true, "admin-1");
  const halted = await evaluateAndAuditOrderAttempt(store, validOrder(), context("attempt-a", "bot-a"));
  const otherBot = await evaluateAndAuditOrderAttempt(store, validOrder(), context("attempt-b", "bot-b"));
  assert.equal(halted.decision, "REFUSE");
  assert.equal(otherBot.decision, "ALLOW");
  if (halted.decision === "REFUSE") assert.ok(halted.reasons.includes("kill-switch-active"));
});

test("missing and unreachable risk policies refuse instead of using defaults", async () => {
  const missing = await evaluateAndAuditOrderAttempt(new InMemorySafetyStore(null), validOrder(), context("missing-policy"));
  const unreachable = await evaluateAndAuditOrderAttempt(new InMemorySafetyStore(approvedPolicy, new Set(["policy"])), validOrder(), context("unreachable-policy"));
  assert.deepEqual(missing, { decision: "REFUSE", policyVersion: "veylora-risk-v1", reasons: ["risk-policy-unavailable"], limits: [] });
  assert.deepEqual(unreachable, { decision: "REFUSE", policyVersion: "veylora-risk-v1", reasons: ["risk-policy-unavailable"], limits: [] });
});

test("per-trade, exposure, and daily-loss caps refuse attempts", async () => {
  const store = new InMemorySafetyStore(approvedPolicy);
  const perTrade = await evaluateAndAuditOrderAttempt(store, validOrder({ serverComputedMaxLossUsd: "101" }), context("per-trade"));
  const exposure = await evaluateAndAuditOrderAttempt(store, validOrder({ currentOpenExposureUsd: "2450" }), context("exposure"));
  const dailyLoss = await evaluateAndAuditOrderAttempt(store, validOrder({ dailyLossUsd: "200" }), context("daily-loss"));
  assert.equal(perTrade.decision, "REFUSE");
  assert.equal(exposure.decision, "REFUSE");
  assert.equal(dailyLoss.decision, "REFUSE");
  if (perTrade.decision === "REFUSE") assert.ok(perTrade.reasons.includes("per-trade-risk-exceeded"));
  if (exposure.decision === "REFUSE") assert.ok(exposure.reasons.includes("open-exposure-exceeded"));
  if (dailyLoss.decision === "REFUSE") assert.ok(dailyLoss.reasons.includes("daily-loss-halt"));
});

test("unavailable kill-switch state and failed audit both refuse", async () => {
  const switchUnavailable = await evaluateAndAuditOrderAttempt(
    new InMemorySafetyStore(approvedPolicy, new Set(["switch"])),
    validOrder(),
    context("switch-unavailable"),
  );
  const auditUnavailable = await evaluateAndAuditOrderAttempt(
    new InMemorySafetyStore(approvedPolicy, new Set(["audit"])),
    validOrder(),
    context("audit-unavailable"),
  );
  assert.deepEqual(switchUnavailable, { decision: "REFUSE", policyVersion: "veylora-risk-v1", reasons: ["risk-state-unavailable"], limits: [] });
  assert.deepEqual(auditUnavailable, { decision: "REFUSE", policyVersion: "veylora-risk-v1", reasons: ["audit-unavailable"], limits: [] });
});

test("risk-cap changes are actor-stamped and audit is append-only", async () => {
  const store = new InMemorySafetyStore(approvedPolicy);
  const updated = { ...approvedPolicy, maxRiskPerTradePercent: "0.5" };
  const at = new Date("2026-10-15T13:00:00.000Z");
  await recordRiskCapsChanged(store, "admin-2", approvedPolicy, updated, at);
  assert.equal(store.auditRecords.length, 1);
  assert.equal(store.auditRecords[0]?.action, "RISK_CAPS_CHANGED");
  assert.equal(store.auditRecords[0]?.actorUserId, "admin-2");
  assert.equal(store.auditRecords[0]?.occurredAt, at);
});

test("integer-cent ledger rejects fractional cents and deduplicates idempotency keys", async () => {
  const store = new InMemorySafetyStore(approvedPolicy);
  const base = { idempotencyKey: "deposit-1", accountId: "account-1", actorUserId: "user-1", type: "CASH" as const, amountCents: 10_000, occurredAt: new Date() };
  assert.deepEqual(await appendIntegerCentLedgerEntry(store, base), { applied: true });
  assert.deepEqual(await appendIntegerCentLedgerEntry(store, base), { applied: false });
  await appendIntegerCentLedgerEntry(store, { ...base, idempotencyKey: "pnl-1", type: "PNL", amountCents: -250 });
  await appendIntegerCentLedgerEntry(store, { ...base, idempotencyKey: "fee-1", type: "FEE", amountCents: 35 });
  assert.deepEqual(await getIntegerCentLedgerSnapshot(store, "account-1"), {
    accountId: "account-1",
    cashBalanceCents: 10_000,
    pnlCents: -250,
    feesCents: 35,
  });
  await assert.rejects(appendIntegerCentLedgerEntry(store, { ...base, amountCents: 1.5 }), /integer cents/);
});