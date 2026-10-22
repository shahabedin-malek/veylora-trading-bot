import { reason, serializeReason, type Reason, type SerializedReason } from "@/lib/observability/reason";
import { redactValue } from "@/lib/observability/logger";
import {
  applyOrderTransition,
  isTerminalOrderStatus,
  type OrderEvent,
  type OrderStatus,
  type OrderTransitionResult,
} from "@/lib/orders/state-machine";
import { orderStore, type OrderStore, type StoredOrder } from "@/lib/orders/store";
import type { OrderVenuePort, VenueOrderReport, VenueOrderState } from "@/lib/orders/venue";
import { resolveOrderVenue, resolveVenueForOrder as resolveVenueForOrderFromRegistry } from "@/lib/venues/registry";

/**
 * Reconciliation: the venue is the truth, and this is where local state is made
 * to agree with it.
 *
 * Anything can go wrong between "we decided to send an order" and "we know what
 * happened to it": the venue times out, the process dies mid-write, the venue
 * fills an order we still believe is open. Reconciliation is the answer to all of
 * them, and it has three parts, kept apart on purpose:
 *
 *  1. **A pure mapping** (`planVenueCorrection`). The venue's vocabulary is
 *     translated into the lifecycle's events and the transitions are *decided*
 *     here — no database, no clock of its own. An impossible correction throws
 *     from this function, so a broken plan never reaches a write.
 *  2. **A divergence record.** When the two sides disagree, *both values are
 *     written down* — local, venue, which field, when — instead of the local
 *     value being quietly overwritten. A quietly corrected discrepancy is a
 *     discrepancy nobody can audit.
 *  3. **An orchestrator** (`reconcileOrders`) that walks every order that is not
 *     terminal, asks the venue, applies the planned transitions through the store
 *     port and reports what it found.
 *
 * Two rules the mapping never breaks, both taken from the state machine:
 *
 *  - **An execution that happened is never un-recorded.** If the venue reports a
 *    lower executed quantity than the local row, the divergence is recorded and
 *    the higher (local) figure is kept. Reconciliation corrects what is wrong, it
 *    does not delete what is real — and the machine would refuse the decrease
 *    anyway.
 *  - **Nothing is closed before the evidence is in.** A venue that cannot be
 *    reached, or cannot say, changes nothing and says why. A venue that answers
 *    "I hold no such order" only closes the order as RECONCILED once the grace
 *    window has passed, because a venue that has not seen a just-sent order yet
 *    is not the same as one that lost it.
 */

/**
 * How the venue's vocabulary maps onto the lifecycle. Written out so the mapping
 * can be read in one place, and so a venue state with no mapping is a visible
 * hole rather than a silent default.
 */
export const VENUE_STATE_MAPPING: Record<VenueOrderState, { live: boolean; event: OrderEvent | null; detail: string }> = {
  OPEN: { live: true, event: "SUBMIT", detail: "The venue holds the order and has executed nothing." },
  PARTIALLY_FILLED: { live: true, event: "PARTIAL_FILL", detail: "The venue has executed part of the order." },
  FILLED: { live: false, event: "COMPLETE_FILL", detail: "The venue has executed all of the order." },
  CANCELLED: { live: false, event: "CANCEL", detail: "The venue holds no live order; anything executed stays executed." },
  REJECTED: { live: false, event: "FAIL", detail: "The venue refused the order." },
  NOT_FOUND: { live: false, event: null, detail: "The venue has no record of the order at all." },
  UNKNOWN: { live: false, event: null, detail: "The venue could not be reached or could not say." },
};

/**
 * How long an order may be open before a venue that has never heard of it is
 * believed. A venue that has not yet seen a just-sent order is not the same as a
 * venue that has lost one, and closing an order on the first NOT_FOUND would
 * invent a discrepancy out of eventual consistency.
 */
export const RECONCILIATION_GRACE_MS = 5 * 60 * 1_000;

/** One field on which the local row and the venue disagree. Both values are kept. */
export type VenueDivergence = {
  field: "status" | "filledQuantity";
  local: string;
  venue: string;
  venueState: VenueOrderState;
  recordedAt: string;
};

export type CorrectionPlan = {
  /** The transitions to apply, in order, already decided by the pure machine. */
  transitions: OrderTransitionResult[];
  /** Where the two sides disagreed. Empty when they agreed. */
  divergences: VenueDivergence[];
  /** True when the plan ends the order's life. */
  terminal: boolean;
  /** True when there is something to write. */
  changed: boolean;
  /** Always present: every reconciliation pass says what it found, even when that is "nothing". */
  reason: Reason;
};

export type PlanInput = {
  source?: "reconcile" | "venue";
  now?: Date;
  graceMs?: number;
  /** The local time the order was last sent, for the grace window. */
};

function venueFilled(report: VenueOrderReport): string {
  return report.filledQuantity ?? "0";
}

function numeric(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Translate the venue's record into the transitions that make the local row agree
 * with it, and note every disagreement along the way.
 *
 * Pure: it takes an order and a report and returns a plan. Nothing is written,
 * and the only thing it can do besides return is throw — from
 * `applyOrderTransition`, for a correction the lifecycle does not allow. That is
 * what lets a test prove "an impossible correction does not run" by asserting the
 * throw, with no database in sight.
 */
export function planVenueCorrection(
  order: Pick<StoredOrder, "status" | "requestedQuantity" | "filledQuantity" | "submittedAt" | "createdAt">,
  report: VenueOrderReport,
  input: PlanInput = {},
): CorrectionPlan {
  const now = input.now ?? new Date();
  const source = input.source ?? "reconcile";
  const graceMs = input.graceMs ?? RECONCILIATION_GRACE_MS;
  const recordedAt = now.toISOString();
  const mapping = VENUE_STATE_MAPPING[report.state];
  const divergences: VenueDivergence[] = [];
  const transitions: OrderTransitionResult[] = [];

  const noteStatus = (venueStatus: OrderStatus) => {
    if (order.status !== venueStatus) {
      divergences.push({ field: "status", local: order.status, venue: venueStatus, venueState: report.state, recordedAt });
    }
  };

  if (isTerminalOrderStatus(order.status)) {
    // Nothing to correct, but a disagreement with a closed order is worth
    // recording: it means something wrote a state the venue does not share.
    const venueStatus = statusFor(report, order);
    if (venueStatus && venueStatus !== order.status) {
      noteStatus(venueStatus);
      return {
        transitions: [],
        divergences,
        terminal: true,
        changed: false,
        reason: reason("UNKNOWN", {
          message: `The order is already ${order.status} locally while ${report.state} at the venue; both values were recorded instead of reopening a closed order.`,
          detail: report.reason,
        }),
      };
    }
    return {
      transitions: [],
      divergences: [],
      terminal: true,
      changed: false,
      reason: reason("NO_ENTRY_CONDITION", { message: `The order is already ${order.status}, which is terminal, so nothing was reconciled.` }),
    };
  }

  if (report.state === "UNKNOWN") {
    return {
      transitions: [],
      divergences: [],
      terminal: false,
      changed: false,
      reason: reason("VENUE_UNAVAILABLE", {
        message: "The venue could not be reached, so the local state was left alone for the next pass.",
        detail: report.reason,
      }),
    };
  }

  if (report.state === "NOT_FOUND") {
    const since = Date.parse(order.submittedAt ?? order.createdAt);
    const openForMs = Number.isFinite(since) ? now.getTime() - since : 0;
    if (openForMs >= graceMs) {
      noteStatus("RECONCILED");
      transitions.push(
        applyOrderTransition(
          order,
          {
            event: "RECONCILE",
            reason: `The venue holds no record of this order ${Math.round(openForMs / 60_000)} minute(s) after it was sent, so it was closed as reconciled.${report.reason ? ` ${report.reason}` : ""}`,
            source,
          },
          now,
        ),
      );
      return {
        transitions,
        divergences,
        terminal: true,
        changed: true,
        reason: reason("UNKNOWN", {
          message: `The venue holds no record of this order, so it was closed as RECONCILED after ${Math.round(openForMs / 60_000)} minute(s).`,
          detail: report.reason,
        }),
      };
    }
    return {
      transitions: [],
      divergences: [],
      terminal: false,
      changed: false,
      reason: reason("NOT_YET_DUE", {
        message: `The venue holds no record of this order yet (${Math.round(openForMs / 1_000)}s old, inside the ${Math.round(graceMs / 1_000)}s grace window), so it was left open.`,
        detail: report.reason,
      }),
    };
  }

  // Everything below is a venue record that says what happened. The venue's
  // executed quantity is applied first, then its status, so a cancelled order
  // that had executed part of its quantity keeps that part as an execution.
  const reportedFilled = venueFilled(report);
  if (numeric(reportedFilled) > numeric(order.filledQuantity)) {
    const event: OrderEvent = numeric(reportedFilled) >= numeric(order.requestedQuantity) ? "COMPLETE_FILL" : "PARTIAL_FILL";
    transitions.push(
      applyOrderTransition(
        order,
        {
          event,
          filledQuantity: reportedFilled,
          reason: `The venue reports ${reportedFilled} executed while the local record held ${order.filledQuantity}.${report.reason ? ` ${report.reason}` : ""}`,
          source,
        },
        now,
      ),
    );
    divergences.push({
      field: "filledQuantity",
      local: order.filledQuantity,
      venue: reportedFilled,
      venueState: report.state,
      recordedAt,
    });
  } else if (numeric(reportedFilled) < numeric(order.filledQuantity)) {
    // The venue's number is lower. That is a disagreement, not an authorisation
    // to forget an execution: both values are recorded and the local one stands.
    divergences.push({
      field: "filledQuantity",
      local: order.filledQuantity,
      venue: reportedFilled,
      venueState: report.state,
      recordedAt,
    });
    return {
      transitions: [],
      divergences,
      terminal: false,
      changed: false,
      reason: reason("UNKNOWN", {
        message: `The venue reports ${reportedFilled} executed while the local record holds ${order.filledQuantity}; both values were recorded and the local execution was kept, because an execution that happened is not undone by a report.`,
        detail: report.reason,
      }),
    };
  }

  const afterFills = transitions.reduce<{ status: OrderStatus; filledQuantity: string; requestedQuantity: string }>(
    (state, result) => ({ status: result.to, filledQuantity: result.filledQuantity, requestedQuantity: result.requestedQuantity }),
    { status: order.status, filledQuantity: order.filledQuantity, requestedQuantity: order.requestedQuantity },
  );

  const target = statusFor(report, afterFills);
  if (target === null) {
    return {
      transitions,
      divergences,
      terminal: false,
      changed: transitions.length > 0,
      reason: reason("UNKNOWN", {
        message: `The venue answered ${report.state}, which this build cannot map onto the order lifecycle, so the local state was left alone.`,
        detail: report.reason,
      }),
    };
  }

  const event = mapping.event;
  if (afterFills.status !== target && event) {
    if (isTerminalOrderStatus(afterFills.status)) {
      // The fills just applied already closed the order, so the venue's cancel or
      // refusal has nothing left to act on. The disagreement is recorded and the
      // executed quantity stands: an execution is not undone by a later report.
      noteStatus(target);
      return {
        transitions,
        divergences,
        terminal: true,
        changed: transitions.length > 0,
        reason: reason("UNKNOWN", {
          message: `The venue reports ${report.state}, but applying its executed quantity already closed the order as ${afterFills.status}; the executed part was kept and both values were recorded.`,
          detail: report.reason,
        }),
      };
    }
    noteStatus(target);
    transitions.push(
      applyOrderTransition(
        afterFills,
        {
          event,
          reason: `${report.reason ?? mapping.detail} The venue reported ${report.state} while the local record held ${order.status}, so the local state was corrected to ${target}.`,
          source,
        },
        now,
      ),
    );
  }

  const terminal = transitions.some((result) => isTerminalOrderStatus(result.to));
  return {
    transitions,
    divergences,
    terminal,
    changed: transitions.length > 0,
    reason:
      divergences.length > 0
        ? reason("UNKNOWN", {
            message: `The venue's record disagrees with the local row on ${divergences.map((entry) => entry.field).join(", ")}; both values were recorded and the local state was corrected where the lifecycle allows it.`,
            detail: report.reason,
          })
        : transitions.length > 0
          ? reason("NO_ENTRY_CONDITION", { message: `The local state was corrected to the venue's ${report.state}.`, retryable: true })
          : reason("NO_ENTRY_CONDITION", {
              message: `The local row already agrees with the venue's ${report.state}, so nothing was changed.`,
              retryable: true,
            }),
  };
}

/** The lifecycle status a venue record implies, or null when it implies none. */
function statusFor(
  report: VenueOrderReport,
  local: Pick<StoredOrder, "requestedQuantity" | "filledQuantity">,
): OrderStatus | null {
  switch (report.state) {
    case "OPEN":
      return "SUBMITTED";
    case "PARTIALLY_FILLED":
      return numeric(venueFilled(report)) >= numeric(local.requestedQuantity) ? "FILLED" : "PARTIALLY_FILLED";
    case "FILLED":
      return "FILLED";
    case "CANCELLED":
      return "CANCELLED";
    case "REJECTED":
      return "FAILED";
    case "NOT_FOUND":
      return "RECONCILED";
    case "UNKNOWN":
      return null;
  }
}

export type ReconcileDeps = {
  store?: OrderStore;
  /** Stated directly by a test or a route; otherwise resolved per order's own venue. */
  venue?: OrderVenuePort;
  /**
   * Phase 21's "where would an order go now" resolver. A test that wants to prove the
   * mismatch guard states it; the default is the per-order resolver below, which is the
   * production rule. When both are given this one wins, and the mismatch guard still
   * applies, so a stated resolver cannot make the pass ask the wrong venue.
   */
  resolveVenue?: (userId: string) => Promise<Awaited<ReturnType<typeof resolveOrderVenue>>>;
  /** Phase 22's per-order resolver: the venue an existing order actually names. */
  resolveVenueForOrder?: (userId: string, venueId: string) => Promise<Awaited<ReturnType<typeof resolveOrderVenue>>>;
  now?: () => Date;
  limit?: number;
  graceMs?: number;
  actorUserId?: string | null;
};

export type ReconcileSummary = {
  /** Orders that were not terminal and therefore looked up. */
  checked: number;
  /** Orders whose local state was corrected to the venue's. */
  corrected: number;
  /** Orders where the two sides disagreed on some field. */
  divergences: number;
  /** Orders the venue could not answer for. */
  unresolved: number;
  /**
   * Orders left alone because the venue that holds them is not the one routing selects
   * now (phase 21). Counted separately from `unresolved`: the venue was never asked, so
   * "it could not answer" would be the wrong sentence for it.
   */
  skippedByVenueMismatch: number;
  /** The orders that changed, with their new status, for the runner summary. */
  changedOrderIds: string[];
  reason: SerializedReason;
};

export const RECONCILE_BATCH_LIMIT = 25;

/**
 * Walk every order that is not terminal, ask the venue what it really did, and
 * make the local row agree — recording both values wherever they disagreed.
 *
 * Idempotent by construction: a second pass over the same orders plans nothing,
 * because the first pass left them agreeing with the venue.
 */
export async function reconcileOrders(deps: ReconcileDeps = {}): Promise<ReconcileSummary> {
  const store = deps.store ?? orderStore();
  const statedVenue = deps.venue ?? null;
  const resolveVenue = deps.resolveVenue ?? null;
  const resolveVenueForOrder =
    deps.resolveVenueForOrder ?? ((userId: string, venueId: string) => resolveVenueForOrderFromRegistry(userId, venueId));
  const now = deps.now ?? (() => new Date());
  const limit = deps.limit ?? RECONCILE_BATCH_LIMIT;
  const actorUserId = deps.actorUserId ?? null;

  const open = await store.listOpenOrders(limit);
  let corrected = 0;
  let divergences = 0;
  let unresolved = 0;
  let skippedByVenueMismatch = 0;
  const changedOrderIds: string[] = [];
  // One resolution per account **and venue** per pass: the batch is usually one owner's
  // orders, and re-reading the rows per order would be a query per row for no new answer.
  const venues = new Map<string, Awaited<ReturnType<typeof resolveOrderVenue>>>();
  const askedVenues = new Set<string>();
  let routingRefusals = 0;

  for (const order of open) {
    let venue = statedVenue;
    let selectedHere = false;
    if (!venue) {
      const cacheKey = `${order.userId}::${order.venue}`;
      let resolution = venues.get(cacheKey);
      if (!resolution) {
        // An open order is looked up at the venue its own row names, so turning the
        // owner's live switch off mid-flight (or changing routing at all) still lets the
        // order finish or reconcile instead of being stranded.
        resolution = resolveVenue ? await resolveVenue(order.userId) : await resolveVenueForOrder(order.userId, order.venue);
        venues.set(cacheKey, resolution);
      }
      if (resolution.kind === "refused") {
        // A routing refusal is not a venue answer, so nothing is corrected: the order
        // stays open and the next pass asks again once the configuration is fixed.
        routingRefusals += 1;
        unresolved += 1;
        continue;
      }
      venue = resolution.venue;
      selectedHere = true;
    }
    // The venue that holds an order is the venue that was asked to place it. Even with the
    // per-order resolver a mismatch is possible — a resolver stated by a caller, or an
    // order whose venue has no key for this account any more — and asking the wrong venue
    // would report "no such order" about an order it never saw, which after the grace
    // window would close a live order as reconciled. So a mismatch is left alone and
    // counted, and the sentence says how many.
    if (selectedHere && venue.id !== order.venue) {
      skippedByVenueMismatch += 1;
      unresolved += 1;
      continue;
    }
    askedVenues.add(venue.id);
    const report = await venue.lookup({ order });
    const plan = planVenueCorrection(order, report, {
      source: "reconcile",
      now: now(),
      ...(deps.graceMs !== undefined ? { graceMs: deps.graceMs } : {}),
    });

    if (plan.divergences.length > 0) divergences += 1;
    if (plan.transitions.length === 0 && plan.divergences.length === 0) unresolved += 1;

    for (const transition of plan.transitions) {
      await store.applyTransition({ orderId: order.id, actorUserId, result: transition, now: now().getTime() });
    }

    if (plan.divergences.length > 0 || plan.transitions.length > 0) {
      await store.recordReconciliation({
        orderId: order.id,
        actorUserId,
        outcome: plan.transitions.length > 0 ? "CORRECTED" : "DIVERGENCE",
        divergences: plan.divergences,
        reason: plan.reason.message,
        detail: {
          venue: venue.id,
          venueState: report.state,
          venueFilledQuantity: venueFilled(report),
          localStatus: order.status,
          localFilledQuantity: order.filledQuantity,
          appliedEvents: plan.transitions.map((transition) => transition.event),
          providerResponse: redactValue(report.providerResponse ?? null),
        },
        now: now().getTime(),
      });
    }

    if (plan.transitions.length > 0) {
      corrected += 1;
      changedOrderIds.push(order.id);
    }
  }

  return {
    checked: open.length,
    corrected,
    divergences,
    unresolved,
    skippedByVenueMismatch,
    changedOrderIds,
    reason:
      open.length === 0
        ? serializeReason(
            reason("NO_ENTRY_CONDITION", { message: "Every order is in a terminal state, so there was nothing to reconcile.", retryable: true }),
          )
        : serializeReason(
            reason("NO_ENTRY_CONDITION", {
              message:
                askedVenues.size > 0
                  ? `${open.length} open order(s) were checked against ${[...askedVenues].sort().join(", ")}: ` +
                    `${corrected} corrected, ${divergences} disagreed with the venue, ${unresolved} left alone` +
                    (skippedByVenueMismatch + routingRefusals > 0
                      ? ` (${skippedByVenueMismatch} belong to a venue the pass resolved elsewhere, ` +
                        `${routingRefusals} could not be resolved at all — usually no key for the venue that holds them).`
                      : ".")
                  : `${open.length} open order(s) were not asked of any venue: ` +
                    `${skippedByVenueMismatch} belong to a venue the pass resolved elsewhere, ` +
                    `${routingRefusals} could not be resolved at all — usually no key for the venue that holds them.`,
              retryable: true,
            }),
          ),
  };
}
