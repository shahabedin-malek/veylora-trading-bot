import { NextRequest } from "next/server";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { authenticationGapResponse, getAccessRefusal } from "@/lib/auth/access-gate";
import { requireUser } from "@/lib/auth/session-store";
import { loggerFor } from "@/lib/observability/request-context";
import { consumeRateLimit, RATE_LIMITS, rateLimitResponse } from "@/lib/security/rate-limit";
import { reason, serializeReason, type Reason } from "@/lib/observability/reason";
import { senderWallet } from "@/lib/withdrawals/chain";
import type { WithdrawalPolicy } from "@/lib/withdrawals/policy";
import { requestWithdrawal } from "@/lib/withdrawals/request";
import { readPricedWithdrawalPolicy } from "@/lib/withdrawals/settings";
import { describeWithdrawalsForUser, runWithdrawalProcessor, withdrawalResource } from "@/lib/withdrawals/service";
import { withdrawalStore } from "@/lib/withdrawals/store";

/**
 * The withdrawal surface.
 *
 * `GET` is the read the panel makes: what the account can spend and what is already held,
 * every network it can be sent on with the fee each one costs, and the owner's own window,
 * timeout and expiry. A deployment with no sending wallet answers 200 with the gap named
 * rather than an error, because the page has to render an honest explanation — an
 * unconfigured seed is configuration, not a refusal, and a blank panel would say nothing.
 *
 * `POST` asks for a withdrawal, and `POST` with `{"action":"check"}` runs the processor for
 * this account's rows — the same pass the runner makes, on demand, which is what lets an
 * owner watch a held request leave its window and a sent one gather confirmations without
 * waiting for the next tick.
 *
 * The policy it works under is the deployment's own values with the owner's stored new-address
 * window on top when they have set one (see `withdrawals/settings.ts`), so the number the panel
 * shows as the hold in force is the number this route actually applies.
 *
 * Two things this route deliberately does *not* do. It does not require a step-up code or a
 * confirmation dialogue: phase 14's brief forbids an approval step in front of a withdrawal
 * the owner asked for, and a second code prompt is exactly that. And it takes nothing from
 * the caller that would let them *cause* a withdrawal other than by asking for one: a check
 * run reads the chains and advances rows this account already owns, so there is nothing in
 * it to abuse.
 */

const MAX_BODY_BYTES = 4_096;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authError(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal
    ? json(
        { error: refusal.error, ...(refusal.code ? { code: refusal.code } : {}), ...(refusal.scope ? { scope: refusal.scope } : {}) },
        refusal.status,
      )
    : null;
}

/**
 * The HTTP status a refusal is answered with.
 *
 * The caller's own mistakes are 400, a conflict with the account's state is 409, and the
 * deployment being unable to serve the request is 503 with the variable named. Nothing is
 * answered 2xx: a refusal that read as an acceptance is the one error a money path must not
 * make.
 */
export function withdrawalRefusalStatus(refusal: Reason): number {
  switch (refusal.code) {
    case "INVALID_AMOUNT":
    case "INVALID_DESTINATION":
      // A request that cannot be replayed is malformed, not in conflict with the account.
    case "MISSING_IDEMPOTENCY_KEY":
      return 400;
    case "INSUFFICIENT_BALANCE":
    case "IDEMPOTENCY_KEY_REUSED":
    case "ALREADY_RUNNING":
      return 409;
    case "NETWORK_UNSUPPORTED":
    case "MISSING_CONFIGURATION":
      return 503;
    default:
      return 400;
  }
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

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The sending wallet's address, or null when it cannot be derived. Never thrown from. */
function senderAddressOrNull(policy: WithdrawalPolicy): string | null {
  const resolved = senderWallet(policy);
  return resolved.ok ? resolved.address : null;
}

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authError(error) ?? json({ error: "Withdrawals are unavailable." }, 503);
  }

  try {
    const policy = await readPricedWithdrawalPolicy();
    const view = await describeWithdrawalsForUser({ userId: user.id, policy });
    return json(view);
  } catch (error) {
    loggerFor("/api/withdrawals").error("withdrawal view failed", { error });
    return json({ error: "Withdrawals are unavailable." }, 503);
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

  // A withdrawal is the one request that moves money out. The ceiling is per account and
  // counts every attempt, including the refused ones, so a loop of rejected destinations
  // cannot be used to probe the policy or to hammer the ledger lock.
  const limit = consumeRateLimit(`money.withdrawal:${user.id}`, RATE_LIMITS.withdrawalCreatePerMinute);
  if (!limit.allowed) {
    return rateLimitResponse(
      limit,
      `Too many withdrawal requests: ${limit.limit} per minute. Try again in ${limit.retryAfterSeconds} seconds.`,
    );
  }

  const parsed = await readJson(request);
  if ("response" in parsed) return parsed.response;
  const body = (typeof parsed.body === "object" && parsed.body !== null ? parsed.body : {}) as Record<string, unknown>;

  const policy = await readPricedWithdrawalPolicy();
  const now = new Date();

  // ── a check run, for an owner watching a withdrawal move ────────────────────
  if (asString(body.action) === "check") {
    try {
      const summary = await runWithdrawalProcessor({ policy, userId: user.id, now });
      const view = await describeWithdrawalsForUser({ userId: user.id, policy, now });
      return json({
        ...view,
        run: {
          live: summary.live,
          releasedFromHold: summary.releasedFromHold,
          broadcast: summary.broadcast,
          broadcastFailed: summary.broadcastFailed,
          confirmed: summary.confirmed,
          cancelled: summary.cancelled,
          failed: summary.failed,
          pending: summary.pending,
          worked: summary.worked,
          reason: summary.reason,
        },
      });
    } catch (error) {
      loggerFor("/api/withdrawals").error("withdrawal check failed", { error });
      return json({ error: "The withdrawal check could not complete." }, 503);
    }
  }

  // ── a withdrawal request ────────────────────────────────────────────────────
  const network = asString(body.network);
  const destination = asString(body.destination);
  const amount = asString(body.amount);
  // The header first, because an HTTP retry of this exact request must resolve to this
  // exact withdrawal; the body is the fallback for a caller that has no header to set.
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || asString(body.idempotencyKey) || "";
  if (!network || !destination || !amount) {
    return json({ error: "A withdrawal needs a network, a destination address and an amount." }, 400);
  }

  try {
    const outcome = await requestWithdrawal({
      store: withdrawalStore,
      policy,
      userId: user.id,
      network,
      destination,
      amount,
      idempotencyKey,
      now,
      hotWalletAddress: senderAddressOrNull(policy),
    });

    if (outcome.refused || !outcome.withdrawal) {
      const refusal = outcome.reason ?? reason("UNKNOWN", { message: "The withdrawal was refused." });
      const status = withdrawalRefusalStatus(refusal);
      return json({ error: refusal.message, reason: serializeReason(refusal), availableMinor: outcome.availableMinor }, status);
    }

    return json(
      { created: outcome.created, withdrawal: withdrawalResource(outcome.withdrawal, { policy, now }) },
      outcome.created ? 201 : 200,
    );
  } catch (error) {
    loggerFor("/api/withdrawals").error("withdrawal request failed", { error, network });
    return json({ error: "The withdrawal could not be requested.", detail: "The server log for this request has the detail." }, 503);
  }
}
