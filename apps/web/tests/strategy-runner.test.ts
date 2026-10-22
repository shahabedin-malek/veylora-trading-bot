import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RISK_POLICY, evaluateRiskOrder } from "@/lib/risk-controls/policy";
import { submitOrder, type OrderProcessOutcome, type SubmitOrderInput } from "@/lib/orders/process";
import {
  createMemoryIdempotencyStore,
  createMemoryOrderStore,
  createScriptedVenue,
} from "@/lib/orders/test-support";
import {
  STRATEGY_DEFINITIONS,
  decisionWindowStart,
  evaluateStrategyDecision,
  marketViewFromCandles,
  missedDecisionWindows,
  strategyDefinition,
  type StrategyMarketView,
  type StrategyPosition,
} from "@/lib/strategies/decide";
import {
  STRATEGY_REASON_CODES,
  STRATEGY_REASON_INFO,
  isStrategyReasonCode,
  strategyCodeForOrderFailure,
} from "@/lib/strategies/reasons";
import {
  runStrategyDecisionPass,
  type StrategyActivationRow,
  type StrategyDecisionWrite,
  type StrategyPassDeps,
  type StrategyRunnerStore,
} from "@/lib/strategies/runner";

const strategy = strategyDefinition("rsi-daily-close")!;
const HOUR = 60 * 60_000;

const market: StrategyMarketView = {
  market: "BTC-USD",
  rsi: 25,
  rsiClosedAt: "2026-10-17T00:00:00.000Z",
  candles: 40,
  lastClose: "60000.00",
  lastClosedAt: "2026-10-17T00:00:00.000Z",
};

const oversold = { ...market, rsi: 25 };
const neutral = { ...market, rsi: 55 };
const overbought = { ...market, rsi: 75 };

function candle(close: number, day: string) {
  const open = new Date(`${day}T00:00:00.000Z`);
  const closeTime = new Date(open.getTime() + 86_400_000);
  return { close: close.toFixed(2), closeTime };
}

// ---------------------------------------------------------------------------------------
// The rule, without a database
// ---------------------------------------------------------------------------------------

test("the signal uses closed candles only, and names the close that went into it", () => {
  const closes = Array.from({ length: 20 }, (_, index) => 100 - index);
  const days = closes.map((_, index) => {
    const day = new Date(Date.UTC(2026, 8, 1) + index * 86_400_000);
    return day.toISOString().slice(0, 10);
  });
  const candles = [
    ...closes.map((close, index) => candle(close, days[index])),
    // Still forming at the as-of time: it must not move the signal.
    { close: "1.00", closeTime: "2026-10-20T00:00:00.000Z" },
  ];
  const view = marketViewFromCandles({ market: "BTC-USD", candles }, new Date("2026-10-18T00:00:00.000Z"));
  assert.ok(view);
  assert.equal(view.lastClose, "81");
  assert.equal(view.lastClosedAt, "2026-09-21T00:00:00.000Z");
  assert.ok(view.rsi < 30, `expected an oversold RSI, got ${view.rsi}`);
});

test("too few closed candles is its own answer rather than a guess", () => {
  const view = marketViewFromCandles(
    { market: "BTC-USD", candles: [candle(100, "2026-10-10"), candle(101, "2026-10-11")] },
    new Date("2026-10-18T00:00:00.000Z"),
  );
  assert.equal(view, null);
});

test("an oversold close enters with the strategy's budget and its stop", () => {
  const decision = evaluateStrategyDecision({ strategy, market: oversold, position: null, openOrderCount: 0 });
  assert.equal(decision.action, "ENTER");
  assert.equal(decision.code, "ENTRY_CONDITION_MET");
  const order = "order" in decision ? decision.order : null;
  assert.ok(order);
  assert.equal(order.side, "BUY");
  assert.equal(order.notionalUsdCents, 2500);
  // 25 USD at 60,000 is 0.00041666…, floored to the quantity precision of the order path.
  assert.equal(order.quantity, "0.00041667");
  assert.equal(order.stopLossPrice, "58800.00");
});

test("no entry names the values it compared, so the panel is not a dead end", () => {
  const decision = evaluateStrategyDecision({ strategy, market: neutral, position: null, openOrderCount: 0 });
  assert.equal(decision.action, "HOLD");
  assert.equal(decision.code, "NO_ENTRY_CONDITION");
  const entry = decision.conditions.find((condition) => condition.id === "entry-rsi");
  assert.ok(entry);
  assert.equal(entry.value, "55.00");
  assert.equal(entry.met, false);
  assert.match(decision.message, /55\.00/);
});

test("an order still working at the venue outranks a second entry", () => {
  const decision = evaluateStrategyDecision({ strategy, market: oversold, position: null, openOrderCount: 1 });
  assert.equal(decision.action, "HOLD");
  assert.equal(decision.code, "POSITION_OPEN");
  assert.equal("order" in decision, false);
});

const position: StrategyPosition = { quantity: "0.00040000", entryPrice: "60000.00", stopLossPrice: "58800.00" };

test("a position closes on the overbought close", () => {
  const decision = evaluateStrategyDecision({ strategy, market: overbought, position, openOrderCount: 0 });
  assert.equal(decision.action, "EXIT");
  assert.equal(decision.code, "EXIT_CONDITION_MET");
  const order = "order" in decision ? decision.order : null;
  assert.ok(order);
  assert.equal(order.side, "SELL");
  assert.equal(order.quantity, "0.00040000");
});

test("the stop closes a position even when the RSI is not overbought", () => {
  const decision = evaluateStrategyDecision({
    strategy,
    market: { ...market, rsi: 45, lastClose: "58700.00" },
    position,
    openOrderCount: 0,
  });
  assert.equal(decision.action, "EXIT");
  assert.equal(decision.code, "STOP_LOSS_TRIGGERED");
});

test("a held position says what it is waiting for", () => {
  const decision = evaluateStrategyDecision({
    strategy,
    market: { ...market, rsi: 50, lastClose: "61000.00" },
    position,
    openOrderCount: 0,
  });
  assert.equal(decision.action, "HOLD");
  assert.equal(decision.code, "EXIT_CONDITION_NOT_MET");
  assert.equal(decision.conditions.some((condition) => condition.id === "stop-loss"), true);
});

test("a disabled strategy and missing data are each their own state", () => {
  const disabled = evaluateStrategyDecision({ strategy: null, market: oversold, position: null, openOrderCount: 0 });
  assert.equal(disabled.code, "STRATEGY_DISABLED");
  const noData = evaluateStrategyDecision({ strategy, market: null, position: null, openOrderCount: 0 });
  assert.equal(noData.code, "MARKET_DATA_UNAVAILABLE");
});

// ---------------------------------------------------------------------------------------
// The taxonomy
// ---------------------------------------------------------------------------------------

test("the taxonomy is closed, named, and covers every reason the phase requires", () => {
  for (const code of STRATEGY_REASON_CODES) {
    assert.equal(isStrategyReasonCode(code), true);
    assert.ok(STRATEGY_REASON_INFO[code].label.length > 0, `${code} has no label`);
    assert.ok(STRATEGY_REASON_INFO[code].fallback.length > 0, `${code} has no sentence`);
  }
  const required = [
    "INSUFFICIENT_VENUE_BALANCE",
    "INVALID_CREDENTIAL",
    "NO_ENTRY_CONDITION",
    "VENUE_UNREACHABLE",
    "RATE_LIMITED",
    "RISK_LIMIT_REACHED",
    "STRATEGY_DISABLED",
    "RUNNER_MISSED_WINDOW",
  ] as const;
  for (const code of required) {
    assert.equal(STRATEGY_REASON_INFO[code].taxonomy, true, `${code} is not marked as part of the phase taxonomy`);
  }
});

test("order-path reasons map onto the strategy taxonomy rather than being flattened", () => {
  assert.equal(strategyCodeForOrderFailure({ code: "INVALID_CREDENTIAL", kind: "refused" }), "INVALID_CREDENTIAL");
  assert.equal(strategyCodeForOrderFailure({ code: "INSUFFICIENT_BALANCE", kind: "refused" }), "INSUFFICIENT_VENUE_BALANCE");
  assert.equal(strategyCodeForOrderFailure({ code: "PROVIDER_RATE_LIMITED", kind: "failed" }), "RATE_LIMITED");
  assert.equal(strategyCodeForOrderFailure({ code: "VENUE_UNAVAILABLE", kind: "failed" }), "VENUE_UNREACHABLE");
  assert.equal(strategyCodeForOrderFailure({ code: "ORDER_REJECTED", kind: "failed" }), "ORDER_FAILED");
  assert.equal(strategyCodeForOrderFailure({ code: "SOMETHING_NEW", kind: "refused" }), "ORDER_REFUSED");
});

test("windows align to the strategy's own interval", () => {
  const start = decisionWindowStart(Date.parse("2026-10-18T10:31:00.000Z"), strategy);
  assert.equal(new Date(start).toISOString(), "2026-10-18T10:00:00.000Z");
  const next = decisionWindowStart(Date.parse("2026-10-18T11:00:01.000Z"), strategy);
  assert.equal(next - start, HOUR);
});

test("a missed window is one recorded gap, keyed away from the window being decided", () => {
  const gap = missedDecisionWindows({
    lastWindowStart: Date.parse("2026-10-18T09:00:00.000Z"),
    windowStart: Date.parse("2026-10-18T12:00:00.000Z"),
    intervalMs: HOUR,
  });
  assert.deepEqual(gap, { count: 2, rowWindowStart: Date.parse("2026-10-18T11:00:00.000Z") });
  assert.equal(
    missedDecisionWindows({
      lastWindowStart: Date.parse("2026-10-18T11:00:00.000Z"),
      windowStart: Date.parse("2026-10-18T12:00:00.000Z"),
      intervalMs: HOUR,
    }),
    null,
  );
});

// ---------------------------------------------------------------------------------------
// The loop, with an in-memory store
// ---------------------------------------------------------------------------------------

class MemoryStrategyStore implements StrategyRunnerStore {
  decisions: (StrategyDecisionWrite & { id: string })[] = [];
  openOrderCountValue = 0;
  positionValue: StrategyPosition | null = null;
  constructor(public rows: StrategyActivationRow[]) {}

  async listRunningActivations() {
    return this.rows.filter((row) => row.status === "RUNNING");
  }

  async claimWindow({ activationId, windowStart }: { activationId: string; windowStart: Date }) {
    const row = this.rows.find((candidate) => candidate.id === activationId);
    if (!row || row.status !== "RUNNING") return false;
    if (row.lastWindowStart && row.lastWindowStart.getTime() >= windowStart.getTime()) return false;
    row.lastWindowStart = windowStart;
    return true;
  }

  async recordDecision(decision: StrategyDecisionWrite) {
    const key = `${decision.activationId}:${decision.windowStart.getTime()}`;
    if (this.decisions.some((stored) => `${stored.activationId}:${stored.windowStart.getTime()}` === key)) return false;
    this.decisions.push({ ...decision, id: `decision-${this.decisions.length + 1}` });
    return true;
  }

  async updateActivation(input: {
    activationId: string;
    now: Date;
    outcome: "running" | "idle" | "error";
    reasonCode: string;
    reasonMessage: string;
  }) {
    const row = this.rows.find((candidate) => candidate.id === input.activationId);
    if (!row) return;
    (row as StrategyActivationRow & { lastOutcome?: string; lastEvaluatedAt?: Date | null }).lastOutcome = input.outcome;
    (row as StrategyActivationRow & { lastEvaluatedAt?: Date | null }).lastEvaluatedAt = input.now;
  }

  async openOrderCount() {
    return this.openOrderCountValue;
  }

  async position() {
    return this.positionValue;
  }

  async tradesToday() {
    return 0;
  }
}

function activation(overrides: Partial<StrategyActivationRow> = {}): StrategyActivationRow {
  return {
    id: "activation-1",
    userId: "user-1",
    status: "RUNNING",
    strategyId: "rsi-daily-close",
    startedAt: new Date("2026-10-18T08:00:00.000Z"),
    lastWindowStart: null,
    ...overrides,
  };
}

function deps(store: StrategyRunnerStore, overrides: Partial<StrategyPassDeps> = {}): StrategyPassDeps {
  return {
    store,
    loadMarket: async () => oversold,
    readRiskPolicy: async () => ({ ...DEFAULT_RISK_POLICY, approvedSymbols: ["BTC-USD"] }),
    evaluateRisk: () => ({ decision: "ALLOW", policyVersion: "veylora-risk-v1", reasons: [] }),
    readRouting: async () => "paper",
    readVenue: async () => ({ connectedCount: 1, placeableCount: 1 }),
    // Phase 25: the switches and the measured usage are injected like everything else, so a
    // pass can be proven without a database.
    readStrategySwitch: async () => false,
    readUsage: async () => ({
      openPositions: 0,
      tradesInInterval: 0,
      strategyOpenNotionalUsd: "0",
      cooldownRemainingMinutes: 0,
      venueId: "dev-paper",
    }),
    // Phase 31: the pass announces what it decided; a unit test records that so it never
    // reaches a database or a receiver.
    publish: async ({ eventType }) => ({ eventType, queued: 0, delivered: 0, failed: 0 }),
    submit: async () =>
      ({
        kind: "submitted",
        order: { id: "order-1" },
        attempts: 1,
        idempotencyKey: "key",
        reason: { code: "ALREADY_COMPLETED", message: "", retryable: false },
        status: 200,
      }) as unknown as OrderProcessOutcome,
    ...overrides,
  };
}

test("a pass decides once, places once and records the decision with its inputs", async () => {
  const store = new MemoryStrategyStore([activation()]);
  const submitted: SubmitOrderInput[] = [];
  const summary = await runStrategyDecisionPass(
    Date.parse("2026-10-18T10:31:00.000Z"),
    deps(store, {
      submit: async (input) => {
        submitted.push(input);
        return {
          kind: "submitted",
          order: { id: "order-1" },
          attempts: 1,
          idempotencyKey: "key",
          reason: { code: "ALREADY_COMPLETED", message: "", retryable: false },
          status: 200,
        } as unknown as OrderProcessOutcome;
      },
    }),
  );

  assert.equal(summary.decided, 1);
  assert.equal(summary.placed, 1);
  assert.equal(submitted.length, 1);
  assert.equal(store.decisions.length, 1);

  const decision = store.decisions[0];
  assert.equal(decision.outcome, "ORDER_PLACED");
  assert.equal(decision.reasonCode, "ENTRY_CONDITION_MET");
  assert.equal(decision.orderId, "order-1");
  assert.equal(decision.inputs.rsi, 25);
  assert.equal(decision.inputs.lastClose, "60000.00");
  assert.equal(
    submitted[0].intent.clientKey,
    `strategy.activation-1.${Date.parse("2026-10-18T10:00:00.000Z")}`,
    "the order's idempotency key is derived from the window, so a replay cannot place twice",
  );
  const row = store.rows[0] as StrategyActivationRow & { lastOutcome?: string };
  assert.equal(row.lastOutcome, "running");
});

test("a decision places through the real order path, not a stand-in", async () => {
  const orders = createMemoryOrderStore();
  const idempotency = createMemoryIdempotencyStore();
  const venue = createScriptedVenue({});
  const store = new MemoryStrategyStore([activation()]);
  const now = Date.parse("2026-10-18T10:31:00.000Z");

  const summary = await runStrategyDecisionPass(
    now,
    deps(store, {
      submit: (input) =>
        submitOrder(input, {
          store: orders.store,
          idempotency: idempotency.store,
          venue: venue.port,
          now: () => new Date(now),
          sleep: async () => undefined,
        }),
    }),
  );

  assert.equal(summary.placed, 1);
  assert.equal(venue.calls.submit, 1, "the phase-06 order path contacted the venue once");
  assert.equal(orders.orders.size, 1);
  const stored = [...orders.orders.values()][0];
  assert.equal(stored.market, "BTC-USD");
  assert.equal(stored.side, "BUY");
  assert.equal(stored.requestedQuantity, "0.00041667");
  assert.equal(stored.stopLossPrice, "58800.00");
  assert.equal(store.decisions[0].orderId, stored.id, "the decision names the order it placed");
});

test("a second pass in the same window writes nothing and places nothing", async () => {
  const store = new MemoryStrategyStore([activation()]);
  const now = Date.parse("2026-10-18T10:31:00.000Z");
  await runStrategyDecisionPass(now, deps(store));
  let submissions = 0;
  const second = await runStrategyDecisionPass(
    now + 60_000,
    deps(store, {
      submit: async () => {
        submissions += 1;
        throw new Error("a second order must not be submitted in the same window");
      },
    }),
  );
  assert.equal(store.decisions.length, 1);
  assert.equal(second.decided, 0);
  assert.equal(submissions, 0);
});

test("two concurrent passes produce one decision for one window", async () => {
  const store = new MemoryStrategyStore([activation()]);
  let submissions = 0;
  const run = () =>
    runStrategyDecisionPass(
      Date.parse("2026-10-18T10:31:00.000Z"),
      deps(store, {
        submit: async () => {
          submissions += 1;
          return {
            kind: "submitted",
            order: { id: `order-${submissions}` },
            attempts: 1,
            idempotencyKey: "key",
            reason: { code: "ALREADY_COMPLETED", message: "", retryable: false },
            status: 200,
          } as unknown as OrderProcessOutcome;
        },
      }),
    );

  const [first, second] = await Promise.all([run(), run()]);
  assert.equal(store.decisions.length, 1, "the window was claimed once and decided once");
  assert.equal(submissions, 1);
  assert.equal(first.decided + second.decided, 1);
});

test("a redeploy mid-interval records one gap and carries on with the current window", async () => {
  const store = new MemoryStrategyStore([
    activation({ lastWindowStart: new Date("2026-10-18T07:00:00.000Z") }),
  ]);
  const summary = await runStrategyDecisionPass(Date.parse("2026-10-18T10:31:00.000Z"), deps(store));

  assert.equal(summary.gaps, 1);
  const gap = store.decisions.find((decision) => decision.reasonCode === "RUNNER_MISSED_WINDOW");
  assert.ok(gap);
  assert.equal(gap.windowStart.toISOString(), "2026-10-18T09:00:00.000Z");
  assert.equal(gap.inputs.missedWindows, 2);
  const current = store.decisions.find((decision) => decision.reasonCode === "ENTRY_CONDITION_MET");
  assert.ok(current);
  assert.equal(store.decisions.length, 2);
});

test("decisions accumulate across intervals, so a closed browser loses nothing", async () => {
  const store = new MemoryStrategyStore([activation()]);
  await runStrategyDecisionPass(Date.parse("2026-10-18T10:31:00.000Z"), deps(store));
  await runStrategyDecisionPass(Date.parse("2026-10-18T11:31:00.000Z"), deps(store));
  await runStrategyDecisionPass(Date.parse("2026-10-18T12:31:00.000Z"), deps(store));
  assert.equal(store.decisions.length, 3);
  assert.deepEqual(
    store.decisions.map((decision) => decision.windowStart.toISOString()),
    ["2026-10-18T10:00:00.000Z", "2026-10-18T11:00:00.000Z", "2026-10-18T12:00:00.000Z"],
  );
});

test("a risk refusal is recorded as its own reason and nothing is sent", async () => {
  const store = new MemoryStrategyStore([activation()]);
  let submissions = 0;
  const summary = await runStrategyDecisionPass(
    Date.parse("2026-10-18T10:31:00.000Z"),
    deps(store, {
      evaluateRisk: () => ({
        decision: "REFUSE",
        policyVersion: "veylora-risk-v1",
        reasons: ["symbol-not-allowed"],
        limits: [],
      }),
      submit: async () => {
        submissions += 1;
        throw new Error("a refused order must not reach the venue");
      },
    }),
  );

  assert.equal(submissions, 0);
  assert.equal(summary.idle, 1);
  assert.equal(store.decisions[0].reasonCode, "RISK_LIMIT_REACHED");
  assert.match(store.decisions[0].reasonMessage, /symbol-not-allowed/);
  const row = store.rows[0] as StrategyActivationRow & { lastOutcome?: string };
  assert.equal(row.lastOutcome, "idle");
});

test("no placeable credential is a reason, and the activation keeps running", async () => {
  const store = new MemoryStrategyStore([activation()]);
  const summary = await runStrategyDecisionPass(
    Date.parse("2026-10-18T10:31:00.000Z"),
    deps(store, { readVenue: async () => ({ connectedCount: 0, placeableCount: 0 }) }),
  );
  assert.equal(summary.idle, 1);
  assert.equal(store.decisions[0].reasonCode, "CREDENTIAL_MISSING");
  assert.equal(store.rows[0].status, "RUNNING");
});

test("a venue failure is an error decision with the order path's own sentence", async () => {
  const store = new MemoryStrategyStore([activation()]);
  const summary = await runStrategyDecisionPass(
    Date.parse("2026-10-18T10:31:00.000Z"),
    deps(store, {
      submit: async () =>
        ({
          kind: "failed",
          order: { id: "order-9" },
          attempts: 3,
          idempotencyKey: "key",
          reason: { code: "VENUE_UNAVAILABLE", message: "The exchange did not answer.", retryable: true },
          status: 503,
        }) as unknown as OrderProcessOutcome,
    }),
  );

  assert.equal(summary.error, 1);
  assert.equal(store.decisions[0].outcome, "ERROR");
  assert.equal(store.decisions[0].reasonCode, "VENUE_UNREACHABLE");
  assert.match(store.decisions[0].reasonMessage, /did not answer/);
  const row = store.rows[0] as StrategyActivationRow & { lastOutcome?: string };
  assert.equal(row.lastOutcome, "error");
});

// ---------------------------------------------------------------------------------------
// Phase 25: the owner's switches and caps, in the loop
// ---------------------------------------------------------------------------------------

const roomyPolicy = {
  ...DEFAULT_RISK_POLICY,
  approvedSymbols: ["BTC-USD"],
  // The phase-20 percentage checks are not the subject here; a roomy percentage lets an
  // order through so a phase-25 cap can be the one that refuses it.
  maxOpenExposurePercent: "200",
  maxRiskPerTradePercent: "5",
};

test("a per-strategy kill switch stops this strategy and leaves the activation running", async () => {
  const store = new MemoryStrategyStore([activation()]);
  let submissions = 0;
  const summary = await runStrategyDecisionPass(
    Date.parse("2026-10-18T10:31:00.000Z"),
    deps(store, {
      readStrategySwitch: async () => true,
      submit: async () => {
        submissions += 1;
        throw new Error("a switched-off strategy must not place an order");
      },
    }),
  );

  assert.equal(submissions, 0);
  assert.equal(summary.idle, 1);
  assert.equal(store.decisions[0].reasonCode, "RISK_LIMIT_REACHED");
  assert.match(store.decisions[0].reasonMessage, /strategy's kill switch/);
  assert.equal(store.rows[0].status, "RUNNING", "the switch stops orders, not the run");
});

test("the global kill switch stops every strategy within the pass", async () => {
  const store = new MemoryStrategyStore([activation(), activation({ id: "activation-2", userId: "user-2" })]);
  let submissions = 0;
  const summary = await runStrategyDecisionPass(
    Date.parse("2026-10-18T10:31:00.000Z"),
    deps(store, {
      readRiskPolicy: async () => ({ ...roomyPolicy, killSwitchActive: true }),
      submit: async () => {
        submissions += 1;
        throw new Error("the global switch is engaged");
      },
    }),
  );

  assert.equal(submissions, 0);
  assert.equal(summary.idle, 2);
  for (const decision of store.decisions) {
    assert.equal(decision.reasonCode, "RISK_LIMIT_REACHED");
    assert.match(decision.reasonMessage, /kill switch/);
  }
});

test("a cap below the strategy's order is recorded with the limit and the value seen", async () => {
  const store = new MemoryStrategyStore([activation()]);
  let submissions = 0;
  const summary = await runStrategyDecisionPass(
    Date.parse("2026-10-18T10:31:00.000Z"),
    deps(store, {
      // The real evaluator, so the refusal is the one the order path would produce.
      evaluateRisk: evaluateRiskOrder,
      readRiskPolicy: async () => ({ ...roomyPolicy, maxOrderNotionalUsd: "5" }),
      submit: async () => {
        submissions += 1;
        throw new Error("a refused order must not reach the venue");
      },
    }),
  );

  assert.equal(submissions, 0);
  assert.equal(summary.idle, 1);
  const decision = store.decisions[0];
  assert.equal(decision.reasonCode, "RISK_LIMIT_REACHED");
  assert.match(decision.reasonMessage, /Max notional per order 5\.00/);
  assert.match(decision.reasonMessage, /25\.00/, "the refusal names the value it saw");
  const risk = decision.inputs.risk as { limits: { limit: string; observed: string }[] } | undefined;
  assert.ok(risk);
  assert.equal(risk.limits[0].limit, "maxOrderNotionalUsd");
  assert.equal(risk.limits[0].observed, "25.00");
});

test("a zeroed cap lets the same order through", async () => {
  const store = new MemoryStrategyStore([activation()]);
  const summary = await runStrategyDecisionPass(
    Date.parse("2026-10-18T10:31:00.000Z"),
    deps(store, {
      evaluateRisk: evaluateRiskOrder,
      readRiskPolicy: async () => ({ ...roomyPolicy, maxOrderNotionalUsd: "0" }),
    }),
  );
  assert.equal(summary.placed, 1, "a cap of zero is unlimited, so the order is placed");
});

test("unmeasurable usage is not treated as 'no limit'", async () => {
  const store = new MemoryStrategyStore([activation()]);
  let submissions = 0;
  await runStrategyDecisionPass(
    Date.parse("2026-10-18T10:31:00.000Z"),
    deps(store, {
      readUsage: async () => {
        throw new Error("the order table is unreachable");
      },
      submit: async () => {
        submissions += 1;
        throw new Error("no order may be placed without measured usage");
      },
    }),
  );
  assert.equal(submissions, 0);
  assert.equal(store.decisions[0].reasonCode, "RISK_LIMIT_REACHED");
  assert.match(store.decisions[0].reasonMessage, /could not be measured/);
  assert.equal(store.rows[0].status, "RUNNING");
});

test("every published strategy definition can be evaluated", () => {
  for (const definition of STRATEGY_DEFINITIONS) {
    const decision = evaluateStrategyDecision({
      strategy: definition,
      market: { ...oversold, market: definition.market },
      position: null,
      openOrderCount: 0,
    });
    assert.ok(decision.action.length > 0);
  }
});
