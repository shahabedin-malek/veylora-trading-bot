import assert from "node:assert/strict";
import test from "node:test";
import {
  lifecycleResource,
  orderIntentFrom,
  orderResource,
  parseLimit,
  parseStatusFilter,
  validateCancellation,
  validateOrderSubmission,
} from "@/lib/orders/api";
import { ORDER_STATUSES } from "@/lib/orders/state-machine";
import { makeOrder } from "@/lib/orders/test-support";

const valid = {
  market: "BTC-USD",
  side: "BUY",
  orderType: "MARKET",
  quantity: "0.01",
  notionalUsdCents: 10_000,
  verifiedBalanceCents: 250_000,
};

test("a well-formed submission is accepted and normalised", () => {
  const result = validateOrderSubmission(valid);
  assert.equal(result.valid, true);
  assert.equal(result.valid && result.value.quantity, "0.01");
  assert.equal(result.valid && result.value.limitPrice, null);
  assert.equal(result.valid && result.value.stopLossPrice, "0");
  assert.equal(result.valid && result.value.clientKey, null);

  const limit = validateOrderSubmission({ ...valid, orderType: "LIMIT", limitPrice: "2400" });
  assert.equal(limit.valid && limit.value.limitPrice, "2400");
});

test("every refusal names the field and what would be acceptable", () => {
  const cases: [unknown, RegExp][] = [
    [null, /JSON object/],
    [{ ...valid, market: "DOGE-EUR" }, /supported Coinbase USD market/],
    [{ ...valid, side: "HOLD" }, /Side must be BUY or SELL/],
    [{ ...valid, orderType: "STOP" }, /Order type must be MARKET or LIMIT/],
    [{ ...valid, quantity: "0" }, /Quantity must be greater than zero/],
    [{ ...valid, quantity: "abc" }, /plain decimal/],
    [{ ...valid, orderType: "LIMIT" }, /A LIMIT order needs one/],
    [{ ...valid, limitPrice: "100" }, /MARKET order does not carry a limit price/],
    [{ ...valid, notionalUsdCents: 0 }, /Notional must be greater than zero/],
    [{ ...valid, notionalUsdCents: 12.5 }, /whole number of US cents/],
    [{ ...valid, verifiedBalanceCents: -1 }, /whole number of US cents/],
    [{ ...valid, idempotencyKey: "short" }, /idempotencyKey must be 8–200 characters/],
  ];
  for (const [input, pattern] of cases) {
    const result = validateOrderSubmission(input);
    assert.equal(result.valid, false, `${JSON.stringify(input)} should be refused`);
    assert.match(result.valid === false ? result.error : "", pattern);
  }
});

test("the Idempotency-Key header is accepted and wins over the body", () => {
  const fromHeader = validateOrderSubmission({ ...valid, idempotencyKey: "from-the-body" }, "from-the-header");
  assert.equal(fromHeader.valid && fromHeader.value.clientKey, "from-the-header");
  assert.equal(validateOrderSubmission(valid, "no spaces allowed").valid, false);
  assert.equal(validateOrderSubmission(valid, "abcdefgh").valid, true);
});

test("a cancellation needs no body and always carries a reason", () => {
  const bare = validateCancellation(undefined);
  assert.equal(bare.valid && bare.reason, "The owner cancelled this order.");
  const given = validateCancellation({ reason: "risk halt", idempotencyKey: "cancel-attempt-1" });
  assert.equal(given.valid && given.reason, "risk halt");
  assert.equal(given.valid && given.clientKey, "cancel-attempt-1");
  assert.equal(validateCancellation({ reason: "x".repeat(400) }).valid, false);
  assert.equal(validateCancellation("not-an-object").valid, false);
});

test("the status filter refuses a status by name instead of silently ignoring it", () => {
  const empty = parseStatusFilter(null);
  assert.deepEqual(empty.valid && empty.statuses, []);
  const two = parseStatusFilter("submitted,filled");
  assert.deepEqual(two.valid && two.statuses, ["SUBMITTED", "FILLED"]);
  const unknown = parseStatusFilter("SUBMITTED,NOPE");
  assert.equal(unknown.valid, false);
  assert.match(unknown.valid === false ? unknown.error : "", /Unknown order status: NOPE/);
  assert.deepEqual(parseLimit("5", 25, 100), 5);
  assert.deepEqual(parseLimit("0", 25, 100), 25);
  assert.deepEqual(parseLimit("1000", 25, 100), 100);
});

test("the resource a route sends explains its own status and carries the audit facts", () => {
  const order = makeOrder({
    id: "order-1",
    status: "PARTIALLY_FILLED",
    requestedQuantity: "1",
    filledQuantity: "0.4",
    attempts: 2,
    lastAttemptReason: "Attempt 2: test-venue accepted the order.",
    venueOrderId: "test-order-1",
    idempotencyKey: "key-1",
  });
  const resource = orderResource(order);

  assert.equal(resource.status, "PARTIALLY_FILLED");
  assert.equal(resource.statusLabel, "PARTIALLY FILLED");
  assert.equal(resource.terminal, false);
  assert.ok(resource.statusDetail.length > 20, "the status travels with the sentence that explains it");
  assert.equal(resource.filledQuantity, "0.4");
  assert.equal(resource.remainingQuantity, "0.6");
  assert.equal(resource.attempts, 2);
  assert.equal(resource.lastAttemptReason, "Attempt 2: test-venue accepted the order.");
  assert.equal(resource.venueOrderId, "test-order-1");
});

test("the lifecycle the API publishes covers every status, so no status is a surprise", () => {
  const lifecycle = lifecycleResource();
  assert.deepEqual(lifecycle.map((entry) => entry.status).sort(), [...ORDER_STATUSES].sort());
  for (const entry of lifecycle) {
    assert.ok(entry.label.length > 0);
    assert.ok(entry.detail.length > 20);
    assert.equal(typeof entry.terminal, "boolean");
  }
});

test("an intent is built for the signed-in account and the chosen venue, never from the body", () => {
  const result = validateOrderSubmission({ ...valid, userId: "someone-else", venue: "coinbase" });
  assert.equal(result.valid, true);
  const intent = orderIntentFrom(result.valid ? result.value : ({} as never), { userId: "dev-test-account", venue: "dev-paper" });
  assert.equal(intent.userId, "dev-test-account");
  assert.equal(intent.venue, "dev-paper");
  assert.equal(intent.market, "BTC-USD");
});
