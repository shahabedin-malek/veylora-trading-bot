import DecimalJS from "decimal.js";
import { prisma } from "@/lib/db";
import { latestClosedRsi } from "@/lib/market-data/indicators";
import { ensureScreenData, loadScreenerCandles } from "@/lib/screener/service";
import { coinbaseMarketData } from "@/lib/market-data/coinbase-service";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";
import { ledgerStore } from "@/lib/ledger/store";
import { readLedgerView } from "@/lib/ledger/statements";
import { readAccountView } from "@/lib/portfolio/service";
import { isTerminalOrderStatus } from "@/lib/orders/state-machine";
import { orderStore } from "@/lib/orders/store";
import { orderIntentFrom, orderResource, validateOrderSubmission } from "@/lib/orders/api";
import { submitOrder } from "@/lib/orders/process";
import { ORDER_NOTE_PREFIX } from "@/lib/orders/origin";
import { authoriseOrder } from "@/lib/risk-controls/enforcement";
import { resolveOrderVenue } from "@/lib/venues/registry";
import { searchTavily, extractTavily, type TavilySearchResult, type TavilyTopic } from "@/lib/tavily/client";
import { consumeTavilyRequest } from "@/lib/tavily/rate-limit";
import {
  isSandbaseConfigured,
  searchSandbaseSocialPosts,
  type SandbaseSocialRead,
  type SandbaseSocialSort,
} from "@/lib/sandbase/client";
import { consumeSandbaseRequest } from "@/lib/sandbase/rate-limit";
import { getIntegrationFeatureSettings } from "@/lib/integrations/settings";
import type { ToolExecutor } from "@/lib/assistant/loop";
import type { AssistantCitation, AssistantToolFailure, AssistantToolRecord } from "@/lib/assistant/citations";

/**
 * The assistant's tools, and the only place they touch the world.
 *
 * Three properties are structural rather than advisory:
 *
 *  1. **The account is a parameter of the executor, never of the tool call.** `userId`
 *     arrives from the session when the executor is built; the arguments the model
 *     sends are filtered against the tool's own declared properties (`sanitiseArguments`),
 *     so a model that emits `{"userId": "someone-else"}` has that key dropped before any
 *     reader sees it. There is no code path in which a tool chooses whose data to read.
 *  2. **A failure is a value, not an exception.** Each handler returns either data with
 *     the citation that describes it or an error sentence; the executor records the
 *     failure so the answer can say which data is missing. Nothing falls back to a
 *     default number.
 *  3. **Writes are paper-only and gated by the same code as every other order.** The one
 *     mutating tool resolves routing, refuses anything but the paper venue *in code*,
 *     runs phase 25's `authoriseOrder`, and only then submits through the phase 06 path.
 *     The model cannot ask for live execution: the tool has no argument for it.
 *
 * Freshness travels with each citation (`asOf`, from the source's own observation), which
 * is what lets the panel say "ledger read at 03:12:04Z" instead of "now".
 */

const DAY_MS = 86_400_000;
const MAX_LEDGER_LINES = 20;
const MAX_CANDLES = 60;
const MAX_ROWS = 25;
const Decimal = DecimalJS.clone({ precision: 40 });

export type AssistantProperty = {
  type: "string" | "number" | "boolean";
  description: string;
  enum?: readonly string[];
};

export type AssistantToolSpec = {
  name: string;
  description: string;
  /** `account` tools refuse when there is no signed-in user; `public` tools do not. */
  scope: "account" | "public";
  parameters: {
    type: "object";
    properties: Record<string, AssistantProperty>;
    required: readonly string[];
  };
};

const SYMBOL_ARGUMENT: AssistantProperty = {
  type: "string",
  description: `Coinbase USD product id from the curated list (${USD_WATCHLIST.map(({ productId }) => productId).join(", ")}).`,
};

/** Every tool the model may call, with the scope it needs and the arguments it accepts. */
export const ASSISTANT_TOOLS: readonly AssistantToolSpec[] = [
  {
    name: "get_account_balance",
    description:
      "Read the signed-in owner's ledger balances per asset, with the moment the ledger was read. Use this for any question about the user's own balance.",
    scope: "account",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_ledger_history",
    description:
      "Read the signed-in owner's ledger statement for a date range: per-asset in/out/net totals and the newest lines. Use this for deposits, withdrawals, transaction history and realised P&L questions.",
    scope: "account",
    parameters: {
      type: "object",
      properties: {
        days: { type: "number", description: "How many days back to cover, 1–366. Defaults to 30." },
      },
      required: [],
    },
  },
  {
    name: "get_open_positions",
    description:
      "Read the signed-in owner's current positions from filled orders, with mark price and unrealised P&L where a mark could be read.",
    scope: "account",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_open_orders",
    description: "List the signed-in owner's orders that are still open, with their venue and status.",
    scope: "account",
    parameters: {
      type: "object",
      properties: { limit: { type: "number", description: "How many rows to return, 1–25. Defaults to 10." } },
      required: [],
    },
  },
  {
    name: "list_market_alerts",
    description: "List the signed-in owner's market alerts and their status.",
    scope: "account",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_market_quote",
    description: "Fetch the latest public Coinbase quote (bid/ask/last) for a USD market symbol.",
    scope: "public",
    parameters: { type: "object", properties: { symbol: SYMBOL_ARGUMENT }, required: ["symbol"] },
  },
  {
    name: "get_market_candles",
    description: "Fetch the most recent closed daily candles from public Coinbase data for a USD market symbol.",
    scope: "public",
    parameters: {
      type: "object",
      properties: {
        symbol: SYMBOL_ARGUMENT,
        days: { type: "number", description: "How many daily candles, 5–60. Defaults to 14." },
      },
      required: ["symbol"],
    },
  },
  {
    name: "get_market_indicator",
    description:
      "Compute RSI-14 for a USD market symbol from the same stored 15m candles the screener reads, so the number agrees with /screener.",
    scope: "public",
    parameters: { type: "object", properties: { symbol: SYMBOL_ARGUMENT }, required: ["symbol"] },
  },
  {
    name: "search_research",
    description:
      "Search the web for market or news research. Requires the account and the admin Tavily Search switch, because it spends that account's research budget.",
    scope: "account",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query, 1–400 characters." },
        topic: { type: "string", description: "general, news or finance. Defaults to news.", enum: ["general", "news", "finance"] },
      },
      required: ["query"],
    },
  },
  {
    name: "extract_research",
    description:
      "Extract the readable text of 1–3 public HTTPS pages, for a source found by search_research. Requires the account and the admin Tavily Extract switch.",
    scope: "account",
    parameters: {
      type: "object",
      properties: {
        urls: { type: "string", description: "Comma-separated public HTTPS URLs, at most 3." },
      },
      required: ["urls"],
    },
  },
  {
    name: "search_social_posts",
    description:
      "Search public Twitter/X posts for a market, ticker or headline and return the posts with author, publication time and engagement counts. Requires the account and the admin SandBase switch, because it spends this deployment's SandBase data allowance. Posts are claims by their authors, never verified market data.",
    scope: "account",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "What to search for, 1–120 characters, e.g. \"bitcoin\" or \"BTC ETF flows\"." },
        sort: { type: "string", description: "Top (most relevant) or Latest (newest). Defaults to Latest.", enum: ["Top", "Latest"] },
        limit: { type: "number", description: "How many posts to return, 1–20. Defaults to 8." },
      },
      required: ["topic"],
    },
  },
  {
    name: "place_paper_order",
    description:
      "Place an order on the development PAPER venue only. This is a simulation: no exchange is contacted and no real funds move. It is refused whenever order routing points at testnet or live.",
    scope: "account",
    parameters: {
      type: "object",
      properties: {
        market: SYMBOL_ARGUMENT,
        side: { type: "string", description: "BUY or SELL.", enum: ["BUY", "SELL"] },
        quantity: { type: "string", description: "Base-asset quantity as a decimal string, e.g. \"0.01\"." },
        orderType: { type: "string", description: "MARKET or LIMIT. Defaults to MARKET.", enum: ["MARKET", "LIMIT"] },
        limitPrice: { type: "string", description: "Required for LIMIT orders; ignored for MARKET." },
      },
      required: ["market", "side", "quantity"],
    },
  },
];

const TOOLS_BY_NAME = new Map(ASSISTANT_TOOLS.map((tool) => [tool.name, tool]));

/** The OpenAI-compatible tool definitions sent with every model request. */
export const ASSISTANT_TOOL_DEFINITIONS = ASSISTANT_TOOLS.map((tool) => ({
  type: "function" as const,
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
}));

export type ToolArguments = Record<string, unknown>;

/**
 * The arguments a tool is allowed to see: only what its own definition declares.
 *
 * This is the second half of caller scoping. The executor's `userId` comes from the
 * session and is not an argument at all, so nothing a model emits can redirect a read —
 * but filtering by the schema also means a stray `userId`, `accountId` or `databaseUrl`
 * never reaches a handler that might one day be tempted to look at it.
 */
export function sanitiseArguments(name: string, args: ToolArguments): ToolArguments | null {
  const spec = TOOLS_BY_NAME.get(name);
  if (!spec) return null;
  const allowed = new Set(Object.keys(spec.parameters.properties));
  const clean: ToolArguments = {};
  for (const [key, value] of Object.entries(args)) {
    if (!allowed.has(key)) continue;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) clean[key] = trimmed;
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shapes the tools return. Rows are bounded here, not left to the caller.
// ─────────────────────────────────────────────────────────────────────────────

export type BalanceRead = {
  readAt: string;
  balances: { asset: string; balance: string; available: string; bucket: string; label: string; entries: number }[];
};

export type StatementRead = {
  from: string;
  to: string;
  readAt: string;
  totals: { asset: string; in: string; out: string; net: string; closing: string; lines: number }[];
  lines: { occurredAt: string; kind: string; asset: string; amount: string; account: string; counterparty: string | null; memo: string | null }[];
  lineCount: number;
};

export type PositionRead = {
  readAt: string;
  positions: {
    market: string;
    quantity: string;
    averageCostUsd: string | null;
    markPriceUsd: string | null;
    markAsOf: string | null;
    marketValueUsd: string | null;
    unrealisedPnlUsd: string | null;
    note: string | null;
  }[];
  note: string | null;
};

export type OrderRead = {
  readAt: string;
  open: {
    id: string;
    venue: string;
    market: string;
    side: string;
    orderType: string;
    status: string;
    statusLabel: string;
    requestedQuantity: string;
    filledQuantity: string;
    notionalUsdCents: number;
    submittedAt: string | null;
  }[];
};

export type AlertRead = {
  readAt: string;
  alerts: { symbol: string; condition: string; threshold: string; status: string; triggeredAt: string | null; lastObservedValue: string | null }[];
};

export type QuoteRead = {
  symbol: string;
  providerId: string;
  bid: string | null;
  ask: string | null;
  last: string | null;
  priceChangePercent24h: string | null;
  /** Null when the provider reported no observation time: a citation says so rather than
   * borrowing the server's clock. */
  observedAt: string | null;
  freshness: string;
};

export type CandleRead = {
  symbol: string;
  interval: string;
  observedAt: string;
  providerId: string;
  candles: { closeTime: string; open: string; high: string; low: string; close: string; volume: string }[];
};

export type IndicatorRead = {
  symbol: string;
  interval: "15m";
  /** The close time of the newest candle that went into the value. */
  observedAt: string;
  providerId: string;
  rsi14: number;
  candles: number;
};

export type PaperOrderInput = {
  market: string;
  side: "BUY" | "SELL";
  quantity: string;
  orderType: "MARKET" | "LIMIT";
  limitPrice: string | null;
};

export type PaperOrderOutcome =
  | {
      placed: true;
      venue: string;
      market: string;
      side: string;
      quantity: string;
      outcome: string;
      status: string | null;
      orderId: string | null;
      reason: string;
    }
  | { placed: false; reason: string };

/**
 * The readers, stated as a type so a test can supply its own.
 *
 * Every account reader's first argument is the session's user id. That is the whole
 * scoping contract, and it is why a test can assert "the id that arrived came from the
 * executor, not from the model's arguments" by watching this boundary.
 */
export type AssistantToolDeps = {
  balances: (userId: string, now: Date) => Promise<BalanceRead>;
  statement: (userId: string, from: Date, to: Date, now: Date) => Promise<StatementRead>;
  positions: (userId: string, now: Date) => Promise<PositionRead>;
  openOrders: (userId: string, now: Date) => Promise<OrderRead>;
  alerts: (userId: string, now: Date) => Promise<AlertRead>;
  quote: (symbol: string) => Promise<QuoteRead>;
  candles: (symbol: string, days: number, now: Date) => Promise<CandleRead>;
  /** The screener's own indicator path: stored 15m candles, one shared calculation. */
  indicator: (symbol: string, now: Date) => Promise<IndicatorRead>;
  search: (query: string, topic: TavilyTopic) => Promise<TavilySearchResult[]>;
  extract: (urls: string[]) => Promise<{ results: { url: string; content: string }[]; failed: string[] }>;
  /** The pinned SandBase data capability: public posts, already bounded and normalised. */
  sandbaseSocial: (
    input: { topic: string; sort: SandbaseSocialSort; limit: number },
    now: Date,
  ) => Promise<SandbaseSocialRead>;
  /**
   * Whether this account may spend a research request, and why not when it may not.
   *
   * The research desk already answers two questions before it searches — is the source
   * switched on in Access & Integrations, and has this account used its minute's
   * allowance — and the assistant is a second door onto the same free, keyless provider.
   * Without this check the switch would be advisory for the assistant alone, and one
   * account could exhaust the provider's limit from a chat box.
   */
  researchAccess: (userId: string, kind: "search" | "extract") => Promise<{ allowed: true } | { allowed: false; reason: string }>;
  /**
   * Whether this account may spend one SandBase request, and why not when it may not.
   *
   * Four things are answered before the provider is asked: the admin switch, whether this
   * deployment has a key at all, and this account's minute — in that order, so a switched-off
   * or unconfigured source never consumes a request. The fourth, the balance, can only be
   * known from the provider's answer, and its 402 is reported as a refusal.
   */
  sandbaseAccess: (userId: string) => Promise<{ allowed: true } | { allowed: false; reason: string }>;
  paperOrder: (userId: string, input: PaperOrderInput, now: Date) => Promise<PaperOrderOutcome>;
};

const DEFAULT_DEPS: AssistantToolDeps = {
  balances: async (userId, now) => {
    const view = await readLedgerView(ledgerStore, {
      userId,
      from: new Date(now.getTime() - DAY_MS),
      to: now,
      now,
    });
    return {
      readAt: view.readAt,
      balances: view.balances.slice(0, MAX_ROWS).map((balance) => ({
        asset: balance.asset,
        balance: balance.decimal,
        available: balance.bucket === "AVAILABLE" ? balance.decimal : "0",
        bucket: balance.bucket,
        label: balance.label,
        entries: balance.entryCount,
      })),
    };
  },

  statement: async (userId, from, to, now) => {
    const view = await readLedgerView(ledgerStore, { userId, from, to, now });
    return {
      from: view.statement.from,
      to: view.statement.to,
      readAt: view.readAt,
      totals: view.statement.totals.map((total) => ({
        asset: total.asset,
        in: total.inDecimal,
        out: total.outDecimal,
        net: total.netDecimal,
        closing: total.closingDecimal,
        lines: total.lineCount,
      })),
      lines: view.statement.lines.slice(-MAX_LEDGER_LINES).map((line) => ({
        occurredAt: line.occurredAt,
        kind: line.kind,
        asset: line.asset,
        amount: line.decimal,
        account: line.accountLabel,
        counterparty: line.counterpartyLabel,
        memo: line.memo,
      })),
      lineCount: view.statement.lines.length,
    };
  },

  positions: async (userId, now) => {
    const view = await readAccountView({
      userId,
      now,
      filter: { from: new Date(now.getTime() - 365 * DAY_MS), to: now, asset: null, types: [], hash: null },
    });
    return {
      readAt: view.overview.readAt,
      positions: view.overview.positions.slice(0, MAX_ROWS).map((position) => ({
        market: position.market,
        quantity: position.quantity,
        averageCostUsd: position.averageCostUsd,
        markPriceUsd: position.markPriceUsd,
        markAsOf: position.markAsOf,
        marketValueUsd: position.marketValueUsd,
        unrealisedPnlUsd: position.unrealisedPnlUsd,
        note: position.note,
      })),
      // A mark that could not be read is reported, never substituted.
      note: view.markFailure,
    };
  },

  openOrders: async (userId, now) => {
    const orders = await orderStore().listOrders({ userId, limit: MAX_ROWS });
    return {
      readAt: now.toISOString(),
      open: orders
        .filter((order) => !isTerminalOrderStatus(order.status))
        .slice(0, 10)
        .map((order) => {
          const resource = orderResource(order);
          return {
            id: resource.id,
            venue: resource.venue,
            market: resource.market,
            side: resource.side,
            orderType: resource.orderType,
            status: resource.status,
            statusLabel: resource.statusLabel,
            requestedQuantity: resource.requestedQuantity,
            filledQuantity: resource.filledQuantity,
            notionalUsdCents: resource.notionalUsdCents,
            submittedAt: resource.submittedAt,
          };
        }),
    };
  },

  alerts: async (userId, now) => {
    const rows = await prisma.marketAlert.findMany({
      where: { userId, status: { not: "DELETED" } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        symbol: true,
        condition: true,
        threshold: true,
        status: true,
        triggeredAt: true,
        lastObservedValue: true,
      },
    });
    return {
      readAt: now.toISOString(),
      alerts: rows.map((row) => ({
        symbol: row.symbol,
        condition: row.condition,
        threshold: row.threshold,
        status: row.status,
        triggeredAt: row.triggeredAt ? row.triggeredAt.toISOString() : null,
        lastObservedValue: row.lastObservedValue,
      })),
    };
  },

  quote: async (symbol) => {
    const result = await coinbaseMarketData.getQuotes({ instruments: [symbol] });
    if (result.status !== "available") {
      throw new Error(`The public Coinbase quote feed answered ${result.reason}.`);
    }
    const quote = result.data.find((candidate) => candidate.instrument.symbol === symbol);
    if (!quote) throw new Error(`The public Coinbase quote feed returned no row for ${symbol}.`);
    return {
      symbol,
      providerId: quote.provenance.providerId,
      bid: quote.bid,
      ask: quote.ask,
      last: quote.last,
      priceChangePercent24h: quote.priceChangePercent24h,
      observedAt: quote.provenance.observedAt,
      freshness: quote.provenance.freshness,
    };
  },

  candles: async (symbol, days, now) => {
    const result = await coinbaseMarketData.getCandles({
      instrument: symbol,
      interval: "1d",
      from: new Date(now.getTime() - (days + 5) * DAY_MS).toISOString(),
      to: now.toISOString(),
    });
    if (result.status !== "available") {
      throw new Error(`The public Coinbase history feed answered ${result.reason}.`);
    }
    const closed = result.data
      .filter((candle) => Date.parse(candle.closeTime) <= now.getTime())
      .sort((left, right) => left.closeTime.localeCompare(right.closeTime))
      .slice(-days);
    const newest = closed.at(-1);
    if (!newest) throw new Error(`No closed daily candles were returned for ${symbol}.`);
    return {
      symbol,
      interval: "1d",
      observedAt: newest.closeTime,
      providerId: newest.provenance.providerId,
      candles: closed.map((candle) => ({
        closeTime: candle.closeTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      })),
    };
  },

  indicator: async (symbol, now) => {
    // The screener refreshes a stale series before it reads, and the assistant asks the
    // same question of the same rows: a screen and an assistant answer that disagreed
    // about one RSI would make both numbers untrustworthy.
    await ensureScreenData({ symbols: [symbol], asOf: now });
    const candles = (await loadScreenerCandles({ symbols: [symbol], asOf: now })).filter(
      (candle) => candle.symbol === symbol,
    );
    const rsi = latestClosedRsi(candles, 14, now);
    if (!rsi) {
      throw new Error(
        `No stored 15m candles for ${symbol} have closed yet, so RSI-14 could not be derived from them.`,
      );
    }
    const newest = candles
      .filter((candle) => new Date(candle.closeTime).getTime() <= now.getTime())
      .sort((left, right) => new Date(left.closeTime).getTime() - new Date(right.closeTime).getTime())
      .at(-1);
    return {
      symbol,
      interval: "15m",
      observedAt: rsi.closedAt,
      providerId: newest?.providerId ?? "market-candle-store",
      rsi14: Number(rsi.value.toFixed(4)),
      candles: rsi.candles,
    };
  },

  search: (query, topic) => searchTavily(query, topic),
  extract: (urls) => extractTavily(urls),

  sandbaseSocial: (input, now) => searchSandbaseSocialPosts({ ...input, now }),

  researchAccess: async (userId, kind) => {
    const settings = await getIntegrationFeatureSettings().catch(() => null);
    if (!settings) {
      return { allowed: false, reason: "Integration settings could not be read, so no research request was made." };
    }
    const enabled = kind === "search" ? settings.tavilySearchEnabled : settings.tavilyExtractEnabled;
    if (!enabled) {
      return {
        allowed: false,
        reason: `${kind === "search" ? "Tavily Search" : "Tavily Extract"} is switched off in Access & Integrations.`,
      };
    }
    if (!consumeTavilyRequest(userId)) {
      return { allowed: false, reason: "Tavily request limit reached; try again in a minute." };
    }
    return { allowed: true };
  },

  sandbaseAccess: async (userId) => {
    const settings = await getIntegrationFeatureSettings().catch(() => null);
    if (!settings) {
      return { allowed: false, reason: "Integration settings could not be read, so no SandBase request was made." };
    }
    if (!settings.sandbaseDataEnabled) {
      return { allowed: false, reason: "SandBase social data is switched off in Access & Integrations." };
    }
    if (!isSandbaseConfigured()) {
      return {
        allowed: false,
        reason: "SandBase is not configured on this deployment: SANDBASE_API_KEY is unset.",
      };
    }
    if (!consumeSandbaseRequest(userId)) {
      return { allowed: false, reason: "SandBase request limit reached; try again in a minute." };
    }
    return { allowed: true };
  },

  paperOrder: async (userId, input, now) => {
    // Where an order would go is read, not assumed: the tool has no execution argument,
    // so this is the only way it can leave the paper venue — and it refuses instead.
    const routing = await resolveOrderVenue(userId);
    if (routing.kind === "refused") return { placed: false, reason: routing.error };
    if (routing.source !== "paper" || routing.venue.environment !== "paper") {
      return { placed: false, reason: describeNonPaperRouting(routing.source) };
    }

    const quote = await DEFAULT_DEPS.quote(input.market);
    const reference = input.orderType === "LIMIT" ? input.limitPrice : input.side === "BUY" ? quote.ask ?? quote.last : quote.bid ?? quote.last;
    if (!reference) {
      return { placed: false, reason: `No public price is available for ${input.market}, so no paper order was created.` };
    }
    const notionalCents = new Decimal(reference).mul(input.quantity).mul(100).toDecimalPlaces(0).toNumber();
    if (!Number.isSafeInteger(notionalCents) || notionalCents <= 0) {
      return { placed: false, reason: `The ${input.quantity} ${input.market} order does not price to a whole number of cents.` };
    }

    const validation = validateOrderSubmission({
      market: input.market,
      side: input.side,
      orderType: input.orderType,
      quantity: input.quantity,
      ...(input.orderType === "LIMIT" ? { limitPrice: input.limitPrice } : {}),
      notionalUsdCents: notionalCents,
      // The paper venue holds no balance to verify, and the field is recorded as what
      // the caller claims. Zero is the honest claim here rather than a made-up one.
      verifiedBalanceCents: 0,
      execution: "paper",
    });
    if (!validation.valid) return { placed: false, reason: validation.error };

    const authorisation = await authoriseOrder({
      userId,
      symbol: input.market,
      notionalUsd: (notionalCents / 100).toFixed(2),
      venueId: routing.venue.id,
      source: "manual",
      actorUserId: userId,
      now,
    });
    if (authorisation.decision.decision === "REFUSE") {
      return { placed: false, reason: authorisation.sentence ?? "The risk policy refused the paper order." };
    }

    const outcome = await submitOrder(
      {
        intent: orderIntentFrom(validation.value, { userId, venue: routing.venue.id }),
        actorUserId: userId,
        origin: "assistant",
        // The note is composed from the shared marker so the audit reason and the
        // backfill's classifier cannot drift apart.
        sourceNote: `${ORDER_NOTE_PREFIX.assistant}, which is restricted to the paper venue.`,
      },
      { venue: routing.venue },
    );

    return {
      placed: outcome.kind === "submitted" || outcome.kind === "replayed" || outcome.kind === "unresolved",
      venue: routing.venue.id,
      market: input.market,
      side: input.side,
      quantity: input.quantity,
      outcome: outcome.kind,
      status: outcome.order?.status ?? null,
      orderId: outcome.order?.id ?? null,
      reason: outcome.reason.message,
    };
  },
};

const PAPER_ONLY_NOTE =
  "This tool places paper orders only: the development paper venue is a simulation, no exchange is contacted and no real funds move.";

/**
 * The refusal that keeps the assistant on the paper venue, as one sentence.
 *
 * Pure and exported because it is the whole of the "clearly labelled as paper" guarantee:
 * the tool takes no execution argument, so the only thing that could put a real order
 * behind the assistant is routing pointing somewhere else — and this is what happens when
 * it does. It names the two switches and the page that places a real order, so the refusal
 * is actionable rather than a dead end.
 */
export function describeNonPaperRouting(source: "paper" | "testnet" | "live"): string {
  return (
    `The assistant only places paper orders, and order routing currently points at ${source}. ` +
    "Switch testnet routing off in Access & Integrations and live execution off in /admin/risk to use it, " +
    "or place the order yourself on /trade."
  );
}

export type AssistantExecutorContext = {
  /** From the session. Null means nobody is signed in, and account tools refuse. */
  userId: string | null;
  now: Date;
  record: AssistantToolRecord;
};

type ToolOutcome =
  | { ok: true; data: unknown; citation: Omit<AssistantCitation, "tool"> }
  | { ok: false; error: string; failure: Omit<AssistantToolFailure, "tool"> };

function cite(label: string, source: string, asOf: string | null, detail?: string): Omit<AssistantCitation, "tool"> {
  return { label, source, asOf, ...(detail ? { detail } : {}) };
}

function requireSymbol(value: unknown): string {
  if (typeof value !== "string" || !USD_WATCHLIST.some(({ productId }) => productId === value)) {
    throw new Error(`Unsupported public Coinbase USD symbol. Choose one of ${USD_WATCHLIST.map(({ productId }) => productId).join(", ")}.`);
  }
  return value;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

/**
 * Build the executor the loop calls.
 *
 * The returned function is the only thing the model's tool calls reach. It owns the
 * session id, sanitises arguments, records what happened (for the citations block and
 * the missing-data sentences), and turns every thrown failure into an error value with
 * a sentence — which is what keeps an outage from becoming an invented number.
 */
export function createAssistantToolExecutor(
  context: AssistantExecutorContext,
  deps: Partial<AssistantToolDeps> = {},
): ToolExecutor {
  const readers: AssistantToolDeps = { ...DEFAULT_DEPS, ...deps };
  const { userId, now, record } = context;

  async function execute(name: string, args: ToolArguments): Promise<ToolOutcome> {
    const spec = TOOLS_BY_NAME.get(name);
    if (!spec) return { ok: false, error: `Unknown tool: ${name}`, failure: { label: name, reason: "the assistant asked for a tool this build does not have" } };

    const clean = sanitiseArguments(name, args);
    if (!clean) return { ok: false, error: `Unknown tool: ${name}`, failure: { label: name, reason: "its arguments could not be read" } };

    if (spec.scope === "account" && !userId) {
      return {
        ok: false,
        error: "Sign in to read account data. Nothing was read and nothing is estimated.",
        failure: { label: spec.name, reason: "no signed-in account" },
      };
    }
    const accountId = userId as string;

    if (name === "get_account_balance") {
      const data = await readers.balances(accountId, now);
      return {
        ok: true,
        data,
        citation: cite("Ledger balances", "ledger", data.readAt, `${data.balances.length} asset(s), derived from ledger entries`),
      };
    }

    if (name === "get_ledger_history") {
      const days = clampInt(clean.days, 30, 1, 366);
      const from = new Date(now.getTime() - days * DAY_MS);
      const data = await readers.statement(accountId, from, now, now);
      return {
        ok: true,
        data,
        citation: cite(
          "Ledger statement",
          "ledger",
          data.to,
          `${data.lineCount} line(s) in the last ${days} day(s); read at ${data.readAt}`,
        ),
      };
    }

    if (name === "get_open_positions") {
      const data = await readers.positions(accountId, now);
      return {
        ok: true,
        data,
        citation: cite(
          "Positions",
          "filled orders + market marks",
          data.readAt,
          data.note ?? `${data.positions.length} open position(s)`,
        ),
      };
    }

    if (name === "list_open_orders") {
      const limit = clampInt(clean.limit, 10, 1, MAX_ROWS);
      const data = await readers.openOrders(accountId, now);
      return {
        ok: true,
        data: { ...data, open: data.open.slice(0, limit) },
        citation: cite("Open orders", "order store", data.readAt, `${data.open.length} open order(s)`),
      };
    }

    if (name === "list_market_alerts") {
      const data = await readers.alerts(accountId, now);
      return {
        ok: true,
        data,
        citation: cite("Market alerts", "alert store", data.readAt, `${data.alerts.length} alert(s)`),
      };
    }

    if (name === "get_market_quote") {
      const symbol = requireSymbol(clean.symbol);
      const data = await readers.quote(symbol);
      return {
        ok: true,
        data,
        citation: cite(`${symbol} quote`, data.providerId, data.observedAt, data.freshness),
      };
    }

    if (name === "get_market_candles") {
      const symbol = requireSymbol(clean.symbol);
      const days = clampInt(clean.days, 14, 5, MAX_CANDLES);
      const data = await readers.candles(symbol, days, now);
      return {
        ok: true,
        data,
        citation: cite(`${symbol} daily candles`, data.providerId, data.observedAt, `${data.candles.length} closed candles`),
      };
    }

    if (name === "get_market_indicator") {
      const symbol = requireSymbol(clean.symbol);
      const data = await readers.indicator(symbol, now);
      return {
        ok: true,
        data,
        citation: cite(
          `${symbol} RSI-14 (15m)`,
          data.providerId,
          data.observedAt,
          `from ${data.candles} closed 15m candles, the same series /screener screens`,
        ),
      };
    }

    if (name === "search_research") {
      if (typeof clean.query !== "string" || clean.query.length < 1 || clean.query.length > 400) {
        throw new Error("Provide a search query of 1–400 characters.");
      }
      const topic: TavilyTopic = clean.topic === "general" || clean.topic === "finance" || clean.topic === "news" ? clean.topic : "news";
      const access = await readers.researchAccess(accountId, "search");
      if (!access.allowed) throw new Error(access.reason);
      const results = await readers.search(clean.query, topic);
      return {
        ok: true,
        data: { query: clean.query, topic, results },
        citation: cite("Web research", "tavily", null, `${results.length} result(s) for ${JSON.stringify(clean.query)}`),
      };
    }

    if (name === "extract_research") {
      if (typeof clean.urls !== "string") throw new Error("Provide 1–3 public HTTPS URLs.");
      const urls = clean.urls.split(",").map((url) => url.trim()).filter(Boolean);
      const access = await readers.researchAccess(accountId, "extract");
      if (!access.allowed) throw new Error(access.reason);
      const extracted = await readers.extract(urls);
      return {
        ok: true,
        data: extracted,
        citation: cite("Page extracts", "tavily", null, `${extracted.results.length} page(s) extracted`),
      };
    }

    if (name === "search_social_posts") {
      if (typeof clean.topic !== "string" || clean.topic.length < 1 || clean.topic.length > 120) {
        throw new Error("Provide a SandBase search topic of 1–120 characters.");
      }
      const sort: SandbaseSocialSort = clean.sort === "Top" ? "Top" : "Latest";
      const limit = clampInt(clean.limit, 8, 1, 20);
      const access = await readers.sandbaseAccess(accountId);
      if (!access.allowed) throw new Error(access.reason);
      const data = await readers.sandbaseSocial({ topic: clean.topic, sort, limit }, now);
      return {
        ok: true,
        data,
        citation: cite(
          `${data.topic} social posts`,
          "sandbase",
          data.newestAt,
          `${data.posts.length} ${data.vendor} post(s), ${sort.toLowerCase()} results; posts are their authors' claims`,
        ),
      };
    }

    if (name === "place_paper_order") {
      const market = requireSymbol(clean.market);
      if (clean.side !== "BUY" && clean.side !== "SELL") throw new Error("Side must be BUY or SELL.");
      if (typeof clean.quantity !== "string") throw new Error("Quantity must be a decimal string.");
      const orderType = clean.orderType === "LIMIT" ? "LIMIT" : "MARKET";
      const limitPrice = typeof clean.limitPrice === "string" ? clean.limitPrice : null;
      if (orderType === "LIMIT" && !limitPrice) throw new Error("A LIMIT paper order needs a limitPrice.");

      const outcome = await readers.paperOrder(
        accountId,
        { market, side: clean.side, quantity: clean.quantity, orderType, limitPrice },
        now,
      );
      if (!outcome.placed) {
        return {
          ok: false,
          error: outcome.reason,
          failure: { label: "Paper order", reason: outcome.reason },
        };
      }
      return {
        ok: true,
        data: { ...outcome, paper: true, note: PAPER_ONLY_NOTE },
        citation: cite("Paper order", `venue ${outcome.venue}`, now.toISOString(), `paper only · ${outcome.status ?? outcome.outcome}`),
      };
    }

    return { ok: false, error: `Unknown tool: ${name}`, failure: { label: name, reason: "no handler" } };
  }

  return async (name, args) => {
    const spec = TOOLS_BY_NAME.get(name);
    try {
      const outcome = await execute(name, args);
      if (outcome.ok) {
        record.citations.push({ tool: name, ...outcome.citation });
        return { ok: true, data: outcome.data };
      }
      record.failures.push({ tool: name, label: spec?.name === "place_paper_order" ? "Paper order" : outcome.failure.label, reason: outcome.failure.reason });
      return { ok: false, error: outcome.error };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "The tool failed without a message.";
      record.failures.push({ tool: name, label: spec?.name ?? name, reason });
      return { ok: false, error: reason };
    }
  };
}

/** For the panel: the tools it can advertise without naming an implementation. */
export function describeAssistantTools(): { name: string; scope: "account" | "public"; description: string }[] {
  return ASSISTANT_TOOLS.map((tool) => ({ name: tool.name, scope: tool.scope, description: tool.description }));
}
