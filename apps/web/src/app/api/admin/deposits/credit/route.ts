import { NextRequest } from "next/server";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { getAccessRefusal, authenticationGapResponse } from "@/lib/auth/access-gate";
import { requireAdmin } from "@/lib/auth/session-store";
import { creditDepositAtValuation } from "@/lib/deposits/manual-credit";
import { depositStore } from "@/lib/deposits/store";

/**
 * Credit one arrival the network does not configure, at a USDT value the owner names.
 *
 * The row is only creditable while it is `AWAITING_VALUATION`; everything else is
 * answered with the state it is in. The amount is the owner's, not a quote: the whole
 * reason this door is manual is that the code cannot prove what an arbitrary token is
 * worth, and a feed at credit time would be a way to pay a fortune for a fake.
 *
 * The ledger movement, the row's move to `CREDITED` and the audit event happen in one
 * transaction inside the service. This route only decides who may ask.
 */

const MAX_BODY_BYTES = 1_024;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authErrorResponse(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal ? json({ error: refusal.error }, refusal.status) : null;
}

export async function POST(request: NextRequest) {
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

  const rawBody = await request.text().catch(() => null);
  if (rawBody === null) return json({ error: "Invalid request body." }, 400);
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413);

  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Send { depositId, usdAmount }." }, 400);
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "depositId,usdAmount" || typeof record.depositId !== "string" || typeof record.usdAmount !== "string") {
    return json({ error: "The accepted fields are depositId and usdAmount, both strings." }, 400);
  }
  if (!record.depositId.trim()) return json({ error: "A deposit id is required." }, 400);

  try {
    const outcome = await creditDepositAtValuation({
      store: depositStore,
      depositId: record.depositId.trim(),
      usdAmount: record.usdAmount,
      actorUserId: admin.id,
    });
    if (!outcome.credited) return json({ error: outcome.error }, 409);
    return json({ credited: true, ledgerTransactionId: outcome.ledgerTransactionId, amountMinor: outcome.amountMinor });
  } catch {
    return json({ error: "The credit could not be posted, so nothing changed." }, 503);
  }
}
