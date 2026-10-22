import { redactValue } from "@/lib/observability/logger";
import { loggerFor } from "@/lib/observability/request-context";
import { reason, serializeReason, type Reason, type SerializedReason } from "@/lib/observability/reason";
import {
  applyOrderTransition,
  IllegalOrderTransitionError,
  isTerminalOrderStatus,
  type OrderTransitionResult,
} from "@/lib/orders/state-machine";
import {
  deriveClientOrderId,
  deriveIdempotencyKey,
  deriveOperationKey,
  fingerprintIntent,
  IDEMPOTENCY_SCOPES,
  idempotencyStore,
  type IdempotencyStore,
  type OrderIntent,
} from "@/lib/orders/idempotency";
import {
  DEFAULT_ORDER_RETRY_POLICY,
  decideRetry,
  describeRetryPolicy,
  reasonForAttemptOutcome,
  type AttemptOutcome,
  type OrderRetryPolicy,
} from "@/lib/orders/retry";
import { planVenueCorrection } from "@/lib/orders/reconcile";
import { DEFAULT_ORDER_ORIGIN, type OrderOrigin } from "@/lib/orders/origin";
import { orderStore, OrderStateConflictError, type OrderStore, type StoredOrder } from "@/lib/orders/store";
import type { OrderVenuePort, VenueOrderReport } from "@/lib/orders/venue";
import {
  resolveOrderVenue,
  resolveVenueForOrder as registryResolveVenueForOrder,
  type OrderVenueResolution,
} from "@/lib/venues/registry";

/**
 * The two operations that move an order: submit and cancel.
 *
 * This is where the pure pieces meet the world, and the order of the steps *is*
 * the design:
 *
 *  1. **The idempotency reservation is taken first.** Two identical requests
 *     cannot both proceed; the loser is told the work is in flight, and a
 *     finished one is replayed rather than repeated. This is the only thing
 *     standing between a retried money operation and a second order, so it is
 *     step one and not an afterthought.
 *  2. **The transition is decided before any side effect.** `applyOrderTransition`
 *     throws on an illegal move and is called before the venue is contacted and
 *     before anything is written, so a refused transition cannot half-happen — a
 *     terminal order is refused with zero side effects, which a test asserts by
 *     counting the calls the injected venue never received.
 *  3. **The venue's answer decides what is written.** A timeout is not a
 *     rejection: the order may be live at the venue, so it is *looked up* rather
 *     than resent on faith, and a submission that cannot be resolved stays live
 *     for reconciliation instead of being failed by guesswork.
 *  4. **Every attempt is recorded** with its reason and the venue's own answer
 *     (redacted), and every transition is audited with the actor, the previous
 *     state, the next state and the reason.
 *
 * Retries are bounded and always carry the same idempotency key, so a retried
 * money operation resolves to the same venue order instead of a second one.
 */

export type OrderProcessDeps = {
  store?: OrderStore;
  /**
   * The venue to use, stated directly. Tests use this; the routes do not, because the
   * venue is a decision about the account and the admin switch, not a request field.
   */
  venue?: OrderVenuePort;
  /**
   * How the venue is chosen when it is not stated (phase 21). Defaults to the registry's
   * resolution, which reads the admin switches and the account's own key.
   */
  resolveVenue?: (userId: string) => Promise<OrderVenueResolution>;
  /**
   * How the venue of an **existing** order is chosen (phase 22). Defaults to the registry's
   * per-order resolution, which reads that order's own venue and ignores the switches —
   * so a cancel still reaches an order whose venue the owner has since switched off.
   */
  resolveVenueForOrder?: (userId: string, venueId: string) => Promise<OrderVenueResolution>;
  idempotency?: IdempotencyStore;
  now?: () => Date;
  policy?: OrderRetryPolicy;
  /** Injected so a test does not wait out the backoff. */
  sleep?: (ms: number) => Promise<void>;
};

export type OrderProcessKind = "submitted" | "replayed" | "in-flight" | "refused" | "failed" | "unresolved" | "cancelled";

export type OrderProcessOutcome = {
  kind: OrderProcessKind;
  order: StoredOrder | null;
  attempts: number;
  idempotencyKey: string;
  /** Always present: no outcome of an order operation is allowed to be silent. */
  reason: SerializedReason;
  /** The HTTP status the route answers with. */
  status: number;
};

type ResolvedDeps = {
  store: OrderStore;
  venue: OrderVenuePort | null;
  resolveVenue: (userId: string) => Promise<OrderVenueResolution>;
  resolveVenueForOrder: (userId: string, venueId: string) => Promise<OrderVenueResolution>;
  idempotency: IdempotencyStore;
  clock: () => Date;
  policy: OrderRetryPolicy;
  sleep: (ms: number) => Promise<void>;
};

function depsWithDefaults(deps: OrderProcessDeps): ResolvedDeps {
  const policy = deps.policy ?? DEFAULT_ORDER_RETRY_POLICY;
  return {
    store: deps.store ?? orderStore(),
    venue: deps.venue ?? null,
    resolveVenue: deps.resolveVenue ?? ((userId: string) => resolveOrderVenue(userId)),
    resolveVenueForOrder:
      deps.resolveVenueForOrder ?? ((userId: string, venueId: string) => registryResolveVenueForOrder(userId, venueId)),
    idempotency: deps.idempotency ?? idempotencyStore(),
    clock: deps.now ?? (() => new Date()),
    policy,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
  };
}

/**
 * The venue for one operation, or the refusal to answer with.
 *
 * A venue stated directly by the caller is used as-is (that is the test seam and the
 * route's explicit choice); otherwise the registry decides from the admin switch and the
 * account's key. A refusal is answered *before* an order row or a reservation exists, so
 * "testnet routing is on but this account has no testnet key" leaves nothing behind.
 */
async function chooseVenue(
  deps: ResolvedDeps,
  userId: string,
  orderVenueId?: string,
): Promise<{ kind: "venue"; venue: OrderVenuePort; source: "paper" | "testnet" | "live" } | { kind: "refused"; status: number; code: string; error: string }> {
  if (deps.venue) return { kind: "venue", venue: deps.venue, source: deps.venue.environment };
  // An order that already exists is sent to the venue it names, not to whatever routing
  // currently selects: cancelling is not placing, and the owner switching live execution
  // off must not stop them closing what is open.
  const resolution = orderVenueId ? await deps.resolveVenueForOrder(userId, orderVenueId) : await deps.resolveVenue(userId);
  if (resolution.kind === "refused") {
    return { kind: "refused", status: resolution.status, code: resolution.code, error: resolution.error };
  }
  return { kind: "venue", venue: resolution.venue, source: resolution.source };
}

/** A provider payload, redacted before it is stored anywhere. */
function providerJson(value: unknown): string {
  return JSON.stringify(redactValue(value) ?? {});
}

/** Apply the transitions a plan produced, then write what the pass found. */
async function applyPlan(input: {
  order: StoredOrder;
  plan: ReturnType<typeof planVenueCorrection>;
  store: OrderStore;
  actorUserId: string | null;
  clock: () => Date;
  venueId: string;
  report: VenueOrderReport;
}): Promise<StoredOrder> {
  let current = input.order;
  for (const transition of input.plan.transitions) {
    current = await input.store.applyTransition({
      orderId: current.id,
      actorUserId: input.actorUserId,
      result: transition,
      now: input.clock().getTime(),
    });
  }
  if (input.plan.divergences.length > 0) {
    await input.store.recordReconciliation({
      orderId: current.id,
      actorUserId: input.actorUserId,
      outcome: input.plan.transitions.length > 0 ? "CORRECTED" : "DIVERGENCE",
      divergences: input.plan.divergences,
      reason: input.plan.reason.message,
      detail: {
        venue: input.venueId,
        venueState: input.report.state,
        venueFilledQuantity: input.report.filledQuantity ?? "0",
        localStatus: input.order.status,
        localFilledQuantity: input.order.filledQuantity,
        appliedEvents: input.plan.transitions.map((transition) => transition.event),
        providerResponse: input.report.providerResponse ?? null,
      },
      now: input.clock().getTime(),
    });
  }
  return current;
}

/** The sentence that explains what one submission attempt produced. */
function attemptReason(input: { venueId: string; attempt: number; outcome: AttemptOutcome; detail?: string }): string {
  const prefix = `Attempt ${input.attempt}: `;
  if (input.outcome === "accepted") return `${prefix}${input.venueId} accepted the order.`;
  if (input.outcome === "rejected") return `${prefix}${input.venueId} refused the order. ${input.detail ?? ""}`.trim();
  return `${prefix}${input.venueId} did not answer definitively. ${input.detail ?? ""}`.trim();
}

export type SubmitOrderInput = {
  intent: OrderIntent;
  actorUserId: string | null;
  /** A sentence from the caller about where the intent came from. */
  sourceNote?: string;
  /**
   * Which path submitted the order, recorded on the row. Defaults to `manual`, so a
   * caller that has not been taught the parameter produces the owner's own origin
   * rather than an unlabelled row.
   */
  origin?: OrderOrigin;
};

/**
 * Submit an order: reserve, create, decide, send, then record what the venue said.
 *
 * The retry loop below never sends without the key it reserved in step one, and
 * never treats a missing answer as a refusal.
 */
export async function submitOrder(input: SubmitOrderInput, deps: OrderProcessDeps = {}): Promise<OrderProcessOutcome> {
  const resolved = depsWithDefaults(deps);
  const { store, idempotency, clock, policy, sleep } = resolved;
  const logger = loggerFor("/api/trading/orders");
  const key = deriveIdempotencyKey(input.intent);
  const clientOrderId = deriveClientOrderId(key);

  // The venue is decided first: no reservation, no row and no signature when routing
  // itself refuses the order.
  const chosen = await chooseVenue(resolved, input.intent.userId);
  if (chosen.kind === "refused") {
    logger.warn("order routing refused the submission", { code: chosen.code, status: chosen.status });
    return {
      kind: "refused",
      order: null,
      attempts: 0,
      idempotencyKey: key,
      reason: serializeReason(
        reason(chosen.code === "READ_ONLY_CREDENTIAL" ? "INVALID_CREDENTIAL" : "MISSING_CONFIGURATION", {
          message: chosen.error,
          detail: `The venue was not asked: ${chosen.code}.`,
        }),
      ),
      status: chosen.status,
    };
  }
  const venue = chosen.venue;

  const reservation = await idempotency.reserve({
    scope: IDEMPOTENCY_SCOPES.submitOrder,
    key,
    fingerprint: fingerprintIntent(input.intent),
    actorUserId: input.actorUserId,
    now: clock().getTime(),
  });

  if (reservation.kind === "conflict") {
    return { kind: "refused", order: null, attempts: 0, idempotencyKey: key, reason: serializeReason(reservation.reason), status: 409 };
  }

  if (reservation.kind === "replay") {
    const existing = await store.findOrderByClientOrderId(clientOrderId);
    return {
      kind: "replayed",
      order: existing,
      attempts: existing?.attempts ?? 0,
      idempotencyKey: key,
      reason: serializeReason(
        reason("ALREADY_COMPLETED", {
          message:
            "This exact intent was already submitted, so the original order was returned instead of a second one being placed.",
          detail: existing ? `That order is ${existing.status}.` : undefined,
        }),
      ),
      status: 200,
    };
  }

  if (reservation.kind === "in-flight") {
    return {
      kind: "in-flight",
      order: null,
      attempts: 0,
      idempotencyKey: key,
      reason: serializeReason(
        reason("ALREADY_RUNNING", {
          message: "An identical submission is still in flight, so no second order was created.",
          detail: `The reservation started at ${reservation.startedAt}.`,
        }),
      ),
      status: 202,
    };
  }

  let order = await store.createOrder({
    userId: input.intent.userId,
    venue: venue.id,
    market: input.intent.market,
    side: input.intent.side,
    orderType: input.intent.orderType,
    origin: input.origin ?? DEFAULT_ORDER_ORIGIN,
    requestedQuantity: input.intent.quantity,
    clientOrderId,
    idempotencyKey: key,
    limitPrice: input.intent.limitPrice ?? null,
    stopLossPrice: input.intent.stopLossPrice ?? "0",
    notionalUsdCents: input.intent.notionalUsdCents,
    verifiedBalanceCents: input.intent.verifiedBalanceCents,
    actorUserId: input.actorUserId,
    reason: input.sourceNote ?? "The order intent was recorded locally.",
    now: clock().getTime(),
  });

  // Decided before the venue is contacted: an illegal move is refused here, with
  // nothing sent, nothing written and the reservation given back.
  let submitDecision: OrderTransitionResult;
  try {
    submitDecision = applyOrderTransition(
      order,
      { event: "SUBMIT", reason: `Attempt 1 of ${policy.maxAttempts} was sent to ${venue.id}.`, source: "local" },
      clock(),
    );
  } catch (error) {
    await idempotency.release({ scope: IDEMPOTENCY_SCOPES.submitOrder, key, reason: messageOf(error), now: clock().getTime() });
    throw error;
  }

  let attempt = 0;
  let lastReason: Reason = reasonForAttemptOutcome("unavailable");

  while (true) {
    attempt += 1;
    if (attempt === 1) {
      // The order is recorded as sent exactly once: a retry is the same
      // submission under the same key, not a new transition.
      order = await store.applyTransition({
        orderId: order.id,
        actorUserId: input.actorUserId,
        result: submitDecision,
        now: clock().getTime(),
      });
    }

    const outcome = await venue.submit({ order, idempotencyKey: key, attempt });
    const attemptKind: AttemptOutcome =
      outcome.kind === "accepted" ? "accepted" : outcome.kind === "rejected" ? "rejected" : outcome.kind === "timeout" ? "timeout" : "unavailable";
    const detail =
      outcome.kind === "accepted"
        ? `It is ${outcome.reported}.`
        : outcome.kind === "rejected"
          ? outcome.reason
          : outcome.reason;

    await store.recordAttempt({
      orderId: order.id,
      actorUserId: input.actorUserId,
      attempt,
      outcome: attemptKind,
      reasonCode: reasonForAttemptOutcome(attemptKind).code,
      reason: attemptReason({ venueId: venue.id, attempt, outcome: attemptKind, detail }),
      providerResponseJson: providerJson("providerResponse" in outcome ? outcome.providerResponse : undefined),
      at: clock().toISOString(),
      now: clock().getTime(),
    });

    if (outcome.kind === "accepted") {
      order = await store.attachVenueOrderId({ orderId: order.id, venueOrderId: outcome.venueOrderId, now: clock().getTime() });
      const report: VenueOrderReport = {
        state: outcome.reported,
        venueOrderId: outcome.venueOrderId,
        filledQuantity: outcome.filledQuantity,
        reason: `${venue.id} accepted the order as ${outcome.venueOrderId} and reports it ${outcome.reported}.`,
        reportedAt: clock().toISOString(),
        providerResponse: outcome.providerResponse,
      };
      const plan = planVenueCorrection(order, report, { source: "venue", now: clock() });
      order = await applyPlan({ order, plan, store, actorUserId: input.actorUserId, clock, venueId: venue.id, report });
      await idempotency.complete({
        scope: IDEMPOTENCY_SCOPES.submitOrder,
        key,
        result: { orderId: order.id, status: order.status },
        orderId: order.id,
        now: clock().getTime(),
      });
      logger.info("order accepted by the venue", {
        orderId: order.id,
        venue: venue.id,
        attempts: attempt,
        status: order.status,
        idempotencyKey: key,
      });
      return {
        kind: "submitted",
        order,
        attempts: attempt,
        idempotencyKey: key,
        reason: serializeReason(
          reason("NO_ENTRY_CONDITION", {
            message: `${venue.id} accepted the order as ${outcome.venueOrderId}, and it is ${order.status}.`,
            retryable: true,
          }),
        ),
        status: 201,
      };
    }

    if (outcome.kind === "timeout") {
      // The venue may hold the order, so the truth is looked up rather than
      // assumed. This is exactly why a timeout is not a failure.
      const looked = await venue.lookup({ order });
      if (looked.state !== "NOT_FOUND" && looked.state !== "UNKNOWN") {
        // The lookup is how the venue id is learned when the submission's own answer was
        // lost: recording it now is what lets a later cancel or reconcile address the
        // order by the venue's id instead of searching for it again.
        if (!order.venueOrderId && looked.venueOrderId) {
          order = await store.attachVenueOrderId({ orderId: order.id, venueOrderId: looked.venueOrderId, now: clock().getTime() });
        }
        const plan = planVenueCorrection(order, looked, { source: "venue", now: clock() });
        order = await applyPlan({ order, plan, store, actorUserId: input.actorUserId, clock, venueId: venue.id, report: looked });
        await idempotency.complete({
          scope: IDEMPOTENCY_SCOPES.submitOrder,
          key,
          result: { orderId: order.id, status: order.status },
          orderId: order.id,
          now: clock().getTime(),
        });
        logger.warn("submission timed out but the venue holds the order", { orderId: order.id, venue: venue.id, state: looked.state });
        return {
          kind: "submitted",
          order,
          attempts: attempt,
          idempotencyKey: key,
          reason: serializeReason(
            reason("VENUE_UNAVAILABLE", {
              message: `The submission timed out, but ${venue.id} holds the order as ${looked.state}, so it was not sent again.`,
              detail: looked.reason,
              retryable: true,
            }),
          ),
          status: 201,
        };
      }
      if (looked.state === "UNKNOWN") {
        // No answer and no readable record. The order stays live and unresolved,
        // which reconciliation can resolve; failing it would invent a refusal
        // that nothing established.
        await idempotency.complete({
          scope: IDEMPOTENCY_SCOPES.submitOrder,
          key,
          result: { orderId: order.id, status: order.status },
          orderId: order.id,
          now: clock().getTime(),
        });
        return {
          kind: "unresolved",
          order,
          attempts: attempt,
          idempotencyKey: key,
          reason: serializeReason(
            reason("VENUE_UNAVAILABLE", {
              message: `The submission timed out and ${venue.id} could not say whether it holds the order, so it was left live for reconciliation.`,
              detail: looked.reason,
              retryable: true,
            }),
          ),
          status: 202,
        };
      }
      lastReason = reasonForAttemptOutcome("not-found", {
        detail: looked.reason ?? `${venue.id} holds no record of the order yet.`,
        providerId: venue.id,
      });
    } else if (outcome.kind === "rejected") {
      lastReason = reason("ORDER_REJECTED", { message: outcome.reason, detail: `The venue answered ${outcome.code}.`, providerId: venue.id });
    } else {
      lastReason = reason("VENUE_UNAVAILABLE", { message: outcome.reason, providerId: venue.id });
    }

    const retry = decideRetry({ attempt, outcome: attemptKind, status: order.status, policy });
    if (!retry.retry) {
      order = await store.applyTransition({
        orderId: order.id,
        actorUserId: input.actorUserId,
        result: applyOrderTransition(
          order,
          {
            event: "FAIL",
            reason: `${lastReason.message} ${retry.reason}`.trim(),
            source: "local",
          },
          clock(),
        ),
        now: clock().getTime(),
      });
      await idempotency.complete({
        scope: IDEMPOTENCY_SCOPES.submitOrder,
        key,
        result: { orderId: order.id, status: order.status },
        orderId: order.id,
        now: clock().getTime(),
      });
      logger.warn("order failed", {
        orderId: order.id,
        venue: venue.id,
        attempts: attempt,
        reason: lastReason.code,
        message: lastReason.message,
      });
      return { kind: "failed", order, attempts: attempt, idempotencyKey: key, reason: serializeReason(lastReason), status: 502 };
    }

    await sleep(retry.delayMs);
  }
}

export type CancelOrderInput = {
  orderId: string;
  actorUserId: string | null;
  reason: string;
  clientKey?: string | null;
};

/**
 * Cancel an order: decide first, ask the venue, then write what the venue confirmed.
 *
 * The write happens *after* the venue answers on purpose. An unconfirmed cancel
 * leaves the order live, because claiming a cancel the venue never confirmed is a
 * lie the next reconciliation would have to undo — and an order that is reported
 * cancelled but had already executed part of its quantity keeps that part as an
 * executed trade, applied before the cancel so nothing is silently dropped.
 */
export async function cancelOrder(input: CancelOrderInput, deps: OrderProcessDeps = {}): Promise<OrderProcessOutcome> {
  const resolved = depsWithDefaults(deps);
  const { store, idempotency, clock } = resolved;
  const logger = loggerFor("/api/trading/orders");
  const key = deriveOperationKey({
    scope: IDEMPOTENCY_SCOPES.cancelOrder,
    parts: [input.orderId, input.reason.trim()],
    clientKey: input.clientKey ?? null,
  });

  const reservation = await idempotency.reserve({
    scope: IDEMPOTENCY_SCOPES.cancelOrder,
    key,
    fingerprint: key,
    actorUserId: input.actorUserId,
    now: clock().getTime(),
  });
  if (reservation.kind === "conflict") {
    return { kind: "refused", order: null, attempts: 0, idempotencyKey: key, reason: serializeReason(reservation.reason), status: 409 };
  }
  if (reservation.kind === "in-flight") {
    return {
      kind: "in-flight",
      order: null,
      attempts: 0,
      idempotencyKey: key,
      reason: serializeReason(
        reason("ALREADY_RUNNING", {
          message: "An identical cancel is still in flight, so no second cancel was sent.",
        }),
      ),
      status: 202,
    };
  }
  if (reservation.kind === "replay") {
    const existing = await store.findOrderById(input.orderId);
    return {
      kind: "replayed",
      order: existing,
      attempts: existing?.attempts ?? 0,
      idempotencyKey: key,
      reason: serializeReason(
        reason("ALREADY_COMPLETED", { message: "This cancel was already applied, so its original result was returned." }),
      ),
      status: 200,
    };
  }

  const order = await store.findOrderById(input.orderId);
  if (!order) {
    await idempotency.release({ scope: IDEMPOTENCY_SCOPES.cancelOrder, key, reason: "No such order.", now: clock().getTime() });
    return {
      kind: "refused",
      order: null,
      attempts: 0,
      idempotencyKey: key,
      reason: serializeReason(reason("UNKNOWN", { message: `No order exists with id ${input.orderId}.` })),
      status: 404,
    };
  }

  // The cancel goes where the order went: the venue is resolved from the order's own row
  // and its own owner, not for whoever is calling, so a cancel can never be sent to a
  // different account's key — nor to whatever venue routing would pick today.
  const chosen = await chooseVenue(resolved, order.userId, order.venue);
  if (chosen.kind === "refused") {
    await idempotency.release({ scope: IDEMPOTENCY_SCOPES.cancelOrder, key, reason: chosen.error, now: clock().getTime() });
    return {
      kind: "refused",
      order,
      attempts: order.attempts,
      idempotencyKey: key,
      reason: serializeReason(
        reason(chosen.code === "READ_ONLY_CREDENTIAL" ? "INVALID_CREDENTIAL" : "MISSING_CONFIGURATION", {
          message: chosen.error,
          detail: `The venue was not asked: ${chosen.code}.`,
        }),
      ),
      status: chosen.status,
    };
  }
  const venue = chosen.venue;

  // Decided before the venue is contacted and before anything is written.
  try {
    applyOrderTransition(order, { event: "CANCEL", reason: input.reason, source: "local" }, clock());
  } catch (error) {
    const failure =
      error instanceof IllegalOrderTransitionError
        ? reason("ORDER_REJECTED", { message: error.message, retryable: false })
        : reason("UNKNOWN", { message: messageOf(error) });
    await idempotency.release({ scope: IDEMPOTENCY_SCOPES.cancelOrder, key, reason: failure.message, now: clock().getTime() });
    return { kind: "refused", order, attempts: order.attempts, idempotencyKey: key, reason: serializeReason(failure), status: 409 };
  }

  const outcome = await venue.cancel({ order, reason: input.reason });

  if (outcome.kind === "unavailable" || outcome.kind === "timeout") {
    await store.recordAttempt({
      orderId: order.id,
      actorUserId: input.actorUserId,
      attempt: Math.max(1, order.attempts),
      outcome: outcome.kind,
      reasonCode: "VENUE_UNAVAILABLE",
      reason: `The cancel was not confirmed: ${outcome.reason}`,
      providerResponseJson: providerJson({ cancel: outcome.kind, reason: outcome.reason }),
      at: clock().toISOString(),
      now: clock().getTime(),
    });
    await idempotency.release({ scope: IDEMPOTENCY_SCOPES.cancelOrder, key, reason: outcome.reason, now: clock().getTime() });
    logger.warn("cancel not confirmed", { orderId: order.id, venue: venue.id, reason: outcome.reason });
    return {
      kind: "unresolved",
      order,
      attempts: order.attempts,
      idempotencyKey: key,
      reason: serializeReason(
        reason("VENUE_UNAVAILABLE", {
          message: `The cancel was not confirmed by ${venue.id}, so the order was left live rather than reported as cancelled.`,
          detail: outcome.reason,
          retryable: true,
        }),
      ),
      status: 202,
    };
  }

  if (outcome.kind === "refused") {
    // A refusal that carries the venue's own record is applied: an order the
    // venue reports filled was filled, and that is the truth to record.
    let current = order;
    const report = outcome.report;
    if (report && report.state !== "UNKNOWN" && report.state !== "NOT_FOUND") {
      const plan = planVenueCorrection(current, report, { source: "venue", now: clock() });
      if (plan.divergences.length > 0 || plan.transitions.length > 0) {
        current = await applyPlan({ order: current, plan, store, actorUserId: input.actorUserId, clock, venueId: venue.id, report });
      }
    }
    await idempotency.complete({
      scope: IDEMPOTENCY_SCOPES.cancelOrder,
      key,
      result: { orderId: current.id, status: current.status },
      orderId: current.id,
      now: clock().getTime(),
    });
    return {
      kind: "refused",
      order: current,
      attempts: current.attempts,
      idempotencyKey: key,
      reason: serializeReason(
        reason("ORDER_REJECTED", {
          message: outcome.reason,
          detail: `The order is ${current.status} locally, which is the venue's record.`,
          retryable: false,
        }),
      ),
      status: 409,
    };
  }

  // Confirmed cancelled. The venue's executed quantity is applied first (as a
  // fill, an execution), and only then is the cancel written — so a partially
  // filled order keeps its filled portion instead of losing it to a status.
  let current = order;
  const report = outcome.report;
  if (report && Number(report.filledQuantity ?? "0") > Number(current.filledQuantity)) {
    const plan = planVenueCorrection(
      current,
      { ...report, state: Number(report.filledQuantity) >= Number(current.requestedQuantity) ? "FILLED" : "PARTIALLY_FILLED" },
      { source: "venue", now: clock() },
    );
    if (plan.transitions.length > 0) {
      current = await applyPlan({ order: current, plan, store, actorUserId: input.actorUserId, clock, venueId: venue.id, report });
    }
  }

  let cancelled = current;
  if (!isTerminalOrderStatus(current.status)) {
    cancelled = await store.applyTransition({
      orderId: current.id,
      actorUserId: input.actorUserId,
      result: applyOrderTransition(current, { event: "CANCEL", reason: input.reason, source: "local" }, clock()),
      now: clock().getTime(),
    });
  }

  await idempotency.complete({
    scope: IDEMPOTENCY_SCOPES.cancelOrder,
    key,
    result: { orderId: cancelled.id, status: cancelled.status },
    orderId: cancelled.id,
    now: clock().getTime(),
  });
  logger.info("order cancelled", { orderId: cancelled.id, venue: venue.id, filledQuantity: cancelled.filledQuantity });

  const filledPart = Number(cancelled.filledQuantity);
  if (cancelled.status !== "CANCELLED") {
    // The venue confirmed a cancel, but applying its executed quantity had
    // already closed the order (a fully executed order has nothing to cancel).
    // Reported as a refusal, because "cancelled" would be the wrong word for it.
    return {
      kind: "refused",
      order: cancelled,
      attempts: cancelled.attempts,
      idempotencyKey: key,
      reason: serializeReason(
        reason("ORDER_REJECTED", {
          message: `${venue.id} confirmed the cancel, but the order had already executed in full, so it is ${cancelled.status} and the executed part stands.`,
          retryable: false,
        }),
      ),
      status: 409,
    };
  }
  return {
    kind: "cancelled",
    order: cancelled,
    attempts: cancelled.attempts,
    idempotencyKey: key,
    reason: serializeReason(
      reason("ALREADY_COMPLETED", {
        message:
          filledPart > 0
            ? `The order was cancelled with ${cancelled.filledQuantity} of ${cancelled.requestedQuantity} already executed; the executed part is kept as a trade.`
            : "The order was cancelled before anything executed.",
        retryable: false,
        detail: `Requested ${cancelled.requestedQuantity}, filled ${cancelled.filledQuantity}, cancelled ${cancelled.remainingQuantity} unexecuted.`,
      }),
    ),
    status: 200,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

export function isOrderStateConflict(error: unknown): boolean {
  return error instanceof OrderStateConflictError;
}

/** The delay the policy uses between attempts, for a UI sentence. */
export function describeOrderRetryPolicy(policy: OrderRetryPolicy = DEFAULT_ORDER_RETRY_POLICY): string {
  return describeRetryPolicy(policy);
}
