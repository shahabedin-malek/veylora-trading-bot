import Link from "next/link";
import { CoinbaseLiveTicker } from "@/components/coinbase-live-ticker";
import { MarketChart, type ChartCandle } from "@/app/markets/market-chart";
import type { MarketQuote } from "@/lib/market-data/provider";

/**
 * The top of `/trade`: the chart the owner watches, beside the three figures the owner
 * checks while watching it. Nothing here is a new reading — the balances and positions are
 * the account view's own projection, the orders are the order store's rows, and the chart is
 * the same stored candles `/markets` draws. The workbench adds only the arrangement, so it
 * cannot disagree with the panels below it.
 *
 * A panel with no rows is not hidden and not drawn as a zero: it says which of the three
 * honest conditions it is in — loading is impossible on the server, so a failed read names
 * its reason, and an empty read says there is nothing yet.
 */

export type DeskBalance = { asset: string; available: string; held: string };
export type DeskPosition = {
  market: string;
  quantity: string;
  markPriceUsd: string | null;
  unrealisedPnlUsd: string | null;
  markFreshness: string | null;
  markSource: string | null;
};
export type DeskOrder = {
  id: string;
  market: string;
  side: string;
  status: string;
  statusLabel: string;
  createdAt: string;
  venue: string;
};

function pnlReading(value: string | null) {
  if (value === null) return { label: "UNAVAILABLE", text: "Not marked", tone: "flat" };
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return { label: "UNAVAILABLE", text: value, tone: "flat" };
  if (numeric > 0) return { label: "UNREALISED GAIN", text: `+${value} USD`, tone: "gain" };
  if (numeric < 0) return { label: "UNREALISED LOSS", text: `−${value.replace(/^-/, "")} USD`, tone: "loss" };
  return { label: "FLAT", text: `${value} USD`, tone: "flat" };
}

function orderTime(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? `${new Date(parsed).toISOString().slice(5, 16).replace("T", " ")} UTC` : value;
}

export function TradeWorkbench({
  productId,
  candles,
  chartFailure,
  quote,
  quoteFailure,
  balances,
  positions,
  orders,
  accountFailure,
  orderFailure,
}: {
  productId: string;
  candles: readonly ChartCandle[];
  chartFailure: string | null;
  quote: MarketQuote | null;
  quoteFailure: string | null;
  balances: readonly DeskBalance[] | null;
  positions: readonly DeskPosition[] | null;
  orders: readonly DeskOrder[] | null;
  accountFailure: string | null;
  orderFailure: string | null;
}) {
  return (
    <div className="trade-workbench" aria-label="Trading workbench">
      <section className="trade-workbench__chart" aria-labelledby="trade-desk-chart-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">01 / MARKET CONTEXT</div>
            <h2 id="trade-desk-chart-title">{productId} · daily candles</h2>
          </div>
          <span className="section-state">PUBLIC SPOT / PAPER EXECUTION</span>
        </div>

        <div className="desk-quote">
          <div className="desk-quote__copy">
            <span className="section-kicker">PUBLIC SPOT FEED</span>
            <strong>{productId}</strong>
            <small>Coinbase Exchange · production</small>
          </div>
          <CoinbaseLiveTicker compact initialQuote={quote} productId={productId} />
        </div>

        {quoteFailure ? (
          <p className="desk-note desk-note--failed" role="status">
            <strong>QUOTE WITHHELD</strong> {quoteFailure} The last verified ticker reading stays on screen when one exists;
            nothing is inferred from the stored candles.
          </p>
        ) : null}

        <MarketChart candles={candles} failure={chartFailure} productId={productId} />
      </section>

      <aside className="trade-workbench__rail" aria-label="Account at a glance">
        <section className="desk-panel" aria-labelledby="desk-balances-title">
          <div className="desk-panel__head">
            <div>
              <div className="section-kicker">ACCOUNT</div>
              <h3 id="desk-balances-title">Balances</h3>
            </div>
            <Link className="desk-panel__link" href="#balances-title">LEDGER ↓</Link>
          </div>
          {balances === null ? (
            <p className="desk-panel__failure" role="alert">
              <strong>Balances unavailable</strong>
              <span>{accountFailure ?? "The ledger did not answer."}</span>
            </p>
          ) : balances.length === 0 ? (
            <p className="desk-panel__empty" role="status">No ledger account yet. A credited deposit opens one.</p>
          ) : (
            <ul className="desk-list desk-list--balances">
              {balances.map((balance) => (
                <li key={balance.asset}>
                  <span>{balance.asset}</span>
                  <strong>{balance.available}</strong>
                  <small>{Number(balance.held) > 0 ? `${balance.held} held` : "available"}</small>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="desk-panel" aria-labelledby="desk-positions-title">
          <div className="desk-panel__head">
            <div>
              <div className="section-kicker">NOW</div>
              <h3 id="desk-positions-title">Positions</h3>
            </div>
            <Link className="desk-panel__link" href="/#portfolio">PORTFOLIO ↗</Link>
          </div>
          {positions === null ? (
            <p className="desk-panel__failure" role="alert">
              <strong>Positions unavailable</strong>
              <span>{accountFailure ?? "The account view did not answer."}</span>
            </p>
          ) : positions.length === 0 ? (
            <p className="desk-panel__empty" role="status">No open position. A filled order opens one.</p>
          ) : (
            <ul className="desk-list desk-list--positions">
              {positions.map((position) => {
                const reading = pnlReading(position.unrealisedPnlUsd);
                return (
                  <li key={position.market}>
                    <div className="desk-list__title">
                      <strong>{position.market}</strong>
                      <span>{position.quantity}</span>
                    </div>
                    <div className={`desk-pnl desk-pnl--${reading.tone}`}>
                      <b>{reading.text}</b>
                      <small>{reading.label}</small>
                    </div>
                    <small className="desk-list__meta">
                      MARK {position.markPriceUsd ?? "UNAVAILABLE"} · {(position.markFreshness ?? "UNKNOWN").replaceAll("_", " ")}
                    </small>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="desk-panel" aria-labelledby="desk-orders-title">
          <div className="desk-panel__head">
            <div>
              <div className="section-kicker">RECENT</div>
              <h3 id="desk-orders-title">Orders</h3>
            </div>
            <span className="desk-panel__links">
              <Link className="desk-panel__link" href="#order-ticket">TICKET ↓</Link>
              <Link className="desk-panel__link" href="#order-state-title">ALL ↓</Link>
            </span>
          </div>
          {orders === null ? (
            <p className="desk-panel__failure" role="alert">
              <strong>Orders unavailable</strong>
              <span>{orderFailure ?? "The order store did not answer."}</span>
            </p>
          ) : orders.length === 0 ? (
            <p className="desk-panel__empty" role="status">No orders yet. The form below places the first one.</p>
          ) : (
            <ol className="desk-list desk-list--orders">
              {orders.map((order) => (
                <li key={order.id}>
                  <div className="desk-list__title">
                    <strong>{order.market} · {order.side}</strong>
                    <span>{order.statusLabel}</span>
                  </div>
                  <small className="desk-list__meta">{order.venue} · {orderTime(order.createdAt)}</small>
                </li>
              ))}
            </ol>
          )}
        </section>
      </aside>
    </div>
  );
}
