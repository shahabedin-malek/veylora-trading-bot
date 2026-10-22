import DecimalJS from "decimal.js";
import { isOrderStatus, ORDER_STATUS_DETAIL } from "@/lib/orders/state-machine";
import type { OrderOrigin } from "@/lib/orders/origin";
import {
  buildPositionLedgers,
  positionsFromLedgers,
  type FigureSource,
  type FilledOrderLike,
  type MarkPrice,
  type PositionLedgerFill,
  type PositionPnl,
} from "@/lib/portfolio/pnl";

/**
 * How the assistant's paper orders played out.
 *
 * The account's positions answer "what does this account hold"; this block answers a
 * narrower question the owner cannot get from them: what did the orders the assistant
 * placed actually do, once the fills the owner and the strategies placed are taken
 * out of the picture. Two properties make that answer trustworthy rather than
 * decorative:
 *
 *  - **It is a subset of the same replay.** Only rows with origin `assistant` are
 *    costed, and they are costed by {@link buildPositionLedgers} — the same
 *    average-cost arithmetic the account's positions use. A second implementation
 *    here would be a second answer to "what did this fill cost", which is exactly the
 *    kind of figure that drifts.
 *  - **It says where the account and the subset disagree.** If the owner sold the
 *    market the assistant bought, the assistant's own fills still read "open" while
 *    the account is flat. The market row names both quantities and says which figure
 *    it is showing, rather than quietly presenting the subset as the position.
 *
 * A result is only ever a figure the fills support: an order that did not fill has no
 * cost basis and is reported as having no result, and a market still held reports an
 * unrealised figure only when a named mark was read for it.
 */

const Decimal = DecimalJS.clone({ precision: 40 });

/** The parts of an order row this block reads, beyond what a position needs. */
export type PaperOrderLike = FilledOrderLike & {
  orderType: string;
  origin: OrderOrigin;
};

/** What one order amounts to, in the same words the table's outcome column uses. */
export type PaperOrderOutcome = "CLOSED" | "OPEN" | "NO_RESULT";

export type PaperPerformanceOrder = {
  orderId: string;
  occurredAt: string;
  market: string;
  side: "BUY" | "SELL";
  orderType: string;
  status: string;
  statusLabel: string;
  requestedQuantity: string;
  filledQuantity: string;
  /** The order's own stated price: its notional divided by the quantity it was for. */
  unitPriceUsd: string;
  notionalUsd: string;
  /** This order's contribution to the assistant's realised result; zero on a buy. */
  realisedUsd: string;
  outcome: PaperOrderOutcome;
  outcomeDetail: string;
  /** The mark for this market, present only while the assistant still holds it. */
  markPriceUsd: string | null;
  markAsOf: string | null;
};

export type AssistantPaperSummary = {
  orders: number;
  filledOrders: number;
  closedOrders: number;
  openOrders: number;
  unfilledOrders: number;
  realisedUsd: string;
  /** `null` when at least one open market has no mark: part of the answer is absent. */
  openUnrealisedUsd: string | null;
  openMarkets: string[];
  unpricedMarkets: string[];
  venues: string[];
};

export type AssistantPaperPerformance = {
  /** The one origin this block counts. Stated on the payload, not only in the copy. */
  origin: "assistant";
  readAt: string;
  /** What the block covers and what it deliberately leaves out. */
  scope: string;
  summary: AssistantPaperSummary;
  orders: PaperPerformanceOrder[];
  /** The assistant's own sub-ledger, per market, closed rows included. */
  markets: PositionPnl[];
  sources: FigureSource[];
  notes: string[];
};

const SCOPE =
  "This block counts only orders the assistant's place_paper_order tool submitted (origin assistant), and it covers every such order on the account rather than the selected date range. Each fill is replayed at its own stated price with average cost, the same arithmetic as the positions above; orders the owner placed on the trade page, an activated strategy or the public API are excluded, and a market row says so where they change the account's holding.";

function usd(cents: number): InstanceType<typeof Decimal> {
  return new Decimal(cents).div(100);
}

/**
 * Build the block from the account's assistant-tagged paper orders.
 *
 * `paperOrders` is every paper order on the account, not just the assistant's: it is
 * what makes the reconciliation sentence on each market row possible. A caller that
 * passes only the subset gets a block whose quantities describe the subset and whose
 * market rows do not claim to reconcile with anything else.
 */
export function buildAssistantPaperPerformance(input: {
  assistantOrders: readonly PaperOrderLike[];
  paperOrders: readonly PaperOrderLike[];
  marks: readonly MarkPrice[];
  now: Date;
}): AssistantPaperPerformance {
  const ledger = buildPositionLedgers(input.assistantOrders);
  const accountLedger = buildPositionLedgers(input.paperOrders);
  const marks = new Map(input.marks.map((mark) => [mark.market, mark]));
  const { positions, pricedMarkets } = positionsFromLedgers(ledger, marks);

  const marketByName = new Map(positions.map((position) => [position.market, position]));

  // Per-market honesty: the assistant's sub-ledger and the account's paper position are
  // different books, and the row says which one it is when they disagree.
  const markets = positions.map((position) => {
    const accountQuantity = accountLedger.get(position.market)?.quantity ?? new Decimal(0);
    const assistantQuantity = ledger.get(position.market)?.quantity ?? new Decimal(0);
    if (assistantQuantity.eq(accountQuantity)) return position;
    const sentence = `The account's paper position in ${position.market} is ${accountQuantity.toFixed()} while the assistant's own fills come to ${assistantQuantity.toFixed()}; the difference was filled or closed by orders placed elsewhere, so this row and its result cover the assistant's fills only.`;
    return { ...position, note: position.note ? `${position.note} ${sentence}` : sentence };
  });

  const fills = new Map<string, PositionLedgerFill>();
  for (const market of ledger.values()) {
    for (const fill of market.fills) fills.set(fill.orderId, fill);
  }

  const orders: PaperPerformanceOrder[] = [...input.assistantOrders]
    .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
    .map((order) => {
      const status = isOrderStatus(order.status) ? order.status : null;
      const statusDetail = status ? ORDER_STATUS_DETAIL[status] : null;
      const requested = new Decimal(order.requestedQuantity);
      const notional = usd(order.notionalUsdCents);
      const unit = requested.isFinite() && requested.gt(0) && notional.isFinite() ? notional.div(requested) : null;
      const fill = fills.get(order.id) ?? null;
      const held = ledger.get(order.market)?.quantity ?? new Decimal(0);
      const market = marketByName.get(order.market) ?? null;

      const outcome: PaperOrderOutcome = fill === null ? "NO_RESULT" : held.gt(0) ? "OPEN" : "CLOSED";
      const outcomeDetail =
        fill === null
          ? (statusDetail?.detail ?? "The order carries no fill this block could cost, so it has no result.")
          : outcome === "OPEN"
            ? `The assistant still holds ${held.toFixed()} of ${order.market}, so this fill's result is unrealised until the rest is sold.`
            : `The assistant holds nothing in ${order.market} any more, so this fill's result is realised.`;

      return {
        orderId: order.id,
        occurredAt: order.occurredAt.toISOString(),
        market: order.market,
        side: order.side,
        orderType: order.orderType,
        status: status ?? order.status,
        statusLabel: statusDetail?.label ?? order.status,
        requestedQuantity: order.requestedQuantity,
        filledQuantity: fill?.filledQuantity ?? "0",
        unitPriceUsd: unit ? unit.toFixed() : "0",
        notionalUsd: notional.isFinite() ? notional.toFixed() : "0",
        realisedUsd: fill?.realisedUsd ?? "0",
        outcome,
        outcomeDetail,
        markPriceUsd: market?.markPriceUsd ?? null,
        markAsOf: market?.markAsOf ?? null,
      };
    });

  const realised = markets.reduce((total, market) => total.plus(new Decimal(market.realisedPnlUsd)), new Decimal(0));
  const openRows = markets.filter((market) => new Decimal(market.quantity).gt(0));
  const unpricedMarkets = openRows.filter((market) => market.unrealisedPnlUsd === null).map((market) => market.market);
  const allPriced = unpricedMarkets.length === 0;
  const openUnrealised = openRows.reduce(
    (total, market) => total.plus(new Decimal(market.unrealisedPnlUsd ?? 0)),
    new Decimal(0),
  );

  const filledOrders = orders.filter((order) => order.outcome !== "NO_RESULT").length;
  const notes = [
    "Only orders with origin assistant are counted here. A fill the owner placed on the trade page, an activated strategy or the public API is not the assistant's, even when it moved the same market.",
    "An order that did not fill has no cost basis, so it is listed with its status and no result rather than a zero that could be read as \"broke even\".",
    "A market the assistant still holds carries an unrealised result, which moves with the mark; only markets it has sold out of carry a realised one.",
  ];
  if (unpricedMarkets.length > 0) {
    notes.push(
      `No mark was read for ${unpricedMarkets.join(", ")}, so those markets have no unrealised figure rather than an estimate.`,
    );
  }

  return {
    origin: "assistant",
    readAt: input.now.toISOString(),
    scope: SCOPE,
    summary: {
      orders: orders.length,
      filledOrders,
      closedOrders: orders.filter((order) => order.outcome === "CLOSED").length,
      openOrders: orders.filter((order) => order.outcome === "OPEN").length,
      unfilledOrders: orders.length - filledOrders,
      realisedUsd: realised.toFixed(),
      openUnrealisedUsd: allPriced ? openUnrealised.toFixed() : null,
      openMarkets: openRows.map((market) => market.market),
      unpricedMarkets,
      venues: [...new Set(input.assistantOrders.filter((order) => order.status === "FILLED" || order.status === "PARTIALLY_FILLED").map((order) => order.venue))].sort(),
    },
    orders,
    markets,
    sources: [
      {
        label: "Order store — assistant paper orders",
        detail: `${orders.length} order(s) tagged with origin assistant, costed at each order's own stated notional divided by the quantity it was for, averaged across fills.`,
        asOf: input.now.toISOString(),
      },
      {
        label: "Public market data",
        detail:
          unpricedMarkets.length === 0
            ? `${pricedMarkets} open market(s) marked from a named reading with its own observation time.`
            : `${pricedMarkets} open market(s) marked; ${unpricedMarkets.join(", ")} had no usable reading and is reported unpriced.`,
        asOf: input.now.toISOString(),
      },
    ],
    notes,
  };
}
