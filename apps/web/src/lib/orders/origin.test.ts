import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyOrderOriginFromNote, ORDER_NOTE_PREFIX } from "@/lib/orders/origin";
import {
  auditReasonOf,
  planOrderOriginBackfill,
  type OriginBackfillAuditEvent,
  type OriginBackfillOrder,
} from "@/lib/orders/origin-backfill";

/**
 * The classifier and the plan, asserted on notes the call sites actually write.
 *
 * The notes are composed from the same exported markers the five submission paths
 * use, which is the point: a reworded note fails here rather than silently leaving
 * historical assistant orders out of the account's assistant paper block.
 */

function created(orderId: string, reason: string | null, at = "2026-10-20T09:00:00.000Z"): OriginBackfillAuditEvent {
  return {
    objectId: orderId,
    action: "ORDER_CREATED",
    redactedJson: reason === null ? "{}" : JSON.stringify({ orderId, reason }),
    occurredAt: new Date(at),
  };
}

function order(id: string, origin = "manual", clientOrderId: string | null = null): OriginBackfillOrder {
  return { id, origin, clientOrderId };
}

const ASSISTANT_NOTE = `${ORDER_NOTE_PREFIX.assistant}, which is restricted to the paper venue.`;
const TRADE_PAGE_NOTE = `${ORDER_NOTE_PREFIX.tradePage}.`;
const TRADE_PAGE_CREDENTIAL_NOTE = `${ORDER_NOTE_PREFIX.tradePage} with credential cred_1, whose scope was checked first.`;
const SIGNAL_NOTE = `${ORDER_NOTE_PREFIX.signal}sig_1 from momentum-desk: RSI cooled below 30.`;
const RUNNER_NOTE = `Momentum${ORDER_NOTE_PREFIX.strategy}2026-10-20T00:00:00.000Z: the RSI crossed up through 30.`;
const API_NOTE = `${ORDER_NOTE_PREFIX.api}vk_live_abc in agent account Desk.`;

test("each submission path's note classifies as the origin that path records", () => {
  assert.equal(classifyOrderOriginFromNote(ASSISTANT_NOTE), "assistant");
  assert.equal(classifyOrderOriginFromNote(TRADE_PAGE_NOTE), "manual");
  assert.equal(classifyOrderOriginFromNote(TRADE_PAGE_CREDENTIAL_NOTE), "manual");
  assert.equal(classifyOrderOriginFromNote(SIGNAL_NOTE), "strategy");
  assert.equal(classifyOrderOriginFromNote(RUNNER_NOTE), "strategy");
  assert.equal(classifyOrderOriginFromNote(API_NOTE), "api");

  // Notes this build cannot place are refused rather than assigned to the nearest
  // path: the fallback is written when a caller supplies no note at all.
  assert.equal(classifyOrderOriginFromNote("The order intent was recorded locally."), null);
  assert.equal(classifyOrderOriginFromNote("The order intent was recorded locally (seed)."), null);
  assert.equal(classifyOrderOriginFromNote(""), null);
});

test("a plan updates only the rows whose note names a path, and says why the rest are left alone", () => {
  const plan = planOrderOriginBackfill({
    orders: [
      order("a-assistant"),
      order("b-trade-page"),
      order("c-no-audit"),
      order("d-api"),
      order("e-unknown"),
      order("f-already", "assistant"),
    ],
    events: [
      created("a-assistant", ASSISTANT_NOTE),
      created("b-trade-page", TRADE_PAGE_NOTE),
      created("d-api", API_NOTE),
      created("e-unknown", "The order intent was recorded locally."),
      created("f-already", ASSISTANT_NOTE),
    ],
  });

  assert.equal(plan.candidates, 6);
  assert.deepEqual(
    plan.updates.map((update) => [update.orderId, update.from, update.to]),
    [
      ["a-assistant", "manual", "assistant"],
      ["d-api", "manual", "api"],
    ],
  );
  // The evidence travels with the decision.
  assert.equal(plan.updates[0]?.evidence, ASSISTANT_NOTE);
  assert.equal(plan.updates[1]?.evidence, API_NOTE);

  const skipped = new Map(plan.skipped.map((entry) => [entry.orderId, entry.reason]));
  assert.equal(skipped.get("b-trade-page"), "manual-note");
  assert.equal(skipped.get("c-no-audit"), "no-event");
  assert.equal(skipped.get("e-unknown"), "unrecognised-note");
  assert.equal(skipped.get("f-already"), "already-set");
  // The note that could not be placed is carried out for an operator to inspect.
  assert.deepEqual(plan.unknownNotes, [{ note: "The order intent was recorded locally.", count: 1 }]);
});

test("an unreadable payload is reported as having no note, not guessed at", () => {
  const plan = planOrderOriginBackfill({
    orders: [order("a"), order("b")],
    events: [
      { objectId: "a", action: "ORDER_CREATED", redactedJson: "not json", occurredAt: new Date() },
      created("b", null),
    ],
  });

  assert.equal(plan.updates.length, 0);
  assert.deepEqual(
    plan.skipped.map((entry) => [entry.orderId, entry.reason]),
    [
      ["a", "no-note"],
      ["b", "no-note"],
    ],
  );
});

test("two creation events naming different paths leave the row alone", () => {
  const plan = planOrderOriginBackfill({
    orders: [order("a")],
    events: [created("a", ASSISTANT_NOTE), created("a", API_NOTE, "2026-10-20T09:05:00.000Z")],
  });

  assert.equal(plan.updates.length, 0);
  assert.equal(plan.skipped[0]?.reason, "conflicting-evidence");
  // The detail names both paths in a stable order, so a reviewer can see what disagreed.
  assert.match(plan.skipped[0]?.detail ?? "", /name api and assistant/);
});

test("an event recorded against the client order id is found as well as one against the row id", () => {
  // The local seed writes its audit rows with the client order id as the object id
  // while the order row carries a cuid; the evidence is still that order's.
  const seeded = order("cmvh2vynz0001", "manual", "dev-order-0001");
  const plan = planOrderOriginBackfill({
    orders: [seeded],
    events: [created("dev-order-0001", ASSISTANT_NOTE)],
  });

  assert.deepEqual(
    plan.updates.map((update) => [update.orderId, update.to]),
    [["cmvh2vynz0001", "assistant"]],
  );
  // The change still targets the row's own id, never the client id.
  assert.equal(plan.updates[0]?.orderId, seeded.id);
});

test("events for another action are not evidence of where the order came from", () => {
  const plan = planOrderOriginBackfill({
    orders: [order("a")],
    events: [{ ...created("a", ASSISTANT_NOTE), action: "ORDER_SUBMITTED" }],
  });

  assert.equal(plan.updates.length, 0);
  assert.equal(plan.skipped[0]?.reason, "no-event");
});

test("the reason reader ignores payloads that are not an object with a sentence", () => {
  assert.equal(auditReasonOf(JSON.stringify({ reason: "a sentence" })), "a sentence");
  assert.equal(auditReasonOf(JSON.stringify({ reason: "   " })), null);
  assert.equal(auditReasonOf(JSON.stringify({ reason: 7 })), null);
  assert.equal(auditReasonOf(JSON.stringify(["reason"])), null);
  assert.equal(auditReasonOf(JSON.stringify(null)), null);
  assert.equal(auditReasonOf(""), null);
});
