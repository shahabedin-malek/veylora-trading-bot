"use client";

import { FlaskConical, Play, Save, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { UTCTimestamp } from "lightweight-charts";
import type { BacktestMetrics, BacktestResult, EquityPoint, SweepResult } from "@/lib/backtesting/engine";
import type { StoredRunSummary } from "@/lib/backtesting/repository";

/**
 * The strategy lab.
 *
 * The panel is arranged as the owner's own path — describe, read and edit, run, compare —
 * and each step shows what the server actually did rather than a summary of it:
 *
 *  - the generated rules are listed *and* the editable text is right there, with the model's
 *    prompt and raw answer available in the trace, so nothing about a generated strategy is
 *    hidden behind a paragraph;
 *  - a result prints the cost assumptions that produced it and the fee table version they
 *    came from, so "the fee changed and so did the result" is visible on screen;
 *  - a sweep prints every value's metrics and says in words that the winner is in-sample
 *    selection, which is what stops a flagged number from reading as a forecast.
 *
 * There is no confirmation step anywhere: generating, saving and running are immediate, and
 * the version history is the record.
 */

type DefinitionView = {
  id: string;
  name: string;
  version: number;
  market: string;
  timeframe: string;
  text: string;
  rules: string[];
  origin: string;
  createdAt: string;
  trace: unknown;
};

type Trace = {
  prompt?: { system: string; user: string; version: string };
  rawOutput: string;
  providerId: string | null;
  model: string | null;
  fallbackFrom: string | null;
};

type DefinitionRunResponse = {
  kind: "BACKTEST" | "PAPER";
  stored: boolean;
  paperBars: number | null;
  definition: { id: string; version: number; text: string };
  result: BacktestResult;
};

type SweepResponse = {
  kind: "SWEEP";
  stored: boolean;
  definition: { id: string; version: number; text: string };
  sweep: SweepResult;
};

const SWEEP_CHOICES = [
  { value: "ENTRY_THRESHOLD", label: "Entry threshold" },
  { value: "EXIT_THRESHOLD", label: "Exit threshold" },
  { value: "SIZE_PERCENT", label: "Size (% of equity)" },
  { value: "STOP_PERCENT", label: "Stop-loss (%)" },
];

function fixed(value: string | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "NOT AVAILABLE";
  return Number(value).toFixed(digits);
}

function money(value: string | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "NOT AVAILABLE";
  return `$${Number(value).toFixed(2)}`;
}

function percentOrNone(value: string | null | undefined): string {
  return value === null || value === undefined ? "NO CLOSED TRADES" : `${value}%`;
}

function EquityCurve({ points }: { points: EquityPoint[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let chart: import("lightweight-charts").IChartApi | null = null;
    let observer: ResizeObserver | null = null;
    let disposed = false;

    const data = points.flatMap((point) => {
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
  }, [points]);

  return <div className="backtest-equity-chart" aria-label="Backtest equity curve" ref={containerRef} />;
}

function MetricsGrid({ metrics, label }: { metrics: BacktestMetrics; label: string }) {
  return (
    <div className="backtest-metrics">
      <div><span>FINAL CAPITAL</span><strong>{money(metrics.finalCapitalUsd)}</strong></div>
      <div><span>TOTAL RETURN</span><strong>{fixed(metrics.totalReturnPercent)}%</strong></div>
      <div><span>MAX DRAWDOWN</span><strong>{fixed(metrics.maxDrawdownPercent)}%</strong></div>
      <div><span>WIN RATE</span><strong>{percentOrNone(metrics.winRatePercent)}</strong></div>
      <div><span>EXPECTANCY / TRADE</span><strong>{metrics.expectancyUsd === null ? "NO CLOSED TRADES" : money(metrics.expectancyUsd)}</strong></div>
      <div><span>TRADES</span><strong>{metrics.tradeCount}</strong></div>
      <div><span>FEES / SPREAD</span><strong>{money(metrics.totalFeesUsd)} / {money(metrics.totalSpreadUsd)}</strong></div>
      <div><span>SLIPPAGE / FUNDING</span><strong>{money(metrics.totalSlippageUsd)} / {money(metrics.totalFundingUsd)}</strong></div>
      <div><span>TOTAL COSTS</span><strong>{money(metrics.totalCostsUsd)}</strong></div>
      <div><span>PROFIT FACTOR</span><strong>{metrics.profitFactor ?? (metrics.tradeCount === 0 ? "NO CLOSED TRADES" : "NO LOSING TRADES")}</strong></div>
      <div><span>SCENARIO</span><strong>{label}</strong></div>
    </div>
  );
}

export function BacktestPanel() {
  const [description, setDescription] = useState("");
  const [text, setText] = useState("");
  const [rules, setRules] = useState<string[]>([]);
  const [definition, setDefinition] = useState<DefinitionView | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [capital, setCapital] = useState("10000");
  const [run, setRun] = useState<DefinitionRunResponse | null>(null);
  const [sweep, setSweep] = useState<SweepResponse | null>(null);
  const [sweepParameter, setSweepParameter] = useState("ENTRY_THRESHOLD");
  const [sweepValues, setSweepValues] = useState("20, 25, 30, 35");

  const [runs, setRuns] = useState<StoredRunSummary[]>([]);
  const [selected, setSelected] = useState<string[]>([]);

  const loadRuns = useCallback(async () => {
    const response = await fetch("/api/backtest/runs", { credentials: "same-origin" });
    if (!response.ok) return;
    const payload = (await response.json()) as { runs?: StoredRunSummary[] };
    setRuns(Array.isArray(payload.runs) ? payload.runs : []);
  }, []);

  // The first read is done here rather than by calling `loadRuns` directly: every state
  // update happens after an await, so the effect body itself renders nothing twice.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/backtest/runs", { credentials: "same-origin" });
        if (!response.ok) return;
        const payload = (await response.json()) as { runs?: StoredRunSummary[] };
        if (active && Array.isArray(payload.runs)) setRuns(payload.runs);
      } catch {
        // A run list that cannot be read is an empty comparison section, not a broken page.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function post(url: string, method: string, body: unknown): Promise<{ ok: boolean; status: number; payload: unknown }> {
    const response = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, payload };
  }

  function errorOf(payload: unknown, fallback: string): string {
    return payload && typeof payload === "object" && "error" in payload && typeof (payload as { error: unknown }).error === "string"
      ? (payload as { error: string }).error
      : fallback;
  }

  function issuesOf(payload: unknown): string[] {
    if (payload && typeof payload === "object" && "issues" in payload && Array.isArray((payload as { issues: unknown }).issues)) {
      return ((payload as { issues: unknown[] }).issues).filter((issue): issue is string => typeof issue === "string");
    }
    return [];
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("generate");
    setError(null);
    setIssues([]);
    setNotice(null);
    try {
      const result = await post("/api/strategies", "POST", { mode: "generate", description });
      if (!result.ok) {
        setIssues(issuesOf(result.payload));
        const raw = result.payload && typeof result.payload === "object" && "rawOutput" in result.payload
          ? String((result.payload as { rawOutput: unknown }).rawOutput ?? "")
          : "";
        if (raw) setTrace({ rawOutput: raw, providerId: null, model: null, fallbackFrom: null });
        throw new Error(errorOf(result.payload, "The strategy could not be generated."));
      }
      const payload = result.payload as { definition: DefinitionView; trace: Trace };
      setDefinition(payload.definition);
      setText(payload.definition.text);
      setRules(payload.definition.rules);
      setTrace(payload.trace);
      setRun(null);
      setSweep(null);
      setNotice(`Generated by ${payload.trace.providerId ?? "the router"}${payload.trace.model ? ` (${payload.trace.model})` : ""}. The prompt and the model's answer are stored with this version.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The strategy could not be generated.");
    } finally {
      setBusy(null);
    }
  }

  async function saveEdit() {
    if (!definition) return;
    setBusy("save");
    setError(null);
    setIssues([]);
    setNotice(null);
    try {
      const result = await post("/api/strategies", "PUT", { id: definition.id, text });
      if (!result.ok) {
        setIssues(issuesOf(result.payload));
        throw new Error(errorOf(result.payload, "The edit could not be saved."));
      }
      const payload = result.payload as { changed: boolean; definition: DefinitionView; previous: DefinitionView; message: string };
      setDefinition(payload.definition);
      setText(payload.definition.text);
      setRules(payload.definition.rules);
      setNotice(payload.message);
      await loadRuns();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The edit could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  async function runBacktest(mode: "definition" | "paper") {
    setBusy(mode);
    setError(null);
    setIssues([]);
    setNotice(null);
    setRun(null);
    setSweep(null);
    try {
      const result = await post("/api/backtest", "POST", {
        mode,
        definitionText: text,
        ...(definition ? { definitionId: definition.id } : {}),
        initialCapitalUsd: capital,
      });
      if (!result.ok) {
        setIssues(issuesOf(result.payload));
        throw new Error(errorOf(result.payload, "The backtest could not be completed."));
      }
      const payload = result.payload as DefinitionRunResponse;
      setRun(payload);
      setDefinition((current) => (current ? { ...current, id: payload.definition.id, version: payload.definition.version } : current));
      if (!payload.stored) setNotice("The result is shown but could not be recorded, so it will not appear in the comparison list.");
      await loadRuns();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The backtest could not be completed.");
    } finally {
      setBusy(null);
    }
  }

  async function runSweep(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("sweep");
    setError(null);
    setIssues([]);
    setNotice(null);
    setSweep(null);
    try {
      const values = sweepValues.split(",").map((value) => value.trim()).filter(Boolean);
      if (values.length < 2 || values.length > 8) throw new Error("Provide between 2 and 8 comma-separated values to sweep.");
      const result = await post("/api/backtest", "POST", {
        mode: "sweep",
        definitionText: text,
        ...(definition ? { definitionId: definition.id } : {}),
        initialCapitalUsd: capital,
        parameter: sweepParameter,
        values,
      });
      if (!result.ok) {
        setIssues(issuesOf(result.payload));
        throw new Error(errorOf(result.payload, "The sweep could not be completed."));
      }
      setSweep(result.payload as SweepResponse);
      await loadRuns();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The sweep could not be completed.");
    } finally {
      setBusy(null);
    }
  }

  function toggleSelected(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id].slice(-4),
    );
  }

  const compared = runs.filter((entry) => selected.includes(entry.id));

  return (
    <div className="backtest-workbench">
      <section className="data-section backtest-config" aria-labelledby="strategy-generate-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">PLAIN ENGLISH · STORED WITH ITS PROMPT</div>
            <h2 id="strategy-generate-title">Describe a strategy</h2>
          </div>
          <span className="section-state">EDITABLE RULES</span>
        </div>
        <form className="backtest-form" onSubmit={generate}>
          <label className="strategy-description">
            <span>DESCRIPTION</span>
            <textarea
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Buy BTC when the 14-period RSI closes below 30 and sell when it closes above 70, with a 4% stop."
              rows={3}
              value={description}
            />
          </label>
          <button className="section-action" disabled={busy !== null || description.trim().length < 3} type="submit">
            <Sparkles aria-hidden="true" size={13} />
            {busy === "generate" ? "ASKING THE MODEL" : "GENERATE DEFINITION"}
          </button>
        </form>
        {issues.length > 0 && (
          <div className="market-chart-empty backtest-message" role="alert">
            <strong>Validation refused these rules</strong>
            <ul className="strategy-issues">
              {issues.map((issue) => <li key={issue}>{issue}</li>)}
            </ul>
          </div>
        )}
        {error && <div className="market-chart-empty backtest-message" role="alert"><strong>Backtest unavailable</strong><span>{error}</span></div>}
        {notice && <p className="backtest-assumptions" role="status">{notice}</p>}
      </section>

      <section className="data-section backtest-results" aria-labelledby="strategy-definition-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">{definition ? `VERSION ${definition.version} · ${definition.origin.toUpperCase()}` : "AWAITING A DEFINITION"}</div>
            <h2 id="strategy-definition-title">The rules, editable</h2>
          </div>
          <span className="section-state">NO ORDERS</span>
        </div>
        <label className="strategy-definition-editor">
          <span>DEFINITION TEXT</span>
          <textarea
            aria-label="Strategy definition text"
            onChange={(event) => setText(event.target.value)}
            rows={9}
            spellCheck={false}
            value={text}
          />
        </label>
        {rules.length > 0 && (
          <ul className="backtest-notes" aria-label="Rules this definition states">
            {rules.map((rule) => <li key={rule}>{rule}</li>)}
          </ul>
        )}
        <div className="risk-policy-actions">
          <button className="section-action" disabled={busy !== null || !definition || !text.trim()} onClick={saveEdit} type="button">
            <Save aria-hidden="true" size={13} />
            {busy === "save" ? "SAVING VERSION" : "SAVE AS NEW VERSION"}
          </button>
        </div>
        {trace?.prompt && (
          <details className="strategy-trace">
            <summary>What produced these rules</summary>
            <p className="section-kicker">PROMPT ({trace.prompt.version})</p>
            <pre>{trace.prompt.system}</pre>
            <pre>{trace.prompt.user}</pre>
            <p className="section-kicker">MODEL OUTPUT · {trace.providerId ?? "unknown provider"}{trace.model ? ` · ${trace.model}` : ""}{trace.fallbackFrom ? ` · after ${trace.fallbackFrom} failed` : ""}</p>
            <pre>{trace.rawOutput}</pre>
          </details>
        )}
      </section>

      <section className="data-section backtest-config" aria-labelledby="strategy-run-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">COSTS FROM /ADMIN/FEES · PRINTED WITH EVERY RESULT</div>
            <h2 id="strategy-run-title">Run it</h2>
          </div>
          <span className="section-state">ANALYSIS ONLY</span>
        </div>
        <form className="backtest-form" onSubmit={(event) => { event.preventDefault(); void runBacktest("definition"); }}>
          <label><span>INITIAL CAPITAL (USD)</span><input inputMode="decimal" onChange={(event) => setCapital(event.target.value)} value={capital} /></label>
          <p className="backtest-assumptions">
            Fee, spread, slippage and funding come from the fee table version in force in /admin/fees; each result states the
            assumptions it used. Change one there and re-run: the result changes and says why.
          </p>
          <div className="risk-policy-actions">
            <button className="section-action" disabled={busy !== null || !text.trim()} type="submit">
              <Play aria-hidden="true" size={13} />
              {busy === "definition" ? "FETCHING FULL HISTORY" : "RUN FULL-YEAR BACKTEST"}
            </button>
            <button className="section-action" disabled={busy !== null || !text.trim()} onClick={() => void runBacktest("paper")} type="button">
              <FlaskConical aria-hidden="true" size={13} />
              {busy === "paper" ? "PAPER-RUNNING" : "PAPER-RUN LAST 60 BARS"}
            </button>
          </div>
        </form>
        <form className="backtest-form" onSubmit={runSweep}>
          <label>
            <span>SWEEP PARAMETER</span>
            <select onChange={(event) => setSweepParameter(event.target.value)} value={sweepParameter}>
              {SWEEP_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
            </select>
          </label>
          <label><span>VALUES (2–8, COMMA SEPARATED)</span><input onChange={(event) => setSweepValues(event.target.value)} value={sweepValues} /></label>
          <button className="section-action" disabled={busy !== null || !text.trim()} type="submit">
            {busy === "sweep" ? "SWEEPING" : "RUN SWEEP"}
          </button>
        </form>
      </section>

      {run && (
        <section className="data-section backtest-results" aria-labelledby="strategy-result-title">
          <div className="section-heading">
            <div>
              <div className="section-kicker">{run.kind} · VERSION {run.definition.version} · {run.result.barCount} DAILY BARS</div>
              <h2 id="strategy-result-title">{run.result.symbol} results</h2>
            </div>
            <span className="section-state">{run.kind === "PAPER" ? `PAPER · LAST ${run.paperBars} BARS` : "BACKTEST"}</span>
          </div>
          <p className="backtest-period">
            {new Date(run.result.periodStart).toISOString().slice(0, 10)} — {new Date(run.result.periodEnd).toISOString().slice(0, 10)}
          </p>
          <MetricsGrid label={run.kind === "PAPER" ? "Paper run" : "Backtest"} metrics={run.result.metrics} />
          <div className="section-kicker backtest-chart-label">COST ASSUMPTIONS APPLIED TO THIS RUN</div>
          <ul className="backtest-notes">{run.result.costAssumptions.map((line) => <li key={line}>{line}</li>)}</ul>
          <div className="section-kicker backtest-chart-label">EQUITY CURVE · COSTS INCLUDED</div>
          <EquityCurve points={run.result.equityCurve} />
          <div className="section-kicker backtest-chart-label">MODEL NOTES</div>
          <ul className="backtest-notes">{run.result.notes.map((note) => <li key={note}>{note}</li>)}</ul>
          <div className="section-heading">
            <div className="section-kicker">TRADE LIST</div>
            <span className="section-state">{run.result.trades.length} ROUND TRIPS</span>
          </div>
          {run.result.trades.length > 0 ? (
            <div className="market-history-table-wrap">
              <table className="market-history-table backtest-trade-table">
                <thead>
                  <tr><th>ENTRY UTC</th><th>EXIT UTC</th><th>ENTRY FILL</th><th>EXIT FILL</th><th>QUANTITY</th><th>FEES</th><th>SPREAD</th><th>SLIPPAGE</th><th>FUNDING</th><th>NET P&amp;L</th><th>EXIT</th></tr>
                </thead>
                <tbody>
                  {run.result.trades.slice(0, 120).map((trade, index) => (
                    <tr key={`${trade.entryAt}:${index}`}>
                      <td>{new Date(trade.entryAt).toISOString().slice(0, 10)}</td>
                      <td>{new Date(trade.exitAt).toISOString().slice(0, 10)}</td>
                      <td>{trade.entryFillPrice}</td>
                      <td>{trade.exitFillPrice}</td>
                      <td>{trade.quantity}</td>
                      <td>{trade.feesUsd}</td>
                      <td>{trade.spreadUsd}</td>
                      <td>{trade.slippageUsd}</td>
                      <td>{trade.fundingUsd}</td>
                      <td>{trade.pnlUsd} ({trade.pnlPercent}%)</td>
                      <td>{trade.exitReason === "END_OF_PERIOD" ? "PERIOD CLOSE" : trade.exitReason === "STOP_LOSS" ? "STOP" : "CONDITION"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="market-chart-empty" role="status">
              <strong>No trades for this definition in the window.</strong>
              <span>Metrics stay honest: win rate and expectancy are not available without closed trades.</span>
            </div>
          )}
        </section>
      )}

      {sweep && (
        <section className="data-section backtest-results" aria-labelledby="strategy-sweep-title">
          <div className="section-heading">
            <div>
              <div className="section-kicker">SWEEP · VERSION {sweep.definition.version} · {sweep.sweep.barCount} DAILY BARS</div>
              <h2 id="strategy-sweep-title">{sweep.sweep.parameterLabel} sweep</h2>
            </div>
            <span className="section-state">BEST {sweep.sweep.bestValue ?? "NONE"} FLAGGED</span>
          </div>
          <p className="backtest-assumptions" role="status">{sweep.sweep.warning}</p>
          <div className="market-history-table-wrap">
            <table className="market-history-table sweep-table">
              <thead>
                <tr><th>VALUE</th><th>RETURN</th><th>MAX DRAWDOWN</th><th>WIN RATE</th><th>EXPECTANCY</th><th>TRADES</th><th>TOTAL COSTS</th><th>BEST</th></tr>
              </thead>
              <tbody>
                {sweep.sweep.runs.map((entry) => (
                  <tr key={entry.value}>
                    <td>{entry.value}</td>
                    <td>{entry.metrics.totalReturnPercent}%</td>
                    <td>{entry.metrics.maxDrawdownPercent}%</td>
                    <td>{percentOrNone(entry.metrics.winRatePercent)}</td>
                    <td>{entry.metrics.expectancyUsd === null ? "—" : money(entry.metrics.expectancyUsd)}</td>
                    <td>{entry.metrics.tradeCount}</td>
                    <td>{money(entry.metrics.totalCostsUsd)}</td>
                    <td>{entry.isBest ? "YES" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="backtest-notes">{sweep.sweep.costAssumptions.map((line) => <li key={line}>{line}</li>)}</ul>
        </section>
      )}

      <section className="data-section backtest-results" aria-labelledby="strategy-compare-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">STORED RUNS · IMMUTABLE HISTORY</div>
            <h2 id="strategy-compare-title">Compare runs</h2>
          </div>
          <span className="section-state">{compared.length} SELECTED</span>
        </div>
        {runs.length === 0 ? (
          <div className="market-chart-empty" role="status">
            <strong>No runs recorded yet.</strong>
            <span>Run a backtest, a sweep or a paper run and it appears here with the version and cost assumptions it used.</span>
          </div>
        ) : (
          <>
            <ul className="strategy-run-picker">
              {runs.slice(0, 12).map((entry) => (
                <li key={entry.id}>
                  <label>
                    <input checked={selected.includes(entry.id)} onChange={() => toggleSelected(entry.id)} type="checkbox" />
                    <span>
                      {entry.kind} · v{entry.definitionVersion} · {entry.symbol} · {entry.metrics.totalReturnPercent}% · fee {entry.costs.feeBps} bps
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {compared.length > 0 && (
              <div className="market-history-table-wrap">
                <table className="market-history-table compare-table">
                  <thead>
                    <tr><th>KIND</th><th>VERSION</th><th>RETURN</th><th>MAX DRAWDOWN</th><th>WIN RATE</th><th>EXPECTANCY</th><th>TRADES</th><th>FEE BPS</th><th>SPREAD/SLIP</th></tr>
                  </thead>
                  <tbody>
                    {compared.map((entry) => (
                      <tr key={entry.id}>
                        <td>{entry.kind}</td>
                        <td>v{entry.definitionVersion}</td>
                        <td>{entry.metrics.totalReturnPercent}%</td>
                        <td>{entry.metrics.maxDrawdownPercent}%</td>
                        <td>{percentOrNone(entry.metrics.winRatePercent)}</td>
                        <td>{entry.metrics.expectancyUsd === null ? "—" : money(entry.metrics.expectancyUsd)}</td>
                        <td>{entry.metrics.tradeCount}</td>
                        <td>{entry.costs.feeBps}</td>
                        <td>{entry.costs.spreadBps}/{entry.costs.slippageBps}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
