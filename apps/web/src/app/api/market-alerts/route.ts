import { Buffer } from "node:buffer";
import { NextRequest } from "next/server";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { getAccessRefusal, authenticationGapResponse } from "@/lib/auth/access-gate";
import { requireUser } from "@/lib/auth/session-store";
import { prisma } from "@/lib/db";
import { validateNewMarketAlert } from "@/lib/alerts/conditions";
import { MAX_ACTIVE_ALERTS_PER_USER } from "@/lib/alerts/limits";
import { formatMarketAlertInterval, getEffectiveMarketAlertIntervalMinutes, getMarketAlertIntervalMinutes } from "@/lib/alerts/scheduler-config";
import { describeMarketAlertEvaluation, nextEvaluationAt } from "@/lib/alerts/evaluate";
import { DEFAULT_NOTIFICATION_SETTINGS, getNotificationSettings, notificationChannelViews } from "@/lib/notifications/settings";
import { isWithinQuietHours } from "@/lib/notifications/dispatch";
import { auditCreate } from "@/lib/audit/record";

const MAX_BODY_BYTES = 2_048;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authError(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal ? json({ error: refusal.error }, refusal.status) : null;
}

async function readBody(request: Request): Promise<{ body: unknown } | { response: Response }> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return { response: json({ error: "Content-Type must be application/json." }, 415) };
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { response: json({ error: "Invalid request body." }, 400) };
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return { response: json({ error: "Request is too large." }, 413) };
  try {
    return { body: JSON.parse(raw) as unknown };
  } catch {
    return { response: json({ error: "Invalid JSON body." }, 400) };
  }
}

export async function GET() {
  try {
    const user = await requireUser();
    const [alerts, settings] = await Promise.all([
      prisma.marketAlert.findMany({
        where: { userId: user.id, status: { not: "DELETED" } },
        orderBy: { createdAt: "desc" },
        // The latest crossing is enough for the list; the delivery log is the history.
        include: { events: { orderBy: { triggeredAt: "desc" }, take: 1 } },
      }),
      getNotificationSettings().catch(() => ({ ...DEFAULT_NOTIFICATION_SETTINGS })),
    ]);
    const deliveries = await prisma.notificationDelivery.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        channel: true,
        target: true,
        subject: true,
        status: true,
        providerId: true,
        providerMessageId: true,
        error: true,
        attempt: true,
        durationMs: true,
        queuedAt: true,
        deliveredAt: true,
        createdAt: true,
      },
    });
    const requestedIntervalMinutes = getMarketAlertIntervalMinutes();
    const intervalMinutes = getEffectiveMarketAlertIntervalMinutes();
    // Why nothing has happened, in the shared reason type, from the alert rows
    // themselves — so the panel can say it without triggering an evaluation.
    const evaluation = describeMarketAlertEvaluation(alerts, intervalMinutes);
    const queued = deliveries.filter((delivery) => delivery.status === "QUEUED").length;
    return json({
      alerts: alerts.map((alert) => ({
        ...alert,
        // "Next evaluation" is derived, never stored: it is the rule's own last check plus
        // the cadence this deployment delivers. Null means "due on the next pass".
        nextEvaluationAt: nextEvaluationAt(alert.lastEvaluatedAt, intervalMinutes),
      })),
      cadence: formatMarketAlertInterval(intervalMinutes),
      intervalMinutes,
      requestedIntervalMinutes,
      schedule: "0 0 * * *",
      evaluation,
      channels: notificationChannelViews(settings),
      quietHours: {
        enabled: settings.quietHoursEnabled,
        start: settings.quietHoursStart,
        end: settings.quietHoursEnd,
        active: isWithinQuietHours(settings, new Date()),
        queued,
      },
      defaultCooldownMinutes: settings.defaultCooldownMinutes,
      deliveries,
    });
  } catch (error) {
    return authError(error) ?? json({ error: "Market alerts are unavailable." }, 503);
  }
}

export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authError(error) ?? json({ error: "User authorization is unavailable." }, 503);
  }

  const parsed = await readBody(request);
  if ("response" in parsed) return parsed.response;
  const validation = validateNewMarketAlert(parsed.body);
  if (!validation.valid) return json({ error: validation.error }, 400);

  try {
    const settings = await getNotificationSettings().catch(() => ({ ...DEFAULT_NOTIFICATION_SETTINGS }));
    const activeCount = await prisma.marketAlert.count({ where: { userId: user.id, status: "ACTIVE" } });
    if (activeCount >= MAX_ACTIVE_ALERTS_PER_USER) {
      return json({ error: `A maximum of ${MAX_ACTIVE_ALERTS_PER_USER} active alerts is allowed.` }, 409);
    }

    const alert = await prisma.$transaction(async (transaction) => {
      const created = await transaction.marketAlert.create({
        data: {
          userId: user.id,
          ...validation.value,
          // The admin default is applied once, at creation. A rule stores its own copy so
          // changing the default never rewrites the pacing of an existing alert.
          cooldownMinutes: validation.value.cooldownMinutes ?? settings.defaultCooldownMinutes,
        },
      });
      await auditCreate(transaction, {
        data: {
          actorUserId: user.id,
          action: "MARKET_ALERT_CREATED",
          objectType: "MarketAlert",
          objectId: created.id,
          outcome: "SUCCESS",
          redactedJson: JSON.stringify({
            symbol: created.symbol,
            condition: created.condition,
            threshold: created.threshold,
            cooldownMinutes: created.cooldownMinutes,
          }),
        },
      });
      return created;
    });
    return json({ alert }, 201);
  } catch {
    return json({ error: "Market alert could not be audited and saved." }, 503);
  }
}

export async function DELETE(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authError(error) ?? json({ error: "User authorization is unavailable." }, 503);
  }

  const parsed = await readBody(request);
  if ("response" in parsed) return parsed.response;
  if (typeof parsed.body !== "object" || parsed.body === null || Array.isArray(parsed.body) ||
    Object.keys(parsed.body).length !== 1 || !("alertId" in parsed.body) || typeof parsed.body.alertId !== "string" || !parsed.body.alertId.trim()) {
    return json({ error: "Only a valid alertId is accepted." }, 400);
  }

  const alertId = parsed.body.alertId;
  try {
    const alert = await prisma.marketAlert.findFirst({ where: { id: alertId, userId: user.id, status: { not: "DELETED" } } });
    if (!alert) return json({ error: "Market alert was not found." }, 404);

    await prisma.$transaction(async (transaction) => {
      const deletedAt = new Date();
      const updated = await transaction.marketAlert.updateMany({
        where: { id: alert.id, userId: user.id, status: { not: "DELETED" } },
        data: { status: "DELETED", deletedAt },
      });
      if (updated.count !== 1) throw new Error("Market alert was already deleted.");
      await auditCreate(transaction, {
        data: {
          actorUserId: user.id,
          action: "MARKET_ALERT_DELETED",
          objectType: "MarketAlert",
          objectId: alert.id,
          outcome: "SUCCESS",
          redactedJson: JSON.stringify({ symbol: alert.symbol, condition: alert.condition, threshold: alert.threshold }),
        },
      });
    });
    return json({ deleted: true, alertId });
  } catch {
    return json({ error: "Market alert deletion could not be audited." }, 503);
  }
}