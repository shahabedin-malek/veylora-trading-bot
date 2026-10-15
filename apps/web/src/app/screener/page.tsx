import DecimalJS from "decimal.js";
import { connection } from "next/server";
import { DepthText } from "@/components/depth-text";
import { TerminalShell } from "@/components/terminal-shell";
import { coinbaseMarketData } from "@/lib/market-data/coinbase-service";
import type { MarketQuote } from "@/lib/market-data/provider";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";

const Decimal = DecimalJS.clone({ precision: 40 });

export const instant = false;

type ScreenRow = {
  instrument: (typeof USD_WATCHLIST)[number];
  quote: MarketQuote | null;
  spreadBps: string | null;
};

function spreadBasisPoints(quote: MarketQuote): string | null {
  if (!quote.bid || !quote.ask) return null;

  try {
    const bid = new Decimal(quote.bid);
    const ask = new Decimal(quote.ask);
    if (!bid.isFinite() || !ask.isFinite() || bid.lte(0) || ask.lt(bid)) return null;

    const midpoint = bid.plus(ask).dividedBy(2);
    return ask.minus(bid).dividedBy(midpoint).times(10_000).toDecimalPlaces(2).toFixed(2);
  } catch {
    return null;
  }
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function validSpreadLimit(value: string | undefined): string | null {
  if (!value || !/^\d{1,5}(?:\.\d{1,2})?$/.test(value)) return null;
  const limit = new Decimal(value);
  return limit.isFinite() && limit.greaterThanOrEqualTo(0) && limit.lessThanOrEqualTo(10_000)
    ? limit.toFixed()
    : null;
}

function MarketRows({ rows }: { rows: readonly ScreenRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="market-chart-empty" role="status">
        <strong>No quotes match this screen</strong>
        <span>Relax the spread limit or refresh after the public feed updates.</span>
      </div>
    );
  }

  return (
    <div className="market-history-table-wrap">
      <table className="market-history-table screener-table">
        <thead>
          <tr><th>MARKET</th><th>BEST BID (USD)</th><th>BEST ASK (USD)</th><th>SPREAD (BPS)</th><th>FRESHNESS</th><th>OBSERVED (UTC)</th></tr>
        </thead>
        <tbody>
          {rows.map(({ instrument, quote, spreadBps }) => (
            <tr key={instrument.productId}>
              <td title={instrument.name}>{instrument.productId}</td>
              <td>{quote?.bid ?? "UNAVAILABLE"}</td>
              <td>{quote?.ask ?? "UNAVAILABLE"}</td>
              <td>{spreadBps ?? "UNAVAILABLE"}</td>
              <td>{quote?.provenance.freshness ?? "UNAVAILABLE"}</td>
              <td>{quote?.provenance.observedAt ? new Date(quote.provenance.observedAt).toISOString() : "UNKNOWN"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function ScreenerPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await connection();
  const params = await searchParams;
  const spreadLimit = validSpreadLimit(firstParam(params.maxSpreadBps));
  const freshOnly = firstParam(params.freshOnly) === "1";
  const results = await Promise.all(USD_WATCHLIST.map(async (instrument) => {
    try {
      const result = await coinbaseMarketData.getQuotes({ instruments: [instrument.productId] });
      return { instrument, quote: result.status === "available" ? result.data[0] ?? null : null };
    } catch {
      return { instrument, quote: null };
    }
  }));

  const rows: ScreenRow[] = results.map(({ instrument, quote }) => ({
    instrument,
    quote,
    spreadBps: quote ? spreadBasisPoints(quote) : null,
  }));
  const unavailableRows = rows.filter(({ quote, spreadBps }) => !quote || spreadBps === null);
  const availableRows = rows
    .filter((row): row is ScreenRow & { quote: MarketQuote; spreadBps: string } => row.quote !== null && row.spreadBps !== null)
    .filter(({ quote }) => !freshOnly || quote.provenance.freshness === "FRESH")
    .filter(({ spreadBps }) => spreadLimit === null || new Decimal(spreadBps).lessThanOrEqualTo(spreadLimit))
    .sort((left, right) => new Decimal(left.spreadBps!).comparedTo(right.spreadBps!));

  return (
    <TerminalShell active="screener" section="MARKET SCREENER">
      <section className="page-heading" aria-labelledby="screener-title">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            MARKET INTELLIGENCE <span className="eyebrow-separator">/</span> SCREENER
          </div>
          <h1 id="screener-title"><DepthText text="Market screener" /></h1>
          <p>Compare real Coinbase Exchange best bid/ask snapshots. This screen is informational and cannot place orders.</p>
        </div>
        <span className="section-state">PUBLIC DATA</span>
      </section>

      <section className="data-section screener-section" aria-labelledby="screen-controls-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">01 / SCREEN CONDITIONS</div>
            <h2 id="screen-controls-title">Spread and freshness</h2>
          </div>
          <span className="section-state">{availableRows.length} MATCHING MARKETS</span>
        </div>
        <form className="screener-filters" method="get">
          <label className="screener-filter-control" htmlFor="max-spread-bps">
            <span>MAX SPREAD (BPS)</span>
            <input id="max-spread-bps" inputMode="decimal" max="10000" min="0" name="maxSpreadBps" placeholder="No limit" step="0.1" type="number" defaultValue={spreadLimit ?? ""} />
          </label>
          <label className="screener-fresh-control" htmlFor="fresh-only">
            <input id="fresh-only" name="freshOnly" type="checkbox" value="1" defaultChecked={freshOnly} />
            <span>Fresh quotes only</span>
          </label>
          <button className="section-action" type="submit">APPLY SCREEN</button>
          <a className="section-action" href="/screener">RESET</a>
        </form>
        <p className="market-watch-note">Spread is calculated from verified bid/ask against their midpoint. Markets without a valid quote remain unranked below; no last price or 24-hour change is inferred.</p>
      </section>

      <section className="data-section screener-section" aria-labelledby="screen-results-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">02 / LIVE SNAPSHOT</div>
            <h2 id="screen-results-title">Best bid/ask by spread</h2>
          </div>
          <span className="section-state">COINBASE EXCHANGE · LEVEL 1</span>
        </div>
        <MarketRows rows={availableRows} />
      </section>

      {unavailableRows.length > 0 && (
        <section className="data-section screener-section" aria-labelledby="unranked-title">
          <div className="section-heading">
            <div>
              <div className="section-kicker">03 / UNRANKED</div>
              <h2 id="unranked-title">Unavailable or invalid quotes</h2>
            </div>
            <span className="section-state">{unavailableRows.length} MARKETS</span>
          </div>
          <MarketRows rows={unavailableRows} />
        </section>
      )}

      <footer className="page-footer">
        <span>PUBLIC COINBASE EXCHANGE DATA</span>
        <a href="/markets">OPEN MARKET CHARTS</a>
      </footer>
    </TerminalShell>
  );
}