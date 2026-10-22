import DecimalJS from "decimal.js";
import { prisma } from "@/lib/db";
import { ApiProblem, isRecord } from "@/lib/api/problem";
import { publicOrderView, agentAccountForOwner, approvalView } from "@/lib/api/service";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";
import { coinbaseMarketData } from "@/lib/market-data/coinbase-service";
import { submitOrder } from "@/lib/orders/process";
import { ORDER_NOTE_PREFIX } from "@/lib/orders/origin";
import { resolveOrderVenue } from "@/lib/venues/registry";
import { authoriseOrder } from "@/lib/risk-controls/enforcement";
import { auditCreate } from "@/lib/audit/record";

/**
 * Agent trading (phase 32).
 *
 * Three rules are structural, not advisory:
 *
 *  - An API key has **one** tradeable account, stored on the key. A request that names a
 *    different `agentAccountId` is refused and recorded; there is no parameter that reaches
 *    the owner's main account.
 *  - The order belongs to the agent's own ledger user, so it appears in the agent's history
 *    and nowhere near the owner's orders.
 *  - An order above the agent account's approval threshold becomes a visible `AgentApproval`
 *    with an expiry, returned as 202. It is never a silent refusal and never an order.
 *
 * The venue is the paper venue deliberately. This build's public trade scope is a sandbox:
 * it proves scoping, history and approvals without giving an external agent a live exchange
 * key. A live agent would be a separate owner decision (and a credential), not something a
 * request can opt into.
 */

const Decimal = DecimalJS.clone({ precision: 40 });
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const MAX_QUANTITY = 1e12;
const MAX_CENTS = 1e12;
const MARKETS = new Set<string>(USD_WATCHLIST.map(({ productId }) => productId));

export const AGENT_APPROVAL_TTL_MINUTES = 30;

export type AgentOrderRequest = {
  market: string;
  side: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT";
  quantity: string;
  limitPrice: string | null;
  stopLossPrice: string;
};

export type AgentTradeActor = {
  ownerUserId: string;
  agentAccountId: string;
  apiKeyId: string | null;
  keyPrefix: string;
};

export type AgentOrderResult = {
  status: "placed" | "approval_required";
  order: ReturnType<typeof publicOrderView> | null;
  approval: ReturnType<typeof approvalView> | null;
  venue: { id: string; source: "paper" } | null;
  message: string;
};

function decimal(value: unknown, field: string, allowZero: boolean): string {
  if (typeof value !== "string") throw new ApiProblem(400, "ORDER_INVALID", `${field} must be a decimal string.`);
  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new ApiProblem(400, "ORDER_INVALID", `${field} must be a plain decimal, for example "0.01".`);
  }
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) throw new ApiProblem(400, "ORDER_INVALID", `${field} is not a readable number.`);
  if (allowZero ? numeric < 0 : numeric <= 0) {
    throw new ApiProblem(400, "ORDER_INVALID", `${field} must be ${allowZero ? "zero or more" : "greater than zero"}.`);
  }
  if (numeric > MAX_QUANTITY) throw new ApiProblem(400, "ORDER_INVALID", `${field} is larger than this API allows.`);
  return trimmed;
}

export function validateAgentOrder(body: unknown): AgentOrderRequest & { agentAccountId: string | null } {
  if (!isRecord(body)) throw new ApiProblem(400, "ORDER_INVALID", "The request body must be a JSON object.");
  if (typeof body.market !== "string" || !MARKETS.has(body.market.toUpperCase())) {
    throw new ApiProblem(400, "ORDER_INVALID", "Choose a supported Coinbase USD market.");
  }
  if (body.side !== "BUY" && body.side !== "SELL") throw new ApiProblem(400, "ORDER_INVALID", "Side must be BUY or SELL.");
  if (body.orderType !== "MARKET" && body.orderType !== "LIMIT") {
    throw new ApiProblem(400, "ORDER_INVALID", "Order type must be MARKET or LIMIT.");
  }
  const quantity = decimal(body.quantity, "Quantity", false);

  let limitPrice: string | null = null;
  if (body.orderType === "LIMIT") {
    limitPrice = decimal(body.limitPrice, "Limit price", false);
  } else if (body.limitPrice !== undefined && body.limitPrice !== null) {
    throw new ApiProblem(400, "ORDER_INVALID", "A MARKET order does not carry a limit price.");
  }

  const stopLossPrice =
    body.stopLossPrice === undefined || body.stopLossPrice === null ? "0" : decimal(body.stopLossPrice, "Stop-loss price", true);

  if (body.agentAccountId !== undefined && body.agentAccountId !== null && typeof body.agentAccountId !== "string") {
    throw new ApiProblem(400, "ORDER_INVALID", "agentAccountId must be a string when supplied.");
  }

  return {
    market: body.market.toUpperCase(),
    side: body.side,
    orderType: body.orderType,
    quantity,
    limitPrice,
    stopLossPrice,
    agentAccountId: typeof body.agentAccountId === "string" ? body.agentAccountId : null,
  };
}

/**
 * The one-account rule, as a pure decision so it can be tested without a database.
 *
 * This is checked before the price is read, before the risk policy is consulted and before
 * an order row exists. A refusal is recorded by {@link placeAgentOrder}; the test asserts
 * this decision and the audit payload it produces.
 */
export function agentAccountScopeRefusal(
  keyAgentAccountId: string,
  requestedAgentAccountId: string | null | undefined,
): ApiProblem | null {
  if (!requestedAgentAccountId || requestedAgentAccountId === keyAgentAccountId) return null;
  return new ApiProblem(
    403,
    "AGENT_ACCOUNT_SCOPE",
    `This key may trade only in agent account ${keyAgentAccountId}; the request named ${requestedAgentAccountId}. Nothing was sent.`,
    { keyAgentAccountId, requestedAgentAccountId },
  );
}

export function agentScopeAuditDetail(input: {
  keyPrefix: string;
  keyAgentAccountId: string;
  requestedAgentAccountId: string;
  market: string | null;
  notionalUsdCents: number | null;
}) {
  return {
    keyPrefix: input.keyPrefix,
    keyAgentAccountId: input.keyAgentAccountId,
    requestedAgentAccountId: input.requestedAgentAccountId,
    market: input.market,
    notionalUsdCents: input.notionalUsdCents,
    reason: "The API key may trade only inside its dedicated agent account.",
  };
}

async function writeAudit(input: {
  actorUserId: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  detail: Record<string, unknown>;
}) {
  try {
    await auditCreate(prisma, {
      data: {
        actorUserId: input.actorUserId,
        action: input.action,
        objectType: input.objectType,
        objectId: input.objectId,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify(input.detail),
      },
    });
  } catch {
    // The order/refusal has already been decided. An unavailable audit table must not
    // turn a refusal into an unhandled error, and the caller still receives the answer.
  }
}

async function marketPriceCents(request: AgentOrderRequest): Promise<number> {
  let price: string | null;
  if (request.orderType === "LIMIT") {
    price = request.limitPrice;
  } else {
    const quote = await coinbaseMarketData.getQuotes({ instruments: [request.market] });
    if (quote.status !== "available" || quote.data.length === 0) {
      throw new ApiProblem(
        503,
        "MARKET_DATA_UNAVAILABLE",
        `A market price for ${request.market} could not be read (${quote.status === "unavailable" ? quote.reason : "empty response"}), so no order was sent.`,
      );
    }
    const row = quote.data[0];
    price = row.last ?? row.ask ?? row.bid;
    if (!price) {
      throw new ApiProblem(503, "MARKET_DATA_UNAVAILABLE", `The quote for ${request.market} carried no price, so no order was sent.`);
    }
  }

  if (!price) {
    throw new ApiProblem(400, "ORDER_INVALID", "The order has no readable price, so no order was sent.");
  }
  const cents = new Decimal(request.quantity).mul(price).mul(100).ceil();
  const numeric = cents.toNumber();
  if (!Number.isSafeInteger(numeric) || numeric <= 0 || numeric > MAX_CENTS) {
    throw new ApiProblem(400, "ORDER_INVALID", "The order's notional is outside the range this API accepts.");
  }
  return numeric;
}

export async function placeAgentOrder(input: {
  actor: AgentTradeActor;
  body: unknown;
  now?: Date;
  /** Set only while executing a decision the owner already made. */
  approvalId?: string;
}): Promise<AgentOrderResult> {
  const now = input.now ?? new Date();
  const request = validateAgentOrder(input.body);

  const scopeRefusal = agentAccountScopeRefusal(input.actor.agentAccountId, request.agentAccountId);
  if (scopeRefusal) {
    await writeAudit({
      actorUserId: input.actor.ownerUserId,
      action: "API_AGENT_SCOPE_REFUSED",
      objectType: "AgentAccount",
      objectId: request.agentAccountId,
      detail: agentScopeAuditDetail({
        keyPrefix: input.actor.keyPrefix,
        keyAgentAccountId: input.actor.agentAccountId,
        requestedAgentAccountId: request.agentAccountId!,
        market: request.market,
        notionalUsdCents: null,
      }),
    });
    throw scopeRefusal;
  }

  const account = await agentAccountForOwner(input.actor.ownerUserId, input.actor.agentAccountId);
  if (!account) throw new ApiProblem(404, "AGENT_ACCOUNT_NOT_FOUND", "The agent account named by this key no longer exists.");
  if (account.status !== "ACTIVE") {
    throw new ApiProblem(403, "AGENT_ACCOUNT_SUSPENDED", `The agent account is ${account.status.toLowerCase()}; no order was sent.`);
  }

  const notionalUsdCents = await marketPriceCents(request);
  const notionalUsd = (notionalUsdCents / 100).toFixed(2);

  const authorisation = await authoriseOrder({
    userId: account.ledgerUserId,
    symbol: request.market,
    notionalUsd,
    venueId: null,
    source: "manual",
    actorUserId: input.actor.ownerUserId,
    now,
  });
  if (authorisation.decision.decision === "REFUSE") {
    await writeAudit({
      actorUserId: input.actor.ownerUserId,
      action: "API_AGENT_ORDER_REFUSED",
      objectType: "AgentAccount",
      objectId: account.id,
      detail: {
        keyPrefix: input.actor.keyPrefix,
        market: request.market,
        notionalUsdCents,
        reasons: authorisation.decision.reasons,
      },
    });
    throw new ApiProblem(409, "RISK_LIMIT_BLOCKED", authorisation.sentence ?? "The owner's risk policy refused this order.", {
      reasons: authorisation.decision.reasons,
      limits: authorisation.decision.limits,
    });
  }

  const threshold = account.approvalThresholdUsdCents;
  if (!input.approvalId && threshold !== null && notionalUsdCents > threshold) {
    const expiresAt = new Date(now.getTime() + AGENT_APPROVAL_TTL_MINUTES * 60 * 1000);
    const approval = await prisma.agentApproval.create({
      data: {
        ownerUserId: input.actor.ownerUserId,
        agentAccountId: account.id,
        apiKeyId: input.actor.apiKeyId,
        status: "PENDING",
        requestJson: JSON.stringify({ ...request, notionalUsdCents }),
        market: request.market,
        side: request.side,
        quantity: request.quantity,
        notionalUsdCents,
        expiresAt,
      },
      select: {
        id: true,
        status: true,
        market: true,
        side: true,
        quantity: true,
        notionalUsdCents: true,
        expiresAt: true,
        createdAt: true,
        decidedAt: true,
        orderId: true,
        agentAccountId: true,
        decisionNote: true,
        agentAccount: { select: { name: true } },
        apiKey: { select: { prefix: true } },
      },
    });
    await writeAudit({
      actorUserId: input.actor.ownerUserId,
      action: "API_AGENT_APPROVAL_REQUESTED",
      objectType: "AgentApproval",
      objectId: approval.id,
      detail: {
        keyPrefix: input.actor.keyPrefix,
        agentAccountId: account.id,
        market: request.market,
        notionalUsdCents,
        expiresAt: expiresAt.toISOString(),
      },
    });
    return {
      status: "approval_required",
      order: null,
      approval: approvalView(approval, now),
      venue: null,
      message:
        `This order is $${notionalUsd} and the agent account's approval threshold is $${(threshold / 100).toFixed(2)}. ` +
        `A pending approval was created and expires at ${expiresAt.toISOString()}. Nothing was sent.`,
    };
  }

  const resolution = await resolveOrderVenue(account.ledgerUserId, { requested: "paper" });
  if (resolution.kind !== "resolved") {
    throw new ApiProblem(resolution.status, resolution.code, resolution.error);
  }
  if (resolution.source !== "paper") {
    throw new ApiProblem(503, "PAPER_VENUE_UNAVAILABLE", "The agent trade path resolves only the paper venue; no order was sent.");
  }
  const venue = resolution.venue;

  const outcome = await submitOrder(
    {
      intent: {
        userId: account.ledgerUserId,
        venue: venue.id,
        market: request.market,
        side: request.side,
        orderType: request.orderType,
        quantity: request.quantity,
        limitPrice: request.limitPrice,
        stopLossPrice: request.stopLossPrice,
        notionalUsdCents,
        verifiedBalanceCents: notionalUsdCents,
        clientKey: null,
      },
      actorUserId: input.actor.ownerUserId,
      origin: "api",
      sourceNote: `${ORDER_NOTE_PREFIX.api}${input.actor.keyPrefix} in agent account ${account.name}.`,
    },
    { venue },
  );

  if (!outcome.order) {
    await writeAudit({
      actorUserId: input.actor.ownerUserId,
      action: "API_AGENT_ORDER_REFUSED",
      objectType: "AgentAccount",
      objectId: account.id,
      detail: {
        keyPrefix: input.actor.keyPrefix,
        market: request.market,
        notionalUsdCents,
        code: outcome.reason.code,
        message: outcome.reason.message,
      },
    });
    throw new ApiProblem(outcome.status, outcome.reason.code, outcome.reason.message);
  }

  await writeAudit({
    actorUserId: input.actor.ownerUserId,
    action: "API_AGENT_ORDER_SUBMITTED",
    objectType: "TradeOrder",
    objectId: outcome.order.id,
    detail: {
      keyPrefix: input.actor.keyPrefix,
      agentAccountId: account.id,
      market: outcome.order.market,
      side: outcome.order.side,
      status: outcome.order.status,
      notionalUsdCents,
      venue: outcome.order.venue,
    },
  });

  return {
    status: "placed",
    order: publicOrderView(outcome.order),
    approval: null,
    venue: { id: venue.id, source: "paper" },
    message: `${outcome.kind === "replayed" ? "The original" : "The"} paper order is ${outcome.order.status} in agent account ${account.name}.`,
  };
}

export async function decideAgentApproval(input: {
  approvalId: string;
  ownerUserId: string;
  actorUserId: string;
  decision: "APPROVE" | "DENY";
  note?: string | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const row = await prisma.agentApproval.findUnique({
    where: { id: input.approvalId },
    select: {
      id: true,
      ownerUserId: true,
      agentAccountId: true,
      apiKeyId: true,
      status: true,
      requestJson: true,
      expiresAt: true,
      agentAccount: { select: { name: true } },
      apiKey: { select: { prefix: true } },
    },
  });
  if (!row || row.ownerUserId !== input.ownerUserId) {
    throw new ApiProblem(404, "APPROVAL_NOT_FOUND", "That approval does not exist for this owner.");
  }
  if (row.status !== "PENDING") {
    throw new ApiProblem(409, "APPROVAL_ALREADY_DECIDED", `This approval is already ${row.status.toLowerCase()}.`);
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    await prisma.agentApproval.updateMany({
      where: { id: row.id, status: "PENDING" },
      data: { status: "EXPIRED", decidedAt: now, decidedByUserId: input.actorUserId },
    });
    throw new ApiProblem(409, "APPROVAL_EXPIRED", `This approval expired at ${row.expiresAt.toISOString()}.`);
  }

  if (input.decision === "DENY") {
    const updated = await prisma.agentApproval.updateMany({
      where: { id: row.id, status: "PENDING" },
      data: {
        status: "DENIED",
        decidedAt: now,
        decidedByUserId: input.actorUserId,
        decisionNote: input.note?.slice(0, 500) ?? null,
      },
    });
    if (updated.count === 0) throw new ApiProblem(409, "APPROVAL_ALREADY_DECIDED", "This approval was decided by another request.");
    await writeAudit({
      actorUserId: input.actorUserId,
      action: "API_AGENT_APPROVAL_DENIED",
      objectType: "AgentApproval",
      objectId: row.id,
      detail: { agentAccountId: row.agentAccountId, note: input.note ?? null },
    });
    return { status: "DENIED" as const, orderId: null };
  }

  const claimed = await prisma.agentApproval.updateMany({
    where: { id: row.id, status: "PENDING" },
    data: { status: "APPROVED", decidedAt: now, decidedByUserId: input.actorUserId },
  });
  if (claimed.count === 0) throw new ApiProblem(409, "APPROVAL_ALREADY_DECIDED", "This approval was decided by another request.");

  try {
    const result = await placeAgentOrder({
      actor: {
        ownerUserId: row.ownerUserId,
        agentAccountId: row.agentAccountId,
        apiKeyId: row.apiKeyId,
        keyPrefix: row.apiKey?.prefix ?? "owner-approval",
      },
      body: JSON.parse(row.requestJson) as unknown,
      approvalId: row.id,
      now,
    });
    if (!result.order) throw new ApiProblem(503, "APPROVAL_EXECUTION_FAILED", "The approved order did not produce an order row.");
    await prisma.agentApproval.update({
      where: { id: row.id },
      data: {
        status: "EXECUTED",
        orderId: result.order.id,
        decisionNote: input.note?.slice(0, 500) ?? null,
      },
    });
    await writeAudit({
      actorUserId: input.actorUserId,
      action: "API_AGENT_APPROVAL_EXECUTED",
      objectType: "AgentApproval",
      objectId: row.id,
      detail: { orderId: result.order.id, agentAccountId: row.agentAccountId },
    });
    return { status: "EXECUTED" as const, orderId: result.order.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The approved order could not be placed.";
    await prisma.agentApproval.update({
      where: { id: row.id },
      data: { status: "FAILED", decisionNote: message.slice(0, 500) },
    });
    throw error;
  }
}
