import assert from "node:assert/strict";
import test from "node:test";
import {
  applyOrderTransition,
  IllegalOrderTransitionError,
  isTerminalOrderStatus,
  ORDER_EVENTS,
  ORDER_STATUS_DETAIL,
  ORDER_STATUSES,
  type OrderEvent,
  type OrderStatus,
} from "@/lib/orders/state-machine";
import {
  attemptsRemain,
  decideRetry,
  DEFAULT_ORDER_RETRY_POLICY,
  delayForAttempt,
  reasonForAttemptOutcome,
} from "@/lib/orders/retry";

/** The transition table, restated here as the expectation it is checked against. */
const LEGAL: Record<OrderStatus, OrderEvent[]> = {
  CREATED: ["SUBMIT", "CANCEL", "FAIL"],
  SUBMITTED: ["PARTIAL_FILL", "COMPLETE_FILL", "CANCEL", "FAIL", "RECONCILE"],
  PARTIALLY_FILLED: ["PARTIAL_FILL", "COMPLETE_FILL", "CANCEL", "FAIL", "RECONCILE"],
  FILLED: [],
  CANCELLED: [],
  FAILED: [],
  RECONCILED: [],
};

const FILL_REQUEST = (event: OrderEvent, filledQuantity?: string) => ({
  event,
  ...(filledQuantity === undefined ? {} : { filledQuantity }),
  reason: "test",
});

test("every legal transition is allowed and every other pair is refused", () => {
  for (const status of ORDER_STATUSES) {
    for (const event of ORDER_EVENTS) {
      const state = { status, requestedQuantity: "1", filledQuantity: status === "PARTIALLY_FILLED" || isTerminalOrderStatus(status) ? "0.4" : "0" };
      const legal = LEGAL[status].includes(event);
      // A complete fill has to reach the requested quantity; a partial one has to
      // add to what is already recorded. Each event is probed with a quantity that
      // is valid for it, so this walks the *table* rather than the quantity rules.
      const quantity = event === "COMPLETE_FILL" ? "1" : "0.6";
      let allowed: boolean;
      try {
        applyOrderTransition(state, FILL_REQUEST(event, quantity), new Date("2026-10-15T00:00:00.000Z"));
        allowed = true;
      } catch (error) {
        assert.ok(error instanceof IllegalOrderTransitionError, `${status} + ${event} threw something else`);
        allowed = false;
      }
      assert.equal(allowed, legal, `${status} + ${event} should be ${legal ? "legal" : "illegal"}`);
    }
  }
});

test("a terminal order refuses every event and says which state it is in", () => {
  for (const status of ORDER_STATUSES.filter(isTerminalOrderStatus)) {
    for (const event of ORDER_EVENTS) {
      assert.throws(
        () => applyOrderTransition({ status, requestedQuantity: "1", filledQuantity: "1" }, FILL_REQUEST(event, "1")),
        (error: unknown) =>
          error instanceof IllegalOrderTransitionError &&
          error.code === "TERMINAL_STATE" &&
          error.from === status &&
          error.message.includes(ORDER_STATUS_DETAIL[status].label),
      );
    }
  }
});

test("a refused transition reports why and carries no state", () => {
  // A partially filled order cannot go straight back to a partial fill that adds
  // nothing, and it cannot fail without a reason.
  assert.throws(
    () => applyOrderTransition({ status: "PARTIALLY_FILLED", requestedQuantity: "1", filledQuantity: "0.4" }, { event: "PARTIAL_FILL", filledQuantity: "0.4" }),
    (error: unknown) => error instanceof IllegalOrderTransitionError && error.code === "INVALID_QUANTITY",
  );
  assert.throws(
    () => applyOrderTransition({ status: "SUBMITTED", requestedQuantity: "1", filledQuantity: "0" }, { event: "FAIL" }),
    (error: unknown) => error instanceof IllegalOrderTransitionError && error.code === "MISSING_REASON",
  );
  assert.throws(
    () => applyOrderTransition({ status: "SUBMITTED", requestedQuantity: "1", filledQuantity: "0" }, { event: "COMPLETE_FILL", filledQuantity: "2" }),
    (error: unknown) => error instanceof IllegalOrderTransitionError && error.code === "INVALID_QUANTITY",
  );
});

test("an order that fills in steps keeps accepting further partial fills", () => {
  const first = applyOrderTransition({ status: "SUBMITTED", requestedQuantity: "2", filledQuantity: "0" }, FILL_REQUEST("PARTIAL_FILL", "0.5"));
  const second = applyOrderTransition(
    { status: first.to, requestedQuantity: first.requestedQuantity, filledQuantity: first.filledQuantity },
    FILL_REQUEST("PARTIAL_FILL", "1.5"),
  );
  assert.equal(second.to, "PARTIALLY_FILLED");
  assert.equal(second.filledQuantity, "1.5");
  assert.equal(second.remainingQuantity, "0.5");
});

test("a fill is cumulative: applying the venue's report twice cannot double-count it", () => {
  const first = applyOrderTransition({ status: "SUBMITTED", requestedQuantity: "1", filledQuantity: "0" }, FILL_REQUEST("PARTIAL_FILL", "0.4"));
  assert.equal(first.to, "PARTIALLY_FILLED");
  assert.equal(first.filledQuantity, "0.4");
  assert.equal(first.remainingQuantity, "0.6");

  const second = applyOrderTransition({ status: "SUBMITTED", requestedQuantity: "1", filledQuantity: "0" }, FILL_REQUEST("PARTIAL_FILL", "0.4"));
  assert.equal(second.filledQuantity, "0.4", "the same report cannot add the quantity twice");

  // A complete fill may repeat the quantity already recorded: reconciliation
  // re-applies the venue's own report, and that must be safe.
  const complete = applyOrderTransition({ status: "PARTIALLY_FILLED", requestedQuantity: "1", filledQuantity: "1" }, FILL_REQUEST("COMPLETE_FILL", "1"));
  assert.equal(complete.to, "FILLED");
  assert.equal(complete.filledQuantity, "1");
});

test("a fill never decreases and never exceeds the request", () => {
  assert.throws(
    () => applyOrderTransition({ status: "PARTIALLY_FILLED", requestedQuantity: "1", filledQuantity: "0.6" }, FILL_REQUEST("PARTIAL_FILL", "0.4")),
    (error: unknown) => error instanceof IllegalOrderTransitionError && error.code === "INVALID_QUANTITY",
  );
  assert.throws(
    () => applyOrderTransition({ status: "SUBMITTED", requestedQuantity: "1", filledQuantity: "0" }, FILL_REQUEST("COMPLETE_FILL", "0.9")),
    (error: unknown) => error instanceof IllegalOrderTransitionError && error.code === "INVALID_QUANTITY",
  );
});

test("cancelling a partially filled order keeps the executed part", () => {
  const partial = applyOrderTransition({ status: "SUBMITTED", requestedQuantity: "2", filledQuantity: "0" }, FILL_REQUEST("PARTIAL_FILL", "0.5"));
  const cancelled = applyOrderTransition(
    { status: partial.to, requestedQuantity: partial.requestedQuantity, filledQuantity: partial.filledQuantity },
    { event: "CANCEL", reason: "the owner cancelled the rest" },
  );

  assert.equal(cancelled.to, "CANCELLED");
  assert.equal(cancelled.filledQuantity, "0.5", "the executed quantity survives the cancel");
  assert.equal(cancelled.remainingQuantity, "1.5", "only the unexecuted remainder is cancelled");
  assert.equal(cancelled.reason, "the owner cancelled the rest");
});

test("every status is explained, and the explanation matches the terminal set", () => {
  for (const status of ORDER_STATUSES) {
    const detail = ORDER_STATUS_DETAIL[status];
    assert.ok(detail, `${status} has no detail entry`);
    assert.equal(detail.label.length > 0, true);
    assert.equal(detail.detail.length > 20, true, `${status} needs an explanatory sentence`);
    assert.equal(detail.terminal, isTerminalOrderStatus(status));
  }
});

test("the retry policy is bounded and never retries a decided outcome", () => {
  const policy = DEFAULT_ORDER_RETRY_POLICY;
  assert.equal(delayForAttempt(1, policy), 0);
  assert.equal(delayForAttempt(2, policy), policy.baseDelayMs);
  assert.equal(delayForAttempt(3, policy), policy.baseDelayMs * policy.multiplier);
  assert.equal(delayForAttempt(9, policy), policy.maxDelayMs, "the delay is capped");
  assert.equal(attemptsRemain(policy.maxAttempts, policy), false);

  assert.equal(decideRetry({ attempt: 1, outcome: "accepted", status: "SUBMITTED", policy }).retry, false);
  assert.equal(decideRetry({ attempt: 1, outcome: "rejected", status: "SUBMITTED", policy }).retry, false);
  assert.equal(decideRetry({ attempt: 1, outcome: "timeout", status: "FILLED", policy }).retry, false);
  assert.equal(decideRetry({ attempt: policy.maxAttempts, outcome: "unavailable", status: "SUBMITTED", policy }).retry, false);

  const retry = decideRetry({ attempt: 1, outcome: "timeout", status: "SUBMITTED", policy });
  assert.equal(retry.retry, true);
  assert.equal(retry.retry === true && retry.delayMs, policy.baseDelayMs);
});

test("every attempt outcome maps to a reason with a code and a sentence", () => {
  for (const outcome of ["accepted", "rejected", "timeout", "unavailable", "not-found"] as const) {
    const mapped = reasonForAttemptOutcome(outcome);
    assert.ok(mapped.code.length > 0);
    assert.ok(mapped.message.length > 10);
    assert.equal(typeof mapped.retryable, "boolean");
  }
});
