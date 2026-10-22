import DecimalJS from "decimal.js";
import { prisma } from "@/lib/db";
import { formatAlertCondition, type MarketAlertCondition } from "@/lib/alerts/conditions";
import { readEmailConfiguration, sendEmailNotification, EMAIL_PROVIDER_ID } from "./email";
import { maskChatId, readTelegramConfiguration, sendTelegramNotification, TELEGRAM_PROVIDER_ID } from "./telegram";
import {
  notificationChannelViews,
  type NotificationChannel,
  type NotificationSettings,
} from "./settings";

const Decimal = DecimalJS.clone({ precision: 40 });

/**
 * Delivery (phase 29).
 *
 * One function decides whether a rule's crossing becomes a notification, on which channels,
 * and whether now is the moment. Everything it decides is written to `NotificationDelivery`
 * before the next step, so the log is the record of what happened rather than a summary
 * reconstructed afterwards.
 *
 * The guarantees, in order:
 *
 *  - **Dedup.** The key is (rule, condition, cooldown window). If any delivery row exists for
 *    that key, this crossing has already been announced and nothing is sent again. The unique
 *    index in the database is the same rule under a concurrent second evaluator.
 *  - **Channel independence.** A channel is skipped, with its own row naming why, when it is
 *    on but unconfigured or when it is switched off. One channel failing never stops another.
 *  - **Quiet hours.** Inside the owner's window the row is queued instead of sent; the queue
 *    is flushed by the next evaluation after the window closes.
 *  - **Bounded retries.** A retryable failure (429, 5xx, a network error) is tried at most
 *    three times with 250 ms and 1 s between attempts, and every attempt is its own row.
 */

export const MAX_DELIVERY_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = [250, 1_000] as const;
export const QUEUE_FLUSH_LIMIT = 50;
export const IN_APP_PROVIDER_ID = "in-app";

type Environment = Record<string, string | undefined>;

export type NotificationAlert = {
  id: string;
  userId: string;
  symbol: string;
  condition: MarketAlertCondition;
  threshold: string;
  cooldownMinutes: number;
};

export type NotificationDeliveryStatus = "SENT" | "FAILED" | "QUEUED" | "SKIPPED" | "SENDING";

export type NewDelivery = {
  userId: string;
  alertId: string;
  channel: NotificationChannel;
  target: string;
  subject: string;
  body: string;
  status: NotificationDeliveryStatus;
  providerId?: string | null;
  providerMessageId?: string | null;
  error?: string | null;
  attempt: number;
  durationMs?: number | null;
  dedupeKey: string;
  windowStart: Date;
  queuedAt?: Date | null;
  deliveredAt?: Date | null;
};

export type DeliveryRow = NewDelivery & { id: string };

export type DeliveryPatch = {
  status: NotificationDeliveryStatus;
  providerId?: string | null;
  providerMessageId?: string | null;
  error?: string | null;
  durationMs?: number | null;
  deliveredAt?: Date | null;
};

/**
 * The persistence the dispatcher needs, as an interface so the tests can prove dedupe,
 * queueing and retries without a database. The Prisma implementation is the only one that
 * runs in the application.
 */
export type NotificationStore = {
  findDelivery(dedupeKey: string): Promise<{ id: string } | null>;
  createDelivery(input: NewDelivery): Promise<{ id: string }>;
  listQueued(limit: number): Promise<DeliveryRow[]>;
  claimQueued(id: string): Promise<boolean>;
  updateDelivery(id: string, patch: DeliveryPatch): Promise<void>;
};

export const prismaNotificationStore: NotificationStore = {
  findDelivery: (dedupeKey) =>
    prisma.notificationDelivery.findFirst({ where: { dedupeKey }, select: { id: true } }),
  createDelivery: async (input) => {
    const row = await prisma.notificationDelivery.create({
      data: {
        userId: input.userId,
        alertId: input.alertId,
        channel: input.channel,
        target: input.target,
        subject: input.subject,
        body: input.body,
        status: input.status,
        providerId: input.providerId ?? null,
        providerMessageId: input.providerMessageId ?? null,
        error: input.error ?? null,
        attempt: input.attempt,
        durationMs: input.durationMs ?? null,
        dedupeKey: input.dedupeKey,
        windowStart: input.windowStart,
        queuedAt: input.queuedAt ?? null,
        deliveredAt: input.deliveredAt ?? null,
      },
      select: { id: true },
    });
    return row;
  },
  listQueued: async (limit) => {
    const rows = await prisma.notificationDelivery.findMany({
      where: { status: "QUEUED" },
      orderBy: { queuedAt: "asc" },
      take: limit,
    });
    return rows as unknown as DeliveryRow[];
  },
  claimQueued: async (id) => {
    const claimed = await prisma.notificationDelivery.updateMany({
      where: { id, status: "QUEUED" },
      data: { status: "SENDING" },
    });
    return claimed.count === 1;
  },
  updateDelivery: async (id, patch) => {
    await prisma.notificationDelivery.update({ where: { id }, data: patch });
  },
};

/** The cooldown bucket a crossing belongs to. The dedupe window, in one place. */
export function alertWindowStart(triggeredAt: Date, cooldownMinutes: number): Date {
  const windowMs = Math.max(1, Math.floor(cooldownMinutes)) * 60_000;
  return new Date(Math.floor(triggeredAt.getTime() / windowMs) * windowMs);
}

export function alertDedupeKey(alert: Pick<NotificationAlert, "id" | "condition">, windowStart: Date): string {
  return `${alert.id}:${alert.condition}:${windowStart.toISOString()}`;
}

/**
 * Quiet hours in UTC, inclusive of the start minute and exclusive of the end, and allowed to
 * wrap midnight (22:00 → 07:00). Start equal to end means "never quiet" rather than a
 * 24-hour silence nobody can escape.
 */
export function isWithinQuietHours(settings: NotificationSettings, now: Date): boolean {
  if (!settings.quietHoursEnabled) return false;
  const start = parseClock(settings.quietHoursStart);
  const end = parseClock(settings.quietHoursEnd);
  if (start === null || end === null || start === end) return false;
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

function parseClock(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function formatAlertSubject(alert: Pick<NotificationAlert, "symbol" | "condition" | "threshold">): string {
  return `${alert.symbol} · ${formatAlertCondition(alert.condition, alert.threshold)}`;
}

export function formatAlertBody(
  alert: Pick<NotificationAlert, "id" | "symbol" | "condition" | "threshold">,
  observedValue: string,
  triggeredAt: Date,
): string {
  const observed = new Decimal(observedValue);
  const value = observed.isFinite() ? observed.toDecimalPlaces(8).toFixed() : observedValue;
  return (
    `${alert.symbol} met "${formatAlertCondition(alert.condition, alert.threshold)}" ` +
    `at ${triggeredAt.toISOString()} with an observed value of ${value}. ` +
    `Alert ${alert.id}. This is an informational alert; no order is placed.`
  );
}

export type DispatchDeps = {
  settings: NotificationSettings;
  store?: NotificationStore;
  env?: Environment;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: Date;
};

export type ChannelOutcome = {
  channel: NotificationChannel;
  status: "SENT" | "FAILED" | "QUEUED" | "SKIPPED";
  attempts: number;
  providerMessageId: string | null;
  error: string | null;
};

export type DispatchSummary = {
  outcome: "SENT" | "QUEUED" | "FAILED" | "SKIPPED" | "DUPLICATE" | "DISABLED";
  dedupeKey: string;
  windowStart: string;
  quietHours: boolean;
  sent: number;
  queued: number;
  failed: number;
  skipped: number;
  channels: ChannelOutcome[];
};

type ChannelSendResult =
  | { ok: true; providerId: string; providerMessageId: string | null; durationMs: number }
  | { ok: false; providerId: string; error: string; retryable: boolean; durationMs: number };

export async function dispatchAlertNotification(
  input: { alert: NotificationAlert; observedValue: string; triggeredAt: Date },
  deps: DispatchDeps,
): Promise<DispatchSummary> {
  const store = deps.store ?? prismaNotificationStore;
  const now = deps.now ?? new Date();
  const windowStart = alertWindowStart(input.triggeredAt, input.alert.cooldownMinutes);
  const dedupeKey = alertDedupeKey(input.alert, windowStart);
  const subject = formatAlertSubject(input.alert);
  const body = formatAlertBody(input.alert, input.observedValue, input.triggeredAt);
  const quietHours = isWithinQuietHours(deps.settings, now);
  let duplicateOnly = false;

  const summary: DispatchSummary = {
    outcome: "SKIPPED",
    dedupeKey,
    windowStart: windowStart.toISOString(),
    quietHours,
    sent: 0,
    queued: 0,
    failed: 0,
    skipped: 0,
    channels: [],
  };

  const existing = await store.findDelivery(dedupeKey);
  if (existing) {
    summary.outcome = "DUPLICATE";
    return summary;
  }

  const views = notificationChannelViews(deps.settings, deps.env ?? process.env).filter((channel) => channel.enabled);
  if (views.length === 0) {
    summary.outcome = "DISABLED";
    return summary;
  }

  for (const channel of views) {
    const target = channelTarget(channel.id, deps.env ?? process.env);
    if (!channel.configured) {
      // The row is the explanation: this channel was on, and the variable named here is what
      // kept it from sending. Other channels still run.
      await store.createDelivery({
        userId: input.alert.userId,
        alertId: input.alert.id,
        channel: channel.id,
        target,
        subject,
        body,
        status: "SKIPPED",
        providerId: providerFor(channel.id),
        error: channel.message,
        attempt: 1,
        durationMs: 0,
        dedupeKey,
        windowStart,
      });
      summary.skipped += 1;
      summary.channels.push({ channel: channel.id, status: "SKIPPED", attempts: 0, providerMessageId: null, error: channel.message });
      continue;
    }

    if (quietHours) {
      await store.createDelivery({
        userId: input.alert.userId,
        alertId: input.alert.id,
        channel: channel.id,
        target,
        subject,
        body,
        status: "QUEUED",
        providerId: providerFor(channel.id),
        error: null,
        attempt: 1,
        durationMs: null,
        dedupeKey,
        windowStart,
        queuedAt: now,
      });
      summary.queued += 1;
      summary.channels.push({ channel: channel.id, status: "QUEUED", attempts: 0, providerMessageId: null, error: null });
      continue;
    }

    const delivered = await deliverWithRetries({
      alertId: input.alert.id,
      userId: input.alert.userId,
      channel: channel.id,
      target,
      subject,
      body,
      dedupeKey,
      windowStart,
    }, deps);
    summary.channels.push({
      channel: channel.id,
      status: delivered.status,
      attempts: delivered.attempts,
      providerMessageId: delivered.providerMessageId,
      error: delivered.error,
    });
    if (delivered.duplicate) duplicateOnly = true;
    else if (delivered.status === "SENT") summary.sent += 1;
    else summary.failed += 1;
  }

  summary.outcome = duplicateOnly
    ? "DUPLICATE"
    : summary.sent > 0
      ? "SENT"
      : summary.queued > 0
        ? "QUEUED"
        : summary.failed > 0
          ? "FAILED"
          : "SKIPPED";
  return summary;
}

type DeliveryContext = {
  alertId: string;
  userId: string;
  channel: NotificationChannel;
  target: string;
  subject: string;
  body: string;
  dedupeKey: string;
  windowStart: Date;
};

type Delivered = {
  status: "SENT" | "FAILED";
  attempts: number;
  providerMessageId: string | null;
  error: string | null;
  duplicate: boolean;
};

async function deliverWithRetries(
  context: DeliveryContext,
  deps: DispatchDeps,
  firstRowId?: string,
): Promise<Delivered> {
  const store = deps.store ?? prismaNotificationStore;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: string | null = null;
  let attempts = 0;

  for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    const result = await sendOnChannel(context.channel, context.subject, context.body, deps);
    const row: NewDelivery = {
      userId: context.userId,
      alertId: context.alertId,
      channel: context.channel,
      target: context.target,
      subject: context.subject,
      body: context.body,
      status: result.ok ? "SENT" : "FAILED",
      providerId: result.providerId,
      providerMessageId: result.ok ? result.providerMessageId : null,
      error: result.ok ? null : result.error,
      attempt,
      durationMs: result.durationMs,
      dedupeKey: context.dedupeKey,
      windowStart: context.windowStart,
      deliveredAt: result.ok ? new Date() : null,
    };

    try {
      if (attempt === 1 && firstRowId) {
        await store.updateDelivery(firstRowId, {
          status: row.status,
          providerId: row.providerId,
          providerMessageId: row.providerMessageId,
          error: row.error,
          durationMs: row.durationMs,
          deliveredAt: row.deliveredAt,
        });
      } else {
        await store.createDelivery(row);
      }
    } catch (error) {
      // Two evaluators that both believed they won the race: the unique index keeps one
      // notification, and the loser reports it instead of sending again.
      if (isUniqueViolation(error)) {
        return { status: "SENT", attempts: attempt, providerMessageId: null, error: null, duplicate: true };
      }
      throw error;
    }

    if (result.ok) {
      return { status: "SENT", attempts: attempt, providerMessageId: result.providerMessageId, error: null, duplicate: false };
    }
    lastError = result.error;
    if (!result.retryable || attempt === MAX_DELIVERY_ATTEMPTS) break;
    await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS.at(-1) ?? 0);
  }

  return { status: "FAILED", attempts, providerMessageId: null, error: lastError, duplicate: false };
}

async function sendOnChannel(
  channel: NotificationChannel,
  subject: string,
  body: string,
  deps: DispatchDeps,
): Promise<ChannelSendResult> {
  if (channel === "IN_APP") {
    // In-app delivery is the stored row itself, which the panel reads. There is no provider
    // to ask and nothing to retry.
    return { ok: true, providerId: IN_APP_PROVIDER_ID, providerMessageId: null, durationMs: 0 };
  }
  if (channel === "EMAIL") {
    return sendEmailNotification({ subject, text: body }, { env: deps.env, fetchImpl: deps.fetchImpl });
  }
  return sendTelegramNotification({ subject, text: body }, { env: deps.env, fetchImpl: deps.fetchImpl });
}

function providerFor(channel: NotificationChannel): string | null {
  if (channel === "EMAIL") return EMAIL_PROVIDER_ID;
  if (channel === "TELEGRAM") return TELEGRAM_PROVIDER_ID;
  return IN_APP_PROVIDER_ID;
}

function channelTarget(channel: NotificationChannel, env: Environment): string {
  if (channel === "EMAIL") return readEmailConfiguration(env).maskedTo ?? "email not configured";
  if (channel === "TELEGRAM") {
    const config = readTelegramConfiguration(env);
    return config.chatId ? `chat ${maskChatId(config.chatId)}` : "telegram chat not configured";
  }
  return "this account's alert panel";
}

export type QueueFlushSummary = {
  quietHours: boolean;
  delivered: number;
  failed: number;
  skipped: number;
};

/**
 * Deliver what quiet hours held back. Called at the start of each evaluation: if the window is
 * still open nothing is touched, and each queued row is claimed before sending so two
 * evaluators cannot deliver the same alert twice.
 */
export async function flushQueuedNotifications(deps: DispatchDeps): Promise<QueueFlushSummary> {
  const store = deps.store ?? prismaNotificationStore;
  const now = deps.now ?? new Date();
  const summary: QueueFlushSummary = {
    quietHours: isWithinQuietHours(deps.settings, now),
    delivered: 0,
    failed: 0,
    skipped: 0,
  };
  if (summary.quietHours) return summary;

  const queued = await store.listQueued(QUEUE_FLUSH_LIMIT);
  for (const row of queued) {
    if (!(await store.claimQueued(row.id))) {
      summary.skipped += 1;
      continue;
    }
    const delivered = await deliverWithRetries({
      alertId: row.alertId,
      userId: row.userId,
      channel: row.channel,
      target: row.target,
      subject: row.subject,
      body: row.body,
      dedupeKey: row.dedupeKey,
      windowStart: row.windowStart,
    }, deps, row.id);
    if (delivered.status === "SENT") summary.delivered += 1;
    else summary.failed += 1;
  }
  return summary;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}
