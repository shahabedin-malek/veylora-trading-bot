import {
  interpretReservation,
  type IdempotencyReservation,
  type IdempotencyScope,
  type IdempotencyStore,
} from "@/lib/orders/idempotency";
import { isTerminalOrderStatus, type OrderEvent, type OrderStatus } from "@/lib/orders/state-machine";
import type { AttemptOutcome } from "@/lib/orders/retry";
import { OrderStateConflictError, type OrderStore, type StoredOrder } from "@/lib/orders/store";
import { DEFAULT_ORDER_ORIGIN } from "@/lib/orders/origin";
import type { VenueDivergence } from "@/lib/orders/reconcile";
import type { OrderVenuePort, VenueCancelOutcome, VenueOrderReport, VenueSubmitOutcome } from "@/lib/orders/venue";

/**
 * The injectable side effects, in memory.
 *
 * Phase 06's state machine is pure, and the two ports it needs — the order store
 * and the venue — are small enough to implement honestly in a test: this file is
 * the proof. The store below keeps the same compare-and-set contract as the
 * Prisma one (a transition whose `from` does not match is a conflict, not an
 * overwrite) and writes the same audit chain, so a test that asserts "one order
 * and one audit chain" is asserting the behaviour the real store has, not a
 * friendlier one invented for tests.
 *
 * Nothing here is imported by application code.
 */

export type RecordedTransition = {
  orderId: string;
  from: OrderStatus;
  to: OrderStatus;
  event: OrderEvent;
  reason: string;
  actorUserId: string | null;
  filledQuantity: string;
  remainingQuantity: string;
};

export type RecordedAttempt = {
  orderId: string;
  attempt: number;
  outcome: AttemptOutcome;
  reason: string;
  reasonCode: string;
  providerResponse: unknown;
};

export type RecordedReconciliation = {
  orderId: string;
  outcome: "CORRECTED" | "DIVERGENCE";
  divergences: readonly VenueDivergence[];
  reason: string;
};

export type MemoryOrderStore = {
  store: OrderStore;
  orders: Map<string, StoredOrder>;
  transitions: RecordedTransition[];
  attempts: RecordedAttempt[];
  reconciliations: RecordedReconciliation[];
  /** Put an order in place as if it had been created and moved before the test. */
  seed(order: Partial<StoredOrder> & Pick<StoredOrder, "status" | "requestedQuantity">): StoredOrder;
};

export function makeOrder(overrides: Partial<StoredOrder> & Pick<StoredOrder, "status" | "requestedQuantity">): StoredOrder {
  const requested = overrides.requestedQuantity;
  const filled = overrides.filledQuantity ?? "0";
  return {
    id: overrides.id ?? `order-${Math.random().toString(36).slice(2, 10)}`,
    userId: overrides.userId ?? "dev-test-account",
    venue: overrides.venue ?? "test-venue",
    market: overrides.market ?? "BTC-USD",
    side: overrides.side ?? "BUY",
    orderType: overrides.orderType ?? "MARKET",
    origin: overrides.origin ?? DEFAULT_ORDER_ORIGIN,
    status: overrides.status,
    requestedQuantity: requested,
    filledQuantity: filled,
    remainingQuantity: overrides.remainingQuantity ?? String(Math.max(0, Number(requested) - Number(filled))),
    clientOrderId: overrides.clientOrderId ?? "ord_test",
    venueOrderId: overrides.venueOrderId ?? null,
    idempotencyKey: overrides.idempotencyKey ?? null,
    limitPrice: overrides.limitPrice ?? null,
    stopLossPrice: overrides.stopLossPrice ?? "0",
    notionalUsdCents: overrides.notionalUsdCents ?? 10_000,
    verifiedBalanceCents: overrides.verifiedBalanceCents ?? 250_000,
    attempts: overrides.attempts ?? 0,
    lastAttemptAt: overrides.lastAttemptAt ?? null,
    lastAttemptReason: overrides.lastAttemptReason ?? null,
    lastProviderResponse: overrides.lastProviderResponse ?? null,
    submittedAt: overrides.submittedAt ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00.000Z").toISOString(),
    updatedAt: overrides.updatedAt ?? new Date("2026-01-01T00:00:00.000Z").toISOString(),
    redactedResult: overrides.redactedResult ?? null,
  };
}

export function createMemoryOrderStore(): MemoryOrderStore {
  const orders = new Map<string, StoredOrder>();
  const transitions: RecordedTransition[] = [];
  const attempts: RecordedAttempt[] = [];
  const reconciliations: RecordedReconciliation[] = [];
  let sequence = 0;

  const store: OrderStore = {
    async createOrder(input) {
      sequence += 1;
      const order = makeOrder({
        id: `order-${sequence}`,
        status: "CREATED",
        requestedQuantity: input.requestedQuantity,
        clientOrderId: input.clientOrderId,
        idempotencyKey: input.idempotencyKey,
        userId: input.userId,
        venue: input.venue,
        market: input.market,
        side: input.side,
        orderType: input.orderType,
        origin: input.origin ?? DEFAULT_ORDER_ORIGIN,
        limitPrice: input.limitPrice,
        stopLossPrice: input.stopLossPrice,
        notionalUsdCents: input.notionalUsdCents,
        verifiedBalanceCents: input.verifiedBalanceCents,
        createdAt: new Date(input.now).toISOString(),
        updatedAt: new Date(input.now).toISOString(),
      });
      orders.set(order.id, order);
      return order;
    },

    async findOrderById(orderId) {
      return orders.get(orderId) ?? null;
    },

    async findOrderByClientOrderId(clientOrderId) {
      return [...orders.values()].find((order) => order.clientOrderId === clientOrderId) ?? null;
    },

    async findOrderByVenueOrderId(venue, venueOrderId) {
      return [...orders.values()].find((order) => order.venue === venue && order.venueOrderId === venueOrderId) ?? null;
    },

    async listOrders({ userId, statuses, limit }) {
      return [...orders.values()]
        .filter((order) => (userId ? order.userId === userId : true))
        .filter((order) => (statuses && statuses.length > 0 ? statuses.includes(order.status) : true))
        .slice(0, limit);
    },

    async listOpenOrders(limit) {
      return [...orders.values()].filter((order) => !isTerminalOrderStatus(order.status)).slice(0, limit);
    },

    async applyTransition(write) {
      const order = orders.get(write.orderId);
      if (!order) throw new Error(`No order ${write.orderId} in the memory store.`);
      const { result } = write;
      // The same compare-and-set rule as the Prisma store: a decision made from
      // a state that has moved is a conflict, never an overwrite.
      if (order.status !== result.from) {
        throw new OrderStateConflictError({ orderId: write.orderId, expected: result.from, actual: order.status });
      }
      const next: StoredOrder = {
        ...order,
        status: result.to,
        requestedQuantity: result.requestedQuantity,
        filledQuantity: result.filledQuantity,
        remainingQuantity: result.remainingQuantity,
        venueOrderId: result.venueOrderId ?? order.venueOrderId,
        attempts: write.attempt?.number ?? order.attempts,
        ...(result.event === "SUBMIT" ? { submittedAt: new Date(write.now).toISOString() } : {}),
        ...(write.attempt
          ? {
              lastAttemptAt: write.attempt.at,
              lastAttemptReason: write.attempt.reason,
              lastProviderResponse: write.attempt.providerResponseJson ? JSON.parse(write.attempt.providerResponseJson) : null,
            }
          : {}),
        updatedAt: new Date(write.now).toISOString(),
      };
      orders.set(next.id, next);
      transitions.push({
        orderId: next.id,
        from: result.from,
        to: result.to,
        event: result.event,
        reason: result.reason,
        actorUserId: write.actorUserId,
        filledQuantity: result.filledQuantity,
        remainingQuantity: result.remainingQuantity,
      });
      return next;
    },

    async recordAttempt(write) {
      const order = orders.get(write.orderId);
      if (!order) throw new Error(`No order ${write.orderId} in the memory store.`);
      orders.set(order.id, {
        ...order,
        attempts: write.attempt,
        lastAttemptAt: write.at,
        lastAttemptReason: write.reason,
        lastProviderResponse: JSON.parse(write.providerResponseJson) as unknown,
      });
      attempts.push({
        orderId: write.orderId,
        attempt: write.attempt,
        outcome: write.outcome,
        reason: write.reason,
        reasonCode: write.reasonCode,
        providerResponse: JSON.parse(write.providerResponseJson) as unknown,
      });
    },

    async recordReconciliation(write) {
      reconciliations.push({
        orderId: write.orderId,
        outcome: write.outcome,
        divergences: write.divergences,
        reason: write.reason,
      });
    },

    async attachVenueOrderId({ orderId, venueOrderId, now }) {
      const order = orders.get(orderId);
      if (!order) throw new Error(`No order ${orderId} in the memory store.`);
      const next: StoredOrder = { ...order, venueOrderId, updatedAt: new Date(now).toISOString() };
      orders.set(orderId, next);
      return next;
    },
  };

  return {
    store,
    orders,
    transitions,
    attempts,
    reconciliations,
    seed(order) {
      const seeded = makeOrder(order);
      orders.set(seeded.id, seeded);
      return seeded;
    },
  };
}

export type MemoryIdempotencyRow = {
  scope: string;
  key: string;
  fingerprint: string;
  status: string;
  resultJson: string;
  reason: string | null;
  orderId: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

export type MemoryIdempotencyStore = {
  store: IdempotencyStore;
  /** The reservation a replay and a completion can be inspected from. */
  read(input: { scope: IdempotencyScope; key: string }): IdempotencyReservation | null;
  rows: Map<string, MemoryIdempotencyRow>;
};

/**
 * The reservation store, with the unique constraint the real one relies on.
 *
 * The insert-only-then-read-the-winner behaviour above is the property the design
 * depends on, so the double has it too: a second reservation for the same key
 * never overwrites the first.
 */
export function createMemoryIdempotencyStore(): MemoryIdempotencyStore {
  const rows = new Map<string, MemoryIdempotencyRow>();
  const key = (scope: string, value: string) => `${scope}::${value}`;

  const store: IdempotencyStore = {
    async reserve({ scope, key: value, fingerprint, now }) {
      const existing = rows.get(key(scope, value));
      if (!existing) {
        rows.set(key(scope, value), {
          scope,
          key: value,
          fingerprint,
          status: "IN_PROGRESS",
          resultJson: "{}",
          reason: null,
          orderId: null,
          createdAt: new Date(now),
          completedAt: null,
        });
        return { kind: "reserved", recordId: key(scope, value) };
      }
      return interpretReservation(
        {
          id: key(scope, value),
          fingerprint: existing.fingerprint,
          status: existing.status,
          resultJson: existing.resultJson,
          createdAt: existing.createdAt,
          completedAt: existing.completedAt,
        },
        fingerprint,
      );
    },

    async complete({ scope, key: value, result, orderId, now }) {
      const row = rows.get(key(scope, value));
      if (!row) throw new Error(`No reservation ${scope} ${value}.`);
      row.status = "COMPLETED";
      row.resultJson = JSON.stringify(result ?? {});
      row.orderId = orderId ?? null;
      row.completedAt = new Date(now);
    },

    async release({ scope, key: value, reason, now }) {
      const row = rows.get(key(scope, value));
      if (!row) throw new Error(`No reservation ${scope} ${value}.`);
      row.status = "FAILED";
      row.reason = reason;
      row.completedAt = new Date(now);
    },
  };

  return {
    store,
    rows,
    read({ scope, key: value }) {
      const row = rows.get(key(scope, value));
      if (!row) return null;
      return interpretReservation(
        {
          id: key(scope, value),
          fingerprint: row.fingerprint,
          status: row.status,
          resultJson: row.resultJson,
          createdAt: row.createdAt,
          completedAt: row.completedAt,
        },
        row.fingerprint,
      );
    },
  };
}

export type ScriptedVenue = {
  port: OrderVenuePort;
  calls: { submit: number; lookup: number; cancel: number; idempotencyKeys: string[]; submitOrderIds: string[] };
};

/**
 * A venue whose answers are written in the test: each call takes the next scripted
 * answer, and the last one repeats. The call counters are what let a test prove a
 * refusal happened *before* the venue was contacted.
 */
export function createScriptedVenue(script: {
  submits?: readonly VenueSubmitOutcome[];
  lookups?: readonly VenueOrderReport[];
  cancels?: readonly VenueCancelOutcome[];
}): ScriptedVenue {
  const calls = { submit: 0, lookup: 0, cancel: 0, idempotencyKeys: [] as string[], submitOrderIds: [] as string[] };
  const at = <T>(list: readonly T[] | undefined, index: number, fallback: T): T =>
    list && list.length > 0 ? (list[Math.min(index, list.length - 1)] as T) : fallback;

  const port: OrderVenuePort = {
    id: "test-venue",
    paper: true,
    environment: "paper",
    async submit({ order, idempotencyKey }) {
      const index = calls.submit;
      calls.submit += 1;
      calls.idempotencyKeys.push(idempotencyKey);
      calls.submitOrderIds.push(order.id);
      return at(script.submits, index, {
        kind: "accepted",
        venueOrderId: `test-${order.id}`,
        reported: "OPEN",
        filledQuantity: "0",
        providerResponse: { test: true },
      });
    },
    async lookup() {
      const index = calls.lookup;
      calls.lookup += 1;
      return at(script.lookups, index, {
        state: "NOT_FOUND",
        reportedAt: new Date().toISOString(),
        reason: "The scripted venue holds no record of this order.",
      });
    },
    async cancel() {
      const index = calls.cancel;
      calls.cancel += 1;
      return at(script.cancels, index, {
        kind: "cancelled",
        report: { state: "CANCELLED", filledQuantity: "0", reportedAt: new Date().toISOString() },
      });
    },
  };
  return { port, calls };
}

/** A march of time: a clock a test can advance by hand. */
export function createTestClock(start = "2026-10-15T12:00:00.000Z") {
  let current = Date.parse(start);
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
      return new Date(current);
    },
  };
}
