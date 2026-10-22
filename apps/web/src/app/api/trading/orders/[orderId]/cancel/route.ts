import { NextRequest } from "next/server";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { getAccessRefusal, authenticationGapResponse } from "@/lib/auth/access-gate";
import { requireUser } from "@/lib/auth/session-store";
import { assertScopeVerified } from "@/lib/auth/step-up";
import { orderResource, validateCancellation } from "@/lib/orders/api";
import { cancelOrder } from "@/lib/orders/process";
import { orderStore } from "@/lib/orders/store";
import { loggerFor } from "@/lib/observability/request-context";

/**
 * `POST /api/trading/orders/[orderId]/cancel`.
 *
 * Three answers are worth knowing about:
 *
 *  - **200** — the venue confirmed the cancel. An order that had already executed
 *    part of its quantity keeps that part, and the answer says so in as many
 *    words: the executed quantity is a trade, not something a cancel discards.
 *  - **409** — the lifecycle refuses the move, or the venue did. A terminal order
 *    is refused *before* the venue is contacted, and the refusal carries the state
 *    machine's own sentence.
 *  - **202** — the venue did not confirm. The order is left live rather than
 *    reported as cancelled, because a cancel the venue never confirmed would be
 *    undone by the next reconciliation, and the answer says exactly that.
 */

const MAX_BODY_BYTES = 4_096;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authErrorResponse(error: unknown) {
  const refusal = getAccessRefusal(error);
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

export async function POST(request: NextRequest, { params }: RouteContext<"/api/trading/orders/[orderId]/cancel">) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let user;
  try {
    user = await requireUser();
    // Cancelling is a trading action like placing one: the same scope guards both,
    // and a cancel that owes a code leaves the order untouched rather than
    // half-cancelled.
    await assertScopeVerified("trading");
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "User authorization is unavailable." }, 503);
  }

  const { orderId } = await params;
  const parsed = await readJson(request);
  if ("response" in parsed) return parsed.response;

  const validation = validateCancellation(parsed.body, request.headers.get("idempotency-key"));
  if (!validation.valid) return json({ error: validation.error }, 400);

  // Ownership is checked before the cancel reaches the venue. Phase 21 made the cancel
  // route resolve a venue from the *order's* owner, which is only correct if the caller is
  // that owner — so the check that was missing is now load-bearing, and an order that is
  // not this account's is reported as absent rather than forbidden (the same sentence a
  // credential uses, for the same reason: saying "forbidden" would confirm it exists).
  const owned = await orderStore().findOrderById(orderId).catch(() => null);
  if (!owned || owned.userId !== user.id) {
    return json({ error: "That order was not found on this account." }, 404);
  }

  try {
    const outcome = await cancelOrder({
      orderId,
      actorUserId: user.id,
      reason: validation.reason,
      clientKey: validation.clientKey,
    });
    return json(
      {
        outcome: outcome.kind,
        attempts: outcome.attempts,
        idempotencyKey: outcome.idempotencyKey,
        reason: outcome.reason,
        order: outcome.order ? orderResource(outcome.order) : null,
      },
      outcome.status,
    );
  } catch (error) {
    loggerFor("/api/trading/orders/[orderId]/cancel").error("order cancel failed", { error, orderId });
    return json({ error: "The cancel could not be completed.", detail: "The server log for this request has the detail." }, 503);
  }
}
