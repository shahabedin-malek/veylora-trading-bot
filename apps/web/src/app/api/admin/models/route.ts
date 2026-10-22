import { NextRequest } from "next/server";
import { authenticationGapResponse, getAccessRefusal } from "@/lib/auth/access-gate";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { requireAdmin } from "@/lib/auth/session-store";
import { describeProviders } from "@/lib/ai/provider";
import {
  AI_FEATURES,
  describeAiRoutes,
  getAiRoutingSettings,
  saveAiRoutingSettings,
  validateAiRoutingSettings,
} from "@/lib/ai/router";
import { readAiUsageReport } from "@/lib/ai/meter";

/**
 * The owner's model settings and the month's AI spend.
 *
 * `GET` reads three things that belong together and are therefore returned together: what
 * each provider can do and what a missing key is called, which provider each feature will
 * actually use right now (after capability and key checks), and the recorded requests with
 * their computed cost. A panel that read them separately could show a route that is not the
 * route in effect.
 *
 * `PUT` replaces the whole routing document. The save is validated as a unit and audited in
 * the same transaction, and the next request obeys it because routing is read per request —
 * that is what makes \"switching a model takes effect without a redeploy\" true rather than a
 * claim.
 *
 * Keys are never part of either direction: the read names the variable, and the write has no
 * field a value could travel in.
 */

const MAX_BODY_BYTES = 8_192;
const MAX_PERIOD_DAYS = 366;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authErrorResponse(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal ? json({ error: refusal.error }, refusal.status) : null;
}

/** This month so far, in UTC, unless the caller names a bounded window. */
export function resolvePeriod(searchParams: URLSearchParams, now = new Date()): { from: Date; to: Date } | null {
  const rawFrom = searchParams.get("from");
  const rawTo = searchParams.get("to");
  if (!rawFrom && !rawTo) {
    return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: now };
  }
  if (!rawFrom || !rawTo) return null;
  const from = new Date(rawFrom);
  const to = new Date(rawTo);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  if (from.getTime() >= to.getTime()) return null;
  if (to.getTime() - from.getTime() > MAX_PERIOD_DAYS * 86_400_000) return null;
  return { from, to };
}

export async function GET(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "AI model settings are unavailable." }, 503);
  }

  const period = resolvePeriod(request.nextUrl.searchParams);
  if (!period) {
    return json(
      { error: `Provide both from and to as ISO timestamps, with from before to and no more than ${MAX_PERIOD_DAYS} days apart.` },
      400,
    );
  }

  const settings = await getAiRoutingSettings();
  const routes = await describeAiRoutes(settings);
  const usage = await readAiUsageReport({
    from: period.from,
    to: period.to,
    currency: settings.currency,
    usdPerCurrencyUnit: settings.usdPerCurrencyUnit,
    monthlyBudgetUsd: settings.monthlyBudgetUsd,
  });

  return json({
    settings,
    features: AI_FEATURES,
    providers: describeProviders(),
    routes,
    usage: usage
      ? usage
      : {
          unavailable: true as const,
          note: "The request records could not be read, so this period's spend is unknown rather than zero.",
        },
    period: { from: period.from.toISOString(), to: period.to.toISOString() },
    readBy: admin.id,
  });
}

export async function PUT(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let admin;
  try {
    admin = await requireAdmin();
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "Administrator authorization is unavailable." }, 503);
  }

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415);
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413);

  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  // The shape check happens before the database call, so a malformed document is a 400
  // that names the problem rather than a 503 that hides it.
  const shape = validateAiRoutingSettings(body);
  if (!shape.valid) return json({ error: shape.error }, 400);

  const saved = await saveAiRoutingSettings(shape.value, admin.id);
  if (!saved.valid) return json({ error: saved.error }, 400);

  // Read back through the same path a request uses: the answer is what is in effect, not
  // what the caller sent.
  const settings = await getAiRoutingSettings();
  return json({ settings, routes: await describeAiRoutes(settings) });
}
