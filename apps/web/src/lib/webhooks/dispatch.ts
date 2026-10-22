import { createHmac, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { redactString } from "@/lib/observability/logger";
import { webhookSecretFor } from "./subscriptions";

/**
 * Signed outbound delivery (phase 31).
 *
 * The receiver verifies the same way we verify an inbound signal: HMAC-SHA256 over
 * `${timestamp}.${rawBody}`, with the timestamp inside the signed material so a captured body
 * cannot be re-dated. Headers:
 *
 *   X-Veylora-Signature: sha256=<hex>
 *   X-Veylora-Timestamp: <ISO 8601>
 *   X-Veylora-Delivery:  <delivery id>
 *   X-Veylora-Event:     <event type>
 *
 * Each attempt is a row. A retry creates attempt N+1 against the same `deliveryKey` rather
 * than overwriting attempt N, so the panel can show "first failure at 10:00, second at
 * 10:00:30, still failing" instead of a status column that erases its own evidence. Backoff is
 * bounded: 30s, 120s, 600s and then no further attempt — a receiver that is down for an hour is
 * marked unhealthy and the owner is told, rather than the queue retrying forever.
 *
 * Neither the payload nor an error ever contains a secret: the secret exists only in the
 * signature header, and the error is the receiver's status or a redacted transport message.
 *
 * The storage calls sit behind `WebhookStore` for the same reason the order path has an
 * `OrderStore`: the retry rule (which attempt, when, and when to call an endpoint unhealthy) is
 * the interesting part, and a test must be able to prove it without a database or a receiver.
 */

export const WEBHOOK_MAX_ATTEMPTS = 4;
export const WEBHOOK_BACKOFF_SECONDS = [30, 120, 600] as const;
export const WEBHOOK_UNHEALTHY_AFTER_FAILURES = 3;
export const WEBHOOK_TIMEOUT_MS = 5_000;
export const WEBHOOK_USER_AGENT = "Veylora-Webhooks/1";

export type WebhookEventPayload = Record<string, unknown>;

export type WebhookDeliveryRow = {
  id: string;
  subscriptionId: string;
  userId: string;
  eventType: string;
  deliveryKey: string;
  attempt: number;
  payload: string;
};

export type WebhookSubscriptionState = {
  url: string;
  active: boolean;
  revoked: boolean;
  /** Opened for signing. Null means the sealed record could not be read. */
  secret: string | null;
};

export type WebhookAttemptUpdate = {
  status: "DELIVERED" | "FAILED";
  responseStatus: number | null;
  error: string | null;
  durationMs: number;
  attemptedAt: Date;
  nextAttemptAt: Date | null;
};

export type WebhookStore = {
  subscriptionsForEvent(userId: string, eventType: string): Promise<{ id: string }[]>;
  subscription(id: string): Promise<WebhookSubscriptionState | null>;
  createDelivery(input: {
    subscriptionId: string;
    userId: string;
    eventType: string;
    deliveryKey: string;
    attempt: number;
    payload: string;
  }): Promise<WebhookDeliveryRow>;
  updateDelivery(id: string, update: WebhookAttemptUpdate): Promise<void>;
  /** Clear the schedule on attempts a later attempt has superseded (a null due time never comes). */
  clearSchedule(deliveryKey: string): Promise<void>;
  recordSuccess(subscriptionId: string, at: Date): Promise<void>;
  /** Increment the failure counter and return the new value, or null when the row is gone. */
  recordFailure(subscriptionId: string, at: Date, error: string): Promise<number | null>;
  markUnhealthy(subscriptionId: string): Promise<void>;
  dueRetries(now: Date, limit: number): Promise<WebhookDeliveryRow[]>;
};

const DELIVERY_SELECT = {
  id: true,
  subscriptionId: true,
  userId: true,
  eventType: true,
  deliveryKey: true,
  attempt: true,
  payload: true,
} as const;

/** The real store. Only this section knows about Prisma. */
export function prismaWebhookStore(): WebhookStore {
  return {
    async subscriptionsForEvent(userId, eventType) {
      return prisma.webhookSubscription.findMany({
        where: { userId, eventType, active: true, revokedAt: null },
        select: { id: true },
      });
    },
    async subscription(id) {
      const row = await prisma.webhookSubscription.findUnique({
        where: { id },
        select: { url: true, active: true, revokedAt: true },
      });
      if (!row) return null;
      let secret: string | null = null;
      try {
        secret = await webhookSecretFor(id);
      } catch {
        secret = null;
      }
      return { url: row.url, active: row.active, revoked: Boolean(row.revokedAt), secret };
    },
    async createDelivery(input) {
      return prisma.webhookDelivery.create({
        data: { ...input, status: "PENDING" },
        select: DELIVERY_SELECT,
      });
    },
    async updateDelivery(id, update) {
      await prisma.webhookDelivery.update({ where: { id }, data: update });
    },
    async clearSchedule(deliveryKey) {
      await prisma.webhookDelivery.updateMany({ where: { deliveryKey }, data: { nextAttemptAt: null } });
    },
    async recordSuccess(subscriptionId, at) {
      await prisma.webhookSubscription.update({
        where: { id: subscriptionId },
        data: {
          health: "HEALTHY",
          consecutiveFailures: 0,
          lastAttemptAt: at,
          lastSuccessAt: at,
          lastError: null,
        },
      });
    },
    async recordFailure(subscriptionId, at, error) {
      const updated = await prisma.webhookSubscription
        .update({
          where: { id: subscriptionId },
          data: { lastAttemptAt: at, lastError: error, consecutiveFailures: { increment: 1 } },
          select: { consecutiveFailures: true },
        })
        .catch(() => null);
      return updated?.consecutiveFailures ?? null;
    },
    async markUnhealthy(subscriptionId) {
      await prisma.webhookSubscription.update({ where: { id: subscriptionId }, data: { health: "UNHEALTHY" } });
    },
    async dueRetries(now, limit) {
      return prisma.webhookDelivery.findMany({
        where: {
          status: "FAILED",
          attempt: { lt: WEBHOOK_MAX_ATTEMPTS },
          nextAttemptAt: { lte: now },
          subscription: { active: true, revokedAt: null },
        },
        orderBy: { nextAttemptAt: "asc" },
        take: limit,
        select: DELIVERY_SELECT,
      });
    },
  };
}

/** Seconds to wait after a failed attempt, before attempt+1. Bounded at the last step. */
export function webhookBackoffSeconds(attempt: number): number {
  const index = Math.min(Math.max(0, attempt - 1), WEBHOOK_BACKOFF_SECONDS.length - 1);
  return WEBHOOK_BACKOFF_SECONDS[index];
}

export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

function transportError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return `No answer within ${WEBHOOK_TIMEOUT_MS}ms.`;
    }
    return redactString(error.message).slice(0, 300);
  }
  return "The request failed before the receiver answered.";
}

async function recordResult(
  store: WebhookStore,
  row: WebhookDeliveryRow,
  update: WebhookAttemptUpdate,
  now: Date,
  terminal: boolean,
): Promise<void> {
  const retryable = update.status === "FAILED" && row.attempt < WEBHOOK_MAX_ATTEMPTS && !terminal;
  await store.updateDelivery(row.id, { ...update, nextAttemptAt: retryable ? update.nextAttemptAt : null });

  if (update.status === "DELIVERED") {
    await store.recordSuccess(row.subscriptionId, now);
    return;
  }
  const failures = await store.recordFailure(row.subscriptionId, now, update.error ?? "The delivery failed.");
  if (failures !== null && failures >= WEBHOOK_UNHEALTHY_AFTER_FAILURES) {
    await store.markUnhealthy(row.subscriptionId);
  }
}

/**
 * Send one delivery row.
 *
 * A revoked or paused endpoint, or one whose secret cannot be opened, is recorded as a failed
 * attempt with no retry: the reason is the endpoint's own state, and retrying cannot change it.
 */
async function attemptDelivery(
  store: WebhookStore,
  row: WebhookDeliveryRow,
  options: { now: Date; fetchImpl: typeof fetch },
): Promise<"delivered" | "failed"> {
  const subscription = await store.subscription(row.subscriptionId);
  if (!subscription || subscription.revoked || !subscription.active) {
    await recordResult(
      store,
      row,
      {
        status: "FAILED",
        responseStatus: null,
        error: "The endpoint is paused or revoked, so this delivery was not sent.",
        durationMs: 0,
        attemptedAt: options.now,
        nextAttemptAt: null,
      },
      options.now,
      true,
    );
    return "failed";
  }
  if (!subscription.secret) {
    await recordResult(
      store,
      row,
      {
        status: "FAILED",
        responseStatus: null,
        error: "The endpoint's signing secret could not be opened, so no signature was produced and nothing was sent.",
        durationMs: 0,
        attemptedAt: options.now,
        nextAttemptAt: null,
      },
      options.now,
      true,
    );
    return "failed";
  }

  const timestamp = options.now.toISOString();
  const startedAt = Date.now();
  const nextAttemptAt = new Date(options.now.getTime() + webhookBackoffSeconds(row.attempt) * 1_000);
  try {
    const response = await options.fetchImpl(subscription.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": WEBHOOK_USER_AGENT,
        "X-Veylora-Signature": `sha256=${webhookSignature(subscription.secret, timestamp, row.payload)}`,
        "X-Veylora-Timestamp": timestamp,
        "X-Veylora-Delivery": row.id,
        "X-Veylora-Event": row.eventType,
      },
      body: row.payload,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    const durationMs = Date.now() - startedAt;
    if (response.ok) {
      await recordResult(
        store,
        row,
        { status: "DELIVERED", responseStatus: response.status, error: null, durationMs, attemptedAt: options.now, nextAttemptAt: null },
        options.now,
        false,
      );
      return "delivered";
    }
    await recordResult(
      store,
      row,
      {
        status: "FAILED",
        responseStatus: response.status,
        error: `The receiver answered HTTP ${response.status}.`,
        durationMs,
        attemptedAt: options.now,
        nextAttemptAt,
      },
      options.now,
      false,
    );
    return "failed";
  } catch (error) {
    await recordResult(
      store,
      row,
      {
        status: "FAILED",
        responseStatus: null,
        error: transportError(error),
        durationMs: Date.now() - startedAt,
        attemptedAt: options.now,
        nextAttemptAt,
      },
      options.now,
      false,
    );
    return "failed";
  }
}

export type PublishResult = {
  eventType: string;
  queued: number;
  delivered: number;
  failed: number;
};

/**
 * Publish one event to every active endpoint subscribed to its type.
 *
 * The rows are written first and then attempted immediately, so a healthy receiver sees the
 * delivery in the same request that caused it, and a failing one already has a scheduled retry
 * when the response returns. An account with no subscriptions returns zeroes without writing
 * anything — which is also why this is safe to call from the strategy loop.
 */
export async function publishWebhookEvent(input: {
  userId: string;
  eventType: string;
  payload: WebhookEventPayload;
  now?: Date;
  fetchImpl?: typeof fetch;
  store?: WebhookStore;
}): Promise<PublishResult> {
  const store = input.store ?? prismaWebhookStore();
  const now = input.now ?? new Date();
  const subscriptions = await store.subscriptionsForEvent(input.userId, input.eventType);
  const result: PublishResult = { eventType: input.eventType, queued: 0, delivered: 0, failed: 0 };
  if (subscriptions.length === 0) return result;

  const body = JSON.stringify({
    type: input.eventType,
    createdAt: now.toISOString(),
    data: input.payload,
  });

  for (const subscription of subscriptions) {
    const row = await store.createDelivery({
      subscriptionId: subscription.id,
      userId: input.userId,
      eventType: input.eventType,
      deliveryKey: randomUUID(),
      attempt: 1,
      payload: body,
    });
    result.queued += 1;
    const outcome = await attemptDelivery(store, row, { now, fetchImpl: input.fetchImpl ?? fetch });
    if (outcome === "delivered") result.delivered += 1;
    else result.failed += 1;
  }
  return result;
}

export type RetryResult = {
  attempted: number;
  delivered: number;
  failed: number;
  exhausted: number;
  endpoints: number;
};

/**
 * The retry job: every failed attempt whose backoff has elapsed gets its next attempt.
 *
 * "Exhausted" is counted, not retried: a delivery that has used all four attempts is final and
 * its endpoint is already marked unhealthy by the third consecutive failure.
 */
export async function deliverPendingWebhooks(input: {
  now?: Date;
  limit?: number;
  fetchImpl?: typeof fetch;
  store?: WebhookStore;
} = {}): Promise<RetryResult> {
  const store = input.store ?? prismaWebhookStore();
  const now = input.now ?? new Date();
  const limit = Math.min(100, Math.max(1, input.limit ?? 25));
  const due = await store.dueRetries(now, limit);

  const result: RetryResult = { attempted: 0, delivered: 0, failed: 0, exhausted: 0, endpoints: 0 };
  const endpoints = new Set<string>();
  for (const previous of due) {
    endpoints.add(previous.subscriptionId);
    const next = await store
      .createDelivery({
        subscriptionId: previous.subscriptionId,
        userId: previous.userId,
        eventType: previous.eventType,
        deliveryKey: previous.deliveryKey,
        attempt: previous.attempt + 1,
        payload: previous.payload,
      })
      .catch(() => null);
    if (!next) {
      result.exhausted += 1;
      continue;
    }
    // The previous row has now been superseded: clearing its schedule is what stops the next
    // run from selecting it and re-deriving the same attempt number.
    await store.clearSchedule(previous.deliveryKey);
    result.attempted += 1;
    const outcome = await attemptDelivery(store, next, { now, fetchImpl: input.fetchImpl ?? fetch });
    if (outcome === "delivered") result.delivered += 1;
    else result.failed += 1;
  }
  result.endpoints = endpoints.size;
  return result;
}

export type WebhookDeliveryView = {
  id: string;
  subscriptionId: string;
  subscriptionLabel: string;
  eventType: string;
  deliveryKey: string;
  attempt: number;
  status: string;
  responseStatus: number | null;
  error: string | null;
  durationMs: number | null;
  attemptedAt: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
};

/** Recent attempts, grouped only by time: the panel shows each one. */
export async function listWebhookDeliveries(userId: string, limit = 30): Promise<WebhookDeliveryView[]> {
  const rows = await prisma.webhookDelivery.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: Math.min(100, Math.max(1, limit)),
    select: {
      id: true,
      subscriptionId: true,
      eventType: true,
      deliveryKey: true,
      attempt: true,
      status: true,
      responseStatus: true,
      error: true,
      durationMs: true,
      attemptedAt: true,
      nextAttemptAt: true,
      createdAt: true,
      subscription: { select: { label: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    subscriptionId: row.subscriptionId,
    subscriptionLabel: row.subscription.label,
    eventType: row.eventType,
    deliveryKey: row.deliveryKey,
    attempt: row.attempt,
    status: row.status,
    responseStatus: row.responseStatus,
    error: row.error,
    durationMs: row.durationMs,
    attemptedAt: row.attemptedAt?.toISOString() ?? null,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}
