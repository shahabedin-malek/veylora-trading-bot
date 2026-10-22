import {
  Activity,
  ArrowLeftRight,
  BarChart3,
  LayoutDashboard,
  Newspaper,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { DepthText } from "@/components/depth-text";
import { prisma } from "@/lib/db";
import { coinbaseMarketData } from "@/lib/market-data/coinbase-service";
import { FINANCIAL_RSS_FEEDS, FINANCIAL_RSS_PROVIDER_IDS } from "@/lib/market-data/rss-feeds";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";
import type { MarketQuote } from "@/lib/market-data/provider";
import { getCurrentUser } from "@/lib/auth/session-store";
import { SessionTopbarAction, TradingReadiness } from "@/components/session-readiness";
import { EthereumPortfolioPanel } from "@/components/ethereum-portfolio-panel";
import { MarketAlertsPanel } from "@/components/market-alerts-panel";
import { getRiskControlsStatus } from "@/lib/risk-controls/policy";
import { getRiskPolicySettings } from "@/lib/risk-controls/settings";

const navigation = [
  { label: "Overview", href: "#overview", icon: LayoutDashboard },
  { label: "Markets", href: "/markets", icon: BarChart3 },
  { label: "Trade", href: "/trade", icon: ArrowLeftRight },
  { label: "Portfolio", href: "#portfolio", icon: Wallet },
  { label: "Activity", href: "#activity", icon: Activity },
];

function ConnectionStatus({
  label,
  detail,
  status = "Not connected",
  icon: Icon,
}: {
  label: string;
  detail: string;
  status?: string;
  icon: typeof BarChart3;
}) {
  return (
    <div className="connection-status">
      <div className="connection-status__top">
        <Icon aria-hidden="true" size={16} strokeWidth={1.7} />
        <span>{label}</span>
      </div>
      <strong>{status}</strong>
      <span className="connection-status__detail">{detail}</span>
    </div>
  );
}

async function freshQuote(): Promise<MarketQuote | null> {
  await connection();
  const result = await coinbaseMarketData.getQuotes({ instruments: ["BTC-USD"] });
  if (result.status !== "available") return null;
  const quote = result.data[0];
  return quote?.provenance.freshness === "FRESH" ? quote : null;
}

async function MarketConnectionStatus() {
  const quote = await freshQuote();
  return (
    <ConnectionStatus
      detail={quote ? "Coinbase Exchange · BTC-USD" : "Approved public feed unavailable"}
      icon={BarChart3}
      label="Market data"
      status={quote ? "Connected" : "Not connected"}
    />
  );
}

async function NewsConnectionStatus() {
  await connection();
  const configuredFeedCount = FINANCIAL_RSS_FEEDS.length + 1;
  const feedRecords = await prisma.marketNewsRecord.groupBy({
    by: ["providerId"],
    where: { providerId: { in: ["coinbase-exchange-status", ...FINANCIAL_RSS_PROVIDER_IDS] } },
    _count: { _all: true },
  }).catch(() => []);
  const feedsWithCachedItems = feedRecords.length;
  const cachedHeadlineCount = feedRecords.reduce((total, feed) => total + feed._count._all, 0);
  const status = feedsWithCachedItems === configuredFeedCount
    ? "Connected"
    : feedsWithCachedItems > 0
      ? "Partial"
      : "Configured";

  return (
    <ConnectionStatus
      detail={`${feedsWithCachedItems}/${configuredFeedCount} feeds · ${cachedHeadlineCount} cached headlines`}
      icon={Newspaper}
      label="News feeds"
      status={status}
    />
  );
}

async function riskPolicyOrNull() {
  try {
    return await getRiskPolicySettings();
  } catch {
    return null;
  }
}

async function recordTradingDashboardView() {
  try {
    const user = await getCurrentUser();
    if (!user) return;
    await prisma.auditEvent.create({
      data: {
        actorUserId: user.id,
        action: "TRADING_DASHBOARD_VIEWED",
        objectType: "TradingDashboard",
        objectId: "overview",
        outcome: "SUCCESS",
        redactedJson: "{}",
      },
    });
  } catch {
    // Status remains read-only if audit storage is unavailable.
  }
}

async function RiskControlsConnectionStatus() {
  await connection();
  const policy = await riskPolicyOrNull();
  if (!policy) {
    return (
      <ConnectionStatus
        detail="Database unavailable; risk settings were not loaded"
        icon={ShieldCheck}
        label="Risk controls"
        status="Unavailable"
      />
    );
  }
  const riskStatus = getRiskControlsStatus(policy);
  return (
    <ConnectionStatus
      detail={riskStatus.detail}
      icon={ShieldCheck}
      label="Risk controls"
      status={riskStatus.status}
    />
  );
}

async function RiskPolicySummary() {
  await connection();
  await recordTradingDashboardView();
  const policy = await riskPolicyOrNull();
  if (!policy) {
    return (
      <section className="data-section operating-policy" aria-labelledby="policy-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">RISK SERVICE / FAIL-CLOSED</div>
            <h2 id="policy-title">Risk policy &amp; safeguards</h2>
          </div>
          <span className="section-state">ORDER ROUTE OFF</span>
        </div>
        <p className="policy-disclaimer" role="status">
          Risk policy could not be loaded from the database, so the order evaluator has no configured limits and refuses every intent until the settings row loads.
        </p>
      </section>
    );
  }
  return (
    <section className="data-section operating-policy" aria-labelledby="policy-title">
      <div className="section-heading">
        <div>
          <div className="section-kicker">RISK SERVICE / FAIL-CLOSED</div>
          <h2 id="policy-title">Risk policy &amp; safeguards</h2>
        </div>
        <span className="section-state">ORDER ROUTE OFF</span>
      </div>
      <p className="policy-disclaimer">
        Admin policy is loaded and the evaluator fails closed on any check it cannot resolve. No order route is wired, so these settings cannot submit trades yet.
      </p>
      <dl className="policy-grid">
        <div><dt>MAX RISK / TRADE</dt><dd>{policy.maxRiskPerTradePercent}% of configured capital</dd></div>
        <div><dt>MAX OPEN EXPOSURE</dt><dd>{policy.maxOpenExposurePercent}% of configured capital</dd></div>
        <div><dt>DAILY-LOSS HALT</dt><dd>{policy.dailyLossHaltPercent}% of configured capital</dd></div>
        <div><dt>MAX TRADES / DAY</dt><dd>{policy.maxTradesPerDay}</dd></div>
        <div><dt>DEFAULT LEVERAGE</dt><dd>{policy.defaultMaxLeverage}×</dd></div>
        <div><dt>MIN VERIFIED BALANCE</dt><dd>${policy.minimumVerifiedBalanceUsd} equivalent</dd></div>
        <div><dt>FIRST 24H EXPOSURE</dt><dd>${policy.first24HourExposureUsd} maximum</dd></div>
        <div><dt>SITE SYMBOLS</dt><dd>{policy.approvedSymbols.length}</dd></div>
        <div><dt>VERIFIED FUNDS</dt><dd>Checked on every intent</dd></div>
        <div><dt>VENUE CHECK</dt><dd>Intent must name a configured venue</dd></div>
        <div><dt>SYMBOL ACCESS</dt><dd>Per-user allow-list narrows the site list</dd></div>
        <div><dt>LIVE ARM</dt><dd>Checked on every intent</dd></div>
        <div><dt>KILL SWITCH</dt><dd>{policy.killSwitchActive ? "ACTIVE · BLOCKS INTENTS" : "READY"}</dd></div>
        <div><dt>AUDIT WRITES</dt><dd>Checked on every intent</dd></div>
      </dl>
      <p className="policy-note">
        Every opening intent is refused without a valid stop-loss and maximum-loss bound. A daily-loss halt blocks new intents at the configured threshold, and the first-day limit applies after arming. These settings configure the evaluator; no order route reads them yet.
      </p>
    </section>
  );
}

function shortAddress(address: string | null) {
  return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "Wallet connected";
}

async function WalletConnectionStatus() {
  await connection();
  const user = await getCurrentUser();
  return (
    <ConnectionStatus
      detail={user ? `${shortAddress(user.address)} · balance unverified` : "No approved balance source"}
      icon={Wallet}
      label="Wallet"
      status={user ? "Connected" : "Not connected"}
    />
  );
}

async function MarketWatch() {
  await connection();
  const quotes = await Promise.all(USD_WATCHLIST.map(async (instrument) => {
    const result = await coinbaseMarketData.getQuotes({ instruments: [instrument.productId] });
    return {
      instrument,
      quote: result.status === "available" ? result.data[0] ?? null : null,
    };
  }));

  return (
    <>
      <p className="market-watch-note">Ten curated Coinbase USD pairs · not a live market-cap ranking.</p>
      <div className="market-watch-list" role="list" aria-label="Curated Coinbase USD markets">
        {quotes.map(({ instrument, quote }) => {
          const observedAt = quote?.provenance.observedAt ?? null;
          const status = quote?.provenance.freshness ?? "UNAVAILABLE";
          const freshnessLabel = quote
            ? `${status} · ${observedAt ? new Date(observedAt).toISOString().slice(11, 19) + "Z" : "TIME UNKNOWN"}`
            : status;

          return (
            <div
              className="market-live-row"
              key={instrument.productId}
              role="listitem"
              aria-label={`${instrument.name}, ${instrument.productId}; best bid ${quote?.bid ?? "unavailable"}; best ask ${quote?.ask ?? "unavailable"}; ${status}${observedAt ? `; observed ${observedAt}` : ""}`}
            >
              <span className="market-live-row__instrument">{instrument.productId}</span>
              <span className="market-live-row__value">{quote?.bid ?? "—"}</span>
              <span className="market-live-row__value">{quote?.ask ?? "—"}</span>
              <span className="market-live-row__source" title={observedAt ?? undefined}>{freshnessLabel}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

export default function Home() {
  return (
    <div className="terminal-shell">
      <aside className="sidebar" aria-label="Application sidebar">
        <a className="brand" href="#overview" aria-label="Veylora overview">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="brand-name">veylora</span>
          <span className="brand-edition">TERMINAL</span>
        </a>

        <div className="sidebar-label">WORKSPACE</div>
        <nav className="primary-nav" aria-label="Primary navigation">
          {navigation.map(({ label, href, icon: Icon }, index) => (
            <a
              aria-current={index === 0 ? "page" : undefined}
              className={`primary-nav__link${index === 0 ? " is-active" : ""}`}
              href={href}
              key={label}
            >
              <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
              <span>{label}</span>
              {index === 0 && <span className="nav-indicator" aria-hidden="true" />}
            </a>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="sidebar-label">SESSION</div>
          <TradingReadiness />
          <div className="sidebar-version">LOCAL FOUNDATION / 01</div>
        </div>
      </aside>

      <div className="workspace" id="overview">
        <header className="topbar">
          <div className="breadcrumb">
            <span>VEYLORA</span>
            <span className="breadcrumb-separator">/</span>
            <span>CONTROL ROOM</span>
          </div>
          <div className="topbar-status">
            <span className="state-dot state-dot--muted" aria-hidden="true" />
            <span>PUBLIC MARKET DATA</span>
            <SessionTopbarAction />
          </div>
        </header>

        <main className="main-content">
          <section className="page-heading" aria-labelledby="page-title">
            <div className="page-heading__copy">
              <div className="eyebrow">
                <span className="eyebrow-line" aria-hidden="true" />
                TRADING CONSOLE <span className="eyebrow-separator">/</span> OVERVIEW
              </div>
              <h1 id="page-title"><DepthText text="Market overview" /></h1>
              <p>Live figures appear only when verified sources are connected.</p>
            </div>
            <div className="arm-state" aria-label="Trading state: disarmed">
              <span className="arm-state__icon">
                <ShieldCheck aria-hidden="true" size={17} strokeWidth={1.8} />
              </span>
              <span>
                <strong>DISARMED</strong>
                <small>ORDER ENTRY OFF</small>
              </span>
            </div>
          </section>

          <section className="connection-grid" aria-label="Connection status">
            <Suspense fallback={<ConnectionStatus detail="Waiting for a fresh public quote" icon={BarChart3} label="Market data" />}>
              <MarketConnectionStatus />
            </Suspense>
            <Suspense fallback={<ConnectionStatus detail="Checking stored exchange notices" icon={Newspaper} label="News feeds" />}>
              <NewsConnectionStatus />
            </Suspense>
            <Suspense fallback={<ConnectionStatus detail="Checking wallet session" icon={Wallet} label="Wallet" />}>
              <WalletConnectionStatus />
            </Suspense>
            <Suspense fallback={<ConnectionStatus detail="Loading local fail-closed policy" icon={ShieldCheck} label="Risk controls" />}>
              <RiskControlsConnectionStatus />
            </Suspense>
          </section>

          <Suspense fallback={<div className="market-chart-empty" role="status"><strong>Loading risk policy</strong></div>}>
            <RiskPolicySummary />
          </Suspense>

          <div className="content-grid">
            <section className="data-section market-section" id="markets" aria-labelledby="markets-title">
              <div className="section-heading">
                <div>
                  <div className="section-kicker">01 / MARKET WATCH</div>
                  <h2 id="markets-title">Watchlist</h2>
                </div>
                <Link className="section-action" href="/markets">OPEN MARKETS</Link>
              </div>

              <div className="table-head" aria-hidden="true">
                <span>ASSET / USD</span>
                <span>BEST BID</span>
                <span>BEST ASK</span>
                <span>FRESHNESS / UTC</span>
              </div>
              <Suspense fallback={<div className="empty-row" role="status"><strong>Loading public USD books</strong></div>}>
                <MarketWatch />
              </Suspense>
            </section>

            <EthereumPortfolioPanel />

            <section className="data-section activity-section" id="activity" aria-labelledby="activity-title">
              <div className="section-heading">
                <div>
                  <div className="section-kicker">03 / AUDIT STREAM</div>
                  <h2 id="activity-title">Recent activity</h2>
                </div>
                <span className="section-state">NO VERIFIED EVENTS</span>
              </div>
              <div className="activity-empty">
                <span className="activity-empty__line" aria-hidden="true" />
                <p>No verified account or execution events.</p>
              </div>
            </section>
          </div>

          <MarketAlertsPanel />

          <footer className="page-footer">
            <span>VEYLORA / REAL DATA ONLY</span>
            <span>COINBASE EXCHANGE / PUBLIC DATA</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
