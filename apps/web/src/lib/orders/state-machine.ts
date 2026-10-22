import DecimalJS from "decimal.js";

/**
 * The one lifecycle every order and long-running process shares.
 *
 * An order moves through a small set of states, and only some moves are legal.
 * That set lives here — not in the database, not in a route, not in the UI —
 * which is what lets the same answer be given by a unit test, by the submit
 * path, by reconciliation and by the page that renders it.
 *
 * Three rules hold this together:
 *
 *  - **One status set, one transition table.** `evaluateOrderTransition` is the
 *    only place that decides whether a move is allowed, and it is pure: no
 *    database, no venue, no clock of its own. `applyOrderTransition` throws for
 *    an illegal move, and callers apply it *before* any side effect, so a
 *    refused transition cannot half-happen.   *  - **Quantities are cumulative and never invented.** A fill reports the
 *    *cumulative* executed quantity for the order, so applying the same venue
 *    report twice cannot double-count it. `filled` never decreases, never
 *    exceeds `requested`, and is never reset — a cancelled partially filled
 *    order keeps its filled portion, because that portion is real.
 *  - **Every state can be explained.** `ORDER_STATUS_DETAIL` gives each status a
 *    label, a sentence and whether it is terminal; the UI renders that, and a
 *    status without an explanation would fail the test that walks this table.
 *
 * The status set is enforced in TypeScript rather than as a database enum on
 * purpose: development runs the SQLite schema derived from `prisma/schema.prisma`
 * (`scripts/dev-database.mjs` refuses to derive a schema containing an enum), and
 * a Postgres-only enum would break `pnpm db:setup`. The database stores the
 * status string; this module is the single source of truth for what it may be.
 * `src/lib/orders/store.ts` validates every status it reads back.
 */

export const ORDER_STATUSES = [
  /** A local intent. Nothing has been sent anywhere yet. */
  "CREATED",
  /** Sent to a venue; we are waiting for (or already have) its acknowledgement. */
  "SUBMITTED",
  /** Some quantity executed; the rest is still live. */
  "PARTIALLY_FILLED",
  /** Fully executed. Terminal. */
  "FILLED",
  /** Cancelled, whether or not part of it had filled. Terminal. */
  "CANCELLED",
  /** The venue refused it, or the attempts ran out. Terminal. */
  "FAILED",
  /** Reconciliation closed it: the venue held no live record and reported neither a fill nor a cancel. Terminal. */
  "RECONCILED",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const TERMINAL_ORDER_STATUSES = ["FILLED", "CANCELLED", "FAILED", "RECONCILED"] as const;
export type TerminalOrderStatus = (typeof TERMINAL_ORDER_STATUSES)[number];

export const ORDER_EVENTS = [
  /** Send the intent to a venue. */
  "SUBMIT",
  /** The venue executed part of the order. */
  "PARTIAL_FILL",
  /** The venue executed all of it. */
  "COMPLETE_FILL",
  /** The order stops being live; whatever filled stays filled. */
  "CANCEL",
  /** The venue refused it, or no attempt can succeed any more. */
  "FAIL",
  /** The venue's own record was applied to a local state that disagreed. */
  "RECONCILE",
] as const;

export type OrderEvent = (typeof ORDER_EVENTS)[number];

/** Where a transition came from, recorded on the audit event. */
export type OrderTransitionSource = "local" | "venue" | "reconcile" | "scheduler";

/**
 * The shared refusal shape. `src/lib/bot-builder/state-machine.ts` returns the
 * same shape for strategy transitions, so a caller handling "may this move
 * happen?" handles both the same way.
 */
export type TransitionRefusalCode =
  | "TERMINAL_STATE"
  | "NOT_ALLOWED"
  | "INVALID_QUANTITY"
  | "MISSING_REASON"
  | "UNKNOWN_STATUS";

export type TransitionDecision<TStatus extends string> =
  | { allowed: true; status: TStatus }
  | { allowed: false; code: TransitionRefusalCode; reason: string };

export type OrderState = {
  status: OrderStatus;
  /** Order quantity, as a decimal string. */
  requestedQuantity: string;
  /** Cumulative executed quantity, as a decimal string. Never decreases. */
  filledQuantity: string;
  /** The quantity that is still live: requested − filled. */
  remainingQuantity: string;
};

export type OrderTransitionRequest = {
  event: OrderEvent;
  /**
   * The **cumulative** executed quantity a fill reports. Greater than the
   * requested quantity is refused, and so is a value below the current filled
   * quantity, because a fill is monotonic. A *complete* fill may repeat the
   * quantity already recorded — applying the venue's own report twice is
   * idempotent, which is what makes reconciliation safe to re-run.
   */
  filledQuantity?: string;
  /** Why: a refusal sentence, a cancel reason, or the venue's own words. */
  reason?: string;
  venueOrderId?: string;
  source?: OrderTransitionSource;
};

export type OrderTransitionResult = {
  from: OrderStatus;
  to: OrderStatus;
  event: OrderEvent;
  requestedQuantity: string;
  filledQuantity: string;
  remainingQuantity: string;
  reason: string;
  venueOrderId?: string;
  source: OrderTransitionSource;
  /** False when the event was already reflected in the current state. */
  changed: boolean;
};

const Decimal = DecimalJS.clone({ precision: 40 });

/** A decimal quantity, as the order tables store it. */
const QUANTITY_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && (ORDER_STATUSES as readonly string[]).includes(value);
}

export function isOrderEvent(value: unknown): value is OrderEvent {
  return typeof value === "string" && (ORDER_EVENTS as readonly string[]).includes(value);
}

export function isTerminalOrderStatus(status: OrderStatus): status is TerminalOrderStatus {
  return (TERMINAL_ORDER_STATUSES as readonly string[]).includes(status);
}

/**
 * The transition table, written out so it can be read in one place. Every status
 * that is not terminal appears here with the events it accepts; a status that is
 * terminal accepts none.
 */
const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderEvent[]> = {
  CREATED: ["SUBMIT", "CANCEL", "FAIL"],
  SUBMITTED: ["PARTIAL_FILL", "COMPLETE_FILL", "CANCEL", "FAIL", "RECONCILE"],
  // A second partial fill is legal: an order that fills in steps keeps filling.
  PARTIALLY_FILLED: ["PARTIAL_FILL", "COMPLETE_FILL", "CANCEL", "FAIL", "RECONCILE"],
  FILLED: [],
  CANCELLED: [],
  FAILED: [],
  RECONCILED: [],
};

const STATUS_AFTER_EVENT: Record<OrderEvent, OrderStatus> = {
  SUBMIT: "SUBMITTED",
  PARTIAL_FILL: "PARTIALLY_FILLED",
  COMPLETE_FILL: "FILLED",
  CANCEL: "CANCELLED",
  FAIL: "FAILED",
  RECONCILE: "RECONCILED",
};

const EVENT_LABEL: Record<OrderEvent, string> = {
  SUBMIT: "submitted",
  PARTIAL_FILL: "partially filled",
  COMPLETE_FILL: "filled",
  CANCEL: "cancelled",
  FAIL: "failed",
  RECONCILE: "reconciled",
};

/**
 * What each status means, in the words the UI shows. A status the owner cannot
 * read is a status that hides its cause, so `tests/orders-state-machine.test.ts`
 * walks this table and requires a sentence for every status.
 */
export const ORDER_STATUS_DETAIL: Record<OrderStatus, { label: string; detail: string; terminal: boolean }> = {
  CREATED: {
    label: "CREATED",
    detail: "The order exists locally and has not been sent to a venue.",
    terminal: false,
  },
  SUBMITTED: {
    label: "SUBMITTED",
    detail: "The order is live at the venue and is waiting to fill or be cancelled.",
    terminal: false,
  },
  PARTIALLY_FILLED: {
    label: "PARTIALLY FILLED",
    detail: "Part of the order has executed; the remaining quantity is still live.",
    terminal: false,
  },
  FILLED: {
    label: "FILLED",
    detail: "The whole order executed. Nothing further happens to it.",
    terminal: true,
  },
  CANCELLED: {
    label: "CANCELLED",
    detail: "The order is no longer live. Any quantity that executed before the cancel is kept.",
    terminal: true,
  },
  FAILED: {
    label: "FAILED",
    detail: "The venue refused the order or no attempt could succeed. The reason above is the venue's own.",
    terminal: true,
  },
  RECONCILED: {
    label: "RECONCILED",
    detail: "Reconciliation closed the order: the venue held no live record and reported neither a fill nor a cancel.",
    terminal: true,
  },
};

/** The statuses in the order the UI lists them. */
export const ORDER_STATUS_DISPLAY_ORDER: readonly OrderStatus[] = [
  "CREATED",
  "SUBMITTED",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCELLED",
  "FAILED",
  "RECONCILED",
];

export class IllegalOrderTransitionError extends Error {
  readonly code: TransitionRefusalCode;
  readonly from: OrderStatus;
  readonly event: OrderEvent;

  constructor(input: { code: TransitionRefusalCode; from: OrderStatus; event: OrderEvent; reason: string }) {
    super(input.reason);
    this.name = "IllegalOrderTransitionError";
    this.code = input.code;
    this.from = input.from;
    this.event = input.event;
  }
}

function quantity(value: string | undefined): DecimalJS | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!QUANTITY_PATTERN.test(trimmed)) return null;
  const parsed = new Decimal(trimmed);
  return parsed.isFinite() ? parsed : null;
}

export function toDecimalString(value: DecimalJS, places = 12): string {
  return value.toDecimalPlaces(places).toString();
}

/**
 * Decide whether a move is legal, without performing it.
 *
 * This is the whole rulebook: terminal states accept nothing, each state accepts
 * only the events listed in the table, a reason is required wherever the outcome
 * is a failure or a cancel (an unexplained stop is the thing this phase exists to
 * remove), and the quantities must add up.
 */
export function evaluateOrderTransition(
  state: Pick<OrderState, "status" | "requestedQuantity" | "filledQuantity">,
  request: OrderTransitionRequest,
): TransitionDecision<OrderStatus> {
  const { status } = state;
  if (!isOrderStatus(status)) {
    return { allowed: false, code: "UNKNOWN_STATUS", reason: `Status ${status} is not one this build understands.` };
  }
  if (!isOrderEvent(request.event)) {
    return {
      allowed: false,
      code: "NOT_ALLOWED",
      reason: `Event ${String(request.event)} is not one this build understands.`,
    };
  }
  if (isTerminalOrderStatus(status)) {
    return {
      allowed: false,
      code: "TERMINAL_STATE",
      reason: `${ORDER_STATUS_DETAIL[status].label} is terminal, so it cannot be ${EVENT_LABEL[request.event]}.`,
    };
  }
  if (!ALLOWED_TRANSITIONS[status].includes(request.event)) {
    return {
      allowed: false,
      code: "NOT_ALLOWED",
      reason: `Transition ${status} → ${EVENT_LABEL[request.event]} is not allowed.`,
    };
  }

  const requested = quantity(state.requestedQuantity);
  const currentFilled = quantity(state.filledQuantity);
  if (requested === null || currentFilled === null || requested.lte(0) || currentFilled.lt(0)) {
    return {
      allowed: false,
      code: "INVALID_QUANTITY",
      reason: "The order's own quantities are not readable decimals.",
    };
  }

  if (request.event === "PARTIAL_FILL" || request.event === "COMPLETE_FILL") {
    const reported = request.event === "COMPLETE_FILL" && request.filledQuantity === undefined
      ? requested
      : quantity(request.filledQuantity);
    if (reported === null) {
      return {
        allowed: false,
        code: "INVALID_QUANTITY",
        reason: "A fill must report the cumulative executed quantity as a plain decimal.",
      };
    }
    if (reported.lt(currentFilled)) {
      return {
        allowed: false,
        code: "INVALID_QUANTITY",
        reason: `A fill reports the cumulative executed quantity (${reported.toString()}), which is below the ${currentFilled.toString()} already recorded; an execution that happened cannot be taken back.`,
      };
    }
    if (request.event === "PARTIAL_FILL" && reported.eq(currentFilled)) {
      return {
        allowed: false,
        code: "INVALID_QUANTITY",
        reason: `A partial fill must add to the ${currentFilled.toString()} already recorded.`,
      };
    }
    if (reported.gt(requested)) {
      return {
        allowed: false,
        code: "INVALID_QUANTITY",
        reason: `A fill of ${reported.toString()} exceeds the ${requested.toString()} requested, so it was refused rather than recorded.`,
      };
    }
    if (request.event === "COMPLETE_FILL" && reported.lt(requested)) {
      return {
        allowed: false,
        code: "INVALID_QUANTITY",
        reason: `A complete fill must reach the ${requested.toString()} requested, not ${reported.toString()}.`,
      };
    }
  }

  if ((request.event === "FAIL" || request.event === "CANCEL" || request.event === "RECONCILE") && !request.reason?.trim()) {
    return {
      allowed: false,
      code: "MISSING_REASON",
      reason: `A ${EVENT_LABEL[request.event]} order must carry the reason it stopped.`,
    };
  }

  return { allowed: true, status: STATUS_AFTER_EVENT[request.event] };
}

/**
 * Apply a transition, or throw.
 *
 * Callers use this **before** any side effect: a refusal here means nothing was
 * written, sent or audited. The returned result carries both the state to store
 * and the reason to record, so the caller never has to re-derive either.
 */
export function applyOrderTransition(
  state: Pick<OrderState, "status" | "requestedQuantity" | "filledQuantity">,
  request: OrderTransitionRequest,
  now: Date = new Date(),
): OrderTransitionResult {
  const decision = evaluateOrderTransition(state, request);
  if (!decision.allowed) {
    throw new IllegalOrderTransitionError({
      code: decision.code,
      from: state.status,
      event: request.event,
      reason: decision.reason,
    });
  }

  const requested = quantity(state.requestedQuantity)!;
  const currentFilled = quantity(state.filledQuantity)!;
  const reportedFilled =
    request.event === "PARTIAL_FILL" || request.event === "COMPLETE_FILL"
      ? request.filledQuantity === undefined
        ? requested
        : quantity(request.filledQuantity)!
      : currentFilled;

  // A cancelled partially filled order keeps what executed: the filled quantity
  // passes through untouched on every non-fill event, which is what stops the
  // filled portion from being silently dropped or counted twice.
  const filled = reportedFilled;
  const remaining = requested.minus(filled);

  return {
    from: state.status,
    to: decision.status,
    event: request.event,
    requestedQuantity: toDecimalString(requested),
    filledQuantity: toDecimalString(filled),
    remainingQuantity: toDecimalString(remaining),
    reason: request.reason?.trim() || defaultReason(request.event, state.status, decision.status, now),
    source: request.source ?? "local",
    ...(request.venueOrderId ? { venueOrderId: request.venueOrderId } : {}),
    changed: decision.status !== state.status || !filled.equals(currentFilled),
  };
}

function defaultReason(event: OrderEvent, from: OrderStatus, to: OrderStatus, now: Date): string {
  if (event === "SUBMIT") return "The order intent was sent to the venue.";
  if (event === "PARTIAL_FILL") return "The venue reported a partial execution.";
  if (event === "COMPLETE_FILL") return "The venue reported the order fully executed.";
  return `${from} → ${to} at ${now.toISOString()}.`;
}

/**
 * The state an order row describes. Kept here so a reader of a stored row and a
 * test share one implementation of "what do these columns mean".
 */
export function orderStateFromRow(row: {
  status: string;
  requestedQuantity: string;
  filledQuantity?: string | null;
}): OrderState {
  const requested = quantity(row.requestedQuantity) ?? new Decimal(0);
  const filled = quantity(row.filledQuantity ?? undefined) ?? new Decimal(0);
  return {
    status: isOrderStatus(row.status) ? row.status : "CREATED",
    requestedQuantity: toDecimalString(requested),
    filledQuantity: toDecimalString(filled),
    remainingQuantity: toDecimalString(requested.minus(filled)),
  };
}
