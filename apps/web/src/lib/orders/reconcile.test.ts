import assert from "node:assert/strict";
import test from "node:test";
import { planVenueCorrection, reconcileOrders, RECONCILIATION_GRACE_MS, VENUE_STATE_MAPPING } from "@/lib/orders/reconcile";
import { ORDER_STATUSES } from "@/lib/orders/state-machine";
import { createMemoryOrderStore, createScriptedVenue, makeOrder } from "@/lib/orders/test-support";
import { createTestClock } from "@/lib/orders/test-support";

/**
 * Reconciliation, tested from the pure mapping outwards.
 *
 * The mapping is where the venue's vocabulary becomes the lifecycle's events, so
 * the cases below are the ones that actually happen: a venue that filled more than
 * the local row knew, a venue that reports less than the local row holds (an
 * execution is never un-recorded), a venue that has never heard of the order, and
 * a venue that cannot answer at all.
 */

const NOW = new Date("2026-10-15T12:00:00.000Z");

function report(state: Parameters<typeof planVenueCorrection>[1]["state"], filledQuantity?: string) {
  return {
    state,
    ...(filledQuantity === undefined ? {} : { filledQuantity }),
    reportedAt: NOW.toISOString(),
    reason: `The venue reported ${state}.`,
  };
}

test("every venue state is mapped, and the mapping says whether it is live", () => {
  for (const state of ["OPEN", "PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED", "NOT_FOUND", "UNKNOWN"] as const) {
    const mapping = VENUE_STATE_MAPPING[state];
    assert.ok(mapping, `${state} has no mapping`);
    assert.equal(typeof mapping.live, "boolean");
    assert.ok(mapping.detail.length > 10);
  }
});

test("a venue fill the local row was missing corrects the local state and records both values", () => {
  const order = makeOrder({ id: "order-1", status: "SUBMITTED", requestedQuantity: "1", filledQuantity: "0" });
  const plan = planVenueCorrection(order, report("FILLED", "1"), { now: NOW });

  assert.equal(plan.transitions.length, 1);
  assert.equal(plan.transitions[0].event, "COMPLETE_FILL");
  assert.equal(plan.transitions[0].to, "FILLED");
  assert.equal(plan.transitions[0].filledQuantity, "1");
  assert.equal(plan.terminal, true);
  assert.equal(plan.changed, true);

  const divergence = plan.divergences.find((entry) => entry.field === "filledQuantity");
  assert.deepEqual({ local: divergence?.local, venue: divergence?.venue }, { local: "0", venue: "1" });
  assert.equal(plan.reason.message.includes("disagrees"), true, "the finding says the two sides disagreed");
});

test("a venue partial fill is recorded as a partial execution, not as a completed order", () => {
  const order = makeOrder({ id: "order-2", status: "SUBMITTED", requestedQuantity: "2", filledQuantity: "0" });
  const plan = planVenueCorrection(order, report("PARTIALLY_FILLED", "0.5"), { now: NOW });

  assert.equal(plan.transitions.length, 1);
  assert.equal(plan.transitions[0].event, "PARTIAL_FILL");
  assert.equal(plan.transitions[0].to, "PARTIALLY_FILLED");
  assert.equal(plan.transitions[0].remainingQuantity, "1.5");
  assert.equal(plan.terminal, false);
});

test("a venue reporting less than the local row holds records the disagreement and keeps the execution", () => {
  const order = makeOrder({ id: "order-3", status: "PARTIALLY_FILLED", requestedQuantity: "1", filledQuantity: "0.6" });
  const plan = planVenueCorrection(order, report("PARTIALLY_FILLED", "0.4"), { now: NOW });

  assert.deepEqual(plan.transitions, [], "an execution that happened is not undone by a report");
  assert.equal(plan.changed, false);
  const divergence = plan.divergences.find((entry) => entry.field === "filledQuantity");
  assert.deepEqual({ local: divergence?.local, venue: divergence?.venue }, { local: "0.6", venue: "0.4" });
  assert.match(plan.reason.message, /an execution that happened is not undone/);
});

test("a local row that never recorded the send is corrected when the venue holds the order", () => {
  const order = makeOrder({ id: "order-4", status: "CREATED", requestedQuantity: "1" });
  const plan = planVenueCorrection(order, report("OPEN", "0"), { now: NOW });

  assert.equal(plan.transitions.length, 1);
  assert.equal(plan.transitions[0].event, "SUBMIT");
  assert.equal(plan.transitions[0].to, "SUBMITTED");
  assert.deepEqual(
    plan.divergences.map((entry) => `${entry.field}:${entry.local}->${entry.venue}`),
    ["status:CREATED->SUBMITTED"],
  );
});

test("a cancelled venue record keeps whatever executed, and cancels only the rest", () => {
  const order = makeOrder({ id: "order-5", status: "SUBMITTED", requestedQuantity: "1", filledQuantity: "0" });
  const plan = planVenueCorrection(order, report("CANCELLED", "0.3"), { now: NOW });

  assert.deepEqual(
    plan.transitions.map((transition) => `${transition.event}:${transition.to}`),
    ["PARTIAL_FILL:PARTIALLY_FILLED", "CANCEL:CANCELLED"],
  );
  assert.equal(plan.transitions[1].filledQuantity, "0.3", "the executed part survives the cancel");
  assert.equal(plan.transitions[1].remainingQuantity, "0.7");
  assert.equal(plan.terminal, true);
});

test("a venue that holds no record only closes the order once the grace window has passed", () => {
  const fresh = makeOrder({
    id: "order-6",
    status: "SUBMITTED",
    requestedQuantity: "1",
    submittedAt: new Date(NOW.getTime() - 1_000).toISOString(),
  });
  const inside = planVenueCorrection(fresh, report("NOT_FOUND"), { now: NOW });
  assert.deepEqual(inside.transitions, [], "a venue that has not seen a just-sent order is not a venue that lost it");
  assert.equal(inside.reason.code, "NOT_YET_DUE");

  const stale = makeOrder({
    id: "order-7",
    status: "SUBMITTED",
    requestedQuantity: "1",
    submittedAt: new Date(NOW.getTime() - RECONCILIATION_GRACE_MS - 60_000).toISOString(),
  });
  const past = planVenueCorrection(stale, report("NOT_FOUND"), { now: NOW });
  assert.equal(past.transitions.length, 1);
  assert.equal(past.transitions[0].event, "RECONCILE");
  assert.equal(past.transitions[0].to, "RECONCILED");
  assert.equal(past.terminal, true);
  assert.equal(past.divergences[0].venue, "RECONCILED");
  assert.match(past.transitions[0].reason, /holds no record/);
});

test("a venue that cannot answer changes nothing and says why", () => {
  const order = makeOrder({ id: "order-8", status: "SUBMITTED", requestedQuantity: "1" });
  const plan = planVenueCorrection(order, report("UNKNOWN"), { now: NOW });

  assert.deepEqual(plan.transitions, []);
  assert.deepEqual(plan.divergences, []);
  assert.equal(plan.reason.code, "VENUE_UNAVAILABLE");
  assert.equal(plan.changed, false);
});

test("a venue that agrees with the local row changes nothing and says so", () => {
  const order = makeOrder({ id: "order-9", status: "PARTIALLY_FILLED", requestedQuantity: "1", filledQuantity: "0.5" });
  const plan = planVenueCorrection(order, report("PARTIALLY_FILLED", "0.5"), { now: NOW });

  assert.deepEqual(plan.transitions, []);
  assert.deepEqual(plan.divergences, []);
  assert.match(plan.reason.message, /already agrees/);
});

test("a closed order is never reopened by reconciliation", () => {
  for (const status of ["FILLED", "CANCELLED", "FAILED", "RECONCILED"] as const) {
    assert.ok(ORDER_STATUSES.includes(status));
    const order = makeOrder({ id: `order-${status}`, status, requestedQuantity: "1", filledQuantity: "1" });
    assert.deepEqual(planVenueCorrection(order, report("OPEN", "0"), { now: NOW }).transitions, []);
  }
});

test("reconciliation corrects a divergent local row and records both values", async () => {
  const orders = createMemoryOrderStore();
  const venue = createScriptedVenue({
    lookups: [{ state: "FILLED", filledQuantity: "1", reportedAt: NOW.toISOString(), reason: "the venue filled it" }],
  });
  const clock = createTestClock();
  const divergent = orders.seed({ id: "order-divergent", status: "SUBMITTED", requestedQuantity: "1", filledQuantity: "0" });

  const summary = await reconcileOrders({ store: orders.store, venue: venue.port, now: clock.now, actorUserId: "dev-test-account" });

  assert.equal(summary.checked, 1);
  assert.equal(summary.corrected, 1);
  assert.equal(summary.divergences, 1);
  assert.deepEqual(summary.changedOrderIds, ["order-divergent"]);

  const corrected = orders.orders.get(divergent.id);
  assert.equal(corrected?.status, "FILLED", "the local state matches the venue");
  assert.equal(corrected?.filledQuantity, "1");

  assert.deepEqual(
    orders.transitions.map((transition) => `${transition.from}->${transition.to}`),
    ["SUBMITTED->FILLED"],
  );
  const recorded = orders.reconciliations[0];
  assert.equal(recorded.outcome, "CORRECTED");
  const divergence = recorded.divergences.find((entry) => entry.field === "filledQuantity");
  assert.deepEqual({ local: divergence?.local, venue: divergence?.venue }, { local: "0", venue: "1" });

  // Running it again finds the order agreeing with the venue: reconciliation is
  // safe to re-run, which is what lets the host call it whenever it likes.
  const second = await reconcileOrders({ store: orders.store, venue: venue.port, now: clock.now, actorUserId: "dev-test-account" });
  assert.equal(second.checked, 0, "a filled order is terminal, so it is not looked up again");
  assert.equal(second.corrected, 0);
  assert.equal(orders.transitions.length, 1);
});

test("a reconciliation pass that finds a divergence without a legal correction writes only the finding", async () => {
  const orders = createMemoryOrderStore();
  const venue = createScriptedVenue({
    lookups: [{ state: "PARTIALLY_FILLED", filledQuantity: "0.2", reportedAt: NOW.toISOString(), reason: "the venue reports less" }],
  });
  const clock = createTestClock();
  orders.seed({ id: "order-lower", status: "PARTIALLY_FILLED", requestedQuantity: "1", filledQuantity: "0.6" });

  const summary = await reconcileOrders({ store: orders.store, venue: venue.port, now: clock.now });

  assert.equal(summary.checked, 1);
  assert.equal(summary.corrected, 0, "the executed quantity was not lowered");
  assert.equal(summary.divergences, 1);
  assert.deepEqual(orders.transitions, []);
  assert.equal(orders.reconciliations[0].outcome, "DIVERGENCE");
  assert.equal(orders.orders.get("order-lower")?.filledQuantity, "0.6");
});

test("an order whose venue cannot be reached is left alone and counted as unresolved", async () => {
  const orders = createMemoryOrderStore();
  const venue = createScriptedVenue({ lookups: [{ state: "UNKNOWN", reportedAt: NOW.toISOString(), reason: "no answer" }] });
  const clock = createTestClock();
  orders.seed({ id: "order-unknown", status: "SUBMITTED", requestedQuantity: "1" });

  const summary = await reconcileOrders({ store: orders.store, venue: venue.port, now: clock.now });

  assert.equal(summary.unresolved, 1);
  assert.equal(summary.corrected, 0);
  assert.deepEqual(orders.transitions, []);
  assert.deepEqual(orders.reconciliations, [], "nothing happened, so nothing was claimed");
  assert.equal(summary.reason.code, "NO_ENTRY_CONDITION");
});
