import { ApiProblem, ApiResult } from "@/lib/api/problem";
import type { ApiPrincipal } from "@/lib/api/auth";
import type { ApiScope } from "@/lib/api/keys";
import {
  listAgentApprovals,
  readAccount,
  readAgent,
  readAlerts,
  readBalances,
  readLedgerHistory,
  readMarketData,
  readOrders,
  readPortfolio,
  readPositions,
  readStrategies,
} from "@/lib/api/service";
import { placeAgentOrder } from "@/lib/api/trading";

/**
 * The public API's routes, as one table.
 *
 * The versioned handler dispatches from this array and `/docs/api` renders from the same
 * array, so a route cannot exist without documentation and a documented route cannot
 * disappear from the handler. Each entry names the one scope it requires; the handler
 * enforces it before calling the service.
 *
 * Only reads and the one agent-order write exist. There is deliberately no route that
 * targets the owner's main account, no key-management route (that stays behind the admin
 * session) and no withdrawal or transfer surface.
 */

export type ApiRouteContext = {
  principal: ApiPrincipal;
  query: URLSearchParams;
  body: unknown;
  request: Request;
  now: Date;
};

export type ApiField = {
  name: string;
  type: string;
  required?: boolean;
  description: string;
};

export type ApiRouteSpec = {
  method: "GET" | "POST";
  /** Relative to `/api/v1`, starting with a slash. */
  path: string;
  summary: string;
  description: string;
  scope: ApiScope;
  query: ApiField[];
  body: ApiField[] | null;
  response: Record<string, unknown>;
  handler: (context: ApiRouteContext) => Promise<unknown>;
};

function queryValue(query: URLSearchParams, name: string): string | null {
  return query.get(name);
}

export const API_ROUTES: readonly ApiRouteSpec[] = [
  {
    method: "GET",
    path: "/account",
    summary: "The owner's account view",
    description:
      "Balances, positions, profit and loss, the period summary, filtered history and the totals that explain it. The same figures the owner's account page and CSV export carry.",
    scope: "read",
    query: [
      { name: "from", type: "date", description: "Start of the history range (default 30 days ago)." },
      { name: "to", type: "date", description: "End of the history range (default now)." },
      { name: "asset", type: "string", description: "Restrict history to one asset." },
      { name: "type", type: "string", description: "Comma-separated history types." },
      { name: "hash", type: "string", description: "Filter to a transaction hash." },
    ],
    body: null,
    response: {
      readAt: "2026-10-19T18:00:00.000Z",
      range: { from: "2026-09-19T18:00:00.000Z", to: "2026-10-19T18:00:00.000Z" },
      balances: [{ asset: "USDT", decimals: 6, available: "20.000000" }],
      positions: [],
      pnl: { realized: "0.00", unrealized: "0.00" },
      summary: {},
      history: [],
      totals: [],
    },
    async handler({ principal, query, now }) {
      return readAccount(
        principal.ownerUserId,
        {
          from: queryValue(query, "from"),
          to: queryValue(query, "to"),
          asset: queryValue(query, "asset"),
          type: queryValue(query, "type"),
          hash: queryValue(query, "hash"),
        },
        now,
      );
    },
  },
  {
    method: "GET",
    path: "/balances",
    summary: "Ledger balances",
    description: "What the owner holds per asset, derived from the ledger entries rather than a stored column.",
    scope: "read",
    query: [],
    body: null,
    response: { readAt: "2026-10-19T18:00:00.000Z", balances: [{ asset: "USDT", decimals: 6, available: "20.000000" }] },
    async handler({ principal }) {
      return readBalances(principal.ownerUserId);
    },
  },
  {
    method: "GET",
    path: "/portfolio",
    summary: "Portfolio snapshot",
    description:
      "Balances, open positions with their marks, profit and loss, and the source of every figure. A mark that could not be read is reported in markFailure rather than estimated.",
    scope: "read",
    query: [
      { name: "from", type: "date", description: "Start of the period (default 30 days ago)." },
      { name: "to", type: "date", description: "End of the period (default now)." },
    ],
    body: null,
    response: { readAt: "2026-10-19T18:00:00.000Z", balances: [], positions: [], pnl: {}, summary: {}, markFailure: null },
    async handler({ principal, query, now }) {
      return readPortfolio(
        principal.ownerUserId,
        { from: queryValue(query, "from"), to: queryValue(query, "to") },
        now,
      );
    },
  },
  {
    method: "GET",
    path: "/positions",
    summary: "Open positions",
    description: "Positions built from every fill, with cost basis and the latest mark. Absent marks are named, not invented.",
    scope: "read",
    query: [],
    body: null,
    response: { readAt: "2026-10-19T18:00:00.000Z", positions: [], markFailure: null },
    async handler({ principal, now }) {
      return readPositions(principal.ownerUserId, {}, now);
    },
  },
  {
    method: "GET",
    path: "/ledger",
    summary: "Ledger statement",
    description:
      "Balances and the balanced statement for a date range, with counterparties and per-asset opening, net and closing figures. The range is capped at 366 days.",
    scope: "read",
    query: [
      { name: "from", type: "date", description: "Start of the statement (default 30 days ago)." },
      { name: "to", type: "date", description: "End of the statement (default now)." },
    ],
    body: null,
    response: {
      readAt: "2026-10-19T18:00:00.000Z",
      balances: [],
      statement: { from: "2026-09-19T18:00:00.000Z", to: "2026-10-19T18:00:00.000Z", lines: [], totals: [] },
    },
    async handler({ principal, query, now }) {
      return readLedgerHistory(
        principal.ownerUserId,
        { from: queryValue(query, "from"), to: queryValue(query, "to") },
        now,
      );
    },
  },
  {
    method: "GET",
    path: "/orders",
    summary: "Order history",
    description:
      "The owner's orders, newest first. Pass agentAccountId to read a dedicated agent account's orders instead; the account must belong to the key's owner.",
    scope: "read",
    query: [
      { name: "limit", type: "integer", description: "1–100, default 25." },
      { name: "status", type: "string", description: "Comma-separated order statuses." },
      { name: "agentAccountId", type: "string", description: "Read one agent account's orders." },
    ],
    body: null,
    response: { account: { kind: "owner" }, orders: [], count: 0 },
    async handler({ principal, query }) {
      const limitRaw = queryValue(query, "limit");
      return readOrders(principal.ownerUserId, {
        limit: limitRaw === null ? undefined : Number(limitRaw),
        status: queryValue(query, "status"),
        agentAccountId: queryValue(query, "agentAccountId"),
      });
    },
  },
  {
    method: "GET",
    path: "/strategies",
    summary: "Strategies and activation",
    description:
      "This account's saved definition versions (without prompt traces) and the current smart-trading activation, including its last pass and placement mode.",
    scope: "read",
    query: [],
    body: null,
    response: { definitions: [], activation: { state: "STOPPED" } },
    async handler({ principal }) {
      return readStrategies(principal.ownerUserId);
    },
  },
  {
    method: "GET",
    path: "/alerts",
    summary: "Market alerts",
    description: "The account's alert rules with their condition, last observed value, last evaluation and cooldown.",
    scope: "read",
    query: [{ name: "limit", type: "integer", description: "1–100, default 50." }],
    body: null,
    response: { alerts: [], count: 0 },
    async handler({ principal, query }) {
      return readAlerts(principal.ownerUserId, queryValue(query, "limit") ?? undefined);
    },
  },
  {
    method: "GET",
    path: "/market-data",
    summary: "Market quotes",
    description:
      "Coinbase USD quotes for the watchlist, with provider provenance and freshness. An unavailable provider is a 503 that names the reason; no stale price is substituted.",
    scope: "read",
    query: [{ name: "symbols", type: "string", description: "Comma-separated markets, default the watchlist." }],
    body: null,
    response: { readAt: "2026-10-19T18:00:00.000Z", quotes: [] },
    async handler({ query }) {
      return readMarketData(queryValue(query, "symbols"));
    },
  },
  {
    method: "GET",
    path: "/agent",
    summary: "The key's dedicated agent account",
    description:
      "The agent account this key names: its approval threshold, balances, orders and approval records. Requires the agent scope.",
    scope: "agent",
    query: [],
    body: null,
    response: {
      account: { id: "agent_...", name: "Research agent", status: "ACTIVE", approvalThresholdUsdCents: null },
      balances: [],
      orders: [],
      approvals: [],
    },
    async handler({ principal, now }) {
      return readAgent(principal, now);
    },
  },
  {
    method: "GET",
    path: "/approvals",
    summary: "Pending and decided approvals",
    description:
      "Approval records owned by this key's owner, newest first. An approval past its expiry is reported as EXPIRED; its expiry is always present.",
    scope: "read",
    query: [
      { name: "status", type: "string", description: "PENDING, APPROVED, EXECUTED, DENIED, EXPIRED or FAILED." },
      { name: "agentAccountId", type: "string", description: "Restrict to one agent account." },
    ],
    body: null,
    response: { approvals: [], count: 0 },
    async handler({ principal, query, now }) {
      const approvals = await listAgentApprovals(principal.ownerUserId, {
        status: queryValue(query, "status"),
        agentAccountId: queryValue(query, "agentAccountId"),
        now,
      });
      return { approvals, count: approvals.length };
    },
  },
  {
    method: "POST",
    path: "/orders",
    summary: "Place an order in the key's agent account",
    description:
      "Places a paper order on behalf of the key's dedicated agent account. The notional is computed from the market quote (or the limit price), never supplied by the caller. A request naming another account is refused and audited; an order above the account's approval threshold returns 202 with a pending approval and its expiry.",
    scope: "trade",
    query: [],
    body: [
      { name: "market", type: "string", required: true, description: "A supported Coinbase USD market, e.g. BTC-USD." },
      { name: "side", type: "string", required: true, description: "BUY or SELL." },
      { name: "orderType", type: "string", required: true, description: "MARKET or LIMIT." },
      { name: "quantity", type: "string", required: true, description: "Base-unit quantity as a decimal string." },
      { name: "limitPrice", type: "string", description: "Required for LIMIT, refused for MARKET." },
      { name: "stopLossPrice", type: "string", description: "Optional stop price." },
      { name: "agentAccountId", type: "string", description: "Must match the key's agent account when supplied." },
    ],
    response: {
      status: "placed",
      order: { id: "ord_...", market: "BTC-USD", side: "BUY", status: "SUBMITTED" },
      approval: null,
      venue: { id: "paper", source: "paper" },
    },
    async handler({ principal, body, now }) {
      if (!principal.agentAccountId) {
        throw new ApiProblem(
          403,
          "AGENT_ACCOUNT_REQUIRED",
          "The trade scope only places orders in a dedicated agent account, and this key names none.",
        );
      }
      const result = await placeAgentOrder({
        actor: {
          ownerUserId: principal.ownerUserId,
          agentAccountId: principal.agentAccountId,
          apiKeyId: principal.keyId,
          keyPrefix: principal.keyPrefix,
        },
        body,
        now,
      });
      return result.status === "approval_required" ? new ApiResult(202, result) : result;
    },
  },
];

export function findApiRoute(method: string, path: string, routes: readonly ApiRouteSpec[] = API_ROUTES): ApiRouteSpec | null {
  return routes.find((route) => route.method === method && route.path === path) ?? null;
}
