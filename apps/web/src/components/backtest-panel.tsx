"use client";

import { Play } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { UTCTimestamp } from "lightweight-charts";
import type { BacktestResult } from "@/lib/backtesting/rsi-backtester";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";

function EquityCurve({ result }: { result: BacktestResult }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let chart: import("lightweight-charts").IChartApi | null = null;
    let observer: ResizeObserver | null = null;
    let disposed = false;

    const data = result.equityCurve.flatMap((point) => {
      const value = Number(point.equityUsd);
      const timestamp = Date.parse(point.time);
      return Number.isFinite(value) && Number.isFinite(timestamp)
        ? [{ time: Math.floor(timestamp / 1000) as UTCTimestamp, value }]
        : [];
    });

    void import("lightweight-charts").then((library) => {
      const container = containerRef.current;
      if (!container || disposed || data.length < 2) return;
      chart = library.createChart(container, {
        width: container.clientWidth,
        height: 250,
        layout: { background: { type: library.ColorType.Solid, color: "transparent" }, textColor: "#8b9a97", fontFamily: '"IBM Plex Mono", monospace', fontSize: 10, attributionLogo: true },
        grid: { vertLines: { color: "rgba(139,154,151,0.08)" }, horzLines: { color: "rgba(139,154,151,0.08)" } },
        rightPriceScale: { borderColor: "#273536" },
        timeScale: { borderColor: "#273536", timeVisible: false, rightOffset: 2 },
        crosshair: { vertLine: { color: "#60706d" }, horzLine: { color: "#60706d" } },
      });
      chart.addSeries(library.LineSeries, { color: "#a8e4bd", lineWidth: 2, priceLineVisible: false }).setData(data);
      chart.timeScale().fitContent();
      observer = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width;
        if (chart && width && width > 0) chart.applyOptions({ width });
      });
      observer.observe(container);
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      chart?.remove();
    };
  }, [result]);

  return <div className="backtest-equity-chart" aria-label="Backtest equity curve" ref={containerRef} />;
}

function fixed(value: string | null, digits = 2) {
  if (value === null || !Number.isFinite(Number(value))) return "NOT AVAILABLE";
  return Number(value).toFixed(digits);
}

export function BacktestPanel() {
  const [symbol, setSymbol] = useState("BTC-USD");
  const [initialCapitalUsd, setInitialCapitalUsd] = useState("");
  const [feeBps, setFeeBps] = useState("");
  const [slippageBps, setSlippageBps] = useState("");
  const [buyRsiBelow, setBuyRsiBelow] = useState("30");
  const [sellRsiAbove, setSellRsiAbove] = useState("70");
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function runBacktest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setResult(null);
    setRunning(true);
    try {
      const response = await fetch("/api/backtest", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, initialCapitalUsd, feeBps, slippageBps, buyRsiBelow, sellRsiAbove }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : "Backtest could not be completed.";
        throw new Error(message);
      }
      setResult(payload as BacktestResult);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Backtest could not be completed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="backtest-workbench">
      <section className="data-section backtest-config" aria-labelledby="backtest-config-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">PUBLIC HISTORICAL DATA · ANALYSIS ONLY</div>
            <h2 id="backtest-config-title">Strategy and assumptions</h2>
          </div>
          <span className="section-state">NO ORDERS</span>
        </div>
        <form className="backtest-form" onSubmit={runBacktest}>
          <label><span>MARKET</span><select onChange={(event) => setSymbol(event.target.value)} value={symbol}>{USD_WATCHLIST.map(({ productId }) => <option key={productId} value={productId}>{productId}</option>)}</select></label>
          <label><span>INITIAL CAPITAL (USD)</span><input inputMode="decimal" onChange={(event) => setInitialCapitalUsd(event.target.value)} placeholder="Required" value={initialCapitalUsd} /></label>
          <label><span>FEE (BPS / SIDE)</span><input inputMode="decimal" onChange={(event) => setFeeBps(event.target.value)} placeholder="Required" value={feeBps} /></label>
          <label><span>SLIPPAGE (BPS / SIDE)</span><input inputMode="decimal" onChange={(event) => setSlippageBps(event.target.value)} placeholder="Required" value={slippageBps} /></label>
          <label><span>RSI-14 BUY ON CROSS BELOW</span><input inputMode="decimal" onChange={(event) => setBuyRsiBelow(event.target.value)} value={buyRsiBelow} /></label>
          <label><span>RSI-14 SELL ON CROSS ABOVE</span><input inputMode="decimal" onChange={(event) => setSellRsiAbove(event.target.value)} value={sellRsiAbove} /></label>
          <div className="backtest-strategy-shape">
            <span>INDICATOR</span><strong>RSI-14 / DAILY</strong>
            <span>CONDITIONS</span><strong>Cross below entry · cross above exit</strong>
            <span>ACTIONS</span><strong>Buy · sell (historical accounting only)</strong>
          </div>
          <p className="backtest-assumptions">Fee and slippage values are your assumptions, applied on entry and exit. The engine requests a fixed trailing 365-day window; it will refuse shortened history.</p>
          <button className="section-action" disabled={running || !initialCapitalUsd || !feeBps || !slippageBps} type="submit">
            <Play aria-hidden="true" size={13} />
            {running ? "FETCHING FULL HISTORY" : "RUN FULL-YEAR BACKTEST"}
          </button>
        </form>
        {error && <div className="market-chart-empty backtest-message" role="alert"><strong>Backtest unavailable</strong><span>{error}</span></div>}
        {!result && !error && <div className="market-chart-empty backtest-message" role="status"><strong>No backtest run</strong><span>Enter capital, fee, and slippage assumptions. The run uses real Coinbase daily candles.</span></div>}
      </section>

      {result && (
        <>
          <section className="data-section backtest-results" aria-labelledby="backtest-results-title">
            <div className="section-heading">
              <div>
                <div className="section-kicker">{result.source.toUpperCase()} · {result.interval.toUpperCase()}</div>
                <h2 id="backtest-results-title">{result.symbol} results</h2>
              </div>
              <span className="section-state">{result.barCount} DAILY BARS</span>
            </div>
            <p className="backtest-period">FULL PERIOD · {new Date(result.periodStart).toISOString().slice(0, 10)} — {new Date(result.periodEnd).toISOString().slice(0, 10)}</p>
            <div className="backtest-metrics">
              <div><span>FINAL CAPITAL</span><strong>${fixed(result.finalCapitalUsd)}</strong></div>
              <div><span>TOTAL RETURN</span><strong>{fixed(result.totalReturnPercent)}%</strong></div>
              <div><span>MAX DRAWDOWN</span><strong>{fixed(result.maxDrawdownPercent)}%</strong></div>
              <div><span>WIN RATE</span><strong>{result.winRatePercent === null ? "NO CLOSED TRADES" : `${result.winRatePercent}%`}</strong></div>
              <div><span>PROFIT FACTOR</span><strong>{result.profitFactor ?? (result.trades.length === 0 ? "NO CLOSED TRADES" : "NO LOSING TRADES")}</strong></div>
              <div><span>FEES / SLIPPAGE</span><strong>${fixed(result.totalFeesUsd)} / ${fixed(result.totalSlippageUsd)}</strong></div>
            </div>
            <div className="section-kicker backtest-chart-label">EQUITY CURVE · FEES AND SLIPPAGE INCLUDED</div>
            <EquityCurve result={result} />
          </section>

          <section className="data-section backtest-results" aria-labelledby="backtest-trades-title">
            <div className="section-heading">
              <div><div className="section-kicker">HISTORICAL SIGNAL ACCOUNTING</div><h2 id="backtest-trades-title">Trade list</h2></div>
              <span className="section-state">{result.trades.length} ROUND TRIPS</span>
            </div>
            {result.trades.length > 0 ? (
              <div className="market-history-table-wrap">
                <table className="market-history-table backtest-trade-table">
                  <thead><tr><th>ENTRY UTC</th><th>EXIT UTC</th><th>ENTRY PRICE</th><th>EXIT PRICE</th><th>QUANTITY</th><th>FEES</th><th>SLIPPAGE</th><th>NET P&amp;L</th><th>EXIT</th></tr></thead>
                  <tbody>{result.trades.map((trade, index) => <tr key={`${trade.entryAt}:${index}`}>
                    <td>{new Date(trade.entryAt).toISOString().slice(0, 10)}</td><td>{new Date(trade.exitAt).toISOString().slice(0, 10)}</td>
                    <td>{trade.entryPrice}</td><td>{trade.exitPrice}</td><td>{trade.quantity}</td><td>{trade.feesUsd}</td><td>{trade.slippageUsd}</td>
                    <td>{trade.pnlUsd} ({trade.pnlPercent}%)</td><td>{trade.exitReason === "END_OF_PERIOD" ? "PERIOD CLOSE" : "RSI EXIT"}</td>
                  </tr>)}</tbody>
                </table>
              </div>
            ) : <div className="market-chart-empty" role="status"><strong>No trades for this strategy in the full period.</strong><span>Metrics remain honest: win rate and profit factor are not available without closed trades.</span></div>}
            <ul className="backtest-notes">{result.notes.map((note) => <li key={note}>{note}</li>)}</ul>
          </section>
        </>
      )}
    </div>
  );
}