import { NextRequest } from "next/server";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { authenticationGapResponse, getAccessRefusal } from "@/lib/auth/access-gate";
import { requireUser } from "@/lib/auth/session-store";
import { loggerFor } from "@/lib/observability/request-context";
import { reason, serializeReason } from "@/lib/observability/reason";
import { cancelWithdrawal } from "@/lib/withdrawals/confirm";
import { withdrawalResource } from "@/lib/withdrawals/service";
import { readPricedWithdrawalPolicy } from "@/lib/withdrawals/settings";
import { withdrawalStore } from "@/lib/withdrawals/store";

/**
 * `GET /api/withdrawals/[id]` and `POST /api/withdrawals/[id]` with `{"action":"cancel"}`.
 *
 * The read is scoped to the account: the row is looked up among the withdrawals this account
 * can see, so an id in the path is never an authorization — an account cannot read a
 * withdrawal it does not own, and gets 404 rather than a hint that one exists.
 *
 * The cancel is an **attempt**, and the response says which kind it was:
 *
 *  - **200 with `cancelled`** — nothing had been sent, so the amount went straight back to
 *    the balance. No chain, no fee.
 *  - **202 with `replacement-sent`** — the transfer is on chain, so a second, empty
 *    transaction was sent at the same nonce for a higher fee, which the network accepts
 *    *instead of* the first. Which one it mines is the chain's answer, so the reply says a
 *    replacement is in flight and the next pass settles it. Reporting this as cancelled
 *    would be a promise this route cannot keep.
 *  - **409** — the withdrawal has already ended, or the confirmation window has not passed
 *    yet and cancelling would spend a fee to cancel something that was about to arrive.
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

export async function GET(_request: NextRequest, { params }: RouteContext<"/api/withdrawals/[id]">) {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authError(error) ?? json({ error: "Withdrawals are unavailable." }, 503);
  }

  const { id } = await params;
  try {
    const policy = await readPricedWithdrawalPolicy();
    const visible = await withdrawalStore.listWithdrawalsForUser(user.id, 200);
    const row = visible.find((candidate) => candidate.id === id) ?? null;
    if (!row) return json({ error: `No withdrawal ${id} is visible to this account.` }, 404);
    return json({ withdrawal: withdrawalResource(row, { policy }) });
  } catch (error) {
    loggerFor("/api/withdrawals/[id]").error("withdrawal read failed", { error, id });
    return json({ error: "The withdrawal could not be read." }, 503);
  }
}

export async function POST(request: NextRequest, { params }: RouteContext<"/api/withdrawals/[id]">) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authError(error) ?? json({ error: "User authorization is unavailable." }, 503);
  }

  const { id } = await params;

  const raw = await request.text().catch(() => null);
  if (raw === null) return json({ error: "Invalid request body." }, 400);
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413);
  let body: unknown;
  try {
    body = raw.trim() ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  const action =
    typeof body === "object" && body !== null && typeof (body as Record<string, unknown>).action === "string"
      ? ((body as Record<string, unknown>).action as string).trim().toLowerCase()
      : "";
  if (action !== "cancel") {
    return json({ error: 'The only action this route accepts is {"action":"cancel"}.' }, 400);
  }

  try {
    const policy = await readPricedWithdrawalPolicy();
    const now = new Date();
    const visible = await withdrawalStore.listWithdrawalsForUser(user.id, 200);
    const row = visible.find((candidate) => candidate.id === id) ?? null;
    if (!row) return json({ error: `No withdrawal ${id} is visible to this account.` }, 404);

    const outcome = await cancelWithdrawal({ store: withdrawalStore, policy, row, now });
    const current = outcome.row ? ((await withdrawalStore.findWithdrawalById(row.id)) ?? outcome.row) : row;

    if (outcome.kind === "refused") {
      const refusal = outcome.reason ?? reason("UNKNOWN", { message: "The cancellation was refused." });
      return json({ outcome: outcome.kind, error: refusal.message, reason: serializeReason(refusal) }, 409);
    }
    if (outcome.kind === "noop") {
      return json({ outcome: outcome.kind, withdrawal: withdrawalResource(current, { policy, now }) }, 409);
    }
    return json(
      { outcome: outcome.kind, withdrawal: withdrawalResource(current, { policy, now }) },
      outcome.kind === "cancelled" ? 200 : 202,
    );
  } catch (error) {
    loggerFor("/api/withdrawals/[id]").error("withdrawal cancel failed", { error, id });
    return json({ error: "The cancellation could not be attempted." }, 503);
  }
}
