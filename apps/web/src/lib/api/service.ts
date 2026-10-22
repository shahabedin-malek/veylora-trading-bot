import { prisma } from "@/lib/db";
import { ApiProblem } from "@/lib/api/problem";
import type { ApiPrincipal } from "@/lib/api/auth";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";
import { coinbaseMarketData } from "@/lib/market-data/coinbase-service";
import { balancesForUser } from "@/lib/ledger/statements";
import { readLedgerView } from "@/lib/ledger/statements";
import { ledgerStore } from "@/lib/ledger/store";
import { orderStore, type StoredOrder } from "@/lib/orders/store";
import { isOrderStatus, type OrderStatus } from "@/lib/orders/state-machine";
import { MAX_RANGE_DAYS, parseHistoryFilter } from "@/lib/portfolio/pnl";
import { accountPayload, readAccountView } from "@/lib/portfolio/service";
import { getStrategyActivationView } from "@/lib/strategies/activation";
import { listStrategyDefinitions } from "@/lib/strategies/repository";

/**
 * The public API's read surface, in one place.
 *
 * Both the REST routes and the MCP tools call these functions, which is the requirement
 * that the two surfaces cannot drift: a field an API caller can read is a field the MCP
 * client can read, and a refusal names the same code in both.
 *
 * Everything is scoped by an explicit owner id passed in by the caller — never by a query
 * parameter. The only way to ask for an agent's history is `agentAccountId` that the
 * authenticated key itself owns, checked by {@link requireAgentAccount}.
 */

export const DEFAULT_ORDER_LIMIT = 25;
export const MAX_ORDER_LIMIT = 100;

const MARKET_SYMBOLS = new Set<string>(USD_WATCHLIST.map(({ productId }) => productId));

export function parseLimit(value: unknown, fallback = DEFAULT_ORDER_LIMIT): number {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_ORDER_LIMIT) {
    throw new ApiProblem(400, "LIMIT_INVALID", `limit must be a whole number between 1 and ${MAX_ORDER_LIMIT}.`);
  }
  return numeric;
}

function filterFrom(query: { from?: string | null; to?: string | null; asset?: string | null; type?: string | null; hash?: string | null }, now: Date) {
  const parsed = parseHistoryFilter(
    {
      from: query.from ?? null,
      to: query.to ?? null,
      asset: query.asset ?? null,
      type: query.type ?? null,
      hash: query.hash ?? null,
    },
    now,
  );
  if (!parsed.valid) throw new ApiProblem(400, "FILTER_INVALID", parsed.error);
  return parsed.filter;
}

export async function readAccount(
  ownerUserId: string,
  query: { from?: string | null; to?: string | null; asset?: string | null; type?: string | null; hash?: string | null },
  now = new Date(),
) {
  const filter = filterFrom(query, now);
  const view = await readAccountView({ userId: ownerUserId, filter, now });
  return { userId: ownerUserId, ...accountPayload(view) };
}

/**
 * A ledger balance, as JSON can carry it.
 *
 * `balanceMinor` and `creditLineMinor` are `bigint` in the ledger, and `JSON.stringify`
 * throws on a bigint. Rendering them as decimal strings keeps the exact figure (a balance
 * must never be rounded through a float) and is why this mapper exists rather than a
 * blanket replacer: every other field is already JSON-safe.
 */
export function balanceView(balance: Awaited<ReturnType<typeof balancesForUser>>[number]) {
  return {
    accountId: balance.accountId,
    code: balance.code,
    ownerType: balance.ownerType,
    bucket: balance.bucket,
    asset: balance.asset,
    decimals: balance.decimals,
    label: balance.label,
    balanceMinor: balance.balanceMinorText,
    balance: balance.decimal,
    entryCount: balance.entryCount,
    creditLineMinor: balance.creditLineMinor === null ? null : balance.creditLineMinor.toString(),
  };
}

export async function readBalances(ownerUserId: string) {
  return {
    balances: (await balancesForUser(ledgerStore, ownerUserId)).map(balanceView),
    readAt: new Date().toISOString(),
  };
}

export async function readPortfolio(
  ownerUserId: string,
  query: { from?: string | null; to?: string | null; asset?: string | null; type?: string | null; hash?: string | null },
  now = new Date(),
) {
  const filter = filterFrom(query, now);
  const view = await readAccountView({ userId: ownerUserId, filter, now });
  const payload = accountPayload(view);
  return {
    userId: ownerUserId,
    readAt: payload.readAt,
    range: payload.range,
    balances: payload.balances,
    positions: payload.positions,
    pnl: payload.pnl,
    summary: payload.summary,
    notes: payload.notes,
    markFailure: payload.markFailure,
    sources: payload.sources,
  };
}

export async function readPositions(
  ownerUserId: string,
  query: { from?: string | null; to?: string | null; asset?: string | null; type?: string | null; hash?: string | null },
  now = new Date(),
) {
  const filter = filterFrom(query, now);
  const view = await readAccountView({ userId: ownerUserId, filter, now });
  return {
    positions: view.overview.positions,
    markFailure: view.markFailure,
    readAt: view.overview.readAt,
  };
}

export async function readLedgerHistory(
  ownerUserId: string,
  query: { from?: string | null; to?: string | null },
  now = new Date(),
) {
  const filter = filterFrom({ from: query.from, to: query.to }, now);
  const view = await readLedgerView(ledgerStore, {
    userId: ownerUserId,
    from: filter.from,
    to: filter.to,
    now,
  });
  return {
    readAt: view.readAt,
    from: filter.from.toISOString(),
    to: filter.to.toISOString(),
    maxRangeDays: MAX_RANGE_DAYS,
    balances: view.balances.map(balanceView),
    statement: {
      ...view.statement,
      accounts: view.statement.accounts.map(balanceView),
    },
  };
}

export function publicOrderView(order: StoredOrder) {
  return {
    id: order.id,
    venue: order.venue,
    market: order.market,
    side: order.side,
    orderType: order.orderType,
    status: order.status,
    quantity: order.requestedQuantity,
    filledQuantity: order.filledQuantity,
    remainingQuantity: order.remainingQuantity,
    limitPrice: order.limitPrice,
    stopLossPrice: order.stopLossPrice,
    notionalUsdCents: order.notionalUsdCents,
    submittedAt: order.submittedAt,
    createdAt: order.createdAt,
    attempts: order.attempts,
  };
}

export function parseOrderStatuses(value: string | null | undefined): OrderStatus[] {
  if (!value) return [];
  const statuses = value.split(",").map((part) => part.trim().toUpperCase()).filter(Boolean);
  const unknown = statuses.filter((status) => !isOrderStatus(status));
  if (unknown.length > 0) {
    throw new ApiProblem(400, "STATUS_INVALID", `Unknown order status: ${unknown.join(", ")}.`);
  }
  return [...new Set(statuses)] as OrderStatus[];
}

export async function readOrders(
  ownerUserId: string,
  options: { limit?: number; status?: string | null; agentAccountId?: string | null },
) {
  const limit = parseLimit(options.limit);
  const statuses = parseOrderStatuses(options.status);
  let userId = ownerUserId;
  let agentAccount = null as Awaited<ReturnType<typeof agentAccountForOwner>> | null;

  if (options.agentAccountId && options.agentAccountId !== "owner") {
    agentAccount = await agentAccountForOwner(ownerUserId, options.agentAccountId);
    if (!agentAccount) {
      throw new ApiProblem(
        404,
        "AGENT_ACCOUNT_NOT_FOUND",
        "That agent account does not belong to this API key's owner.",
      );
    }
    userId = agentAccount.ledgerUserId;
  }

  const orders = await orderStore().listOrders({
    userId,
    ...(statuses.length > 0 ? { statuses } : {}),
    limit,
  });
  return {
    account: agentAccount ? { kind: "agent", id: agentAccount.id, name: agentAccount.name } : { kind: "owner" },
    orders: orders.map(publicOrderView),
    count: orders.length,
  };
}

export async function readStrategies(ownerUserId: string) {
  const [definitions, activation] = await Promise.all([
    listStrategyDefinitions(ownerUserId),
    getStrategyActivationView(ownerUserId),
  ]);
  return {
    definitions: definitions.map((definition) => ({
      id: definition.id,
      name: definition.name,
      version: definition.version,
      market: definition.market,
      timeframe: definition.timeframe,
      origin: definition.origin,
      text: definition.text,
      createdAt: definition.createdAt,
    })),
    activation: {
      id: activation.id,
      state: activation.state,
      stateLabel: activation.stateLabel,
      strategy: activation.strategy,
      startedAt: activation.startedAt,
      stoppedAt: activation.stoppedAt,
      lastPass: activation.lastPass,
      placement: activation.placement,
      reason: activation.reason,
    },
  };
}

export async function readAlerts(ownerUserId: string, limitInput?: unknown) {
  const limit = parseLimit(limitInput, 50);
  const alerts = await prisma.marketAlert.findMany({
    where: { userId: ownerUserId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      symbol: true,
      condition: true,
      threshold: true,
      status: true,
      cooldownMinutes: true,
      lastEvaluatedAt: true,
      lastObservedValue: true,
      conditionMet: true,
      triggeredAt: true,
      createdAt: true,
    },
  });
  return { alerts, count: alerts.length };
}

export async function readMarketData(symbolsInput?: string | null) {
  const requested = (symbolsInput ?? "")
    .split(",")
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
  const symbols = requested.length > 0 ? [...new Set(requested)] : USD_WATCHLIST.map(({ productId }) => productId);
  const unknown = symbols.filter((symbol) => !MARKET_SYMBOLS.has(symbol));
  if (unknown.length > 0) {
    throw new ApiProblem(
      400,
      "SYMBOL_UNKNOWN",
      `Unknown symbol: ${unknown.join(", ")}. Supported markets: ${[...MARKET_SYMBOLS].join(", ")}.`,
    );
  }

  const result = await coinbaseMarketData.getQuotes({ instruments: symbols });
  if (result.status !== "available") {
    throw new ApiProblem(
      503,
      "MARKET_DATA_UNAVAILABLE",
      `Market data is unavailable (${result.reason}). The response says why rather than returning an old price.`,
      { reason: result.reason, retryable: result.retryable },
    );
  }
  return { readAt: new Date().toISOString(), quotes: result.data };
}

export type AgentApprovalView = {
  id: string;
  status: string;
  effectiveStatus: string;
  expired: boolean;
  market: string;
  side: string;
  quantity: string;
  notionalUsdCents: number;
  expiresAt: string;
  createdAt: string;
  decidedAt: string | null;
  orderId: string | null;
  agentAccountId: string;
  agentAccountName: string;
  keyPrefix: string | null;
  decisionNote: string | null;
};

type ApprovalRow = {
  id: string;
  status: string;
  market: string;
  side: string;
  quantity: string;
  notionalUsdCents: number;
  expiresAt: Date;
  createdAt: Date;
  decidedAt: Date | null;
  orderId: string | null;
  agentAccountId: string;
  decisionNote: string | null;
  agentAccount: { name: string };
  apiKey: { prefix: string } | null;
};

/**
 * An approval is `EXPIRED` once its own clock passes, even though the stored status still
 * says `PENDING`. The derivation is on every read so an expired request never looks
 * actionable, and a later decision writes the same state it showed.
 */
export function approvalView(row: ApprovalRow, now = new Date()): AgentApprovalView {
  const expired = row.status === "PENDING" && row.expiresAt.getTime() <= now.getTime();
  return {
    id: row.id,
    status: row.status,
    effectiveStatus: expired ? "EXPIRED" : row.status,
    expired,
    market: row.market,
    side: row.side,
    quantity: row.quantity,
    notionalUsdCents: row.notionalUsdCents,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    orderId: row.orderId,
    agentAccountId: row.agentAccountId,
    agentAccountName: row.agentAccount.name,
    keyPrefix: row.apiKey?.prefix ?? null,
    decisionNote: row.decisionNote,
  };
}

export async function listAgentApprovals(
  ownerUserId: string,
  options: { status?: string | null; agentAccountId?: string | null; now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const rows = await prisma.agentApproval.findMany({
    where: {
      ownerUserId,
      ...(options.agentAccountId ? { agentAccountId: options.agentAccountId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
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
  const requestedStatus = options.status?.trim().toUpperCase() ?? null;
  return rows
    .map((row) => approvalView(row, now))
    .filter((row) => !requestedStatus || row.effectiveStatus === requestedStatus || row.status === requestedStatus);
}

export async function agentAccountForOwner(ownerUserId: string, agentAccountId: string) {
  return prisma.agentAccount.findFirst({
    where: { id: agentAccountId, ownerUserId },
    select: {
      id: true,
      name: true,
      status: true,
      approvalThresholdUsdCents: true,
      ledgerUserId: true,
      createdAt: true,
    },
  });
}

/** The agent account the authenticated key itself names, or a named refusal. */
export async function requireAgentAccount(principal: ApiPrincipal) {
  if (!principal.agentAccountId) {
    throw new ApiProblem(
      403,
      "AGENT_ACCOUNT_REQUIRED",
      "This key names no dedicated agent account, so it has nothing to trade or show here.",
    );
  }
  if (principal.agentAccountStatus && principal.agentAccountStatus !== "ACTIVE") {
    throw new ApiProblem(
      403,
      "AGENT_ACCOUNT_SUSPENDED",
      `The agent account for this key is ${principal.agentAccountStatus.toLowerCase()}. The owner can reactivate it.`,
    );
  }
  const account = await agentAccountForOwner(principal.ownerUserId, principal.agentAccountId);
  if (!account) {
    throw new ApiProblem(404, "AGENT_ACCOUNT_NOT_FOUND", "The agent account named by this key no longer exists.");
  }
  return account;
}

export async function readAgent(principal: ApiPrincipal, now = new Date()) {
  const account = await requireAgentAccount(principal);
  const [balances, orders, approvals] = await Promise.all([
    balancesForUser(ledgerStore, account.ledgerUserId),
    orderStore().listOrders({ userId: account.ledgerUserId, limit: MAX_ORDER_LIMIT }),
    listAgentApprovals(principal.ownerUserId, { agentAccountId: account.id, now }),
  ]);
  return {
    account: {
      id: account.id,
      name: account.name,
      status: account.status,
      approvalThresholdUsdCents: account.approvalThresholdUsdCents,
      createdAt: account.createdAt.toISOString(),
    },
    balances: balances.map(balanceView),
    orders: orders.map(publicOrderView),
    approvals,
    readAt: now.toISOString(),
  };
}
