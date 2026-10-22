import DecimalJS from "decimal.js";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { coinbaseMarketData } from "@/lib/market-data/coinbase-service";
import { calculateRsi } from "@/lib/market-data/indicators";
import { describeMarketDataFailure, type MarketDataResult, type MarketQuote } from "@/lib/market-data/provider";
import { reason, serializeReason, type Reason, type ReasonCode, type SerializedReason } from "@/lib/observability/reason";
import { PROVIDER_IDS } from "@/lib/observability/provider-call";
import {
  doesAlertTrigger,
  MARKET_ALERT_CONDITIONS,
  type MarketAlertCondition,
} from "@/lib/alerts/conditions";
import { formatMarketAlertInterval, getEffectiveMarketAlertIntervalMinutes } from "@/lib/alerts/scheduler-config";
import {
  alertWindowStart,
  dispatchAlertNotification,
  flushQueuedNotifications,
  type QueueFlushSummary,
} from "@/lib/notifications/dispatch";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  getNotificationSettings,
  type NotificationSettings,
} from "@/lib/notifications/settings";
import { publishWebhookEvent } from "@/lib/webhooks/dispatch";
import { auditCreate } from "@/lib/audit/record";

const Decimal = DecimalJS.clone({ precision: 40 });
const RSI_PERIOD = 14;
const RSI_INTERVAL_MS = 15 * 60_000;
const RSI_MAX_AGE_MS = RSI_INTERVAL_MS * 2;

export const MAX_MARKET_ALERTS_PER_RUN = 250;

type ActiveAlert = {
  id: string;
  userId: string;
  symbol: string;
  condition: string;
  threshold: string;
  cooldownMinutes: number;
  conditionMet: boolean;
  triggeredAt: Date | null;
};

type Observation = { value: string; observedAt: Date };
type EvaluationErrorCode = "PUBLIC_FEED_UNAVAILABLE" | "QUOTE_NOT_FRESH" | "INDICATOR_UNAVAILABLE" | "INVALID_ALERT";
type ObservationResult = { observation: Observation } | { error: EvaluationErrorCode; reason: Reason };

function isCondition(value: string): value is MarketAlertCondition {
  return MARKET_ALERT_CONDITIONS.includes(value as MarketAlertCondition);
}

/**
 * Each way a check can come up empty, as the shared reason type. This is what
 * the owner reads instead of "nothing happened": a stale quote and a refused
 * API key are different sentences, because they need different actions.
 */
export function reasonForEvaluationError(code: EvaluationErrorCode, options: { providerId?: string; detail?: string } = {}): Reason {
  const base = { ...(options.providerId ? { providerId: options.providerId } : {}), ...(options.detail ? { detail: options.detail } : {}) };
  switch (code) {
    case "QUOTE_NOT_FRESH":
      return reason("STALE_DATA", { ...base, message: "The freshest public quote was older than 30 seconds, so it was not acted on." });
    case "INDICATOR_UNAVAILABLE":
      return reason("INVALID_PROVIDER_RESPONSE", {
        ...base,
        message: "Not enough closed 15-minute candles were available to compute RSI-14.",
      });
    case "INVALID_ALERT":
      return reason("UNKNOWN", {
        ...base,
        retryable: false,
        message: "An alert's condition is not one this build understands, so it was not evaluated.",
      });
    case "PUBLIC_FEED_UNAVAILABLE":
    default:
      return reason("VENUE_UNAVAILABLE", {
        ...base,
        message: "The public Coinbase feed did not answer, so this check could not be made.",
      });
  }
}

/**
 * The reason behind an unavailable Coinbase read, in the shared vocabulary: the
 * feed's own answer (rate-limited, unreadable, refused) is what the owner needs,
 * not the generic "feed unavailable" this path used to persist.
 */
function coinbaseFailureReason(result: MarketDataResult<never>): Reason {
  return describeMarketDataFailure(result as Extract<MarketDataResult<never>, { status: "unavailable" }>, PROVIDER_IDS.coinbase);
}

function staleQuote(quote: MarketQuote | null, now: Date, providerId: string): ObservationResult {
  const observedAt = quote?.provenance.observedAt ? new Date(quote.provenance.observedAt) : null;
  const detail = observedAt && Number.isFinite(observedAt.getTime())
    ? `The newest quote was observed at ${observedAt.toISOString()}; the current time is ${now.toISOString()}.`
    : undefined;
  return { error: "QUOTE_NOT_FRESH", reason: reasonForEvaluationError("QUOTE_NOT_FRESH", { providerId, detail }) };
}

function quoteObservation(quote: MarketQuote, now: Date, providerId: string): ObservationResult {
  if (!quote.bid || !quote.ask || quote.provenance.freshness !== "FRESH" || !quote.provenance.observedAt) {
    return staleQuote(quote, now, providerId);
  }
  const observedAt = new Date(quote.provenance.observedAt);
  if (!Number.isFinite(observedAt.getTime()) || observedAt.getTime() > now.getTime() || now.getTime() - observedAt.getTime() > 30_000) {
    return staleQuote(quote, now, providerId);
  }
  try {
    const bid = new Decimal(quote.bid);
    const ask = new Decimal(quote.ask);
    if (!bid.isFinite() || !ask.isFinite() || bid.lte(0) || ask.lt(bid)) return staleQuote(quote, now, providerId);
    return { observation: { value: ask.plus(bid).dividedBy(2).toFixed(), observedAt } };
  } catch {
    return staleQuote(quote, now, providerId);
  }
}

async function collectObservations(alerts: readonly ActiveAlert[], now: Date): Promise<Map<string, ObservationResult>> {
  const results = new Map<string, ObservationResult>();
  const priceSymbols = [...new Set(alerts.filter((alert) => alert.condition.startsWith("PRICE_")).map(({ symbol }) => symbol))];
  const indicatorSymbols = [...new Set(alerts.filter((alert) => alert.condition.startsWith("RSI_14_")).map(({ symbol }) => symbol))];

  if (priceSymbols.length > 0) {
    let feedFailure: Reason | null = null;
    try {
      const quotes = await coinbaseMarketData.getQuotes({ instruments: priceSymbols });
      if (quotes.status === "available") {
        for (const quote of quotes.data) {
          results.set(`PRICE:${quote.instrument.id}`, quoteObservation(quote, now, quotes.data[0]?.provenance.providerId ?? PROVIDER_IDS.coinbase));
        }
      } else {
        feedFailure = coinbaseFailureReason(quotes);
      }
    } catch (error) {
      feedFailure = reasonForEvaluationError("PUBLIC_FEED_UNAVAILABLE", {
        providerId: PROVIDER_IDS.coinbase,
        detail: error instanceof Error ? error.message : undefined,
      });
    }
    for (const symbol of priceSymbols) {
      if (results.has(`PRICE:${symbol}`)) continue;
      results.set(`PRICE:${symbol}`, {
        error: "PUBLIC_FEED_UNAVAILABLE",
        reason: feedFailure ?? reasonForEvaluationError("PUBLIC_FEED_UNAVAILABLE", { providerId: PROVIDER_IDS.coinbase }),
      });
    }
  }

  await Promise.all(indicatorSymbols.map(async (symbol) => {
    try {
      const result = await coinbaseMarketData.getCandles({
        instrument: symbol,
        interval: "15m",
        from: new Date(now.getTime() - RSI_INTERVAL_MS * 24).toISOString(),
        to: now.toISOString(),
      });
      if (result.status !== "available") {
        results.set(`RSI_14:${symbol}`, { error: "PUBLIC_FEED_UNAVAILABLE", reason: coinbaseFailureReason(result) });
        return;
      }

      const candles = result.data
        .filter((candle) => Date.parse(candle.closeTime) <= now.getTime())
        .sort((left, right) => Date.parse(left.closeTime) - Date.parse(right.closeTime));
      const latest = candles.at(-1);
      if (!latest || now.getTime() - Date.parse(latest.closeTime) > RSI_MAX_AGE_MS || candles.length <= RSI_PERIOD) {
        results.set(`RSI_14:${symbol}`, {
          error: "INDICATOR_UNAVAILABLE",
          reason: reasonForEvaluationError("INDICATOR_UNAVAILABLE", {
            providerId: PROVIDER_IDS.coinbase,
            detail: `${candles.length} closed candle(s) were available and ${RSI_PERIOD + 1} are needed.`,
          }),
        });
        return;
      }

      const rsi = calculateRsi(candles.map(({ close }) => Number(close)), RSI_PERIOD);
      if (rsi === null || !Number.isFinite(rsi)) {
        results.set(`RSI_14:${symbol}`, {
          error: "INDICATOR_UNAVAILABLE",
          reason: reasonForEvaluationError("INDICATOR_UNAVAILABLE", { providerId: PROVIDER_IDS.coinbase }),
        });
        return;
      }
      results.set(`RSI_14:${symbol}`, {
        observation: { value: new Decimal(rsi).toDecimalPlaces(4).toFixed(4), observedAt: new Date(latest.closeTime) },
      });
    } catch (error) {
      results.set(`RSI_14:${symbol}`, {
        error: "PUBLIC_FEED_UNAVAILABLE",
        reason: reasonForEvaluationError("PUBLIC_FEED_UNAVAILABLE", {
          providerId: PROVIDER_IDS.coinbase,
          detail: error instanceof Error ? error.message : undefined,
        }),
      });
    }
  }));

  return results;
}

/**
 * Claim one crossing and write its history, atomically.
 *
 * The `where` is the whole rule: the alert is still active, it has not already been marked as
 * met, and its previous fire is older than its own cooldown. Whichever evaluator's update
 * matches, wins — a second one finds `conditionMet` true or the cooldown still running and
 * writes nothing. The event's `windowStart` then carries the same deduplication into the
 * delivery layer, so even a re-armed rule cannot notify twice for one window.
 *
 * Returning false is not an error: it means this check did not produce a notification, and
 * the caller records that as a skip rather than inventing a fire.
 */
export async function claimAndAuditAlertTrigger(
  transaction: Pick<Prisma.TransactionClient, "marketAlert" | "marketAlertEvent" | "auditEvent">,
  alert: ActiveAlert,
  observation: Observation,
  triggeredAt: Date,
): Promise<boolean> {
  const cooldownFloor = new Date(triggeredAt.getTime() - Math.max(1, alert.cooldownMinutes) * 60_000);
  const windowStart = alertWindowStart(triggeredAt, alert.cooldownMinutes);
  const claimed = await transaction.marketAlert.updateMany({
    where: {
      id: alert.id,
      userId: alert.userId,
      status: "ACTIVE",
      conditionMet: false,
      OR: [{ triggeredAt: null }, { triggeredAt: { lte: cooldownFloor } }],
    },
    data: {
      conditionMet: true,
      triggeredAt,
      lastEvaluatedAt: triggeredAt,
      lastObservedValue: observation.value,
      lastEvaluationError: null,
    },
  });
  if (claimed.count !== 1) return false;

  await transaction.marketAlertEvent.create({
    data: {
      alertId: alert.id,
      actorUserId: alert.userId,
      observedValue: observation.value,
      sourceObservedAt: observation.observedAt,
      providerId: "coinbase-exchange",
      windowStart,
      triggeredAt,
    },
  });
  await auditCreate(transaction, {
    data: {
      actorUserId: alert.userId,
      action: "MARKET_ALERT_TRIGGERED",
      objectType: "MarketAlert",
      objectId: alert.id,
      outcome: "SUCCESS",
      redactedJson: JSON.stringify({
        symbol: alert.symbol,
        condition: alert.condition,
        threshold: alert.threshold,
        observedValue: observation.value,
        sourceObservedAt: observation.observedAt.toISOString(),
      }),
    },
  });
  return true;
}

export type AlertNotificationTotals = {
  sent: number;
  queued: number;
  failed: number;
  skipped: number;
  duplicates: number;
};

export async function evaluateActiveMarketAlerts(now = new Date()) {
  const intervalMinutes = getEffectiveMarketAlertIntervalMinutes();
  // The channel switches and quiet hours are read once per run. A settings row that cannot
  // be read falls back to the safe default (in-app only) rather than turning every channel
  // on: a switch that cannot be read is not permission to send email or Telegram.
  const settings: NotificationSettings = await getNotificationSettings().catch(() => ({ ...DEFAULT_NOTIFICATION_SETTINGS }));
  // Quiet hours hold deliveries, not evaluations: what was queued is delivered as soon as
  // the window has closed, before this run looks for new crossings.
  const queue: QueueFlushSummary | null = await flushQueuedNotifications({ settings, now }).catch(() => null);
  const alerts = await prisma.marketAlert.findMany({
    where: {
      status: "ACTIVE",
      OR: [
        { lastEvaluatedAt: null },
        { lastEvaluatedAt: { lte: new Date(now.getTime() - intervalMinutes * 60_000) } },
      ],
    },
    orderBy: [{ lastEvaluatedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: MAX_MARKET_ALERTS_PER_RUN,
    select: {
      id: true,
      userId: true,
      symbol: true,
      condition: true,
      threshold: true,
      cooldownMinutes: true,
      conditionMet: true,
      triggeredAt: true,
    },
  });
  const observations = await collectObservations(alerts, now);
  let triggered = 0;
  let failed = 0;
  let skipped = 0;
  /** Checks where the condition still held but had already been announced. */
  let holding = 0;
  const notifications: AlertNotificationTotals = { sent: 0, queued: 0, failed: 0, skipped: 0, duplicates: 0 };
  const failureReasons = new Map<ReasonCode, { reason: Reason; count: number }>();
  const noteFailure = (failure: Reason) => {
    const existing = failureReasons.get(failure.code);
    if (existing) existing.count += 1;
    else failureReasons.set(failure.code, { reason: failure, count: 1 });
  };

  for (const alert of alerts) {
    if (!isCondition(alert.condition)) {
      failed += 1;
      noteFailure(reasonForEvaluationError("INVALID_ALERT"));
      await prisma.marketAlert.updateMany({
        where: { id: alert.id, status: "ACTIVE" },
        data: { lastEvaluatedAt: now, lastEvaluationError: "INVALID_ALERT" },
      });
      continue;
    }

    const family = alert.condition.startsWith("PRICE_") ? "PRICE" : "RSI_14";
    const result = observations.get(`${family}:${alert.symbol}`);
    if (!result || "error" in result) {
      failed += 1;
      noteFailure(
        result && "error" in result
          ? result.reason
          : reasonForEvaluationError("PUBLIC_FEED_UNAVAILABLE", { providerId: PROVIDER_IDS.coinbase }),
      );
      await prisma.marketAlert.updateMany({
        where: { id: alert.id, status: "ACTIVE" },
        data: { lastEvaluatedAt: now, lastEvaluationError: result && "error" in result ? result.error : "PUBLIC_FEED_UNAVAILABLE" },
      });
      continue;
    }

    const isTriggered = doesAlertTrigger(alert.condition, alert.threshold, result.observation.value);
    if (!isTriggered) {
      skipped += 1;
      // Clearing the flag is what arms the rule for its next crossing. An alert that was
      // never met is written the same way, so a threshold edit re-arms it immediately.
      await prisma.marketAlert.updateMany({
        where: { id: alert.id, status: "ACTIVE" },
        data: {
          conditionMet: false,
          lastEvaluatedAt: now,
          lastObservedValue: result.observation.value,
          lastEvaluationError: null,
        },
      });
      continue;
    }

    if (alert.conditionMet) {
      // The condition still holds. It has already been announced, and re-sending it on every
      // check is exactly the repetition this phase forbids; only the observation moves.
      holding += 1;
      skipped += 1;
      await prisma.marketAlert.updateMany({
        where: { id: alert.id, status: "ACTIVE" },
        data: {
          lastEvaluatedAt: now,
          lastObservedValue: result.observation.value,
          lastEvaluationError: null,
        },
      });
      continue;
    }

    const committed = await prisma.$transaction((transaction) =>
      claimAndAuditAlertTrigger(transaction, alert, result.observation, now),
    );
    if (!committed) {
      // Lost the race, or the rule's cooldown is still running after a clear-and-cross.
      holding += 1;
      skipped += 1;
      await prisma.marketAlert.updateMany({
        where: { id: alert.id, status: "ACTIVE" },
        data: {
          lastEvaluatedAt: now,
          lastObservedValue: result.observation.value,
          lastEvaluationError: null,
        },
      });
      continue;
    }

    triggered += 1;
    // Phase 31: the alert is the event an owner may want outside this app. Publishing is
    // attempted after the trigger is committed, and a receiver that is down never changes the
    // alert's own outcome — it becomes a retry on the webhook side.
    await publishWebhookEvent({
      userId: alert.userId,
      eventType: "alert.triggered",
      payload: {
        alertId: alert.id,
        symbol: alert.symbol,
        condition: alert.condition,
        threshold: alert.threshold,
        observedValue: result.observation.value,
        triggeredAt: now.toISOString(),
      },
      now,
    }).catch(() => null);
    try {
      const delivery = await dispatchAlertNotification(
        {
          alert: {
            id: alert.id,
            userId: alert.userId,
            symbol: alert.symbol,
            condition: alert.condition,
            threshold: alert.threshold,
            cooldownMinutes: alert.cooldownMinutes,
          },
          observedValue: result.observation.value,
          triggeredAt: now,
        },
        { settings, now },
      );
      notifications.sent += delivery.sent;
      notifications.queued += delivery.queued;
      notifications.failed += delivery.failed;
      notifications.skipped += delivery.skipped;
      if (delivery.outcome === "DUPLICATE") notifications.duplicates += 1;
      if (delivery.outcome === "FAILED") {
        noteFailure(reason("PROVIDER_ERROR", {
          message: "An alert fired but at least one notification channel could not deliver it; the delivery log records the provider's answer.",
        }));
      }
    } catch (error) {
      notifications.failed += 1;
      noteFailure(reason("DATABASE_UNAVAILABLE", {
        detail: error instanceof Error ? error.message : undefined,
        message: "An alert fired but its delivery log could not be written, so no channel was recorded as sent.",
      }));
    }
  }

  const reasons = [...failureReasons.values()].map(({ reason: failure, count }) => ({ ...serializeReason(failure), count }));

  return {
    evaluated: alerts.length,
    triggered,
    failed,
    skipped,
    batchFull: alerts.length === MAX_MARKET_ALERTS_PER_RUN,
    cadence: formatMarketAlertInterval(intervalMinutes),
    /** Why this run did nothing, or null when it triggered something. */
    outcome: triggered > 0 ? ("triggered" as const) : failed > 0 ? ("failed" as const) : ("idle" as const),
    reason: summarizeRunReason({ evaluated: alerts.length, triggered, failed, skipped, holding, reasons, now, intervalMinutes }),
    reasons,
    notifications,
    queue,
    /** Alerts whose condition is true but which have already fired — the honest idle case. */
    holding,
  };
}

function summarizeRunReason(input: {
  evaluated: number;
  triggered: number;
  failed: number;
  skipped: number;
  holding: number;
  reasons: readonly (SerializedReason & { count: number })[];
  now: Date;
  intervalMinutes: number;
}): SerializedReason | null {
  if (input.triggered > 0) return null;
  if (input.evaluated === 0) {
    return serializeReason(
      reason("NOT_YET_DUE", {
        message: `No alert was due for evaluation at ${input.now.toISOString()}; the cadence is ${formatMarketAlertInterval(input.intervalMinutes)}.`,
      }),
    );
  }
  if (input.failed > 0 && input.skipped === 0) {
    const dominant = [...input.reasons].sort((left, right) => right.count - left.count)[0];
    return dominant
      ? serializeReason(
          reason(dominant.code, {
            message: `${input.failed} of ${input.evaluated} alert(s) could not be checked: ${dominant.message}`,
            retryable: dominant.retryable,
            ...(dominant.providerId ? { providerId: dominant.providerId } : {}),
            ...(dominant.variable ? { variable: dominant.variable } : {}),
            ...(dominant.detail ? { detail: dominant.detail } : {}),
          }),
        )
      : null;
  }
  if (input.holding > 0) {
    const crossedNothing = input.skipped - input.holding;
    return serializeReason(
      reason("NO_ENTRY_CONDITION", {
        message:
          `${input.skipped} alert(s) were checked at ${input.now.toISOString()}; ` +
          `${input.holding} already met their condition or were inside their cooldown, so no new crossing was announced` +
          (crossedNothing > 0 ? `, and ${crossedNothing} crossed no threshold.` : "."),
        ...(input.failed > 0 ? { detail: `${input.failed} further alert(s) could not be checked.` } : {}),
      }),
    );
  }
  return serializeReason(
    reason("NO_ENTRY_CONDITION", {
      message: `${input.skipped} alert(s) were checked at ${input.now.toISOString()}; none crossed its threshold.`,
      ...(input.failed > 0 ? { detail: `${input.failed} further alert(s) could not be checked.` } : {}),
    }),
  );
}

export type MarketAlertEvaluationState = {
  outcome: "triggered" | "idle" | "failed" | "never-run";
  reason: SerializedReason | null;
  checks: number;
  failures: number;
  lastEvaluatedAt: string | null;
  lastTriggeredAt: string | null;
};

/**
 * When this rule is next due, from its own last check. Null means it has never been checked
 * and is due on the next runner pass — which is the truthful answer for a new rule, rather
 * than a timestamp derived from its creation.
 */
export function nextEvaluationAt(
  lastEvaluatedAt: Date | string | null,
  intervalMinutes: number,
): string | null {
  if (!lastEvaluatedAt) return null;
  const time = new Date(lastEvaluatedAt).getTime();
  if (!Number.isFinite(time)) return null;
  return new Date(time + intervalMinutes * 60_000).toISOString();
}

/**
 * The same question, asked of an owner's alert rows rather than of a run:
 * "if I look at my alerts now, why has nothing happened?" The answer is
 * persisted state, so the panel can show it without triggering an evaluation.
 */
export function describeMarketAlertEvaluation(
  alerts: readonly {
    status: string;
    lastEvaluatedAt: Date | string | null;
    lastEvaluationError: string | null;
    triggeredAt?: Date | string | null;
    conditionMet?: boolean;
    cooldownMinutes?: number;
  }[],
  intervalMinutes: number,
  now = new Date(),
): MarketAlertEvaluationState {
  const checks = alerts.filter((alert) => alert.lastEvaluatedAt !== null).length;
  const failures = alerts.filter((alert) => alert.lastEvaluationError !== null).length;
  const timestamps = alerts
    .map((alert) => (alert.lastEvaluatedAt ? new Date(alert.lastEvaluatedAt).getTime() : Number.NaN))
    .filter((value) => Number.isFinite(value));
  const lastEvaluatedAt = timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null;
  const fired = alerts
    .map((alert) => (alert.triggeredAt ? new Date(alert.triggeredAt).getTime() : Number.NaN))
    .filter((value) => Number.isFinite(value));
  const lastTriggeredAt = fired.length > 0 ? new Date(Math.max(...fired)).toISOString() : null;
  // "This run fired something" rather than "this rule has ever fired": the last completed
  // check is the tie-breaker, so an idle day after a fire still explains itself.
  const triggered = lastTriggeredAt !== null && lastEvaluatedAt !== null &&
    Date.parse(lastTriggeredAt) >= Date.parse(lastEvaluatedAt);

  if (triggered) return { outcome: "triggered", reason: null, checks, failures, lastEvaluatedAt, lastTriggeredAt };
  if (failures > 0) {
    const codes = alerts
      .map((alert) => alert.lastEvaluationError)
      .filter((code): code is string => Boolean(code));
    const dominantCode = codes.sort((left, right) => codes.filter((code) => code === right).length - codes.filter((code) => code === left).length)[0];
    const failure = dominantCode && isEvaluationErrorCode(dominantCode)
      ? reasonForEvaluationError(dominantCode, { providerId: PROVIDER_IDS.coinbase })
      : reason("UNKNOWN", { message: "An alert's last check failed and recorded an unrecognised code." });
    return {
      outcome: "failed",
      reason: serializeReason(reason(failure.code, { ...failure, message: `${failures} alert check(s) failed: ${failure.message}` })),
      checks,
      failures,
      lastEvaluatedAt,
      lastTriggeredAt,
    };
  }
  if (checks > 0) {
    const holding = alerts.filter((alert) => alert.conditionMet === true).length;
    const cooling = alerts.filter((alert) => {
      if (!alert.triggeredAt || !alert.cooldownMinutes) return false;
      const firedAt = new Date(alert.triggeredAt).getTime();
      return Number.isFinite(firedAt) && now.getTime() - firedAt < alert.cooldownMinutes * 60_000;
    }).length;
    return {
      outcome: "idle",
      reason: serializeReason(
        reason("NO_ENTRY_CONDITION", {
          message: cooling > 0
            ? `${checks} alert(s) were checked; ${cooling} fired recently and are still inside their cooldown, so nothing new was announced.`
            : holding > 0
              ? `${checks} alert(s) were checked; ${holding} already met their condition, so no new crossing was announced.`
              : `${checks} alert(s) were checked; none crossed its threshold.`,
          ...(lastEvaluatedAt ? { detail: `Last check ${lastEvaluatedAt}.` } : {}),
        }),
      ),
      checks,
      failures,
      lastEvaluatedAt,
      lastTriggeredAt,
    };
  }
  return {
    outcome: "never-run",
    reason: serializeReason(
      reason("NOT_YET_DUE", {
        message: `No alert has been checked yet; the runner evaluates every ${formatMarketAlertInterval(intervalMinutes)}.`,
      }),
    ),
    checks,
    failures,
    lastEvaluatedAt,
    lastTriggeredAt,
  };
}

function isEvaluationErrorCode(value: string): value is EvaluationErrorCode {
  return value === "PUBLIC_FEED_UNAVAILABLE" || value === "QUOTE_NOT_FRESH" || value === "INDICATOR_UNAVAILABLE" || value === "INVALID_ALERT";
}