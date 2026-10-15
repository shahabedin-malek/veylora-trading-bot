"use client";

import { BellRing, Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { MARKET_ALERT_CONDITIONS, formatAlertCondition, type MarketAlertCondition } from "@/lib/alerts/conditions";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";

type AlertEvent = {
  observedValue: string;
  sourceObservedAt: string;
  triggeredAt: string;
};

type MarketAlert = {
  id: string;
  symbol: string;
  condition: MarketAlertCondition;
  threshold: string;
  status: "ACTIVE" | "TRIGGERED" | "DELETED";
  lastEvaluatedAt: string | null;
  lastObservedValue: string | null;
  lastEvaluationError: string | null;
  triggeredAt: string | null;
  event: AlertEvent | null;
};

type AlertResponse = { alerts?: MarketAlert[]; cadence?: string; schedule?: string; error?: string };

async function loadAlerts(): Promise<AlertResponse> {
  try {
    const response = await fetch("/api/market-alerts", { cache: "no-store", credentials: "same-origin" });
    const payload: unknown = await response.json();
    if (response.status === 401) return { error: "Connect a wallet to manage personal alerts." };
    if (!response.ok || typeof payload !== "object" || payload === null || !("alerts" in payload) || !Array.isArray(payload.alerts)) {
      return { error: "Alerts are unavailable. Check authentication and database connectivity." };
    }
    const record = payload as Record<string, unknown>;
    return {
      alerts: record.alerts as MarketAlert[],
      cadence: typeof record.cadence === "string" ? record.cadence : "24 hours",
      schedule: typeof record.schedule === "string" ? record.schedule : "0 0 * * *",
    };
  } catch {
    return { error: "Alerts are unavailable. Check authentication and database connectivity." };
  }
}

function timestamp(value: string | null): string {
  if (!value) return "NOT EVALUATED";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "TIME UNAVAILABLE";
}

export function MarketAlertsPanel() {
  const [alerts, setAlerts] = useState<MarketAlert[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cadence, setCadence] = useState("24 hours");
  const [schedule, setSchedule] = useState("0 0 * * *");
  const [symbol, setSymbol] = useState<string>(USD_WATCHLIST[0].productId);
  const [condition, setCondition] = useState<MarketAlertCondition>("PRICE_ABOVE");
  const [threshold, setThreshold] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadAlerts().then((result) => {
      if (cancelled) return;
      setAlerts(result.alerts ?? null);
      setLoadError(result.error ?? null);
    });
    return () => { cancelled = true; };
  }, []);

  async function refresh() {
    const result = await loadAlerts();
    setAlerts(result.alerts ?? null);
    setLoadError(result.error ?? null);
    setCadence(result.cadence ?? "24 hours");
    setSchedule(result.schedule ?? "0 0 * * *");
  }

  async function createAlert(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/market-alerts", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, condition, threshold }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : "Alert could not be saved.";
        throw new Error(message);
      }
      setThreshold("");
      await refresh();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Alert could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteAlert(alertId: string) {
    setFormError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/market-alerts", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alertId }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : "Alert could not be deleted.";
        throw new Error(message);
      }
      await refresh();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Alert could not be deleted.");
    } finally {
      setBusy(false);
    }
  }

  const evaluationError = (alert: MarketAlert) => alert.lastEvaluationError
    ? `CHECK FAILED · ${alert.lastEvaluationError}`
    : alert.lastEvaluatedAt
      ? `LAST CHECK · ${timestamp(alert.lastEvaluatedAt)}`
      : "WAITING FOR FIRST CHECK";

  return (
    <section className="data-section market-alerts-section" aria-labelledby="market-alerts-title">
      <div className="section-heading">
        <div>
          <div className="section-kicker">PUBLIC COINBASE FEED</div>
          <h2 id="market-alerts-title">Market alerts</h2>
        </div>
        <span className="section-state">{alerts ? `${alerts.length} ALERTS` : "STATUS UNAVAILABLE"}</span>
      </div>

      <div className="market-alerts-cadence">
        <BellRing aria-hidden="true" size={15} />
        <span>Effective cadence: {cadence} · Vercel schedule {schedule}. Faster checks require a verified plan and matching schedule/interval configuration.</span>
      </div>
      <p className="market-watch-note">Price conditions use a fresh Coinbase best-bid/ask midpoint. RSI-14 uses closed 15-minute Coinbase candles. Triggers are in-app and never place orders.</p>

      {loadError ? (
        <div className="market-chart-empty" role="status"><strong>{loadError}</strong></div>
      ) : (
        <form className="market-alert-form" onSubmit={createAlert}>
          <label>
            <span>MARKET</span>
            <select disabled={busy} onChange={(event) => setSymbol(event.target.value)} value={symbol}>
              {USD_WATCHLIST.map(({ productId }) => <option key={productId} value={productId}>{productId}</option>)}
            </select>
          </label>
          <label>
            <span>CONDITION</span>
            <select disabled={busy} onChange={(event) => setCondition(event.target.value as MarketAlertCondition)} value={condition}>
              {MARKET_ALERT_CONDITIONS.map((item) => <option key={item} value={item}>{item.replaceAll("_", " ")}</option>)}
            </select>
          </label>
          <label>
            <span>{condition.startsWith("PRICE_") ? "USD THRESHOLD" : "RSI-14 THRESHOLD"}</span>
            <input
              disabled={busy}
              inputMode="decimal"
              onChange={(event) => setThreshold(event.target.value)}
              placeholder={condition.startsWith("PRICE_") ? "e.g. 70000" : "e.g. 70"}
              value={threshold}
            />
          </label>
          <button disabled={busy || !threshold.trim()} type="submit"><Plus aria-hidden="true" size={14} />CREATE ALERT</button>
        </form>
      )}

      {formError && <p className="login-error" role="alert">{formError}</p>}

      {alerts?.length === 0 && (
        <div className="market-chart-empty" role="status">
          <strong>No alerts yet</strong>
          <span>Created alerts are checked against fresh public Coinbase data. No order is placed.</span>
        </div>
      )}

      {alerts && alerts.length > 0 && (
        <ul className="market-alert-list" aria-label="Market alerts">
          {alerts.map((alert) => (
            <li key={alert.id} className={`market-alert-item market-alert-item--${alert.status.toLowerCase()}`}>
              <div className="market-alert-item__main">
                <div className="market-alert-item__title">
                  <strong>{alert.symbol}</strong>
                  <span>{formatAlertCondition(alert.condition, alert.threshold)}</span>
                  <b>{alert.status}</b>
                </div>
                {alert.status === "TRIGGERED" && alert.event ? (
                  <small>TRIGGERED {timestamp(alert.event.triggeredAt)} · VALUE {alert.event.observedValue} · SOURCE {timestamp(alert.event.sourceObservedAt)}</small>
                ) : (
                  <small>{evaluationError(alert)}{alert.lastObservedValue ? ` · LAST VALUE ${alert.lastObservedValue}` : ""}</small>
                )}
              </div>
              <button aria-label={`Delete ${alert.symbol} alert`} disabled={busy} onClick={() => void deleteAlert(alert.id)} title="Delete alert" type="button">
                <Trash2 aria-hidden="true" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}