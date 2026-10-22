import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAssistantPaperPerformance,
  type AssistantPaperPerformance,
  type PaperOrderLike,
} from "@/lib/portfolio/paper-performance";
import { buildAccountOverview, type MarkPrice } from "@/lib/portfolio/pnl";
import { accountPayload } from "@/lib/portfolio/service";

/**
 * The assistant's paper block, asserted on rows stated literally.
 *
 * No database, no network and no clock: an order list is written in the test and the
 * block is built from it, so "the assistant's own fills produced this result",
 * "an order that did not fill has no result" and "the block says when the account and
 * the assistant disagree" are checked against the numbers themselves.
 */

const NOW = new Date("2026-10-22T12:00:00.000Z");

function order(input: {
  id: string;
  market?: string;
  side?: "BUY" | "SELL";
  status?: string;
  requested: string;
  filled: string;
  notionalUsdCents: number;
  at: string;
  origin?: PaperOrderLike["origin"];
  venue?: string;
}): PaperOrderLike {
  return {
    id: input.id,
    venue: input.venue ?? "dev-paper",
    market: input.market ?? "BTC-USD",
    side: input.side ?? "BUY",
    status: input.status ?? "FILLED",
    requestedQuantity: input.requested,
    filledQuantity: input.filled,
    notionalUsdCents: input.notionalUsdCents,
    occurredAt: new Date(input.at),
    orderType: "MARKET",
    origin: input.origin ?? "assistant",
  };
}

function performance(
  assistantOrders: readonly PaperOrderLike[],
  paperOrders: readonly PaperOrderLike[] = assistantOrders,
  marks: readonly MarkPrice[] = [],
): AssistantPaperPerformance {
  return buildAssistantPaperPerformance({ assistantOrders, paperOrders, marks, now: NOW });
}

const MARK: MarkPrice = {
  market: "BTC-USD",
  price: "120",
  source: "Coinbase",
  asOf: "2026-10-22T11:59:00.000Z",
  freshness: "1 minute old",
};

// A round trip: two units bought at $100 and sold at $130, so $60 realised.
const BOUGHT_TWO = order({ id: "a-buy", requested: "2", filled: "2", notionalUsdCents: 20_000, at: "2026-10-20T09:00:00.000Z" });
const SOLD_TWO = order({
  id: "a-sell",
  side: "SELL",
  requested: "2",
  filled: "2",
  notionalUsdCents: 26_000,
  at: "2026-10-21T09:00:00.000Z",
});

test("a closed assistant round trip is realised against the assistant's own average cost", () => {
  const built = performance([BOUGHT_TWO, SOLD_TWO]);

  assert.equal(built.summary.orders, 2);
  assert.equal(built.summary.filledOrders, 2);
  assert.equal(built.summary.closedOrders, 2);
  assert.equal(built.summary.openOrders, 0);
  assert.equal(built.summary.realisedUsd, "60");
  assert.equal(built.summary.openUnrealisedUsd, "0");
  assert.deepEqual(built.summary.openMarkets, []);
  assert.deepEqual(built.summary.venues, ["dev-paper"]);

  // The market row is closed: nothing held, so the result is realised, not estimated.
  assert.deepEqual(
    built.markets.map((market) => [market.market, market.quantity, market.realisedPnlUsd, market.note]),
    [["BTC-USD", "0", "60", null]],
  );

  // The result is attributed to the sell that produced it, not to the buy.
  const rows = new Map(built.orders.map((entry) => [entry.orderId, entry]));
  assert.equal(rows.get("a-sell")?.realisedUsd, "60");
  assert.equal(rows.get("a-buy")?.realisedUsd, "0");
  assert.equal(rows.get("a-buy")?.outcome, "CLOSED");
  assert.equal(rows.get("a-sell")?.outcome, "CLOSED");
  assert.equal(rows.get("a-buy")?.unitPriceUsd, "100");
});

test("a market still held is unrealised, priced only by a mark that was actually read", () => {
  const held = order({ id: "a-buy", requested: "1", filled: "1", notionalUsdCents: 10_000, at: "2026-10-20T09:00:00.000Z" });

  const priced = performance([held], [held], [MARK]);
  assert.equal(priced.summary.openOrders, 1);
  assert.equal(priced.summary.realisedUsd, "0");
  assert.equal(priced.summary.openUnrealisedUsd, "20");
  assert.deepEqual(priced.summary.openMarkets, ["BTC-USD"]);
  assert.deepEqual(priced.summary.unpricedMarkets, []);
  assert.equal(priced.markets[0]?.unrealisedPnlUsd, "20");
  assert.equal(priced.markets[0]?.markSource, "Coinbase");
  assert.equal(priced.orders[0]?.markPriceUsd, "120");
  assert.equal(priced.orders[0]?.outcome, "OPEN");

  // Without a reading the figure is absent, not zero and not estimated.
  const unpriced = performance([held]);
  assert.equal(unpriced.summary.openUnrealisedUsd, null);
  assert.deepEqual(unpriced.summary.unpricedMarkets, ["BTC-USD"]);
  assert.equal(unpriced.markets[0]?.unrealisedPnlUsd, null);
  assert.equal(unpriced.orders[0]?.markPriceUsd, null);
  assert.match(unpriced.notes.join(" "), /No mark was read for BTC-USD/);
});

test("an order that never filled is listed with its status and no result", () => {
  const refused = order({
    id: "a-refused",
    status: "FAILED",
    requested: "1",
    filled: "0",
    notionalUsdCents: 10_000,
    at: "2026-10-20T09:00:00.000Z",
  });
  const built = performance([refused]);

  assert.equal(built.summary.orders, 1);
  assert.equal(built.summary.filledOrders, 0);
  assert.equal(built.summary.unfilledOrders, 1);
  assert.equal(built.summary.realisedUsd, "0");
  assert.deepEqual(built.markets, []);
  assert.equal(built.orders[0]?.outcome, "NO_RESULT");
  assert.equal(built.orders[0]?.statusLabel, "FAILED");
  assert.equal(built.orders[0]?.realisedUsd, "0");
  assert.match(built.orders[0]?.outcomeDetail ?? "", /refused/i);
});

test("a partial fill is costed at the price of the order it was for", () => {
  const partial = order({
    id: "a-partial",
    status: "PARTIALLY_FILLED",
    requested: "2",
    filled: "1",
    notionalUsdCents: 20_000,
    at: "2026-10-20T09:00:00.000Z",
  });
  const built = performance([partial]);

  assert.equal(built.orders[0]?.filledQuantity, "1");
  assert.equal(built.orders[0]?.unitPriceUsd, "100");
  assert.equal(built.markets[0]?.quantity, "1");
  assert.equal(built.markets[0]?.averageCostUsd, "100");
  assert.equal(built.markets[0]?.costBasisUsd, "100");
  assert.equal(built.markets[0]?.filledOrders, 1);
});

test("the payload the account page fetches carries the block", () => {
  const paperPerformance = performance([BOUGHT_TWO, SOLD_TWO]);
  const overview = buildAccountOverview({
    userId: "u1",
    now: NOW,
    accounts: [],
    ownEntries: [],
    siblings: [],
    accountById: new Map(),
    deposits: [],
    withdrawals: [],
    orders: [],
    marks: [],
    filter: { from: new Date("2026-10-01T00:00:00.000Z"), to: NOW, asset: null, types: [], hash: null },
    paperPerformance,
  });

  const payload = accountPayload({ overview, external: null, markFailure: null });

  // The page renders `data.paperPerformance`; the route hands it the one the server built.
  assert.equal(payload.paperPerformance.origin, "assistant");
  assert.equal(payload.paperPerformance.summary.realisedUsd, "60");
  assert.equal(payload.paperPerformance.orders.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(payload.paperPerformance)), paperPerformance);
});

test("a fill placed elsewhere is excluded, and the market row says so", () => {
  const assistant = order({ id: "a-buy", requested: "1", filled: "1", notionalUsdCents: 10_000, at: "2026-10-20T09:00:00.000Z" });
  const owner = order({
    id: "m-buy",
    origin: "manual",
    requested: "1",
    filled: "1",
    notionalUsdCents: 10_000,
    at: "2026-10-20T09:30:00.000Z",
  });

  const built = performance([assistant], [assistant, owner]);

  // The assistant's own book is untouched by somebody else's fill...
  assert.equal(built.summary.orders, 1);
  assert.equal(built.markets[0]?.quantity, "1");
  // ...and the row names the difference rather than presenting the subset as the position.
  assert.match(built.markets[0]?.note ?? "", /is 2 while the assistant's own fills come to 1/);
  assert.match(built.markets[0]?.note ?? "", /placed elsewhere/);
});

test("a market the owner closed still reads open for the assistant, with both quantities named", () => {
  const assistant = order({ id: "a-buy", requested: "1", filled: "1", notionalUsdCents: 10_000, at: "2026-10-20T09:00:00.000Z" });
  const ownerSold = order({
    id: "m-sell",
    origin: "manual",
    side: "SELL",
    requested: "1",
    filled: "1",
    notionalUsdCents: 12_000,
    at: "2026-10-20T10:00:00.000Z",
  });

  const built = performance([assistant], [assistant, ownerSold]);

  assert.equal(built.markets[0]?.quantity, "1");
  assert.equal(built.orders[0]?.outcome, "OPEN");
  assert.match(built.markets[0]?.note ?? "", /is 0 while the assistant's own fills come to 1/);
  // The owner's sale is not the assistant's result.
  assert.equal(built.summary.realisedUsd, "0");
});
