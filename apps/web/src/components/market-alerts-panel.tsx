"use client";

import { BellRing, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { MARKET_ALERT_CONDITIONS, formatAlertCondition, type MarketAlertCondition } from "@/lib/alerts/conditions";
import { REQUEST_ID_HEADER } from "@/lib/observability/request-id";
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
  cooldownMinutes?: number;
  conditionMet?: boolean;
  lastEvaluatedAt: string | null;
  lastObservedValue: string | null;
  lastEvaluationError: string | null;
  triggeredAt: string | null;
  nextEvaluationAt?: string | null;
  events?: AlertEvent[];
};

type AlertEvaluation = {
  outcome: "triggered" | "idle" | "failed" | "never-run";
  reason: { code: string; message: string; retryable: boolean; variable?: string; providerId?: string; detail?: string } | null;
  checks: number;
  failures: number;
  lastEvaluatedAt: string | null;
  lastTriggeredAt?: string | null;
};

type ChannelView = {
  id: "IN_APP" | "EMAIL" | "TELEGRAM";
  label: string;
  enabled: boolean;
  configured: boolean;
  missingVariables: string[];
  state: "READY" | "OFF" | "NOT_CONFIGURED";
  message: string;
};

type QuietHours = { enabled: boolean; start: string; end: string; active: boolean; queued: number };

type Delivery = {
  id: string;
  channel: string;
  target: string;
  subject: string;
  status: string;
  providerId: string | null;
  providerMessageId: string | null;
  error: string | null;
  attempt: number;
  durationMs: number | null;
  queuedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
};

type AlertResponse = {
  alerts?: MarketAlert[];
  cadence?: string;
  schedule?: string;
  evaluation?: AlertEvaluation;
  channels?: ChannelView[];
  quietHours?: QuietHours;
  deliveries?: Delivery[];
  defaultCooldownMinutes?: number;
  error?: string;
};

async function loadAlerts(): Promise<AlertResponse> {
  try {
    const response = await fetch("/api/market-alerts", { cache: "no-store", credentials: "same-origin" });
    const payload: unknown = await response.json();
    if (response.status === 401) return { error: "Connect a wallet to manage personal alerts." };
    if (!response.ok) {
      // The server's refusal names the cause (a missing configuration variable,
      // for example); do not replace it with a guess. The request id is echoed
      // so a report can be traced to the server lines for this exact call.
      const serverReason = typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : null;
      const requestId = response.headers.get(REQUEST_ID_HEADER);
      const refusal = serverReason ?? `Market alerts answered ${response.status}; no alert list was returned.`;
      return { error: requestId ? `${refusal} (request ${requestId})` : refusal };
    }
    if (typeof payload !== "object" || payload === null || !("alerts" in payload) || !Array.isArray(payload.alerts)) {
      return { error: "Market alerts answered without an alert list." };
    }
    const record = payload as Record<string, unknown>;
    return {
      alerts: record.alerts as MarketAlert[],
      cadence: typeof record.cadence === "string" ? record.cadence : "24 hours",
      schedule: typeof record.schedule === "string" ? record.schedule : "0 0 * * *",
      evaluation: parseEvaluation(record.evaluation),
      channels: parseChannels(record.channels),
      quietHours: parseQuietHours(record.quietHours),
      deliveries: Array.isArray(record.deliveries) ? record.deliveries as Delivery[] : [],
      defaultCooldownMinutes: typeof record.defaultCooldownMinutes === "number" ? record.defaultCooldownMinutes : 60,
    };
  } catch (cause) {
    return { error: cause instanceof Error ? `Market alerts could not be requested: ${cause.message}` : "Market alerts could not be requested." };
  }
}

function parseEvaluation(value: unknown): AlertEvaluation | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.outcome !== "string" || !["triggered", "idle", "failed", "never-run"].includes(record.outcome)) return undefined;
  const reason = typeof record.reason === "object" && record.reason !== null ? (record.reason as AlertEvaluation["reason"]) : null;
  return {
    outcome: record.outcome as AlertEvaluation["outcome"],
    reason,
    checks: typeof record.checks === "number" ? record.checks : 0,
    failures: typeof record.failures === "number" ? record.failures : 0,
    lastEvaluatedAt: typeof record.lastEvaluatedAt === "string" ? record.lastEvaluatedAt : null,
    lastTriggeredAt: typeof record.lastTriggeredAt === "string" ? record.lastTriggeredAt : null,
  };
}

function parseChannels(value: unknown): ChannelView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.label !== "string" || typeof record.state !== "string") return [];
    return [{
      id: record.id as ChannelView["id"],
      label: record.label,
      enabled: record.enabled === true,
      configured: record.configured === true,
      missingVariables: Array.isArray(record.missingVariables) ? record.missingVariables.filter((entry): entry is string => typeof entry === "string") : [],
      state: record.state as ChannelView["state"],
      message: typeof record.message === "string" ? record.message : "",
    }];
  });
}

function parseQuietHours(value: unknown): QuietHours | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return {
    enabled: record.enabled === true,
    start: typeof record.start === "string" ? record.start : "22:00",
    end: typeof record.end === "string" ? record.end : "07:00",
    active: record.active === true,
    queued: typeof record.queued === "number" ? record.queued : 0,
  };
}

function timestamp(value: string | null | undefined): string {
  if (!value) return "NOT YET";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "TIME UNAVAILABLE";
}

function duration(value: number | null): string {
  return value === null ? "—" : `${value} ms`;
}

export function MarketAlertsPanel() {
  const [alerts, setAlerts] = useState<MarketAlert[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState<AlertEvaluation | null>(null);
  const [cadence, setCadence] = useState("24 hours");
  const [schedule, setSchedule] = useState("0 0 * * *");
  const [channels, setChannels] = useState<ChannelView[]>([]);
  const [quietHours, setQuietHours] = useState<QuietHours | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [symbol, setSymbol] = useState<string>(USD_WATCHLIST[0].productId);
  const [condition, setCondition] = useState<MarketAlertCondition>("PRICE_ABOVE");
  const [threshold, setThreshold] = useState("");
  const [cooldown, setCooldown] = useState(60);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((result: AlertResponse) => {
    setAlerts(result.alerts ?? null);
    setLoadError(result.error ?? null);
    setEvaluation(result.evaluation ?? null);
    setCadence(result.cadence ?? "24 hours");
    setSchedule(result.schedule ?? "0 0 * * *");
    setChannels(result.channels ?? []);
    setQuietHours(result.quietHours ?? null);
    setDeliveries(result.deliveries ?? []);
    setCooldown(result.defaultCooldownMinutes ?? 60);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadAlerts().then((result) => {
      if (cancelled) return;
      apply(result);
    });
    return () => { cancelled = true; };
  }, [apply]);

  async function refresh() {
    apply(await loadAlerts());
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
        body: JSON.stringify({ symbol, condition, threshold, cooldownMinutes: cooldown }),
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

  const alertState = (alert: MarketAlert) => {
    if (alert.lastEvaluationError) return `CHECK FAILED · ${alert.lastEvaluationError}`;
    if (alert.conditionMet) return "CONDITION STILL MET · WAITING FOR A NEW CROSSING";
    if (alert.lastEvaluatedAt) return `LAST CHECK · ${timestamp(alert.lastEvaluatedAt)}`;
    return "WAITING FOR FIRST CHECK";
  };

  const lastFire = (alert: MarketAlert) => alert.events?.[0]?.triggeredAt ?? alert.triggeredAt;

  return (
    <section className="data-section market-alerts-section" id="alerts" aria-labelledby="market-alerts-title">
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

      {channels.length > 0 && (
        <ul className="notification-channels" aria-label="Notification channels">
          {channels.map((channel) => (
            <li className={`notification-channel notification-channel--${channel.state.toLowerCase()}`} key={channel.id}>
              <span className="notification-channel__label">{channel.label}</span>
              <b>{channel.state.replaceAll("_", " ")}</b>
              {channel.missingVariables.length > 0
                ? <small>SET {channel.missingVariables.join(", ")}</small>
                : <small>{channel.message}</small>}
            </li>
          ))}
        </ul>
      )}

      {quietHours?.enabled && (
        <div className={`notification-quiet ${quietHours.active ? "notification-quiet--active" : ""}`} role="status">
          <strong>
            QUIET HOURS {quietHours.start}–{quietHours.end} UTC · {quietHours.active ? "DELIVERY PAUSED" : "DELIVERY RESUMED"}
          </strong>
          <span>
            {quietHours.queued > 0
              ? `${quietHours.queued} notification(s) are queued and will be delivered when the window closes.`
              : "Alerts that trigger inside the window are queued, not dropped."}
          </span>
        </div>
      )}

      {evaluation?.reason && (
        <div className={`market-alerts-reason market-alerts-reason--${evaluation.outcome}`} role="status">
          <span className="market-alerts-reason__code">{evaluation.reason.code.replaceAll("_", " ")}</span>
          <span>{evaluation.reason.message}</span>
          {evaluation.reason.variable && <span>Set {evaluation.reason.variable} to change this.</span>}
          {evaluation.reason.detail && <span>{evaluation.reason.detail}</span>}
        </div>
      )}
      <p className="market-watch-note">Price conditions use a fresh Coinbase best-bid/ask midpoint. RSI-14 uses closed 15-minute Coinbase candles. Triggers are informational and never place orders.</p>

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
          <label>
            <span>COOLDOWN (MIN)</span>
            <input
              disabled={busy}
              inputMode="numeric"
              min={1}
              onChange={(event) => setCooldown(Number(event.target.value) || 1)}
              type="number"
              value={cooldown}
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
                {lastFire(alert) ? (
                  <small>LAST FIRE {timestamp(lastFire(alert))} · VALUE {alert.events?.[0]?.observedValue ?? alert.lastObservedValue ?? "—"}</small>
                ) : (
                  <small>{alertState(alert)}{alert.lastObservedValue ? ` · LAST VALUE ${alert.lastObservedValue}` : ""}</small>
                )}
                <small>
                  LAST CHECK {timestamp(alert.lastEvaluatedAt)} · NEXT CHECK {alert.nextEvaluationAt ? timestamp(alert.nextEvaluationAt) : "ON THE NEXT RUNNER PASS"} · COOLDOWN {alert.cooldownMinutes ?? 60} MIN
                </small>
              </div>
              <button aria-label={`Delete ${alert.symbol} alert`} disabled={busy} onClick={() => void deleteAlert(alert.id)} title="Delete alert" type="button">
                <Trash2 aria-hidden="true" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="notification-delivery-log">
        <div className="section-heading">
          <div>
            <div className="section-kicker">DELIVERY LOG</div>
            <h3>What was sent, and what failed</h3>
          </div>
          <span className="section-state">{deliveries.length} ATTEMPTS</span>
        </div>
        {deliveries.length === 0 ? (
          <p className="market-watch-note" role="status">No delivery attempt yet. A trigger writes one row per channel, and every retry writes another.</p>
        ) : (
          <div className="market-history-table-wrap">
            <table className="market-history-table notification-delivery-table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Channel</th>
                  <th scope="col">Target</th>
                  <th scope="col">Status</th>
                  <th scope="col">Provider id</th>
                  <th scope="col">Attempt</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((delivery) => (
                  <tr key={delivery.id} className={`notification-delivery notification-delivery--${delivery.status.toLowerCase()}`}>
                    <td>{timestamp(delivery.createdAt)}</td>
                    <td>{delivery.channel}</td>
                    <td>{delivery.target}</td>
                    <td>{delivery.status}{delivery.queuedAt ? ` · queued ${timestamp(delivery.queuedAt)}` : ""}</td>
                    <td>{delivery.providerMessageId ?? delivery.providerId ?? "—"}</td>
                    <td>{delivery.attempt}</td>
                    <td>{duration(delivery.durationMs)}</td>
                    <td>{delivery.error ?? delivery.subject}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
