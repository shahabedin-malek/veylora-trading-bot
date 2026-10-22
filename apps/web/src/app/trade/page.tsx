import { connection } from "next/server";
import { redirect } from "next/navigation";
import { AccessNotice } from "@/components/access-notice";
import { BalancePanel } from "@/components/balance-panel";
import { DepositPanel } from "@/components/deposit-panel";
import { NetworkSwitcher } from "@/components/network-switcher";
import { OrdersPanel } from "@/components/orders-panel";
import { SmartTradingControl } from "@/components/smart-trading-control";
import { StrategyStatus } from "@/components/strategy-status";
import { TerminalShell } from "@/components/terminal-shell";
import { TradeWorkbench } from "@/components/trade-workbench";
import { TradingAccounts } from "@/components/trading-accounts";
import { WithdrawPanel } from "@/components/withdraw-panel";
import { checkPageAccess } from "@/lib/auth/access-gate";
import { prisma } from "@/lib/db";
import { developmentDetail } from "@/lib/dev-mode/development-detail";
import { coinbaseMarketData } from "@/lib/market-data/coinbase-service";
import { describeMarketDataFailure, type MarketQuote } from "@/lib/market-data/provider";
import { orderResource } from "@/lib/orders/api";
import { orderStore } from "@/lib/orders/store";
import { accountPayload, readAccountView } from "@/lib/portfolio/service";
import { getStrategyActivationView } from "@/lib/strategies/activation";
import { getStrategyDecisionFeed } from "@/lib/strategies/runner";
import { orderVenueSummary } from "@/lib/venues/registry";

export const instant = false;

const CAPABILITY = "Connected exchange accounts need a signed-in account";

export default async function TradePage() {
  await connection();
  const access = await checkPageAccess({ kind: "user" });
  if (access.status === "unconfigured") {
    return (
      <TerminalShell active="trade" section="TRADE">
        <AccessNotice capability={CAPABILITY} reason={access.reason} />
      </TerminalShell>
    );
  }
  if (access.status === "anonymous") redirect("/login");
  // A signed-in account that cannot read its own trading page is sent to sign-in rather
  // than shown a half-page; the activation below is read only once an identity exists.
  if (access.status !== "granted") redirect("/login");

  // The heading states where an order would go, from the same registry the submission asks.
  // It is read per render rather than hard-coded, because the answer is admin data now —
  // phase 21's testnet switch and phase 22's real-money switch — and a stale label would be
  // a lie the moment the owner changes either one.
  // The activation is the account's own row. Its absence is the "not started" state, not
  // an error, so the read is allowed to answer with a view either way; only a database
  // that cannot be read at all leaves the control off the page, and that is said plainly
  // rather than drawn as a disabled button.
  const strategyView = await getStrategyActivationView(access.user.id).catch(() => null);
  // The decisions the runner wrote, read on the server once per request. A missing table or a
  // failed read leaves the section off rather than drawing an empty history that would read
  // like "nothing has ever run".
  const decisionFeed = await getStrategyDecisionFeed(access.user.id).catch(() => null);

  const venue = await orderVenueSummary();
  const venueState =
    venue.environment === "live"
      ? "LIVE VENUE"
      : venue.environment === "testnet"
        ? "TESTNET VENUE"
        : venue.available
          ? "PAPER VENUE"
          : "ROUTING UNAVAILABLE";

  // The workbench reads the same sources as the panels below it, in parallel, and each read
  // carries its own failure: a chart that could not be read must not take the balances with
  // it, and no panel is rendered blank in place of a reason.
  const deskNow = new Date();
  const deskProductId = "BTC-USD";
  const deskFrom = new Date(deskNow.getTime() - 365 * 86_400_000);
  const [accountRead, orderRead, quoteRead, candleRead] = await Promise.all([
    readAccountView({
      userId: access.user.id,
      filter: { from: deskFrom, to: deskNow, asset: null, types: [], hash: null },
      now: deskNow,
    })
      .then((view) => ({ ok: true as const, payload: accountPayload(view) }))
      .catch((error: unknown) => ({
        ok: false as const,
        failure: developmentDetail(error, "The account view could not be read from the ledger."),
      })),
    orderStore().listOrders({ userId: access.user.id, limit: 6 })
      .then((rows) => ({ ok: true as const, orders: rows.map(orderResource) }))
      .catch((error: unknown) => ({
        ok: false as const,
        failure: developmentDetail(error, "The order store could not be read."),
      })),
    coinbaseMarketData.getQuotes({ instruments: [deskProductId] }).catch(() => ({
      status: "unavailable" as const,
      reason: "provider-error" as const,
      retryable: true,
    })),
    prisma.marketCandleRecord.findMany({
      where: {
        providerId: "coinbase-exchange",
        symbol: deskProductId,
        interval: "1d",
        openTime: { gte: deskFrom, lte: deskNow },
      },
      orderBy: { openTime: "asc" },
      take: 365,
    })
      .then((rows) => ({ ok: true as const, rows }))
      .catch((error: unknown) => ({
        ok: false as const,
        failure: developmentDetail(error, "The stored candle history could not be read."),
      })),
  ]);

  const deskQuote: MarketQuote | null = quoteRead.status === "available" ? quoteRead.data[0] ?? null : null;
  const quoteFailure =
    quoteRead.status === "available"
      ? deskQuote
        ? null
        : "The provider answered without a quote for this market."
      : describeMarketDataFailure(quoteRead).message;
  const candles = candleRead.ok
    ? candleRead.rows.map((candle) => ({
        openTime: candle.openTime.toISOString(),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      }))
    : [];

  return (
    <TerminalShell active="trade" section="TRADE">
      <section className="page-heading" aria-labelledby="trade-page-title">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            ACCOUNT ACCESS <span className="eyebrow-separator">/</span> SPOT
          </div>
          <h1 id="trade-page-title">Trading desk</h1>
          <p>Market context, balances, positions and recent orders in one view. Connect your own exchange accounts and place a paper order below; every key is encrypted at rest and scoped to your signed-in account.</p>
        </div>
      </section>

      <TradeWorkbench
        accountFailure={accountRead.ok ? null : accountRead.failure}
        balances={accountRead.ok ? accountRead.payload.balances.map(({ asset, available, held }) => ({ asset, available, held })) : null}
        candles={candles}
        chartFailure={candleRead.ok ? null : candleRead.failure}
        orderFailure={orderRead.ok ? null : orderRead.failure}
        orders={orderRead.ok ? orderRead.orders.map(({ id, market, side, status, statusLabel, createdAt, venue }) => ({
          id,
          market,
          side,
          status,
          statusLabel,
          createdAt,
          venue,
        })) : null}
        positions={accountRead.ok ? accountRead.payload.positions.map(({ market, quantity, markPriceUsd, unrealisedPnlUsd, markFreshness, markSource }) => ({
          market,
          quantity,
          markPriceUsd,
          unrealisedPnlUsd,
          markFreshness,
          markSource,
        })) : null}
        productId={deskProductId}
        quote={deskQuote}
        quoteFailure={quoteFailure}
      />

      <NetworkSwitcher />

      <section className="data-section trading-automation-section" aria-labelledby="automation-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">01 / AUTOMATION</div>
            <h2 id="automation-title">Smart AI trading</h2>
          </div>
          <span className="section-state">OWNER CONTROLLED</span>
        </div>
        <p className="trading-security-note">
          Start or stop automated trading for this account. The state is data, not a browser
          session: it survives a reload, a closed tab and a redeploy, and only the runner records what a pass found.
          Start and stop always answer, and neither asks for a confirmation.
        </p>
        {strategyView ? (
          <SmartTradingControl initialView={strategyView} />
        ) : (
          <p className="policy-disclaimer" role="status">
            The activation state could not be read from the database, so the control is not shown rather than shown
            with a state it cannot confirm.            Nothing was started or stopped.
          </p>
        )}
        {decisionFeed ? <StrategyStatus feed={decisionFeed} /> : null}
      </section>

      <section className="data-section trading-accounts-section" aria-labelledby="account-connections-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">02 / EXCHANGE ACCESS</div>
            <h2 id="account-connections-title">Your connected accounts</h2>
          </div>
          <span className="section-state">BALANCE READS</span>
        </div>
        <p className="trading-security-note">Connectors exist for Coinbase Advanced, Kraken, and Binance; another venue joins when a connector is written. Keys are encrypted at rest, sent only to the venue you chose, and read balances or profiles.</p>
        <TradingAccounts />
      </section>

      <section className="data-section trading-orders-state" aria-labelledby="order-state-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">03 / EXECUTION</div>
            <h2 id="order-state-title">Orders</h2>
          </div>
          <span className="section-state">{venueState}</span>
        </div>
        <p className="trading-security-note">
          Statuses, retries, idempotency keys and reconciliation are real, and so is the venue: orders go to{" "}
          {venue.label} under this account&apos;s own key, chosen by the admin switches below rather than by the request.
          {" "}{venue.detail} Every state change is written to the audit trail with its reason, and so is every order a
          switch stopped.
        </p>
        <OrdersPanel />
      </section>

      <section className="data-section trading-deposits-state" aria-labelledby="deposits-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">04 / FUNDING</div>
            <h2 id="deposits-title">Deposits</h2>
          </div>
          <span className="section-state">ON-CHAIN</span>
        </div>
        <p className="trading-security-note">Your deposit address per enabled network, derived from this deployment&apos;s seed and your account alone, so it never changes. A transfer is recorded when the watcher sees it, shown as pending until it has the confirmations this network requires, and credited once — replaying the same chain event credits nothing twice. Every state change is audited.</p>
        <DepositPanel />
      </section>

      <section className="data-section trading-balances-state" aria-labelledby="balances-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">05 / LEDGER</div>
            <h2 id="balances-title">Balances and statement</h2>
          </div>
          <span className="section-state">DOUBLE ENTRY</span>
        </div>
        <p className="trading-security-note">Every credited deposit posts a balanced movement between the platform&apos;s accounts and yours, in exact minor units with no floating point anywhere in the path. The balance here is not stored: it is the sum of those entries, the statement lists each one with its counterparty and transaction id, and the ledger&apos;s own invariants are checked on the runner&apos;s cadence and reported above the figures.</p>
        <BalancePanel />
      </section>

      <section className="data-section trading-withdrawals-state" aria-labelledby="withdrawals-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">06 / WITHDRAWALS</div>
            <h2 id="withdrawals-title">Withdrawals</h2>
          </div>
          <span className="section-state">OWN WALLET</span>
        </div>
        <p className="trading-security-note">A withdrawal holds the amount out of your spendable balance the moment it is accepted, so two requests can never spend it twice. It is signed once and broadcast once — a retry re-sends the same signed transaction rather than signing a second one — and it settles only once the network&apos;s confirmation count is reached. A failure that took nothing releases the amount and says why, and the only hold in front of your own withdrawal is the new-address window you configure.</p>
        <WithdrawPanel />
      </section>
    </TerminalShell>
  );
}