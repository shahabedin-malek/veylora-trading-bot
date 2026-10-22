import assert from "node:assert/strict";
import test from "node:test";
import { cancelOrder, submitOrder, type OrderProcessDeps } from "@/lib/orders/process";
import { deriveIdempotencyKey, IDEMPOTENCY_SCOPES, type OrderIntent } from "@/lib/orders/idempotency";
import {
  createMemoryIdempotencyStore,
  createMemoryOrderStore,
  createScriptedVenue,
  createTestClock,
  type MemoryIdempotencyStore,
  type MemoryOrderStore,
  type ScriptedVenue,
} from "@/lib/orders/test-support";

/**
 * The acceptance criteria, run against the injectable ports.
 *
 * Nothing here touches a database or a network: the pure state machine and the
 * two ports are the whole system, which is what makes "an illegal transition was
 * refused with no side effect" a countable assertion — how many times the venue
 * was called, and how many transitions were written.
 */

const intent: OrderIntent = {
  userId: "dev-test-account",
  venue: "test-venue",
  market: "BTC-USD",
  side: "BUY",
  orderType: "MARKET",
  quantity: "1",
  limitPrice: null,
  stopLossPrice: "0",
  notionalUsdCents: 10_000,
  verifiedBalanceCents: 250_000,
};

function harness(inputs: {
  submits?: Parameters<typeof createScriptedVenue>[0]["submits"];
  lookups?: Parameters<typeof createScriptedVenue>[0]["lookups"];
  cancels?: Parameters<typeof createScriptedVenue>[0]["cancels"];
  sleeps?: number[];
} = {}): {
  orders: MemoryOrderStore;
  idempotency: MemoryIdempotencyStore;
  venue: ScriptedVenue;
  deps: OrderProcessDeps;
  clock: ReturnType<typeof createTestClock>;
} {
  const orders = createMemoryOrderStore();
  const idempotency = createMemoryIdempotencyStore();
  const venue = createScriptedVenue({ submits: inputs.submits, lookups: inputs.lookups, cancels: inputs.cancels });
  const clock = createTestClock();
  const sleeps = inputs.sleeps ?? [];
  const deps: OrderProcessDeps = {
    store: orders.store,
    idempotency: idempotency.store,
    venue: venue.port,
    now: clock.now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.advance(ms);
    },
  };
  return { orders, idempotency, venue, deps, clock };
}

test("two identical submissions with the same key create one order", async () => {
  const { orders, venue, deps } = harness();

  const first = await submitOrder({ intent, actorUserId: "dev-test-account" }, deps);
  const second = await submitOrder({ intent, actorUserId: "dev-test-account" }, deps);

  assert.equal(first.kind, "submitted");
  assert.equal(orders.orders.size, 1, "a retried identical intent is one order, not two");
  assert.equal(venue.calls.submit, 1, "the venue was contacted once");
  assert.equal(second.kind, "replayed");
  assert.equal(second.reason.code, "ALREADY_COMPLETED");
  assert.equal(second.order?.id, first.order?.id);
  assert.equal(second.idempotencyKey, first.idempotencyKey);

  // One audit chain: created once, submitted once.
  assert.deepEqual(
    orders.transitions.map((transition) => `${transition.from}->${transition.to}`),
    ["CREATED->SUBMITTED"],
  );
});

test("a deliberate second order needs a different key, and says so when the key is reused for something else", async () => {
  const { orders, venue, deps } = harness();

  await submitOrder({ intent, actorUserId: "dev-test-account" }, deps);
  // The same key with a *different* intent is refused rather than replayed.
  const reused = await submitOrder(
    { intent: { ...intent, clientKey: "explicit-attempt-1" }, actorUserId: "dev-test-account" },
    deps,
  );
  assert.notEqual(reused.kind, "refused");

  const conflict = await submitOrder(
    {
      // Same explicit key as the previous call, but a different quantity: the key
      // is now bound to another operation, which is a refusal, not a replay.
      intent: { ...intent, quantity: "2", clientKey: "explicit-attempt-1" },
      actorUserId: "dev-test-account",
    },
    deps,
  );
  assert.equal(conflict.kind, "refused");
  assert.equal(conflict.reason.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(conflict.status, 409);
  assert.equal(orders.orders.size, 2);
  assert.equal(venue.calls.submit, 2);
});

test("a venue timeout is looked up, not resent, and a retry produces one order and one audit chain", async () => {
  const { orders, venue, deps } = harness({
    submits: [
      { kind: "timeout", reason: "the venue did not answer", providerResponse: { simulated: "timeout" } },
      { kind: "accepted", venueOrderId: "test-venue-order", reported: "OPEN", filledQuantity: "0", providerResponse: { accepted: true } },
    ],
    lookups: [{ state: "NOT_FOUND", reportedAt: "2026-10-15T12:00:00.000Z", reason: "nothing recorded yet" }],
  });

  const outcome = await submitOrder({ intent, actorUserId: "dev-test-account" }, deps);

  assert.equal(outcome.kind, "submitted");
  assert.equal(outcome.attempts, 2);
  assert.equal(orders.orders.size, 1, "one order, despite two attempts");
  assert.equal(venue.calls.submit, 2);
  assert.equal(venue.calls.lookup, 1, "the timed-out submission was looked up rather than assumed");
  // The retry carries the *same* key: that is what stops the second attempt from
  // being a second order at the venue.
  assert.equal(venue.calls.idempotencyKeys[0], venue.calls.idempotencyKeys[1]);
  assert.equal(venue.calls.idempotencyKeys[1], outcome.idempotencyKey);
  assert.equal(venue.calls.submitOrderIds[0], venue.calls.submitOrderIds[1], "both attempts are the same order row");

  // One chain, one SUBMIT transition: the retry is not a new transition.
  assert.deepEqual(
    orders.transitions.map((transition) => transition.event),
    ["SUBMIT"],
  );
  assert.deepEqual(
    orders.attempts.map((attempt) => attempt.outcome),
    ["timeout", "accepted"],
  );
  assert.match(orders.attempts[0].reason, /did not answer definitively/);
  assert.equal(orders.attempts[0].reasonCode, "VENUE_UNAVAILABLE");
  assert.deepEqual(orders.attempts[0].providerResponse, { simulated: "timeout" }, "the venue's own answer is recorded, redacted");
});

test("a timeout the venue cannot resolve for keeps the order live for reconciliation", async () => {
  const { orders, deps } = harness({
    submits: [{ kind: "timeout", reason: "no answer" }],
    lookups: [{ state: "UNKNOWN", reportedAt: "2026-10-15T12:00:00.000Z", reason: "the venue could not say" }],
  });

  const outcome = await submitOrder({ intent, actorUserId: "dev-test-account" }, deps);

  assert.equal(outcome.kind, "unresolved");
  assert.equal(outcome.status, 202);
  assert.equal(outcome.reason.code, "VENUE_UNAVAILABLE");
  assert.equal(outcome.order?.status, "SUBMITTED", "the order stays live: nothing established that it was refused");
  assert.equal(orders.transitions.length, 1);
});

test("an unreachable venue exhausts the bounded retry policy and fails with the provider's reason", async () => {
  const sleeps: number[] = [];
  const { orders, venue, deps, clock } = harness({
    submits: [{ kind: "unavailable", reason: "the venue refused the connection" }],
    sleeps,
  });

  const outcome = await submitOrder({ intent, actorUserId: "dev-test-account" }, deps);

  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.status, 502);
  assert.equal(outcome.attempts, 3, "the policy's attempt ceiling is the stop, not an infinite loop");
  assert.equal(venue.calls.submit, 3);
  assert.equal(outcome.reason.code, "VENUE_UNAVAILABLE");
  assert.match(outcome.reason.message, /refused the connection/);
  assert.deepEqual(sleeps, [1_000, 4_000], "bounded, geometric backoff between attempts");
  assert.equal(clock.now().toISOString(), "2026-10-15T12:00:05.000Z");
  assert.equal(outcome.order?.status, "FAILED");
  assert.match(outcome.order?.lastAttemptReason ?? "", /refused the connection/);
  assert.deepEqual(
    orders.transitions.map((transition) => `${transition.from}->${transition.to}`),
    ["CREATED->SUBMITTED", "SUBMITTED->FAILED"],
  );
});

test("a venue refusal is an answer, not a failure to get one, and it lands FAILED with the venue's words", async () => {
  const { orders, venue, deps } = harness({
    submits: [{ kind: "rejected", code: "INSUFFICIENT_FUNDS", reason: "the venue says the account cannot cover this order", providerResponse: { code: "x" } }],
  });

  const outcome = await submitOrder({ intent, actorUserId: "dev-test-account" }, deps);

  assert.equal(outcome.kind, "failed");
  assert.equal(venue.calls.submit, 1, "a refusal is not retried");
  assert.equal(outcome.reason.code, "ORDER_REJECTED");
  assert.equal(outcome.order?.status, "FAILED");
  assert.match(outcome.order?.lastAttemptReason ?? "", /cannot cover this order/);
  assert.deepEqual(
    orders.transitions.map((transition) => transition.event),
    ["SUBMIT", "FAIL"],
  );
});

test("an illegal transition is refused before any side effect runs", async () => {
  const { orders, venue, deps } = harness();
  const filled = orders.seed({ id: "order-filled", status: "FILLED", requestedQuantity: "1", filledQuantity: "1" });
  const terminalBefore = orders.transitions.length;

  const outcome = await cancelOrder({ orderId: filled.id, actorUserId: "dev-test-account", reason: "cancel a filled order" }, deps);

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.status, 409);
  assert.equal(outcome.reason.code, "ORDER_REJECTED");
  assert.match(outcome.reason.message, /FILLED is terminal/);
  assert.equal(venue.calls.cancel, 0, "the venue was never contacted");
  assert.equal(orders.transitions.length, terminalBefore, "nothing was written");
  assert.equal(orders.orders.get(filled.id)?.status, "FILLED", "the order was not touched");
});

test("cancelling a partially filled order keeps the executed part and records the venue's higher fill", async () => {
  const { orders, venue, deps } = harness({
    cancels: [
      {
        kind: "cancelled",
        report: { state: "CANCELLED", filledQuantity: "0.6", reportedAt: "2026-10-15T12:00:01.000Z", reason: "the venue executed 0.6 before the cancel" },
      },
    ],
  });
  const partial = orders.seed({ id: "order-partial", status: "SUBMITTED", requestedQuantity: "1", filledQuantity: "0.4" });

  const outcome = await cancelOrder({ orderId: partial.id, actorUserId: "dev-test-account", reason: "the owner cancelled the rest" }, deps);

  assert.equal(outcome.kind, "cancelled");
  assert.equal(outcome.status, 200);
  assert.equal(venue.calls.cancel, 1);
  const final = orders.orders.get(partial.id);
  assert.equal(final?.status, "CANCELLED");
  assert.equal(final?.filledQuantity, "0.6", "the executed quantity is kept, and the venue's higher figure is recorded");
  assert.equal(final?.remainingQuantity, "0.4", "only the unexecuted remainder is cancelled");
  assert.deepEqual(
    orders.transitions.map((transition) => `${transition.from}->${transition.to}`),
    ["SUBMITTED->PARTIALLY_FILLED", "PARTIALLY_FILLED->CANCELLED"],
    "the fill is written as a fill first, then the cancel",
  );
  // The disagreement is recorded with both values.
  assert.equal(orders.reconciliations.length, 1);
  const divergence = orders.reconciliations[0].divergences.find((entry) => entry.field === "filledQuantity");
  assert.deepEqual({ local: divergence?.local, venue: divergence?.venue }, { local: "0.4", venue: "0.6" });
  assert.match(outcome.reason.message, /0\.6 of 1 already executed/);
});

test("a cancel the venue does not confirm leaves the order live instead of reporting a lie", async () => {
  const { orders, venue, deps } = harness({ cancels: [{ kind: "unavailable", reason: "the venue could not be reached" }] });
  const live = orders.seed({ id: "order-live", status: "SUBMITTED", requestedQuantity: "1" });

  const outcome = await cancelOrder({ orderId: live.id, actorUserId: "dev-test-account", reason: "the owner cancelled" }, deps);

  assert.equal(outcome.kind, "unresolved");
  assert.equal(outcome.status, 202);
  assert.equal(outcome.reason.code, "VENUE_UNAVAILABLE");
  assert.equal(orders.orders.get(live.id)?.status, "SUBMITTED", "the order is still live");
  assert.deepEqual(orders.transitions, [], "no cancel transition was written");
  assert.equal(venue.calls.cancel, 1);
  assert.match(orders.attempts[0].reason, /cancel was not confirmed/);
});

test("cancelling twice with the same reason replays the first result", async () => {
  const { orders, venue, deps } = harness();
  const live = orders.seed({ id: "order-twice", status: "SUBMITTED", requestedQuantity: "1" });

  const first = await cancelOrder({ orderId: live.id, actorUserId: "dev-test-account", reason: "the owner cancelled" }, deps);
  const second = await cancelOrder({ orderId: live.id, actorUserId: "dev-test-account", reason: "the owner cancelled" }, deps);

  assert.equal(first.kind, "cancelled");
  assert.equal(second.kind, "replayed");
  assert.equal(second.reason.code, "ALREADY_COMPLETED");
  assert.equal(venue.calls.cancel, 1, "the venue saw one cancel, not two");
  assert.equal(orders.orders.get(live.id)?.status, "CANCELLED");
});

test("a cancel for an order that does not exist is refused, and nothing is reserved against it", async () => {
  const { idempotency, venue, deps } = harness();

  const outcome = await cancelOrder({ orderId: "order-missing", actorUserId: "dev-test-account", reason: "the owner cancelled" }, deps);

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.status, 404);
  assert.equal(venue.calls.cancel, 0);
  const key = outcome.idempotencyKey;
  const rows = [...idempotency.rows.values()].filter((row) => row.scope === IDEMPOTENCY_SCOPES.cancelOrder && row.key === key);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "FAILED", "the key is released so a later attempt can try again");
});

test("a venue that accepts an order it has already partly executed is recorded as partly executed", async () => {
  const { orders, deps } = harness({
    submits: [
      {
        kind: "accepted",
        venueOrderId: "test-partial",
        reported: "PARTIALLY_FILLED",
        filledQuantity: "0.25",
        providerResponse: { accepted: true },
      },
    ],
  });

  const outcome = await submitOrder({ intent, actorUserId: "dev-test-account" }, deps);

  assert.equal(outcome.kind, "submitted");
  assert.equal(outcome.order?.status, "PARTIALLY_FILLED");
  assert.equal(outcome.order?.filledQuantity, "0.25");
  assert.deepEqual(
    orders.transitions.map((transition) => `${transition.from}->${transition.to}`),
    ["CREATED->SUBMITTED", "SUBMITTED->PARTIALLY_FILLED"],
  );
  // The order was accepted, so the key is completed and a retry replays it.
  const row = [...orders.orders.values()][0];
  assert.equal(row.idempotencyKey, deriveIdempotencyKey(intent));
});

test("the order records which path submitted it, and defaults to the owner's own", async () => {
  const assistant = harness();
  const placed = await submitOrder(
    { intent, actorUserId: "dev-test-account", origin: "assistant" },
    assistant.deps,
  );
  assert.equal(placed.kind, "submitted");
  assert.equal(
    placed.order?.origin,
    "assistant",
    "the assistant's paper block selects on this column, so the path that placed the order must be on the row",
  );

  // A caller that has not been taught the parameter produces an explainable origin
  // rather than an unlabelled row.
  const manual = harness();
  const own = await submitOrder({ intent, actorUserId: "dev-test-account" }, manual.deps);
  assert.equal(own.order?.origin, "manual");
});
