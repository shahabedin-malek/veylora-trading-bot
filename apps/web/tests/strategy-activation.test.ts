import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateStrategyRunState,
  isStrategyActivationIntent,
  STRATEGY_ACTIVATION_INTENTS,
  STRATEGY_RUN_STATES,
} from "../src/lib/bot-builder/state-machine";
import {
  defaultStrategyId,
  describeStrategyActivation,
  planActivationChange,
  strategyChoices,
  type ActivationSnapshot,
  type DescribeActivationInput,
  type RunnerReadiness,
  type VenueReadiness,
} from "../src/lib/strategies/state";
import { findSmartStrategy, SMART_STRATEGIES } from "../src/lib/strategies/schedule";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const STRATEGY = findSmartStrategy("rsi-daily-close");

function snapshot(overrides: Partial<ActivationSnapshot> = {}): ActivationSnapshot {
  return {
    id: "act_1",
    status: "RUNNING",
    strategyId: STRATEGY?.id ?? null,
    startedAt: NOW - 90_000,
    stoppedAt: null,
    lastChangeReason: "OWNER_STARTED",
    lastChangedAt: NOW - 90_000,
    lastChangedBy: "user_1",
    lastEvaluatedAt: NOW - 60_000,
    lastOutcome: "running",
    lastReasonCode: null,
    lastReasonMessage: null,
    runCount: 3,
    ...overrides,
  };
}

function venue(overrides: Partial<VenueReadiness> = {}): VenueReadiness {
  return {
    connectedCount: 1,
    placeableCount: 1,
    label: "Binance Spot Testnet",
    routing: "paper",
    liveExecutionEnabled: false,
    detail: "1 trade-capable key(s) connected.",
    ...overrides,
  };
}

function runner(overrides: Partial<RunnerReadiness> = {}): RunnerReadiness {
  return {
    jobId: "strategy-activation",
    label: "Smart trading activation",
    scheduled: true,
    cadence: "5 minutes",
    nextDueAt: new Date(NOW + 120_000).toISOString(),
    lastFinishedAt: new Date(NOW - 60_000).toISOString(),
    detail: "The last pass finished; the next is due shortly.",
    ...overrides,
  };
}

function describe(overrides: Partial<DescribeActivationInput> = {}) {
  return describeStrategyActivation({
    row: snapshot(),
    now: NOW,
    strategy: STRATEGY,
    venue: venue(),
    riskKillSwitchActive: false,
    runner: runner(),
    openOrderCount: 0,
    lastChangedByLabel: null,
    ...overrides,
  });
}

test("the lifecycle rule puts the owner's intent first, then blockers, then a failed pass", () => {
  assert.equal(evaluateStrategyRunState({ intent: null, blockerCount: 0, lastOutcome: null }), "stopped");
  assert.equal(evaluateStrategyRunState({ intent: "STOPPED", blockerCount: 2, lastOutcome: "error" }), "stopped");
  assert.equal(evaluateStrategyRunState({ intent: "RUNNING", blockerCount: 1, lastOutcome: "error" }), "idle");
  assert.equal(evaluateStrategyRunState({ intent: "RUNNING", blockerCount: 0, lastOutcome: "error" }), "error");
  assert.equal(evaluateStrategyRunState({ intent: "RUNNING", blockerCount: 0, lastOutcome: "running" }), "running");
  assert.equal(evaluateStrategyRunState({ intent: "RUNNING", blockerCount: 0, lastOutcome: null }), "running");
});

test("intent and run state stay separate vocabularies", () => {
  assert.deepEqual([...STRATEGY_ACTIVATION_INTENTS], ["RUNNING", "STOPPED"]);
  assert.equal(STRATEGY_RUN_STATES.length, 4);
  assert.equal(isStrategyActivationIntent("RUNNING"), true);
  assert.equal(isStrategyActivationIntent("STOPPED"), true);
  assert.equal(isStrategyActivationIntent("running"), false);
  assert.equal(isStrategyActivationIntent(null), false);
});

test("a never-started account reads as not started, and both controls are available", () => {
  const view = describe({ row: null });

  assert.equal(view.state, "stopped");
  assert.equal(view.intent, null);
  assert.equal(view.reason?.code, "NOT_STARTED");
  assert.match(view.reason?.message ?? "", /has not been started for this account/);
  // A stopped row is not a checklist: "no strategy selected" would be untrue before start,
  // because starting selects the default.
  assert.deepEqual(view.blockers, []);
  assert.equal(view.actions.start.label, "START SMART TRADING");
  assert.equal(view.actions.stop.label, "STOP SMART TRADING");
  assert.match(view.actions.start.detail, /No confirmation is asked/);
  assert.deepEqual(view.strategyCatalog, [...SMART_STRATEGIES]);
  assert.equal(view.id, null);
  assert.equal(view.elapsedMs, null);
});

test("a running activation with live execution off says placement is off, and stays running", () => {
  const view = describe();

  assert.equal(view.state, "running");
  assert.equal(view.stateLabel, "RUNNING");
  assert.equal(view.reason, null);
  assert.equal(view.blockers.length, 0);
  assert.equal(view.placement.label, "PAPER PLACEMENT");
  assert.equal(view.placement.liveExecutionEnabled, false);
  assert.match(view.placement.detail, /Placement is off for real money/);
  assert.match(view.placement.detail, /live execution is switched off in \/admin\/risk/);
  assert.equal(view.elapsedMs, 90_000);
  assert.equal(view.lastPass.runCount, 3);
  assert.equal(view.runner.scheduled, true);
});

test("a live placement is labelled live and names the switch that authorises it", () => {
  const view = describe({
    venue: venue({ routing: "live", liveExecutionEnabled: true, label: "Binance" }),
  });

  assert.equal(view.placement.label, "LIVE PLACEMENT");
  assert.equal(view.placement.liveExecutionEnabled, true);
  assert.match(view.placement.detail, /real-money order/);
});

test("a testnet placement names the switch that is off", () => {
  const view = describe({ venue: venue({ routing: "testnet" }) });

  assert.equal(view.placement.label, "TESTNET PLACEMENT");
  assert.match(view.placement.detail, /Live execution is switched off/);
  assert.match(view.placement.detail, /no real funds can move/);
});

test("every idle state names its reason and where to fix it", () => {
  const cases: Array<{ name: string; input: Partial<DescribeActivationInput>; code: string; href: string }> = [
    { name: "no strategy", input: { strategy: null }, code: "NO_STRATEGY_SELECTED", href: "/trade" },
    {
      name: "no venue",
      input: { venue: venue({ connectedCount: 0, placeableCount: 0, label: null }) },
      code: "NO_VENUE_CONNECTED",
      href: "/admin/access",
    },
    {
      name: "read-only venue",
      input: { venue: venue({ connectedCount: 1, placeableCount: 0 }) },
      code: "NO_PLACEABLE_VENUE",
      href: "/admin/access",
    },
    { name: "risk limit", input: { riskKillSwitchActive: true }, code: "RISK_LIMIT_REACHED", href: "/admin/risk" },
    {
      name: "runner not scheduled",
      input: { runner: runner({ scheduled: false, nextDueAt: null, detail: "The stride job has not run." }) },
      code: "RUNNER_NOT_SCHEDULED",
      href: "/admin/data",
    },
  ];

  for (const testCase of cases) {
    const view = describe(testCase.input);
    assert.equal(view.state, "idle", `${testCase.name} should be idle`);
    assert.equal(view.stateLabel, "IDLE", `${testCase.name} label`);
    assert.equal(view.reason?.code, testCase.code, `${testCase.name} reason code`);
    assert.equal(view.blockers[0]?.code, testCase.code, `${testCase.name} blocker code`);
    assert.equal(view.blockers[0]?.action.href, testCase.href, `${testCase.name} fix location`);
    assert.ok((view.blockers[0]?.message ?? "").length > 20, `${testCase.name} needs a human sentence`);
    assert.match(view.detail, /cannot place/, `${testCase.name} detail explains the block`);
    assert.equal(view.headline, "SMART TRADING IS IDLE");
  }
});

test("a running activation whose last pass failed shows the error state with the pass's own words", () => {
  const view = describe({
    row: snapshot({
      lastOutcome: "error",
      lastReasonCode: "LAST_PASS_FAILED",
      lastReasonMessage: "The venue could not be reached for this pass.",
    }),
  });

  assert.equal(view.state, "error");
  assert.equal(view.stateLabel, "ERROR");
  assert.equal(view.reason?.code, "LAST_PASS_FAILED");
  assert.equal(view.reason?.message, "The venue could not be reached for this pass.");
  assert.equal(view.headline, "SMART TRADING NEEDS ATTENTION");
  assert.match(view.detail, /next pass will try again/);
});

test("a stopped activation names the owner and the time, and says open orders keep reconciling", () => {
  const view = describe({
    row: snapshot({
      status: "STOPPED",
      startedAt: NOW - 3_600_000,
      stoppedAt: NOW - 60_000,
      lastChangeReason: "OWNER_STOPPED",
      lastChangedAt: NOW - 60_000,
      lastOutcome: "running",
    }),
    openOrderCount: 2,
    lastChangedByLabel: "0x1111111111111111111111111111111111111111",
  });

  assert.equal(view.state, "stopped");
  assert.equal(view.reason?.code, "OWNER_STOPPED");
  assert.match(view.reason?.message ?? "", /Stopped by owner at 2026-10-18T11:59:00.000Z/);
  assert.match(view.reason?.message ?? "", /0x1111111111111111111111111111111111111111/);
  assert.match(view.detail, /2 order\(s\) already placed are still open/);
  assert.match(view.detail, /reconciliation continues/);
  assert.equal(view.elapsedMs, null);
  assert.equal(view.headline, "SMART TRADING IS STOPPED");
  assert.equal(view.openOrderCount, 2);
  // Stopping is not a checklist either: the owner's instruction is the whole state.
  assert.deepEqual(view.blockers, []);
});

test("start and stop are idempotent by rule, and only the opposite transition writes", () => {
  const startWhileRunning = planActivationChange({ action: "start", currentStatus: "RUNNING", strategyLabel: "Smart RSI · daily close" });
  assert.equal(startWhileRunning.write, false);
  assert.match(startWhileRunning.write === false ? startWhileRunning.message : "", /already running with Smart RSI/);

  const freshStart = planActivationChange({ action: "start", currentStatus: null });
  assert.deepEqual(freshStart, { write: true, from: null, to: "RUNNING" });

  const restart = planActivationChange({ action: "start", currentStatus: "STOPPED" });
  assert.deepEqual(restart, { write: true, from: "STOPPED", to: "RUNNING" });

  const stopRunning = planActivationChange({ action: "stop", currentStatus: "RUNNING" });
  assert.deepEqual(stopRunning, { write: true, from: "RUNNING", to: "STOPPED" });

  const secondStop = planActivationChange({ action: "stop", currentStatus: "STOPPED" });
  assert.equal(secondStop.write, false);
  assert.match(secondStop.write === false ? secondStop.message : "", /already stopped/);

  const stopWithNoRow = planActivationChange({ action: "stop", currentStatus: null });
  assert.equal(stopWithNoRow.write, false);
  assert.match(stopWithNoRow.write === false ? stopWithNoRow.message : "", /nothing to stop/);
});

test("a start naming a different published bot switches the activation instead of answering that it is already running", () => {
  // Phase 30: publishing a bot mid-run and then choosing it is how the owner moves from the
  // built-in to their own rules. Same-id presses stay no-ops; a different id must write, or
  // the panel would report the old strategy while the owner believes the new one is live.
  const sameBot = planActivationChange({
    action: "start",
    currentStatus: "RUNNING",
    currentStrategyId: "bot:bot-1",
    nextStrategyId: "bot:bot-1",
    strategyLabel: "Daily BTC · v1",
  });
  assert.equal(sameBot.write, false);
  assert.match(sameBot.write === false ? sameBot.message : "", /already running/);

  const otherBot = planActivationChange({
    action: "start",
    currentStatus: "RUNNING",
    currentStrategyId: "bot:bot-1",
    nextStrategyId: "bot:bot-2",
  });
  assert.deepEqual(otherBot, { write: true, from: "RUNNING", to: "RUNNING" });

  const fromBuiltIn = planActivationChange({
    action: "start",
    currentStatus: "RUNNING",
    currentStrategyId: "rsi-daily-close",
    nextStrategyId: "bot:bot-2",
  });
  assert.equal(fromBuiltIn.write, true);

  // Omitting both ids is the pre-phase-30 call shape and must stay the idempotent no-op.
  assert.equal(planActivationChange({ action: "start", currentStatus: "RUNNING" }).write, false);
});

test("a stop-then-start pair leaves one activation by rule, and the second press writes nothing", () => {
  // The persistence layer keys the row by account, so the sequence below is exactly what
  // the two controls do: stop writes once, start writes once, and a repeated press of
  // either is a no-op that still answers.
  const afterStop = planActivationChange({ action: "stop", currentStatus: "RUNNING" });
  assert.equal(afterStop.write, true);
  const statusAfterStop = afterStop.write ? afterStop.to : null;

  const afterStart = planActivationChange({ action: "start", currentStatus: statusAfterStop });
  assert.equal(afterStart.write, true);
  const statusAfterStart = afterStart.write ? afterStart.to : null;

  assert.equal(statusAfterStart, "RUNNING");
  assert.equal(planActivationChange({ action: "start", currentStatus: statusAfterStart }).write, false);
  assert.equal(planActivationChange({ action: "stop", currentStatus: statusAfterStart }).write, true);
});

const PUBLISHED_BOT = {
  id: "bot:bot-1",
  label: "Daily BTC · v1",
  detail: "This account's selected published bot.",
};

const DELETED_BOT = {
  id: "bot:bot-2",
  label: "Daily BTC · v1 (deleted)",
  detail: "This bot was deleted, so the runner records that there is nothing to evaluate.",
};

test("the picker offers the built-in that is selected plus every published bot, once each", () => {
  // Phase 30: the catalog is where a published bot becomes startable. It is rendered, so
  // the list and the ids a press can send are the same set — and the selected built-in is
  // in the list even though the bot catalog never contains it, or the picker would drop
  // the strategy the account is actually on.
  const choices = strategyChoices({
    strategy: STRATEGY,
    strategyCatalog: [PUBLISHED_BOT, { ...PUBLISHED_BOT, label: "Daily BTC duplicate" }, DELETED_BOT],
  });
  assert.deepEqual(choices.map((choice) => choice.id), [STRATEGY?.id, "bot:bot-1", "bot:bot-2"]);
  assert.equal(choices[0]?.label, "Smart RSI · daily close");
  // A deleted bot the activation still names is offered with the state in its label, so
  // the owner can see why the runner is not evaluating it rather than finding a silent gap.
  assert.match(choices[2]?.label ?? "", /\(deleted\)/);
});

test("an empty catalog still offers the built-ins rather than an empty picker", () => {
  assert.deepEqual(strategyChoices({ strategy: null, strategyCatalog: [] }), [...SMART_STRATEGIES]);
});

test("a press starts the selected strategy, defaulting to the running one and then the catalog", () => {
  // The default is what a press sends when the owner never touched the picker, so it must
  // be the running strategy first: anything else would move a running account on a press
  // the owner read as "keep going".
  assert.equal(defaultStrategyId({ strategy: PUBLISHED_BOT, strategyCatalog: [DELETED_BOT] }), "bot:bot-1");
  assert.equal(defaultStrategyId({ strategy: null, strategyCatalog: [PUBLISHED_BOT] }), "bot:bot-1");
  // Nothing offered and nothing selected is null, not a guessed id: the route applies the
  // default it documents, and the panel does not invent one.
  assert.equal(defaultStrategyId({ strategy: null, strategyCatalog: [] }), null);
});

test("a published bot is startable by id once it is in the catalog", () => {
  const view = describe({ row: null, strategy: null, strategyCatalog: [PUBLISHED_BOT] });
  assert.deepEqual(view.strategyCatalog.map((entry) => entry.id), ["bot:bot-1"]);
  assert.equal(defaultStrategyId({ strategy: view.strategy, strategyCatalog: view.strategyCatalog }), "bot:bot-1");
});
