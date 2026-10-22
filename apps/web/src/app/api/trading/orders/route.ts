import { NextRequest } from "next/server";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { getAccessRefusal, authenticationGapResponse } from "@/lib/auth/access-gate";
import { requireUser } from "@/lib/auth/session-store";
import { assertScopeVerified } from "@/lib/auth/step-up";
import {
  lifecycleResource,
  orderIntentFrom,
  orderResource,
  parseLimit,
  parseStatusFilter,
  validateOrderSubmission,
} from "@/lib/orders/api";
import { buildPreTradeReport } from "@/lib/orders/preflight";
import { describeOrderRetryPolicy, submitOrder } from "@/lib/orders/process";
import { ORDER_NOTE_PREFIX } from "@/lib/orders/origin";
import { describeOrderReconcileCadence, getOrderReconcileIntervalMinutes } from "@/lib/orders/scheduler-config";
import { orderStore } from "@/lib/orders/store";
import { loggerFor } from "@/lib/observability/request-context";
import { authoriseOrder } from "@/lib/risk-controls/enforcement";
import { getRiskPolicySettings } from "@/lib/risk-controls/settings";
import { decideCredentialUse, loadCredentialScope } from "@/lib/trading/read-only-credentials";
import {
  describeTestnetComparison,
  LIVE_EXECUTION_DISABLED,
  orderVenueSummary,
  readOrderRoutingSettings,
  resolveOrderVenue,
  TESTNET_ROUTING_DISABLED,
  type OrderRoutingSettings,
  type RequestedExecution,
} from "@/lib/venues/registry";
import { prisma } from "@/lib/db";
import { auditCreate } from "@/lib/audit/record";
import { consumeRateLimit, RATE_LIMITS, rateLimitResponse } from "@/lib/security/rate-limit";

/**
 * The order endpoint: `GET /api/trading/orders` lists them, `POST` submits one.
 *
 * Every answer carries the same three things the owner needs to judge an order:
 * the state, the sentence that explains the state, and — when the order is open —
 * what reconciliation will do about it. Nothing about this endpoint is silent:
 * a submission that was replayed says so, one that is still in flight says so, and
 * a submission that failed carries the venue's own words as its reason.
 *
 * The response is never cached, on any answer: an order's state is the outcome of
 * a write, and a cached one would be a stale claim about money.
 */

const MAX_BODY_BYTES = 16_384;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A submission may name the key it is to be placed with.
 *
 * When it does, that key's scope is decided *here*, before anything is validated,
 * reserved or sent: a key the owner stored as read-only is refused by name
 * (`READ_ONLY_CREDENTIAL`, 409) and the attempt leaves no order, no reservation and no
 * money anywhere — the refusal is the whole of what happens. An unnamed key is the
 * development paper venue's own path and is unaffected.
 *
 * The refusal is audited like any other decision about money, in its own row, so
 * "someone tried to trade with a read-only key" is a thing the record answers rather
 * than a thing that has to be reproduced.
 */
async function refuseReadOnlyCredential(
  body: unknown,
  user: { id: string },
): Promise<{ response: Response } | { credentialId: string | null }> {
  const credentialId = isRecord(body) && typeof body.credentialId === "string" ? body.credentialId.trim() : "";
  if (!credentialId) return { credentialId: null };

  const decision = decideCredentialUse(await loadCredentialScope(credentialId, user.id));
  if (decision.kind === "allowed") return { credentialId };

  try {
    await auditCreate(prisma, {
      data: {
        actorUserId: user.id,
        action: decision.body.code === "READ_ONLY_CREDENTIAL" ? "ORDER_REFUSED_READ_ONLY_KEY" : "ORDER_REFUSED_UNKNOWN_KEY",
        objectType: "TradingVenueCredential",
        objectId: credentialId,
        outcome: "REFUSED",
        redactedJson: JSON.stringify({ code: decision.body.code ?? "NOT_FOUND" }),
      },
    });
  } catch (error) {
    // The refusal stands whether or not the audit row could be written: the request
    // was refused before it reached anything that could move money.
    loggerFor("/api/trading/orders").error("the read-only refusal could not be audited", { error });
  }
  return { response: json(decision.body, decision.status) };
}

function authErrorResponse(error: unknown) {
  const refusal = getAccessRefusal(error);
  // The step-up refusal carries its code and scope, so the client's one prompt
  // can say which action it is proving — and a failure that is not a step-up
  // cannot be mistaken for one.
  return refusal
    ? json(
        { error: refusal.error, ...(refusal.code ? { code: refusal.code } : {}), ...(refusal.scope ? { scope: refusal.scope } : {}) },
        refusal.status,
      )
    : null;
}

async function readJson(request: NextRequest): Promise<{ body: unknown } | { response: Response }> {
  const raw = await request.text().catch(() => null);
  if (raw === null) return { response: json({ error: "Invalid request body." }, 400) };
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return { response: json({ error: "Request is too large." }, 413) };
  if (!raw.trim()) return { body: undefined };
  try {
    return { body: JSON.parse(raw) as unknown };
  } catch {
    return { response: json({ error: "Invalid JSON body." }, 400) };
  }
}

/**
 * Where an order would go, from the same registry the submission uses.
 *
 * Phase 21 turned this from a constant into a question with an answer that depends on the
 * admin switch, so it is read per response rather than captured once: a page that shows
 * "paper venue" must not keep saying it after the owner switches testnet routing on.
 */
async function venueFacts() {
  const summary = await orderVenueSummary();
  return {
    id: summary.venueId,
    label: summary.label,
    environment: summary.environment,
    paper: summary.environment === "paper",
    testnetRoutingEnabled: summary.testnetRoutingEnabled,
    liveExecutionEnabled: summary.liveExecutionEnabled,
    available: summary.available,
    detail: summary.detail,
  };
}

/**
 * The two switches, read once per submission.
 *
 * Read here rather than only inside the registry so a refusal can name the state it was
 * refused by, and passed to the resolution so the row is read once. Null means the switches
 * could not be read at all, in which case the refusal simply does not claim a state it
 * could not see — and the registry refuses the order for the same reason.
 */
async function venueRoutingSettings(): Promise<OrderRoutingSettings | null> {
  try {
    return await readOrderRoutingSettings();
  } catch {
    return null;
  }
}

function switchState(settings: OrderRoutingSettings | null, code: string) {
  if (!settings) return null;
  const live = code === LIVE_EXECUTION_DISABLED;
  return {
    name: live ? "liveExecutionEnabled" : "testnetOrdersEnabled",
    state: live ? settings.liveExecutionEnabled : settings.testnetOrdersEnabled,
    panel: live ? "/admin/risk" : "/admin/access",
  };
}

/**
 * A submission that the owner's switch stopped, recorded as such.
 *
 * The acceptance criterion for phase 22 is that this attempt is "audited as blocked by the
 * switch itself, naming its state". The audit row therefore carries the switch's name and
 * value rather than only a code, so the record answers "was it off when they tried?"
 * without anyone having to reconstruct the settings row's history.
 *
 * A refusal stands whether or not its audit row could be written: the request was refused
 * before anything existed that could move money.
 */
async function auditSwitchRefusal(input: {
  userId: string;
  code: string;
  requested: RequestedExecution | "auto";
  settings: OrderRoutingSettings;
}) {
  const live = input.code === LIVE_EXECUTION_DISABLED;
  const switchName = live ? "liveExecutionEnabled" : "testnetOrdersEnabled";
  try {
    await auditCreate(prisma, {
      data: {
        actorUserId: input.userId,
        action: "ORDER_BLOCKED_BY_SWITCH",
        objectType: "RiskPolicySettings",
        objectId: "global",
        outcome: "REFUSED",
        redactedJson: JSON.stringify({
          code: input.code,
          requested: input.requested,
          switch: switchName,
          state: false,
        }),
      },
    });
  } catch (error) {
    loggerFor("/api/trading/orders").error("the switch refusal could not be audited", { error, code: input.code });
  }
}

/**
 * What the pre-trade report noticed, written to the trail with the order.
 *
 * Requirement 3 of the phase: everything a pre-trade evaluation notices appears in the
 * order response *and* the audit trail. The report never changes the outcome — the order
 * has already been placed by the time this is written when it is written after, and never
 * waits on it either way.
 */
async function auditPreflight(input: {
  userId: string;
  venueId: string;
  report: Awaited<ReturnType<typeof buildPreTradeReport>>;
  order: { market: string; side: string; quantity: string };
}) {
  try {
    await auditCreate(prisma, {
      data: {
        actorUserId: input.userId,
        action: "ORDER_PRECHECK_REPORTED",
        objectType: input.venueId,
        objectId: `${input.order.market}:${input.order.side}`,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({
          venue: input.venueId,
          order: input.order,
          summary: input.report.summary,
          notices: input.report.notices.map((notice) => ({ code: notice.code ?? notice.name, detail: notice.detail })),
        }),
      },
    });
  } catch (error) {
    // A report that could not be filed does not change the order: the venue is the record
    // of what happened, and the response still carries the report to the owner.
    loggerFor("/api/trading/orders").error("the pre-trade report could not be audited", { error, venue: input.venueId });
  }
}

export async function GET(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "Order directory is unavailable." }, 503);
  }

  const params = new URL(request.url).searchParams;
  const filter = parseStatusFilter(params.get("status"));
  if (!filter.valid) return json({ error: filter.error }, 400);
  const limit = parseLimit(params.get("limit"), 25, 100);

  try {
    const orders = await orderStore().listOrders({
      userId: user.id,
      ...(filter.statuses.length > 0 ? { statuses: filter.statuses } : {}),
      limit,
    });
    const venue = await venueFacts();
    return json({
      orders: orders.map(orderResource),
      count: orders.length,
      lifecycle: lifecycleResource(),
      venue,
      retry: {
        detail: describeOrderRetryPolicy(),
      },
      reconciliation: {
        intervalMinutes: getOrderReconcileIntervalMinutes(),
        cadence: describeOrderReconcileCadence(),
        detail:
          "Any order that is not terminal is looked up at the venue on the runner's next pass; when the two disagree, both values are recorded.",
      },
    });
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "Order directory is unavailable." }, 503);
  }
}

export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let user;
  try {
    user = await requireUser();
    // Placing an order is the action the trading scope guards. The check is here,
    // before the body is read, so a submission that owes a code costs nothing and
    // cannot half-happen: nothing is validated, reserved or sent until the code
    // is satisfied.
    await assertScopeVerified("trading");
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "User authorization is unavailable." }, 503);
  }

  // The order path is the other place a request can move money. Counted per account, before
  // the body is parsed, so the limit is a property of the caller rather than of the payload.
  const limit = consumeRateLimit(`money.order:${user.id}`, RATE_LIMITS.orderCreatePerMinute);
  if (!limit.allowed) {
    return rateLimitResponse(
      limit,
      `Too many order submissions: ${limit.limit} per minute. Try again in ${limit.retryAfterSeconds} seconds.`,
    );
  }

  const parsed = await readJson(request);
  if ("response" in parsed) return parsed.response;

  const credential = await refuseReadOnlyCredential(parsed.body, user);
  if ("response" in credential) return credential.response;

  const validation = validateOrderSubmission(parsed.body, request.headers.get("idempotency-key"));
  if (!validation.valid) return json({ error: validation.error }, 400);

  // Where this order goes is decided here, before an order row exists: a live request with
  // the owner's switch off, or testnet routing on with no usable key, is an answer to the
  // request rather than a failed venue call after the fact. A refusal names the missing
  // thing and leaves nothing written — except, for a switch, the audit row that says the
  // switch blocked it.
  const requested: RequestedExecution | "auto" = validation.value.execution;
  const settings = await venueRoutingSettings();
  const resolution = await resolveOrderVenue(user.id, {
    ...(requested === "auto" ? {} : { requested }),
    ...(settings ? { settings: async () => settings } : {}),
  }).catch(() => null);
  if (!resolution) {
    return json({ error: "Order routing could not be read, so no order was sent.", code: "DATABASE_UNAVAILABLE" }, 503);
  }
  if (resolution.kind === "refused") {
    if (
      settings &&
      (resolution.code === LIVE_EXECUTION_DISABLED || resolution.code === TESTNET_ROUTING_DISABLED)
    ) {
      await auditSwitchRefusal({ userId: user.id, code: resolution.code, requested, settings });
    }
    return json(
      {
        error: resolution.error,
        code: resolution.code,
        requested,
        venue: await venueFacts(),
        switch: switchState(settings, resolution.code),
      },
      resolution.status,
    );
  }
  const venue = resolution.venue;

  // The pre-trade report is gathered before the venue is asked, so an outage it finds is
  // reported even when the submission that follows fails. Nothing in it can stop the
  // order: it is a report, and the venue's answer is what decides.
  const policy = await getRiskPolicySettings().catch(() => null);
  const preflight = await buildPreTradeReport({
    venue,
    ...(resolution.credential ? { credential: resolution.credential } : {}),
    policy,
    order: {
      market: validation.value.market,
      side: validation.value.side,
      quantity: validation.value.quantity,
      notionalUsdCents: validation.value.notionalUsdCents,
      verifiedBalanceCents: validation.value.verifiedBalanceCents,
    },
    openOrders: async () => orderStore().listOrders({ userId: user.id, limit: 100 }),
  });
  await auditPreflight({
    userId: user.id,
    venueId: venue.id,
    report: preflight,
    order: { market: validation.value.market, side: validation.value.side, quantity: validation.value.quantity },
  });

  // The dry comparison is a report for the owner and never a step in this path: it is
  // computed for a live order (where the two configurations can differ) and it places,
  // decrypts and contacts nothing.
  const comparison =
    resolution.source === "live" ? await describeTestnetComparison(user.id, validation.value.market).catch(() => null) : null;

  /**
   * Phase 25: the owner's limits and switches, before the order is placed.
   *
   * The same gate the strategy runner calls, with the same policy row and the same usage
   * arithmetic, so a cap proven on the trading page is the cap the strategy meets. A refusal
   * is an answer to the request with the limit, the value seen and the cap in it — and an
   * audit row — rather than a failed venue call: nothing has been reserved, sent or written
   * to an exchange by this point.
   */
  const authorisation = await authoriseOrder({
    userId: user.id,
    symbol: validation.value.market,
    notionalUsd: (validation.value.notionalUsdCents / 100).toFixed(2),
    venueId: venue.id,
    source: "manual",
    actorUserId: user.id,
  });
  if (authorisation.decision.decision === "REFUSE") {
    const switchBreach = authorisation.decision.limits.find((limit) => limit.reason === "kill-switch-active") ?? null;
    return json(
      {
        outcome: "refused",
        error: authorisation.sentence,
        code: "RISK_LIMIT_BLOCKED",
        reasons: authorisation.decision.reasons,
        limits: authorisation.decision.limits,
        switch: switchBreach
          ? {
              name: switchBreach.limit,
              state: true,
              scope: switchBreach.scope,
              panel: "/admin/risk",
            }
          : null,
        venue: await venueFacts(),
        routing: resolution.detail,
        preflight,
      },
      409,
    );
  }

  try {
    const outcome = await submitOrder(
      {
        intent: orderIntentFrom(validation.value, { userId: user.id, venue: venue.id }),
        actorUserId: user.id,
        origin: "manual",
        sourceNote: credential.credentialId
          ? `${ORDER_NOTE_PREFIX.tradePage} with credential ${credential.credentialId}, whose scope was checked first.`
          : `${ORDER_NOTE_PREFIX.tradePage}.`,
      },
      { venue },
    );

    return json(
      {
        outcome: outcome.kind,
        attempts: outcome.attempts,
        idempotencyKey: outcome.idempotencyKey,
        reason: outcome.reason,
        order: outcome.order ? orderResource(outcome.order) : null,
        venue: await venueFacts(),
        routing: resolution.detail,
        preflight,
        ...(comparison ? { testnetComparison: comparison } : {}),
      },
      outcome.status,
    );
  } catch (error) {
    // An illegal transition at this point means the row moved under us. The
    // refusal is reported with the state machine's own sentence rather than a
    // generic failure, and the request's log line carries the detail.
    loggerFor("/api/trading/orders").error("order submission was refused before any write", { error });
    return json(
      {
        outcome: "refused",
        error: error instanceof Error ? error.message : "The order was refused.",
        detail: "The server log for this request has the detail.",
      },
      409,
    );
  }
}
