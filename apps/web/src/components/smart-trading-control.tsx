"use client";

import { CircleAlert, CirclePlay, CircleStop, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { StrategyActivationView } from "@/lib/strategies/activation";
import { defaultStrategyId, strategyChoices } from "@/lib/strategies/state";

/**
 * The one control: start smart trading, stop it, and see exactly what the system is doing.
 *
 * Both buttons are always rendered and never disabled because of configuration. A press
 * always sends a request and always gets an answer — "started", "already running",
 * "already stopped" — which is what the phase means by a control that can be pressed and
 * observed rather than a button that looks available and does nothing.
 *
 * The state shown is the server's, not the panel's opinion: the state, every reason, the
 * blocker list and the placement sentence all come back from the activation view. The panel
 * adds only its own clock, a periodic re-read, and the strategy picker.
 *
 * The picker is what makes a bot published in the builder startable (phase 30). The control
 * starts the strategy the owner selected from the server's own catalog — the built-ins plus
 * this account's published bots — and sends that id, rather than starting whatever happened
 * to be selected last. Choosing a different one while the account is running is a strategy
 * change, not a no-op, and the message the server returns says which one is now running.
 */

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

function formatTime(value: string | null): string {
  if (!value) return "not yet";
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function reasonLabel(code: string | null): string {
  return code ? code.replaceAll("_", " ") : "REASON UNAVAILABLE";
}

export function SmartTradingControl({ initialView }: { initialView: StrategyActivationView }) {
  const [view, setView] = useState(initialView);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState<number | null>(null);
  // What the owner picked, and only that: the effective selection is derived below, so a
  // poll that changes the catalog or the running strategy never needs to overwrite state
  // in an effect. Null means "nothing was chosen", which is how the control keeps its
  // pre-phase-30 behaviour — it starts the running strategy, or the first offered one.
  const [chosenId, setChosenId] = useState<string | null>(null);

  // The clock is local and starts after mount, so the server's HTML and the first client
  // render agree; the elapsed time then advances without a request.
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  // A read every twenty seconds keeps a running activation's last pass and next pass
  // current, including when the runner recorded something while this tab was in the
  // background. It never writes.
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const response = await fetch("/api/strategies/activate", { credentials: "same-origin", cache: "no-store" });
        const body: unknown = await response.json().catch(() => null);
        if (response.ok && body && typeof body === "object" && "view" in body) {
          setView(body.view as StrategyActivationView);
        }
      } catch {
        // A failed poll leaves the last known state on screen; the next one replaces it.
      }
    }, 20_000);
    return () => clearInterval(timer);
  }, []);

  async function apply(method: "POST" | "DELETE") {
    // A stop with no activation to stop is answered here rather than by a request: the
    // account has no row, so there is nothing for the server to change. Every other state
    // has an id, and the stop is the server's answer.
    if (method === "DELETE" && !view.id) {
      setMessage("No activation exists for this account, so there is nothing to stop. Nothing was written.");
      setError(null);
      return;
    }
    setBusy(method === "POST" ? "start" : "stop");
    setMessage(null);
    setError(null);
    try {
      const response = await fetch(method === "POST" ? "/api/strategies/activate" : `/api/strategies/${encodeURIComponent(view.id ?? "")}`, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        ...(method === "POST"
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ strategyId: selected?.id ?? null }),
            }
          : {}),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !body || typeof body !== "object") {
        const reason =
          body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error
            : "The request could not be answered.";
        throw new Error(reason);
      }
      if ("view" in body) setView(body.view as StrategyActivationView);
      setMessage(typeof (body as { message?: unknown }).message === "string" ? (body as { message: string }).message : "Saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request could not be answered.");
    } finally {
      setBusy(null);
    }
  }

  const choices = useMemo(() => strategyChoices(view), [view]);
  // The owner's choice while it is still offered; otherwise the default, which is the
  // strategy the account is on and then the first offered one. A published bot that is
  // deleted while it is selected falls back here rather than leaving a press aimed at an
  // id the server would refuse.
  const selected =
    choices.find((choice) => choice.id === chosenId) ??
    choices.find((choice) => choice.id === defaultStrategyId(view)) ??
    choices[0] ??
    null;
  const elapsed =
    view.startedAt && view.intent === "RUNNING"
      ? clock !== null
        ? clock - Date.parse(view.startedAt)
        : view.elapsedMs
      : null;

  return (
    <section className={`smart-trading smart-trading--${view.state}`} aria-labelledby="smart-trading-title">
      <div className="smart-trading__head">
        <div>
          <div className="section-kicker">SMART AI TRADING / ONE CONTROL</div>
          <h3 id="smart-trading-title">{view.headline}</h3>
        </div>
        <span className={`smart-trading__state smart-trading__state--${view.state}`} role="status">
          {view.stateLabel}
        </span>
      </div>

      <p className="smart-trading__detail">{view.detail}</p>

      {view.reason && (
        <div className="smart-trading__reason" role="status">
          <CircleAlert aria-hidden="true" size={16} />
          <div>
            <strong>{reasonLabel(view.reason.code)}</strong>
            <span>{view.reason.message}</span>
          </div>
        </div>
      )}

      {view.blockers.length > 0 && (
        <div className="smart-trading__blockers">
          <div className="section-kicker">WHAT IS MISSING</div>
          <ul>
            {view.blockers.map((blocker) => (
              <li key={blocker.code}>
                <div>
                  <strong>{reasonLabel(blocker.code)}</strong>
                  <span>{blocker.message}</span>
                </div>
                <Link className="section-action smart-trading__fix" href={blocker.action.href}>
                  {blocker.action.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <dl className="smart-trading__facts">
        <div>
          <dt>STRATEGY</dt>
          <dd>{view.strategy?.label ?? "None selected"}</dd>
        </div>
        <div>
          <dt>RUNNING FOR</dt>
          <dd>{elapsed !== null ? formatDuration(elapsed) : view.intent === "RUNNING" ? "Waiting for first pass" : "Not running"}</dd>
        </div>
        <div>
          <dt>LAST PASS</dt>
          <dd>
            {formatTime(view.lastPass.at)}
            {view.lastPass.outcome ? ` · ${view.lastPass.outcome.toUpperCase()}` : ""}
            {` · ${view.lastPass.runCount} pass(es)`}
          </dd>
        </div>
        <div>
          <dt>NEXT PASS</dt>
          <dd>{view.runner.scheduled ? formatTime(view.runner.nextDueAt) : "Not scheduled"}</dd>
        </div>
        <div>
          <dt>PLACEMENT</dt>
          <dd>{view.placement.label}</dd>
        </div>
        <div>
          <dt>LAST CHANGE</dt>
          <dd>
            {view.lastChange.at
              ? `${formatTime(view.lastChange.at)}${view.lastChange.by ? ` by ${view.lastChange.by}` : ""}`
              : "Never changed"}
          </dd>
        </div>
      </dl>

      <p className="smart-trading__placement">{view.placement.detail}</p>
      <p className="smart-trading__runner">{view.runner.detail}</p>

      <div className="smart-trading__strategy">
        <label className="risk-policy-field" htmlFor="smart-trading-strategy">
          <span>STRATEGY TO START</span>
          <select
            id="smart-trading-strategy"
            onChange={(event) => setChosenId(event.target.value)}
            value={selected?.id ?? ""}
          >
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>{choice.label}</option>
            ))}
          </select>
        </label>
        {selected && <p className="smart-trading__strategy-detail">{selected.detail}</p>}
        {selected && view.intent === "RUNNING" && selected.id !== view.strategy?.id && (
          <p className="smart-trading__strategy-switch" role="status">
            Pressing start moves this account from {view.strategy?.label ?? "its current strategy"} to {selected.label}.
          </p>
        )}
      </div>

      <div className="smart-trading__actions">
        <button
          className="section-action smart-trading__start"
          disabled={busy !== null}
          onClick={() => void apply("POST")}
          type="button"
        >
          {busy === "start" ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : <CirclePlay aria-hidden="true" size={14} />}
          {busy === "start" ? "STARTING" : view.actions.start.label}
        </button>
        <button
          className="section-action smart-trading__stop"
          disabled={busy !== null}
          onClick={() => void apply("DELETE")}
          type="button"
        >
          {busy === "stop" ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : <CircleStop aria-hidden="true" size={14} />}
          {busy === "stop" ? "STOPPING" : view.actions.stop.label}
        </button>
        {message && <span role="status">{message}</span>}
        {error && (
          <span className="login-error" role="alert">
            {error}
          </span>
        )}
      </div>

      <p className="policy-note">
        {view.actions.start.detail} {view.actions.stop.detail}
      </p>
    </section>
  );
}
