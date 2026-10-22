"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { formatAlertCondition, type MarketAlertCondition } from "@/lib/alerts/conditions";
import type { MarketIngestSummary } from "@/lib/market-data/ingest";
import type { ScreenEvaluation, ScreenerRow } from "@/lib/screener/evaluate";
import type { ScreenerPayload } from "@/lib/screener/payload";
import type { StoredScreener, StoredScreenerResult } from "@/lib/screener/service";

/**
 * The screener surface (phase 19).
 *
 * It has four jobs, and every control does one of them: build a condition and
 * run it, refresh the stored candles it reads, save a screen and replay it, or
 * turn the matches into alerts. Nothing here asks for confirmation before a
 * screen runs — RUN is the request — and every result states its as-of time and
 * the provider that supplied each value.
 */

type ApiBody = Record<string, unknown> & { error?: string };

/** The condition name without a threshold, for the select's own options. */
const CONDITION_LABELS: Record<MarketAlertCondition, string> = {
  PRICE_ABOVE: "Price at or above",
  PRICE_BELOW: "Price at or below",
  RSI_14_ABOVE: "15m RSI-14 at or above",
  RSI_14_BELOW: "15m RSI-14 at or below",
};

function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function formatLatency(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${value} ms`;
}

function formatRate(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

function resultSummary(ingest: MarketIngestSummary | null): string | null {
  if (!ingest) return null;
  const failedSources = [...new Set(ingest.failures.map((failure) => failure.sourceId))];
  const parts = [
    `${ingest.candlesStored} candle row(s) stored`,
    `${ingest.newsStored} headline(s) stored`,
  ];
  if (ingest.gapsRestored > 0) parts.push(`${ingest.gapsRestored} gap candle(s) restored`);
  if (failedSources.length > 0) {
    parts.push(`${ingest.failures.length} operation(s) failed: ${failedSources.join(", ")}`);
  }
  return parts.join(" · ");
}

function changedRows(last: StoredScreenerResult, previous: StoredScreenerResult): number {
  const previousBySymbol = new Map(previous.rows.map((row) => [row.symbol, row]));
  return last.rows.filter((row) => {
    const before = previousBySymbol.get(row.symbol);
    return !before || before.value !== row.value || before.matched !== row.matched;
  }).length;
}

function RowValue({ row, condition }: { row: ScreenerRow; condition: MarketAlertCondition }) {
  if (row.value === null) return <span className="screener-muted">{row.reason ?? "Unavailable"}</span>;
  return <span>{condition.startsWith("PRICE_") ? `$${row.value}` : row.value}</span>;
}

export function ScreenerPanel({ initialPayload }: { initialPayload: ScreenerPayload }) {
  const [payload, setPayload] = useState<ScreenerPayload>(initialPayload);
  const [condition, setCondition] = useState<MarketAlertCondition>("PRICE_ABOVE");
  const [threshold, setThreshold] = useState("100");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialPayload.watchlist.map(({ productId }) => productId)),
  );
  const [name, setName] = useState("");
  const [result, setResult] = useState<ScreenEvaluation | null>(null);
  const [lastIngest, setLastIngest] = useState<MarketIngestSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(
    initialPayload.storageUnavailable
      ? "Saved screens could not be read from the database. Running a screen over stored candles is still available."
      : null,
  );
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const response = await fetch("/api/screener", { cache: "no-store" });
      const data = (await response.json()) as ScreenerPayload;
      setPayload(data);
      if (data.storageUnavailable) {
        setError("Saved screens could not be read from the database. Running a screen over stored candles is still available.");
      }
    } catch {
      setError("The screener could not reach its server route.");
    }
  }, []);

  const watchlist = payload?.watchlist ?? [];
  const conditions = payload?.conditions ?? [];
  const screens = payload?.screens ?? [];
  const authenticated = payload?.authenticated === true;

  const post = useCallback(async (body: ApiBody): Promise<ApiBody | null> => {
    setBusy(String(body.action));
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/screener", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let data: ApiBody;
      try {
        data = (await response.json()) as ApiBody;
      } catch {
        data = { error: `The server answered ${response.status} without a readable body.` };
      }
      if (!response.ok) {
        setError(typeof data.error === "string" ? data.error : `The request failed (${response.status}).`);
        return null;
      }
      return data;
    } catch {
      setError("The screener could not reach its server route.");
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  async function runScreen() {
    const data = await post({ action: "evaluate", condition, threshold, symbols: [...selected] });
    if (!data) return;
    if (data.result) setResult(data.result as ScreenEvaluation);
    if (data.ingest) setLastIngest(data.ingest as MarketIngestSummary);
    const summary = resultSummary((data.ingest as MarketIngestSummary | null) ?? null);
    if (summary) setNotice(summary);
  }

  async function syncData() {
    const data = await post({ action: "ingest", symbols: [...selected] });
    if (!data) return;
    const ingest = data.ingest as MarketIngestSummary | undefined;
    if (ingest) setLastIngest(ingest);
    const summary = resultSummary(ingest ?? null);
    if (summary) setNotice(summary);
    await reload();
  }

  async function saveCurrent() {
    const data = await post({ action: "save", name, condition, threshold, symbols: [...selected] });
    if (!data) return;
    setNotice(`Saved "${name.trim()}" with ${selected.size} symbol(s).`);
    setName("");
    await reload();
  }

  async function runSaved(screen: StoredScreener) {
    const data = await post({ action: "run", screenerId: screen.id });
    if (!data) return;
    if (data.evaluation) setResult(data.evaluation as ScreenEvaluation);
    if (data.ingest) setLastIngest(data.ingest as MarketIngestSummary);
    const summary = resultSummary((data.ingest as MarketIngestSummary | null) ?? null);
    setNotice(summary ?? `Ran "${screen.name}".`);
    await reload();
  }

  async function createAlerts(screen: StoredScreener) {
    const data = await post({ action: "create-alerts", screenerId: screen.id });
    if (!data) return;
    const created = Number(data.created ?? 0);
    const skipped = Number(data.skipped ?? 0);
    setNotice(
      `Created ${created} alert(s) from "${screen.name}" at ${formatTime(String(data.screenedAt ?? ""))}` +
        (skipped > 0 ? `; ${skipped} symbol(s) already had the same active alert or the limit was reached.` : "."),
    );
    await reload();
  }

  async function deleteScreen(screen: StoredScreener) {
    if (!window.confirm(`Delete the saved screen "${screen.name}" and its recorded runs?`)) return;
    const data = await post({ action: "delete", screenerId: screen.id });
    if (!data) return;
    setNotice(`Deleted "${screen.name}".`);
    await reload();
  }

  function toggleSymbol(symbol: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
  }

  const resultRows = result?.rows ?? [];
  const missingRows = resultRows.filter((row) => row.value === null);
  const ingestHealth = lastIngest?.health ?? payload.ingestHealth;

  return (
    <>
      <section className="data-section screener-section" aria-labelledby="screen-controls-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">01 / SCREEN CONDITIONS</div>
            <h2 id="screen-controls-title">Condition and symbol set</h2>
          </div>
          <span className="section-state">{selected.size} OF {watchlist.length} MARKETS</span>
        </div>

        <form
          className="screener-filters"
          onSubmit={(event) => {
            event.preventDefault();
            void runScreen();
          }}
        >
          <label className="screener-filter-control" htmlFor="screen-condition">
            <span>CONDITION</span>
            <select
              id="screen-condition"
              onChange={(event) => {
                const next = event.target.value as MarketAlertCondition;
                setCondition(next);
                setThreshold(next.startsWith("RSI_") ? "70" : "100");
              }}
              value={condition}
            >
              {conditions.map((entry) => (
                <option key={entry} value={entry}>{CONDITION_LABELS[entry]}</option>
              ))}
            </select>
          </label>
          <label className="screener-filter-control" htmlFor="screen-threshold">
            <span>{condition.startsWith("RSI_") ? "RSI-14 THRESHOLD" : "USD THRESHOLD"}</span>
            <input
              id="screen-threshold"
              inputMode="decimal"
              name="threshold"
              onChange={(event) => setThreshold(event.target.value)}
              required
              step="0.0001"
              type="number"
              value={threshold}
            />
          </label>
          <button className="section-action" disabled={busy !== null || selected.size === 0} type="submit">
            {busy === "evaluate" ? "RUNNING…" : "RUN SCREEN"}
          </button>
          <button className="section-action" disabled={busy !== null} onClick={() => void syncData()} type="button">
            {busy === "ingest" ? "SYNCING…" : "SYNC STORED CANDLES"}
          </button>
        </form>

        <div className="screener-symbol-heading">
          <span>SYMBOLS</span>
          <div>
            <button className="screener-link-button" onClick={() => setSelected(new Set(watchlist.map(({ productId }) => productId)))} type="button">ALL</button>
            <button className="screener-link-button" onClick={() => setSelected(new Set())} type="button">NONE</button>
          </div>
        </div>
        <div className="screener-symbols" role="group" aria-label="Screen symbols">
          {watchlist.map(({ productId, name: symbolName }) => (
            <label className="screener-symbol" key={productId} title={symbolName}>
              <input
                checked={selected.has(productId)}
                onChange={() => toggleSymbol(productId)}
                type="checkbox"
              />
              <span>{productId}</span>
            </label>
          ))}
        </div>
        <p className="market-watch-note">
          PRICE conditions use the newest closed 15-minute close. RSI-14 uses the same shared indicator module as the
          backtester and the assistant. A symbol with no closed candle is listed with the reason, not dropped. Every run
          states its as-of time and the provider each value came from.
        </p>
        {selected.size === 0 && <p className="screener-inline-error" role="status">Choose at least one symbol to run a screen.</p>}
      </section>

      {notice && <p className="screener-notice" role="status" aria-live="polite">{notice}</p>}
      {error && <p className="screener-inline-error" role="alert">{error}</p>}

      {result && (
        <section className="data-section screener-section" aria-labelledby="screen-results-title">
          <div className="section-heading">
            <div>
              <div className="section-kicker">02 / RESULTS</div>
              <h2 id="screen-results-title">{formatAlertCondition(result.condition, result.threshold)}</h2>
            </div>
            <span className="section-state">{result.matchedCount} MATCHED / {result.rows.length} CHECKED</span>
          </div>
          <dl className="screener-run-meta">
            <div><dt>AS OF</dt><dd>{formatTime(result.asOf)}</dd></div>
            <div><dt>DATA AS OF</dt><dd>{formatTime(result.dataAsOf)}</dd></div>
            <div><dt>PROVIDER</dt><dd>{result.providerIds.length > 0 ? result.providerIds.join(", ") : "NONE"}</dd></div>
            <div><dt>INTERVAL</dt><dd>{result.interval}</dd></div>
            <div><dt>RESULT HASH</dt><dd title={result.resultHash}>{result.resultHash.slice(0, 12)}</dd></div>
          </dl>
          {missingRows.length > 0 && (
            <p className="screener-notice screener-notice--warn" role="status">
              {missingRows.length} symbol(s) had no usable closed candle; they are listed below with the reason.
            </p>
          )}
          <div className="market-history-table-wrap">
            <table className="market-history-table screener-table">
              <thead>
                <tr><th>MARKET</th><th>VALUE</th><th>MATCHED</th><th>OBSERVED (UTC)</th><th>PROVIDER</th><th>FRESHNESS</th><th>NOTE</th></tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={row.symbol}>
                    <td>{row.symbol}</td>
                    <td><RowValue condition={result.condition} row={row} /></td>
                    <td><span className={`screener-badge ${row.matched ? "is-match" : "is-miss"}`}>{row.matched ? "MATCH" : "NO MATCH"}</span></td>
                    <td>{formatTime(row.observedAt)}</td>
                    <td>{row.providerId ?? "—"}</td>
                    <td>{row.freshness ?? "—"}</td>
                    <td>{row.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="data-section screener-section" aria-labelledby="saved-screens-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">03 / SAVED SCREENS</div>
            <h2 id="saved-screens-title">Save, replay, compare</h2>
          </div>
          <span className="section-state">{screens.length} SAVED</span>
        </div>
        <form
          className="screener-filters"
          onSubmit={(event) => {
            event.preventDefault();
            void saveCurrent();
          }}
        >
          <label className="screener-filter-control screener-filter-control--wide" htmlFor="screen-name">
            <span>SCREEN NAME</span>
            <input
              id="screen-name"
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              placeholder="Overbought majors"
              required
              type="text"
              value={name}
            />
          </label>
          <button className="section-action" disabled={!authenticated || busy !== null || name.trim().length === 0} type="submit">
            {busy === "save" ? "SAVING…" : "SAVE CURRENT SCREEN"}
          </button>
          {!authenticated && <span className="screener-muted">Sign in to save screens and create alerts.</span>}
        </form>

        {screens.length === 0 ? (
          <div className="market-chart-empty" role="status">
            <strong>No saved screens</strong>
            <span>Run a condition, name it, and save it. A saved screen keeps its condition, threshold and symbols.</span>
          </div>
        ) : (
          <ul className="screener-saved">
            {screens.map((screen) => (
              <li className="screener-saved__item" key={screen.id}>
                <div className="screener-saved__head">
                  <div>
                    <h3>{screen.name}</h3>
                    <p>{formatAlertCondition(screen.condition, screen.threshold)} · {screen.symbols.join(", ")}</p>
                  </div>
                  <span className="section-state">{screen.lastRun ? `${screen.lastRun.matchedCount} MATCHED` : "NEVER RUN"}</span>
                </div>
                <p className="screener-saved__compare">
                  {screen.lastRun
                    ? `Last run ${formatTime(screen.lastRun.asOf)} · data ${formatTime(screen.lastRun.dataAsOf)} · ${screen.lastRun.providerIds.join(", ") || "no provider"}`
                    : "No recorded run yet."}
                  {screen.lastRun && screen.previousRun && (
                    screen.lastRun.resultHash === screen.previousRun.resultHash
                      ? ` · identical to the previous run (${formatTime(screen.previousRun.asOf)})`
                      : ` · ${changedRows(screen.lastRun, screen.previousRun)} symbol result(s) changed since ${formatTime(screen.previousRun.asOf)}`
                  )}
                </p>
                <div className="screener-actions">
                  <button className="screener-link-button" disabled={busy !== null} onClick={() => void runSaved(screen)} type="button">
                    {busy === "run" ? "RUNNING…" : "RE-RUN"}
                  </button>
                  <button className="screener-link-button" disabled={!authenticated || busy !== null || !screen.lastRun} onClick={() => void createAlerts(screen)} type="button">
                    CREATE ALERTS
                  </button>
                  <Link className="screener-link-button" href="/#alerts">OPEN ALERTS</Link>
                  <button className="screener-link-button screener-link-button--danger" disabled={!authenticated || busy !== null} onClick={() => void deleteScreen(screen)} type="button">
                    DELETE
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="data-section screener-section" aria-labelledby="provider-health-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">04 / PROVIDER HEALTH</div>
            <h2 id="provider-health-title">Every source, with its failures</h2>
          </div>
          <span className="section-state">{payload.health.length} SOURCES WITH CALLS</span>
        </div>
        {payload.health.length === 0 ? (
          <div className="market-chart-empty" role="status">
            <strong>No provider calls recorded</strong>
            <span>Run a screen or sync the candles; every outbound call is retained with its latency and outcome.</span>
          </div>
        ) : (
          <div className="market-history-table-wrap">
            <table className="market-history-table screener-table">
              <thead>
                <tr><th>SOURCE</th><th>CALLS</th><th>FAILURES</th><th>ERROR RATE</th><th>AVG LATENCY</th><th>LAST SUCCESS</th><th>LAST FAILURE</th><th>LAST OUTCOME</th></tr>
              </thead>
              <tbody>
                {payload.health.map((entry) => (
                  <tr key={entry.providerId}>
                    <td>{entry.providerId}</td>
                    <td>{entry.totalCount}</td>
                    <td>{entry.failureCount}</td>
                    <td>{formatRate(entry.errorRate)}</td>
                    <td>{formatLatency(entry.averageDurationMs)}</td>
                    <td>{formatTime(entry.lastSuccessAt)}</td>
                    <td>{formatTime(entry.lastFailureAt)}</td>
                    <td>{entry.lastOutcome ?? "—"}{entry.lastReasonCode ? ` · ${entry.lastReasonCode}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {ingestHealth.length > 0 && (
          <>
            <p className="screener-saved__compare">
              Ingest operations in this process (a logical failure such as an unreadable body is recorded here even when
              the HTTP call succeeded).
            </p>
            <div className="market-history-table-wrap">
              <table className="market-history-table screener-table">
                <thead>
                  <tr><th>SOURCE</th><th>OK</th><th>FAILED</th><th>CONSECUTIVE</th><th>ERROR RATE</th><th>AVG LATENCY</th><th>LAST SUCCESS</th><th>LAST FAILURE</th><th>COOLDOWN</th></tr>
                </thead>
                <tbody>
                  {ingestHealth.map((entry) => (
                    <tr key={entry.sourceId}>
                      <td>{entry.sourceId}</td>
                      <td>{entry.successCount}</td>
                      <td>{entry.failureCount}</td>
                      <td>{entry.consecutiveFailures}</td>
                      <td>{formatRate(entry.errorRate)}</td>
                      <td>{formatLatency(entry.averageDurationMs)}</td>
                      <td>{formatTime(entry.lastSuccessAt)}</td>
                      <td>{formatTime(entry.lastFailureAt)}</td>
                      <td>{formatTime(entry.cooldownUntil)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {lastIngest && (
          <p className={`screener-notice${lastIngest.failures.length > 0 ? " screener-notice--warn" : ""}`}>
            <strong>LAST SYNC:</strong> {resultSummary(lastIngest) ?? "No operation ran."}
            {lastIngest.failures.length > 0 && (
              <> {lastIngest.failures.map((failure) => `${failure.sourceId} (${failure.reason})`).join(", ")}.</>
            )}
          </p>
        )}
      </section>
    </>
  );
}
