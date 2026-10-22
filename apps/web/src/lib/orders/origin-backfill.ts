import {
  classifyOrderOriginFromNote,
  DEFAULT_ORDER_ORIGIN,
  parseOrderOrigin,
  type OrderOrigin,
} from "@/lib/orders/origin";

/**
 * Recovering an order's origin from the audit trail.
 *
 * The origin column was added after orders had already been placed, so every row
 * that predates it reads `manual` — the column's default. That default is honest
 * for the owner's own ticket and wrong for an assistant order, and the account
 * page's assistant paper-performance block selects on the column, so those older
 * orders would simply not appear.
 *
 * The evidence is already there. Creating an order writes one `ORDER_CREATED` audit
 * event whose payload carries the caller's `sourceNote` as `reason`, and each of the
 * five submission paths writes a note that begins with a marker exported by
 * `origin.ts`. This module turns those events into a plan and nothing else: it reads,
 * it decides, and it says why a row was left alone. The script beside it is the only
 * part that writes.
 *
 * Three properties matter more than the number of rows recovered:
 *
 *  - **A row is only changed when its note names a path.** A fallback note ("the
 *    intent was recorded locally"), a seed row, a sentence from an older build or a
 *    missing event leaves the row as it is and is reported. Guessing here would put
 *    somebody else's fills into the assistant's record.
 *  - **Contradictory evidence is refused, not resolved.** Two creation events that
 *    name different paths leave the row alone; one of them is wrong and this module
 *    cannot tell which.
 *  - **The decision carries its evidence.** Every update names the note it rests on,
 *    so a reviewer can check the classification rather than trust it.
 */

/** The audit action an order's creation writes; the source note is its `reason`. */
export const ORDER_CREATED_AUDIT_ACTION = "ORDER_CREATED";

/**
 * The parts of a `TradeOrder` row the plan reads.
 *
 * `clientOrderId` is searched beside the row id because one writer (the local seed)
 * recorded its audit events against the client order id rather than the primary key.
 * Looking in both places costs one `OR` and turns a seed row from "no evidence" into
 * "evidence this build cannot place", which is the more accurate report.
 */
export type OriginBackfillOrder = { id: string; origin: string; clientOrderId?: string | null };

/** The parts of an `AuditEvent` row the plan reads. */
export type OriginBackfillAuditEvent = {
  objectId: string | null;
  action: string;
  redactedJson: string;
  occurredAt: Date;
};

export type OriginBackfillSkipReason =
  | "already-set"
  | "no-event"
  | "no-note"
  | "unrecognised-note"
  | "conflicting-evidence"
  | "manual-note";

export type OriginBackfillUpdate = {
  orderId: string;
  from: OrderOrigin;
  /** Never `manual`: that is what the row already says. */
  to: Exclude<OrderOrigin, "manual">;
  /** The audit reason the decision rests on. */
  evidence: string;
};

export type OriginBackfillPlan = {
  candidates: number;
  updates: OriginBackfillUpdate[];
  skipped: { orderId: string; reason: OriginBackfillSkipReason; detail: string | null }[];
  /** The notes that could not be placed, so an operator can extend the classifier. */
  unknownNotes: { note: string; count: number }[];
};

/**
 * The source note on an `ORDER_CREATED` event, or `null` when the payload is not
 * readable JSON or carries no reason.
 *
 * The payload was written by the audit writer, which redacts values but does not
 * rewrite sentences, so the note arrives intact apart from a length cap the order
 * path never applies to this field.
 */
export function auditReasonOf(redactedJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(redactedJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const reason = (parsed as Record<string, unknown>).reason;
    return typeof reason === "string" && reason.trim().length > 0 ? reason : null;
  } catch {
    return null;
  }
}

function byObjectId(events: readonly OriginBackfillAuditEvent[]): Map<string, OriginBackfillAuditEvent[]> {
  const grouped = new Map<string, OriginBackfillAuditEvent[]>();
  for (const event of events) {
    if (event.action !== ORDER_CREATED_AUDIT_ACTION || !event.objectId) continue;
    const list = grouped.get(event.objectId) ?? [];
    list.push(event);
    grouped.set(event.objectId, list);
  }
  return grouped;
}

/**
 * Decide, for every candidate order, whether its audit trail names a path.
 *
 * Candidates are normally the rows that still read `manual`, but a row whose origin
 * is already set is skipped with `already-set` rather than trusted to be right — the
 * caller may have passed a wider set by mistake, and this function does not overwrite
 * a recorded origin.
 */
export function planOrderOriginBackfill(input: {
  orders: readonly OriginBackfillOrder[];
  events: readonly OriginBackfillAuditEvent[];
}): OriginBackfillPlan {
  const eventsFor = byObjectId(input.events);
  const updates: OriginBackfillUpdate[] = [];
  const skipped: OriginBackfillPlan["skipped"] = [];
  const unknownCounts = new Map<string, number>();

  for (const order of input.orders) {
    const stored = parseOrderOrigin(order.origin);
    if (stored !== DEFAULT_ORDER_ORIGIN) {
      skipped.push({ orderId: order.id, reason: "already-set", detail: stored });
      continue;
    }

    const matched = new Map<string, OriginBackfillAuditEvent>();
    for (const key of [order.id, order.clientOrderId ?? null]) {
      if (!key) continue;
      for (const event of eventsFor.get(key) ?? []) {
        matched.set(`${event.objectId}\n${event.occurredAt.toISOString()}\n${event.redactedJson}`, event);
      }
    }
    const events = [...matched.values()].sort(
      (left, right) => left.occurredAt.getTime() - right.occurredAt.getTime(),
    );
    if (events.length === 0) {
      skipped.push({ orderId: order.id, reason: "no-event", detail: null });
      continue;
    }

    const notes = events
      .map((event) => auditReasonOf(event.redactedJson))
      .filter((note): note is string => note !== null);
    if (notes.length === 0) {
      skipped.push({ orderId: order.id, reason: "no-note", detail: "The creation event carries no reason." });
      continue;
    }

    const targets = new Set<OrderOrigin>();
    const classified = notes
      .map((note) => ({ note, origin: classifyOrderOriginFromNote(note) }))
      .filter((entry): entry is { note: string; origin: OrderOrigin } => entry.origin !== null);
    for (const entry of classified) targets.add(entry.origin);
    if (targets.size > 1) {
      skipped.push({
        orderId: order.id,
        reason: "conflicting-evidence",
        detail: `The creation events name ${[...targets].sort().join(" and ")}; one of them is wrong.`,
      });
      continue;
    }

    const target = [...targets][0] ?? null;
    if (target === null) {
      const note = notes[0]!;
      skipped.push({ orderId: order.id, reason: "unrecognised-note", detail: note });
      unknownCounts.set(note, (unknownCounts.get(note) ?? 0) + 1);
      continue;
    }
    if (target === "manual") {
      // The trail says the owner's own ticket, which is what the row already claims.
      skipped.push({ orderId: order.id, reason: "manual-note", detail: "The creation note is the trading page's." });
      continue;
    }

    // The evidence is the note that produced this origin, not merely the first one.
    updates.push({
      orderId: order.id,
      from: stored,
      to: target,
      evidence: classified.find((entry) => entry.origin === target)?.note ?? notes[0]!,
    });
  }

  return {
    candidates: input.orders.length,
    updates,
    skipped,
    unknownNotes: [...unknownCounts.entries()]
      .map(([note, count]) => ({ note, count }))
      .sort((left, right) => right.count - left.count || left.note.localeCompare(right.note)),
  };
}
