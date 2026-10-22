import {
  isOrderStatus,
  ORDER_STATUS_DETAIL,
  toDecimalString,
  type OrderStatus,
  type OrderTransitionResult,
} from "@/lib/orders/state-machine";
import type { AttemptOutcome } from "@/lib/orders/retry";
import type { VenueDivergence } from "@/lib/orders/reconcile";
import { redactValue } from "@/lib/observability/logger";
import { DEFAULT_ORDER_ORIGIN, parseOrderOrigin, type OrderOrigin } from "@/lib/orders/origin";
import DecimalJS from "decimal.js";
import { auditCreate } from "@/lib/audit/record";

/**
 * Where orders live, behind a port.
 *
 * The state machine is pure; this is the other half — reading a row, writing a
 * transition, and writing the audit event that goes with it. Every side effect
 * the order lifecycle needs is one method here, which is why a test can run the
 * whole submit-and-reconcile path against an in-memory implementation and prove
 * (for instance) that a refused transition wrote nothing.
 *
 * Two properties are enforced here rather than trusted to callers:
 *
 *  - **A transition is compare-and-set.** The status the caller decided from is
 *    part of the update's `where`, so two processes cannot both move an order
 *    from SUBMITTED: the second update matches no row and gets a conflict
 *    instead of silently overwriting the first.
 *  - **A transition and its audit event commit together**, in one transaction, so
 *    the trail cannot end up with a state change nobody recorded or a record of a
 *    change that rolled back.
 *
 * `requestedAmount` in the table is the requested quantity: the column keeps its
 * name (the migration and seed already use it) and is mapped to
 * `requestedQuantity` once, here, so the domain speaks one language.
 */

const Decimal = DecimalJS.clone({ precision: 40 });

export type StoredOrder = {
  id: string;
  userId: string;
  venue: string;
  market: string;
  side: string;
  orderType: string;
  /** Where the intent came from: the owner, the assistant, a strategy or the API. */
  origin: OrderOrigin;
  status: OrderStatus;
  /** Maps to the `requestedAmount` column. */
  requestedQuantity: string;
  filledQuantity: string;
  remainingQuantity: string;
  clientOrderId: string;
  venueOrderId: string | null;
  idempotencyKey: string | null;
  limitPrice: string | null;
  stopLossPrice: string;
  notionalUsdCents: number;
  verifiedBalanceCents: number;
  attempts: number;
  lastAttemptAt: string | null;
  lastAttemptReason: string | null;
  lastProviderResponse: unknown;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  redactedResult: unknown;
};

export type CreateOrderInput = {
  userId: string;
  venue: string;
  market: string;
  side: string;
  orderType: string;
  /** Defaults to `manual`; a path that is not the owner's own ticket says which one it is. */
  origin?: OrderOrigin;
  /** The requested quantity, as the venue's base-unit decimal. */
  requestedQuantity: string;
  clientOrderId: string;
  idempotencyKey: string;
  limitPrice: string | null;
  stopLossPrice: string;
  notionalUsdCents: number;
  verifiedBalanceCents: number;
  /** Where the intent came from, for the audit trail. */
  actorUserId: string | null;
  reason: string;
  now: number;
};

export type OrderTransitionWrite = {
  orderId: string;
  actorUserId: string | null;
  result: OrderTransitionResult;
  /** The attempt that produced this transition, when one did. */
  attempt?: { number: number; outcome: AttemptOutcome; reason: string; providerResponseJson: string; at: string };
  now: number;
};

export type OrderAttemptWrite = {
  orderId: string;
  actorUserId: string | null;
  attempt: number;
  outcome: AttemptOutcome;
  reasonCode: string;
  reason: string;
  providerResponseJson: string;
  at: string;
  now: number;
};

/**
 * A reconciliation finding. `divergences` is empty when the venue and the local
 * row agreed and something was still applied; each entry carries both values, so
 * the record says what disagreed, not only that something did.
 */
export type OrderReconciliationWrite = {
  orderId: string;
  actorUserId: string | null;
  outcome: "CORRECTED" | "DIVERGENCE";
  divergences: readonly VenueDivergence[];
  reason: string;
  detail: Record<string, unknown>;
  now: number;
};

export type OrderStore = {
  createOrder(input: CreateOrderInput): Promise<StoredOrder>;
  findOrderById(orderId: string): Promise<StoredOrder | null>;
  findOrderByClientOrderId(clientOrderId: string): Promise<StoredOrder | null>;
  findOrderByVenueOrderId(venue: string, venueOrderId: string): Promise<StoredOrder | null>;
  listOrders(input: { userId?: string; statuses?: readonly OrderStatus[]; limit: number }): Promise<StoredOrder[]>;
  /** Every order that is not in a terminal state — what reconciliation walks. */
  listOpenOrders(limit: number): Promise<StoredOrder[]>;
  /** Compare-and-set the status, write the quantities, and audit the move. */
  applyTransition(write: OrderTransitionWrite): Promise<StoredOrder>;
  /** One audit event per attempt, with its reason and the venue's own answer. */
  recordAttempt(write: OrderAttemptWrite): Promise<void>;
  /** One audit event per reconciliation finding, carrying both values on a divergence. */
  recordReconciliation(write: OrderReconciliationWrite): Promise<void>;
  attachVenueOrderId(input: { orderId: string; venueOrderId: string; now: number }): Promise<StoredOrder>;
};

/** The order moved while this caller was deciding, so its decision is stale. */
export class OrderStateConflictError extends Error {
  readonly code = "ORDER_STATE_CONFLICT";

  constructor(input: { orderId: string; expected: OrderStatus; actual: OrderStatus | null }) {
    super(
      `Order ${input.orderId} was expected in ${input.expected} but is ${
        input.actual ? ORDER_STATUS_DETAIL[input.actual].label : "gone"
      }, so this transition was refused rather than applied to a stale decision.`,
    );
    this.name = "OrderStateConflictError";
  }
}

/** The audit action for each transition, so one event per move is readable in the trail. */
export const ORDER_AUDIT_ACTIONS = {
  SUBMIT: "ORDER_SUBMITTED",
  PARTIAL_FILL: "ORDER_PARTIALLY_FILLED",
  COMPLETE_FILL: "ORDER_FILLED",
  CANCEL: "ORDER_CANCELLED",
  FAIL: "ORDER_FAILED",
  RECONCILE: "ORDER_RECONCILED",
} as const;

export const ORDER_ATTEMPT_AUDIT_ACTION = "ORDER_ATTEMPT";

/**
 * Two actions rather than one: "the local row was corrected" and "the two sides
 * disagreed" are different findings, and a single action would hide which one a
 * row in the trail is.
 */
export const ORDER_RECONCILIATION_AUDIT_ACTIONS = {
  CORRECTED: "ORDER_RECONCILIATION",
  DIVERGENCE: "ORDER_RECONCILIATION_DIVERGENCE",
} as const;

type StoredOrderRow = {
  id: string;
  userId: string;
  venue: string;
  market: string;
  side: string;
  orderType: string;
  origin: string;
  status: string;
  requestedAmount: string;
  filledQuantity: string;
  clientOrderId: string;
  venueOrderId: string | null;
  idempotencyKey: string | null;
  limitPrice: string | null;
  stopLossPrice: string;
  notionalUsdCents: number;
  verifiedBalanceCents: number;
  attempts: number;
  lastAttemptAt: Date | null;
  lastAttemptReason: string | null;
  lastProviderResponseJson: string;
  submittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  redactedResultJson: string;
};

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function toStoredOrder(row: StoredOrderRow): StoredOrder {
  const requested = new Decimal(row.requestedAmount);
  const filled = new Decimal(row.filledQuantity);
  return {
    id: row.id,
    userId: row.userId,
    venue: row.venue,
    market: row.market,
    side: row.side,
    orderType: row.orderType,
    origin: parseOrderOrigin(row.origin),
    // A status the build does not understand is reported as CREATED with the row
    // untouched: the alternative is rendering a state nobody can explain, and
    // `ORDER_STATUS_DETAIL` is walked by a test precisely so this cannot happen
    // silently in the other direction.
    status: isOrderStatus(row.status) ? row.status : "CREATED",
    requestedQuantity: toDecimalString(requested),
    filledQuantity: toDecimalString(filled),
    remainingQuantity: toDecimalString(requested.minus(filled)),
    clientOrderId: row.clientOrderId,
    venueOrderId: row.venueOrderId,
    idempotencyKey: row.idempotencyKey,
    limitPrice: row.limitPrice,
    stopLossPrice: row.stopLossPrice,
    notionalUsdCents: row.notionalUsdCents,
    verifiedBalanceCents: row.verifiedBalanceCents,
    attempts: row.attempts,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    lastAttemptReason: row.lastAttemptReason,
    lastProviderResponse: parseJson(row.lastProviderResponseJson),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    redactedResult: parseJson(row.redactedResultJson),
  };
}

const ORDER_SELECT = {
  id: true,
  userId: true,
  venue: true,
  market: true,
  side: true,
  orderType: true,
  origin: true,
  status: true,
  requestedAmount: true,
  filledQuantity: true,
  clientOrderId: true,
  venueOrderId: true,
  idempotencyKey: true,
  limitPrice: true,
  stopLossPrice: true,
  notionalUsdCents: true,
  verifiedBalanceCents: true,
  attempts: true,
  lastAttemptAt: true,
  lastAttemptReason: true,
  lastProviderResponseJson: true,
  submittedAt: true,
  createdAt: true,
  updatedAt: true,
  redactedResultJson: true,
} as const;

/**
 * The audit payload for one transition. The previous state, the next state and
 * the reason are the point of it; the quantities and the venue order id make it
 * possible to reconstruct what the order looked like at each step.
 */
export function transitionAuditPayload(input: {
  write: OrderTransitionWrite;
  actorUserId: string | null;
}): Record<string, unknown> {
  const { result } = input.write;
  return {
    orderId: input.write.orderId,
    previousStatus: result.from,
    nextStatus: result.to,
    event: result.event,
    reason: result.reason,
    source: result.source,
    actorUserId: input.actorUserId,
    filledQuantity: result.filledQuantity,
    remainingQuantity: result.remainingQuantity,
    ...(result.venueOrderId ? { venueOrderId: result.venueOrderId } : {}),
    ...(input.write.attempt ? { attempt: input.write.attempt.number, attemptOutcome: input.write.attempt.outcome } : {}),
  };
}

/** The Prisma-backed store. The client is imported per call, never at module load. */
export function createPrismaOrderStore(): OrderStore {
  return {
    async createOrder(input) {
      const { prisma } = await import("@/lib/db");
      const created = await prisma.$transaction(async (transaction) => {
        const row = await transaction.tradeOrder.create({
          data: {
            userId: input.userId,
            venue: input.venue,
            market: input.market,
            side: input.side,
            orderType: input.orderType,
            origin: input.origin ?? DEFAULT_ORDER_ORIGIN,
            status: "CREATED",
            requestedAmount: input.requestedQuantity,
            filledQuantity: "0",
            clientOrderId: input.clientOrderId,
            idempotencyKey: input.idempotencyKey,
            limitPrice: input.limitPrice,
            stopLossPrice: input.stopLossPrice,
            notionalUsdCents: input.notionalUsdCents,
            verifiedBalanceCents: input.verifiedBalanceCents,
            attempts: 0,
            createdAt: new Date(input.now),
            updatedAt: new Date(input.now),
          },
          select: ORDER_SELECT,
        });
        await auditCreate(transaction, {
          data: {
            actorUserId: input.actorUserId,
            action: "ORDER_CREATED",
            objectType: "TradeOrder",
            objectId: row.id,
            outcome: "SUCCESS",
            redactedJson: JSON.stringify({
              orderId: row.id,
              previousStatus: null,
              nextStatus: "CREATED",
              reason: input.reason,
              clientOrderId: input.clientOrderId,
              idempotencyKey: input.idempotencyKey,
              requestedQuantity: input.requestedQuantity,
              market: input.market,
              side: input.side,
              orderType: input.orderType,
              origin: input.origin ?? DEFAULT_ORDER_ORIGIN,
              venue: input.venue,
            }),
            occurredAt: new Date(input.now),
          },
        });
        return row;
      });
      return toStoredOrder(created);
    },

    async findOrderById(orderId) {
      const { prisma } = await import("@/lib/db");
      const row = await prisma.tradeOrder.findUnique({ where: { id: orderId }, select: ORDER_SELECT });
      return row ? toStoredOrder(row) : null;
    },

    async findOrderByClientOrderId(clientOrderId) {
      const { prisma } = await import("@/lib/db");
      const row = await prisma.tradeOrder.findUnique({ where: { clientOrderId }, select: ORDER_SELECT });
      return row ? toStoredOrder(row) : null;
    },

    async findOrderByVenueOrderId(venue, venueOrderId) {
      const { prisma } = await import("@/lib/db");
      const row = await prisma.tradeOrder.findFirst({
        where: { venue, venueOrderId },
        orderBy: { createdAt: "desc" },
        select: ORDER_SELECT,
      });
      return row ? toStoredOrder(row) : null;
    },

    async listOrders({ userId, statuses, limit }) {
      const { prisma } = await import("@/lib/db");
      const rows = await prisma.tradeOrder.findMany({
        where: {
          ...(userId ? { userId } : {}),
          ...(statuses && statuses.length > 0 ? { status: { in: [...statuses] } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(Math.max(1, limit), 200),
        select: ORDER_SELECT,
      });
      return rows.map(toStoredOrder);
    },

    async listOpenOrders(limit) {
      const { prisma } = await import("@/lib/db");
      const rows = await prisma.tradeOrder.findMany({
        where: { status: { in: ["CREATED", "SUBMITTED", "PARTIALLY_FILLED"] } },
        orderBy: { createdAt: "asc" },
        take: Math.min(Math.max(1, limit), 200),
        select: ORDER_SELECT,
      });
      return rows.map(toStoredOrder);
    },

    async applyTransition(write) {
      const { prisma } = await import("@/lib/db");
      const { result } = write;
      const updated = await prisma.$transaction(async (transaction) => {
        const attempted = await transaction.tradeOrder.updateMany({
          // The status the caller decided from is part of the match, so a stale
          // decision cannot overwrite a newer one.
          where: { id: write.orderId, status: result.from },
          data: {
            status: result.to,
            requestedAmount: result.requestedQuantity,
            filledQuantity: result.filledQuantity,
            ...(result.venueOrderId ? { venueOrderId: result.venueOrderId } : {}),
            ...(result.event === "SUBMIT" ? { submittedAt: new Date(write.now) } : {}),
            ...(write.attempt
              ? {
                  attempts: write.attempt.number,
                  lastAttemptAt: new Date(write.attempt.at),
                  lastAttemptReason: write.attempt.reason.slice(0, 500),
                  lastProviderResponseJson: write.attempt.providerResponseJson,
                }
              : {}),
            updatedAt: new Date(write.now),
          },
        });
        if (attempted.count === 0) {
          const current = await transaction.tradeOrder.findUnique({
            where: { id: write.orderId },
            select: { status: true },
          });
          throw new OrderStateConflictError({
            orderId: write.orderId,
            expected: result.from,
            actual: current && isOrderStatus(current.status) ? current.status : null,
          });
        }
        await auditCreate(transaction, {
          data: {
            actorUserId: write.actorUserId,
            action: ORDER_AUDIT_ACTIONS[result.event],
            objectType: "TradeOrder",
            objectId: write.orderId,
            outcome: result.event === "FAIL" ? "FAILURE" : "SUCCESS",
            redactedJson: JSON.stringify(transitionAuditPayload({ write, actorUserId: write.actorUserId })),
            occurredAt: new Date(write.now),
          },
        });
        return transaction.tradeOrder.findUniqueOrThrow({ where: { id: write.orderId }, select: ORDER_SELECT });
      });
      return toStoredOrder(updated);
    },

    async recordAttempt(write) {
      const { prisma } = await import("@/lib/db");
      await prisma.$transaction(async (transaction) => {
        await transaction.tradeOrder.update({
          where: { id: write.orderId },
          data: {
            attempts: write.attempt,
            lastAttemptAt: new Date(write.at),
            lastAttemptReason: write.reason.slice(0, 500),
            lastProviderResponseJson: write.providerResponseJson,
            updatedAt: new Date(write.now),
          },
        });
        await auditCreate(transaction, {
          data: {
            actorUserId: write.actorUserId,
            action: ORDER_ATTEMPT_AUDIT_ACTION,
            objectType: "TradeOrder",
            objectId: write.orderId,
            outcome: write.outcome === "accepted" ? "SUCCESS" : "FAILURE",
            redactedJson: JSON.stringify({
              orderId: write.orderId,
              attempt: write.attempt,
              attemptOutcome: write.outcome,
              reasonCode: write.reasonCode,
              reason: write.reason,
              providerResponse: parseJson(write.providerResponseJson),
            }),
            occurredAt: new Date(write.at),
          },
        });
      });
    },

    async recordReconciliation(write) {
      const { prisma } = await import("@/lib/db");
      await auditCreate(prisma, {
        data: {
          actorUserId: write.actorUserId,
          action: ORDER_RECONCILIATION_AUDIT_ACTIONS[write.outcome],
          objectType: "TradeOrder",
          objectId: write.orderId,
          outcome: write.outcome === "CORRECTED" ? "SUCCESS" : "FAILURE",
          redactedJson: JSON.stringify(
            redactValue({
              ...write.detail,
              orderId: write.orderId,
              reason: write.reason,
              divergenceCount: write.divergences.length,
              // One entry per field, carrying the local figure and the venue's.
              divergences: write.divergences.map((divergence) => ({
                field: divergence.field,
                local: divergence.local,
                venue: divergence.venue,
                venueState: divergence.venueState,
                recordedAt: divergence.recordedAt,
              })),
            }),
          ),
          occurredAt: new Date(write.now),
        },
      });
    },

    async attachVenueOrderId({ orderId, venueOrderId, now }) {
      const { prisma } = await import("@/lib/db");
      const row = await prisma.tradeOrder.update({
        where: { id: orderId },
        data: { venueOrderId, updatedAt: new Date(now) },
        select: ORDER_SELECT,
      });
      return toStoredOrder(row);
    },
  };
}

let sharedStore: OrderStore | null = null;

/** The store the running application uses. */
export function orderStore(): OrderStore {
  sharedStore ??= createPrismaOrderStore();
  return sharedStore;
}
