import DecimalJS from "decimal.js";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { coinbaseMarketData } from "@/lib/market-data/coinbase-service";
import { calculateRsi } from "@/lib/market-data/indicators";
import type { MarketQuote } from "@/lib/market-data/provider";
import {
  doesAlertTrigger,
  MARKET_ALERT_CONDITIONS,
  type MarketAlertCondition,
} from "@/lib/alerts/conditions";
import { formatMarketAlertInterval, getEffectiveMarketAlertIntervalMinutes } from "@/lib/alerts/scheduler-config";

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
};

type Observation = { value: string; observedAt: Date };
type EvaluationErrorCode = "PUBLIC_FEED_UNAVAILABLE" | "QUOTE_NOT_FRESH" | "INDICATOR_UNAVAILABLE" | "INVALID_ALERT";
type ObservationResult = { observation: Observation } | { error: EvaluationErrorCode };

function isCondition(value: string): value is MarketAlertCondition {
  return MARKET_ALERT_CONDITIONS.includes(value as MarketAlertCondition);
}

function quoteObservation(quote: MarketQuote, now: Date): ObservationResult {
  if (!quote.bid || !quote.ask || quote.provenance.freshness !== "FRESH" || !quote.provenance.observedAt) {
    return { error: "QUOTE_NOT_FRESH" };
  }
  const observedAt = new Date(quote.provenance.observedAt);
  if (!Number.isFinite(observedAt.getTime()) || observedAt.getTime() > now.getTime() || now.getTime() - observedAt.getTime() > 30_000) {
    return { error: "QUOTE_NOT_FRESH" };
  }
  try {
    const bid = new Decimal(quote.bid);
    const ask = new Decimal(quote.ask);
    if (!bid.isFinite() || !ask.isFinite() || bid.lte(0) || ask.lt(bid)) return { error: "QUOTE_NOT_FRESH" };
    return { observation: { value: ask.plus(bid).dividedBy(2).toFixed(), observedAt } };
  } catch {
    return { error: "QUOTE_NOT_FRESH" };
  }
}

async function collectObservations(alerts: readonly ActiveAlert[], now: Date): Promise<Map<string, ObservationResult>> {
  const results = new Map<string, ObservationResult>();
  const priceSymbols = [...new Set(alerts.filter((alert) => alert.condition.startsWith("PRICE_")).map(({ symbol }) => symbol))];
  const indicatorSymbols = [...new Set(alerts.filter((alert) => alert.condition.startsWith("RSI_14_")).map(({ symbol }) => symbol))];

  if (priceSymbols.length > 0) {
    try {
      const quotes = await coinbaseMarketData.getQuotes({ instruments: priceSymbols });
      if (quotes.status === "available") {
        for (const quote of quotes.data) results.set(`PRICE:${quote.instrument.id}`, quoteObservation(quote, now));
      }
    } catch {
      // The generic unavailable code is persisted below; provider messages never reach clients or audit data.
    }
    for (const symbol of priceSymbols) {
      if (!results.has(`PRICE:${symbol}`)) results.set(`PRICE:${symbol}`, { error: "PUBLIC_FEED_UNAVAILABLE" });
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
        results.set(`RSI_14:${symbol}`, { error: "PUBLIC_FEED_UNAVAILABLE" });
        return;
      }

      const candles = result.data
        .filter((candle) => Date.parse(candle.closeTime) <= now.getTime())
        .sort((left, right) => Date.parse(left.closeTime) - Date.parse(right.closeTime));
      const latest = candles.at(-1);
      if (!latest || now.getTime() - Date.parse(latest.closeTime) > RSI_MAX_AGE_MS || candles.length <= RSI_PERIOD) {
        results.set(`RSI_14:${symbol}`, { error: "INDICATOR_UNAVAILABLE" });
        return;
      }

      const rsi = calculateRsi(candles.map(({ close }) => Number(close)), RSI_PERIOD);
      if (rsi === null || !Number.isFinite(rsi)) {
        results.set(`RSI_14:${symbol}`, { error: "INDICATOR_UNAVAILABLE" });
        return;
      }
      results.set(`RSI_14:${symbol}`, {
        observation: { value: new Decimal(rsi).toDecimalPlaces(4).toFixed(4), observedAt: new Date(latest.closeTime) },
      });
    } catch {
      results.set(`RSI_14:${symbol}`, { error: "PUBLIC_FEED_UNAVAILABLE" });
    }
  }));

  return results;
}

export async function claimAndAuditAlertTrigger(
  transaction: Pick<Prisma.TransactionClient, "marketAlert" | "marketAlertEvent" | "auditEvent">,
  alert: ActiveAlert,
  observation: Observation,
  triggeredAt: Date,
): Promise<boolean> {
  const claimed = await transaction.marketAlert.updateMany({
    where: { id: alert.id, userId: alert.userId, status: "ACTIVE" },
    data: {
      status: "TRIGGERED",
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
      triggeredAt,
    },
  });
  await transaction.auditEvent.create({
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

export async function evaluateActiveMarketAlerts(now = new Date()) {
  const intervalMinutes = getEffectiveMarketAlertIntervalMinutes();
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
    select: { id: true, userId: true, symbol: true, condition: true, threshold: true },
  });
  const observations = await collectObservations(alerts, now);
  let triggered = 0;
  let failed = 0;
  let skipped = 0;

  for (const alert of alerts) {
    if (!isCondition(alert.condition)) {
      failed += 1;
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
      await prisma.marketAlert.updateMany({
        where: { id: alert.id, status: "ACTIVE" },
        data: { lastEvaluatedAt: now, lastEvaluationError: result && "error" in result ? result.error : "PUBLIC_FEED_UNAVAILABLE" },
      });
      continue;
    }

    const isTriggered = doesAlertTrigger(alert.condition, alert.threshold, result.observation.value);
    if (!isTriggered) {
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
    if (committed) triggered += 1;
    else skipped += 1;
  }

  return {
    evaluated: alerts.length,
    triggered,
    failed,
    skipped,
    batchFull: alerts.length === MAX_MARKET_ALERTS_PER_RUN,
    cadence: formatMarketAlertInterval(intervalMinutes),
  };
}