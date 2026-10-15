import { connection } from "next/server";
import Link from "next/link";
import Image from "next/image";
import { CoinbaseLiveTicker } from "@/components/coinbase-live-ticker";
import { DepthText } from "@/components/depth-text";
import { GlareHover } from "@/components/glare-hover";
import { TerminalShell } from "@/components/terminal-shell";
import { coinbaseMarketData } from "@/lib/market-data/coinbase-service";
import { prisma } from "@/lib/db";
import { FINANCIAL_RSS_PROVIDER_IDS } from "@/lib/market-data/rss-feeds";
import { getBitcoinFearGreedIndex } from "@/lib/market-data/alternative-me-fear-greed";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";
import { getIntegrationFeatureSettings } from "@/lib/integrations/settings";
import { buildYearMarketReport } from "@/lib/market-data/year-report";
import { MarketChart, type ChartCandle } from "./market-chart";

export const instant = false;

async function LiveMarkets({ selectedMarket }: { selectedMarket: (typeof USD_WATCHLIST)[number] }) {
  const end = new Date();
  const start = new Date(end.getTime() - 365 * 86_400_000);
  start.setUTCHours(0, 0, 0, 0);
  const integrationSettings = await getIntegrationFeatureSettings().catch(() => null);
  const fearGreedEnabled = integrationSettings?.alternativeMeSentimentEnabled === true;
  const [quoteResult, candleRecords, reportRecords, fearGreed] = await Promise.all([
    coinbaseMarketData.getQuotes({ instruments: [selectedMarket.productId] }),
    prisma.marketCandleRecord.findMany({
      where: {
        providerId: "coinbase-exchange",
        symbol: selectedMarket.productId,
        interval: "1d",
        openTime: { gte: start, lte: end },
      },
      orderBy: { openTime: "asc" },
      take: 365,
    }).catch(() => []),
    prisma.marketCandleRecord.findMany({
      where: {
        providerId: "coinbase-exchange",
        symbol: { in: USD_WATCHLIST.map(({ productId }) => productId) },
        interval: "1d",
        openTime: { gte: start, lte: end },
      },
      orderBy: [{ symbol: "asc" }, { openTime: "asc" }],
      take: USD_WATCHLIST.length * 365,
    }).catch(() => []),
    fearGreedEnabled ? getBitcoinFearGreedIndex().catch(() => null) : Promise.resolve(null),
  ]);
  const financialNewsRecords = await prisma.marketNewsRecord.findMany({
    where: {
      providerId: { in: [...FINANCIAL_RSS_PROVIDER_IDS] },
      imageUrl: { not: null },
    },
    orderBy: [{ publishedAt: "desc" }, { fetchedAt: "desc" }],
    take: 12,
  }).catch(() => []);

  const quote = quoteResult.status === "available" ? quoteResult.data[0] ?? null : null;
  const freshQuote = quote?.provenance.freshness === "FRESH" ? quote : null;
  const yearReports = USD_WATCHLIST.map((instrument) => ({
    ...instrument,
    report: buildYearMarketReport(reportRecords
      .filter((record) => record.symbol === instrument.productId)
      .map((record) => ({
        openTime: record.openTime,
        high: record.high,
        low: record.low,
        close: record.close,
        volume: record.volume,
      }))),
  }));
  const candles: ChartCandle[] = candleRecords.map((candle) => ({
    openTime: candle.openTime.toISOString(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  }));
  const latestCandle = candleRecords.at(-1);
  const history = candleRecords.slice(-7).reverse();

  return (
    <>
      <div className="market-workbench-grid">
        <section className="data-section market-chart-section" aria-labelledby="chart-title">
          <div className="section-heading">
            <div>
              <div className="section-kicker">01 / DAILY CANDLES</div>
              <h2 id="chart-title">{selectedMarket.productId} · 1 year</h2>
            </div>
            <span className="section-state">{candles.length} STORED BARS</span>
          </div>
          <nav className="market-asset-selector" aria-label="Select market chart">
            {USD_WATCHLIST.map(({ productId, name }) => (
              <Link
                aria-current={productId === selectedMarket.productId ? "page" : undefined}
                className={productId === selectedMarket.productId ? "is-selected" : undefined}
                href={`/markets?asset=${encodeURIComponent(productId)}`}
                key={productId}
                title={name}
              >
                {productId}
              </Link>
            ))}
          </nav>
          <MarketChart candles={candles} productId={selectedMarket.productId} />
        </section>

        <GlareHover className="market-quote-glare">
        <aside className="market-quote-rail" aria-label={`${selectedMarket.productId} live quote`}>
          <div className="section-kicker">02 / PUBLIC SPOT FEED</div>
          <h2>{selectedMarket.productId}</h2>
          <p className="market-quote-rail__source">Coinbase Exchange · production</p>
          <CoinbaseLiveTicker key={selectedMarket.productId} initialQuote={freshQuote} productId={selectedMarket.productId} />
          <dl className="market-source-details">
            <div><dt>REST SNAPSHOT</dt><dd>{quote?.provenance.freshness === "FRESH" ? "FRESH" : "WITHHELD"}</dd></div>
            <div><dt>HISTORY SOURCE</dt><dd>Coinbase daily candles</dd></div>
            <div><dt>LAST STORED BAR</dt><dd>{latestCandle?.closeTime.toISOString().slice(0, 10) ?? "Not connected"}</dd></div>
            <div><dt>ORDER ENTRY</dt><dd>DISABLED</dd></div>
          </dl>
        </aside>
        </GlareHover>
      </div>

      <section className="data-section market-history-section" aria-labelledby="sentiment-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">02 / ATTRIBUTED SENTIMENT</div>
            <h2 id="sentiment-title">Bitcoin Fear &amp; Greed</h2>
          </div>
          <span className="section-state">DAILY / INFORMATIONAL ONLY</span>
        </div>
        {!fearGreedEnabled ? (
          <div className="market-chart-empty" role="status">
            <strong>Sentiment source disabled</strong>
            <span>An administrator can enable Alternative.me under Access → Project readiness.</span>
          </div>
        ) : fearGreed ? (
          <div className="sentiment-reading">
            <strong>{fearGreed.value}<span>/100</span></strong>
            <div>
              <b>{fearGreed.classification}</b>
              <small>Observed {fearGreed.observedAt} · updates about every five minutes</small>
            </div>
            <a href="https://alternative.me/crypto/fear-and-greed-index/" rel="noopener noreferrer" target="_blank">Data from Alternative.me</a>
          </div>
        ) : (
          <div className="market-chart-empty" role="status">
            <strong>Sentiment unavailable</strong>
            <span>Alternative.me did not return a valid reading. No score is inferred or carried forward.</span>
          </div>
        )}
        <p className="market-watch-note">Bitcoin market-sentiment context only. This index is not financial advice and never changes Veylora risk limits or authorizes orders.</p>
      </section>

      <section className="data-section market-history-section" aria-labelledby="year-report-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">03 / ONE-YEAR REPORT</div>
            <h2 id="year-report-title">Curated USD markets</h2>
          </div>
          <span className="section-state">{USD_WATCHLIST.length} MARKETS</span>
        </div>
        <p className="market-watch-note">Period change uses each asset&apos;s first and last stored daily close in the trailing one-year window. Coverage can vary; this is not a live market-cap ranking.</p>
        <div className="market-history-table-wrap">
          <table className="market-history-table">
            <thead><tr><th>MARKET</th><th>PERIOD CHANGE</th><th>HIGH</th><th>LOW</th><th>VOLUME</th><th>DAILY BARS</th><th>OBSERVED PERIOD</th></tr></thead>
            <tbody>
              {yearReports.map(({ productId, report }) => (
                <tr key={productId}>
                  <td><Link href={`/markets?asset=${encodeURIComponent(productId)}`}>{productId}</Link></td>
                  <td>{report ? `${report.periodChangePercent}%` : "UNAVAILABLE"}</td>
                  <td>{report?.high ?? "—"}</td>
                  <td>{report?.low ?? "—"}</td>
                  <td>{report?.volume ?? "—"}</td>
                  <td>{report?.bars ?? 0}</td>
                  <td>{report ? `${report.startDate} → ${report.endDate}` : "Insufficient stored history"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="data-section market-history-section" aria-labelledby="history-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">04 / SELECTED MARKET HISTORY</div>
            <h2 id="history-title">{selectedMarket.productId} daily candles</h2>
          </div>
          <span className="section-state">DELAYED HISTORICAL DATA</span>
        </div>
        {history.length > 0 ? (
          <div className="market-history-table-wrap">
            <table className="market-history-table">
              <thead><tr><th>DATE</th><th>OPEN</th><th>HIGH</th><th>LOW</th><th>CLOSE</th><th>VOLUME</th><th>PROVENANCE</th></tr></thead>
              <tbody>
                {history.map((candle) => (
                  <tr key={candle.openTime.toISOString()}>
                    <td>{candle.openTime.toISOString().slice(0, 10)}</td>
                    <td>{candle.open}</td>
                    <td>{candle.high}</td>
                    <td>{candle.low}</td>
                    <td>{candle.close}</td>
                    <td>{candle.volume}</td>
                    <td>{candle.providerId} · {candle.freshness}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="market-chart-empty" role="status">
            <strong>No verified candle history</strong>
            <span>Stored history will appear after a successful public feed sync.</span>
          </div>
        )}
      </section>

      <section className="data-section market-history-section" aria-labelledby="news-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">05 / NEWSWIRE</div>
            <h2 id="news-title">Financial news</h2>
          </div>
          <span className="section-state">IMAGE-BACKED RSS / DELAYED</span>
        </div>
        {financialNewsRecords.length > 0 ? (
          <ul className="market-news-gallery" aria-label="Financial RSS stories with images">
            {financialNewsRecords.map((item) => item.imageUrl && (
              <li key={item.url}>
                <a className="market-news-gallery__link" href={item.url} rel="noreferrer" target="_blank">
                  <div className="market-news-gallery__image">
                    <Image
                      alt=""
                      fill
                      loading="lazy"
                      sizes="(max-width: 520px) 100vw, (max-width: 900px) 50vw, 33vw"
                      src={item.imageUrl}
                    />
                  </div>
                  <div className="market-news-gallery__details">
                    <span className="market-news-gallery__source">{item.sourceName}</span>
                    <h3>{item.title}</h3>
                    <span className="market-news-gallery__date">{item.publishedAt?.toISOString().slice(0, 10) ?? "Date unavailable"}</span>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <div className="market-chart-empty" role="status">
            <strong>No image-backed stories</strong>
            <span>Stories appear here when a financial RSS feed supplies an approved image.</span>
          </div>
        )}
      </section>

      <footer className="page-footer">
        <span>PUBLIC MARKET DATA</span>
        <Link href="/">RETURN TO OVERVIEW</Link>
      </footer>
    </>
  );
}

export default async function MarketsPage({ searchParams }: PageProps<"/markets">) {
  await connection();
  const params = await searchParams;
  const requestedAsset = Array.isArray(params.asset) ? params.asset[0] : params.asset;
  const selectedMarket = USD_WATCHLIST.find(({ productId }) => productId === requestedAsset) ?? USD_WATCHLIST[0];
  return (
    <TerminalShell active="markets" section="MARKETS">
      <section className="page-heading" aria-labelledby="markets-page-title">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            TRADING CONSOLE <span className="eyebrow-separator">/</span> MARKETS
          </div>
          <h1 id="markets-page-title"><DepthText text="Public market data" /></h1>
          <p>Read-only Coinbase Exchange spot data. No orders or account data are accessed.</p>
        </div>
        <span className="section-state">{USD_WATCHLIST.length} USD MARKETS / PRODUCTION</span>
      </section>
      <LiveMarkets selectedMarket={selectedMarket} />
    </TerminalShell>
  );
}