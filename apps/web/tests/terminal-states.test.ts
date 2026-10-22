import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketChart, type ChartCandle } from "@/app/markets/market-chart";
import { TradeWorkbench } from "@/components/trade-workbench";

/**
 * Phase 33's rule for a data surface is that it has three honest readings — loading,
 * loaded and failed-with-reason — and that a failed read names its reason rather than
 * drawing a blank panel. The client panels fetch, so their loading and failure branches
 * are exercised through the API tests; these are the server-rendered surfaces, whose
 * branches depend only on the props the page hands them, so they can be rendered here.
 */

const candle = (openTime: string, close: string): ChartCandle => ({
  openTime,
  open: close,
  high: close,
  low: close,
  close,
  volume: "12.5",
});

const productId = "BTC-USD";
const emptyMarketProps = {
  productId,
  candles: [] as readonly ChartCandle[],
  chartFailure: null,
  quote: null,
  quoteFailure: null,
  balances: null,
  positions: null,
  orders: null,
  accountFailure: "The ledger did not answer.",
  orderFailure: "The order store did not answer.",
};

test("a failed market surface names every reason instead of rendering a blank panel", () => {
  const quoteFailure = "The market-data provider answered with an error.";
  const chartFailure = "The stored candle history could not be read.";
  const markup = renderToStaticMarkup(createElement(TradeWorkbench, {
    ...emptyMarketProps,
    chartFailure,
    quoteFailure,
  }));

  assert.match(markup, /Balances unavailable/);
  assert.match(markup, /The ledger did not answer\./);
  assert.match(markup, /Positions unavailable/);
  assert.match(markup, /Orders unavailable/);
  assert.match(markup, /The order store did not answer\./);
  assert.match(markup, /QUOTE WITHHELD/);
  assert.match(markup, new RegExp(quoteFailure.replaceAll(".", "\\.")));
  assert.match(markup, /Chart unavailable/);
  assert.match(markup, new RegExp(chartFailure.replaceAll(".", "\\.")));
});

test("a chart with no stored bars says so and carries no last-updated claim", () => {
  const markup = renderToStaticMarkup(createElement(MarketChart, { candles: [], productId }));
  assert.match(markup, /No verified candle history/);
  assert.match(markup, /LAST STORED BAR · NONE/);
});

test("a chart with a single bar renders the reading instead of a broken canvas", () => {
  const markup = renderToStaticMarkup(createElement(MarketChart, {
    candles: [candle("2026-10-17T00:00:00.000Z", "81200.25")],
    productId,
  }));
  assert.match(markup, /ONLY STORED BAR IN THIS RANGE/);
  assert.match(markup, /2026-10-17/);
  assert.match(markup, /81200\.25/);
  assert.match(markup, /LAST STORED BAR · 2026-10-17 · 1 BAR\(S\) IN 1Y/);
});

test("a chart whose bars cannot be dated says the range is empty instead of drawing them", () => {
  const markup = renderToStaticMarkup(createElement(MarketChart, {
    candles: [
      { ...candle("2023-01-01T00:00:00.000Z", "16000"), openTime: "not-a-date" },
      { ...candle("2023-01-02T00:00:00.000Z", "16100"), openTime: "also-not-a-date" },
    ],
    productId,
  }));
  assert.match(markup, /No bars in the selected range/);
  assert.match(markup, /LAST STORED BAR · also-not/);
});

test("a position states gain or loss in words as well as in colour and sign", () => {
  const position = {
    market: "BTC-USD",
    quantity: "0.001",
    markPriceUsd: "81200",
    markFreshness: "FRESH",
    markSource: "coinbase",
  };
  const gain = renderToStaticMarkup(createElement(TradeWorkbench, {
    ...emptyMarketProps,
    accountFailure: null,
    balances: [],
    positions: [{ ...position, unrealisedPnlUsd: "3.25" }],
    orders: [],
    orderFailure: null,
  }));
  assert.match(gain, /UNREALISED GAIN/);
  assert.match(gain, /\+3\.25 USD/);

  const loss = renderToStaticMarkup(createElement(TradeWorkbench, {
    ...emptyMarketProps,
    accountFailure: null,
    balances: [],
    positions: [{ ...position, unrealisedPnlUsd: "-3.25" }],
    orders: [],
    orderFailure: null,
  }));
  assert.match(loss, /UNREALISED LOSS/);
  assert.match(loss, /−3\.25 USD/);
});

test("an empty account says what is missing rather than drawing a zero", () => {
  const markup = renderToStaticMarkup(createElement(TradeWorkbench, {
    ...emptyMarketProps,
    accountFailure: null,
    balances: [],
    positions: [],
    orders: [],
    orderFailure: null,
  }));
  assert.match(markup, /No ledger account yet/);
  assert.match(markup, /No open position/);
  assert.match(markup, /No orders yet/);
});
