import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalOrderIntent,
  deriveClientOrderId,
  deriveIdempotencyKey,
  deriveOperationKey,
  fingerprintIntent,
  IDEMPOTENCY_SCOPES,
  interpretReservation,
  isUsableClientKey,
  type OrderIntent,
} from "@/lib/orders/idempotency";
import { createMemoryIdempotencyStore } from "@/lib/orders/test-support";

const intent: OrderIntent = {
  userId: "dev-test-account",
  venue: "dev-paper",
  market: "BTC-USD",
  side: "BUY",
  orderType: "MARKET",
  quantity: "0.01",
  limitPrice: null,
  stopLossPrice: "0",
  notionalUsdCents: 10_000,
  verifiedBalanceCents: 250_000,
};

test("the key is derived from the caller's intent, not from the moment they called", () => {
  const first = deriveIdempotencyKey(intent);
  const second = deriveIdempotencyKey({ ...intent });
  assert.equal(first, second, "two identical intents produce the same key");

  // Decimal spelling is normalised, so 0.10 and 0.1 are the same intent — which
  // is what makes a retry that formats its number differently still a replay.
  assert.equal(deriveIdempotencyKey({ ...intent, quantity: "0.10" }), deriveIdempotencyKey({ ...intent, quantity: "0.1" }));

  assert.notEqual(deriveIdempotencyKey({ ...intent, market: "ETH-USD" }), first);
  assert.notEqual(deriveIdempotencyKey({ ...intent, quantity: "0.02" }), first);
  assert.notEqual(deriveIdempotencyKey({ ...intent, side: "SELL" }), first);
  assert.notEqual(deriveIdempotencyKey({ ...intent, userId: "someone-else" }), first);

  // A caller-supplied key is how a person asks for a deliberate second order.
  assert.notEqual(deriveIdempotencyKey({ ...intent, clientKey: "order-attempt-2" }), first);
  assert.equal(fingerprintIntent(intent), fingerprintIntent({ ...intent, quantity: "0.010" }));
  assert.match(canonicalOrderIntent(intent), /^intent=order\.v1/);
});

test("the venue sees a client order id derived from the key, so a retry is the same order", () => {
  const key = deriveIdempotencyKey(intent);
  assert.equal(deriveClientOrderId(key), deriveClientOrderId(key));
  assert.match(deriveClientOrderId(key), /^ord_[0-9a-f]{40}$/);
  assert.notEqual(deriveClientOrderId(key), deriveClientOrderId(deriveIdempotencyKey({ ...intent, quantity: "0.02" })));
});

test("a cancel key is derived from the order and the reason it was given", () => {
  const key = deriveOperationKey({ scope: IDEMPOTENCY_SCOPES.cancelOrder, parts: ["order-1", "owner cancelled"] });
  assert.equal(key, deriveOperationKey({ scope: IDEMPOTENCY_SCOPES.cancelOrder, parts: ["order-1", "owner cancelled"] }));
  assert.notEqual(key, deriveOperationKey({ scope: IDEMPOTENCY_SCOPES.cancelOrder, parts: ["order-2", "owner cancelled"] }));
  assert.notEqual(key, deriveOperationKey({ scope: IDEMPOTENCY_SCOPES.cancelOrder, parts: ["order-1", "risk halt"] }));
  assert.notEqual(
    deriveOperationKey({ scope: IDEMPOTENCY_SCOPES.cancelOrder, parts: ["order-1", "owner cancelled"], clientKey: "again" }),
    key,
  );
});

test("client keys are refused unless they are usable", () => {
  assert.equal(isUsableClientKey("order-attempt-2"), true);
  assert.equal(isUsableClientKey("abcdefgh"), true);
  assert.equal(isUsableClientKey("short"), false);
  assert.equal(isUsableClientKey("has spaces in it"), false);
  assert.equal(isUsableClientKey("x".repeat(201)), false);
  assert.equal(isUsableClientKey(42), false);
});

test("a reservation answers replay, conflict, in-flight or free", () => {
  const row = { id: "r1", fingerprint: "same", status: "COMPLETED", resultJson: '{"orderId":"order-1"}', createdAt: new Date(0), completedAt: new Date(1) };
  const replay = interpretReservation(row, "same");
  assert.equal(replay.kind, "replay");
  assert.deepEqual(replay.kind === "replay" && replay.result, { orderId: "order-1" });

  const conflict = interpretReservation(row, "different");
  assert.equal(conflict.kind, "conflict");
  assert.equal(conflict.kind === "conflict" && conflict.reason.code, "IDEMPOTENCY_KEY_REUSED");
  assert.match(conflict.kind === "conflict" ? conflict.reason.message : "", /different operation/);

  assert.equal(interpretReservation({ ...row, status: "IN_PROGRESS", completedAt: null }, "same").kind, "in-flight");
  // A released key is free again: the operation failed and may be retried.
  assert.equal(interpretReservation({ ...row, status: "FAILED" }, "same").kind, "reserved");
});

test("the reservation store only lets one caller win each key", async () => {
  const memory = createMemoryIdempotencyStore();
  const first = await memory.store.reserve({
    scope: IDEMPOTENCY_SCOPES.submitOrder,
    key: "key-1",
    fingerprint: "fingerprint-a",
    actorUserId: "user-1",
    now: 0,
  });
  assert.equal(first.kind, "reserved");

  const second = await memory.store.reserve({
    scope: IDEMPOTENCY_SCOPES.submitOrder,
    key: "key-1",
    fingerprint: "fingerprint-a",
    actorUserId: "user-1",
    now: 1,
  });
  assert.equal(second.kind, "in-flight", "the second caller joins the first rather than starting a second order");

  const conflicting = await memory.store.reserve({
    scope: IDEMPOTENCY_SCOPES.submitOrder,
    key: "key-1",
    fingerprint: "fingerprint-b",
    actorUserId: "user-1",
    now: 2,
  });
  assert.equal(conflicting.kind, "conflict");

  await memory.store.complete({ scope: IDEMPOTENCY_SCOPES.submitOrder, key: "key-1", result: { orderId: "order-1" }, orderId: "order-1", now: 3 });
  const replay = await memory.store.reserve({
    scope: IDEMPOTENCY_SCOPES.submitOrder,
    key: "key-1",
    fingerprint: "fingerprint-a",
    actorUserId: "user-1",
    now: 4,
  });
  assert.equal(replay.kind, "replay");
  assert.deepEqual(replay.kind === "replay" ? replay.result : null, { orderId: "order-1" });
});
