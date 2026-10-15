import { Buffer } from "node:buffer";
import { NextRequest } from "next/server";
import { getAuthConfig, getAuthUnavailableReason, isSameOriginRequest } from "@/lib/auth/config";
import { AuthenticationRequiredError, requireUser } from "@/lib/auth/session-store";
import { prisma } from "@/lib/db";
import { validateNewMarketAlert } from "@/lib/alerts/conditions";
import { formatMarketAlertInterval, getEffectiveMarketAlertIntervalMinutes, getMarketAlertIntervalMinutes } from "@/lib/alerts/scheduler-config";

const MAX_BODY_BYTES = 2_048;
const MAX_ACTIVE_ALERTS_PER_USER = 50;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authError(error: unknown) {
  if (error instanceof AuthenticationRequiredError) return json({ error: "Authentication required." }, 401);
  return null;
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
    const alerts = await prisma.marketAlert.findMany({
      where: { userId: user.id, status: { not: "DELETED" } },
      orderBy: { createdAt: "desc" },
      include: { event: true },
    });
    const requestedIntervalMinutes = getMarketAlertIntervalMinutes();
    const intervalMinutes = getEffectiveMarketAlertIntervalMinutes();
    return json({ alerts, cadence: formatMarketAlertInterval(intervalMinutes), intervalMinutes, requestedIntervalMinutes, schedule: "0 0 * * *" });
  } catch (error) {
    return authError(error) ?? json({ error: "Market alerts are unavailable." }, 503);
  }
}

export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return json({ error: getAuthUnavailableReason() ?? "Authentication is unavailable." }, 503);
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
    const activeCount = await prisma.marketAlert.count({ where: { userId: user.id, status: "ACTIVE" } });
    if (activeCount >= MAX_ACTIVE_ALERTS_PER_USER) {
      return json({ error: `A maximum of ${MAX_ACTIVE_ALERTS_PER_USER} active alerts is allowed.` }, 409);
    }

    const alert = await prisma.$transaction(async (transaction) => {
      const created = await transaction.marketAlert.create({
        data: { userId: user.id, ...validation.value },
      });
      await transaction.auditEvent.create({
        data: {
          actorUserId: user.id,
          action: "MARKET_ALERT_CREATED",
          objectType: "MarketAlert",
          objectId: created.id,
          outcome: "SUCCESS",
          redactedJson: JSON.stringify({ symbol: created.symbol, condition: created.condition, threshold: created.threshold }),
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
  if (!config) return json({ error: getAuthUnavailableReason() ?? "Authentication is unavailable." }, 503);
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
      await transaction.auditEvent.create({
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