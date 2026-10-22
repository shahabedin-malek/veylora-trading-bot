"use client";

import { LoaderCircle, Save } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { RiskPolicyUpdate } from "@/lib/risk-controls/settings";

/**
 * The editor for the owner's limits.
 *
 * Every value here is data: the evaluator reads the row, never a constant, so what the owner
 * types is what refuses an order. `0` is how the owner says "no limit", and each field says
 * so in its own words rather than leaving an empty number box to be guessed at.
 *
 * The two switches are deliberately *not* in this formable area: they take effect the moment
 * they are pressed (see the switch panel above this form), and a switch whose effect waited
 * for a "save" would be the one control on the page that did not do what it looked like it
 * did.
 */
export type RiskPolicyValues = RiskPolicyUpdate;

/** Who last moved the live switch, and when, as the audit trail recorded it. */
export type LiveSwitchChange = { by: string | null; at: string | null };

function NumberField({
  id,
  label,
  value,
  min,
  max,
  step,
  detail,
  effectiveFrom,
  onChange,
}: {
  id: string;
  label: string;
  value: string | number;
  min: string;
  max?: string;
  step: string;
  detail: string;
  effectiveFrom?: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <label className="risk-policy-field" htmlFor={id}>
      <span>{label}</span>
      <input id={id} type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(event.target.value)} />
      <small>{detail}</small>
      {effectiveFrom && <small className="risk-effective-from">In effect since {effectiveFrom}</small>}
    </label>
  );
}

const UNLIMITED = "0 means unlimited.";

export function RiskPolicyForm({
  initialSettings,
  liveChange,
  effectiveFrom,
}: {
  initialSettings: RiskPolicyValues;
  liveChange: LiveSwitchChange;
  effectiveFrom: Record<string, string>;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function updateNumber(field: keyof RiskPolicyValues, value: string) {
    setSettings((current) => ({
      ...current,
      [field]: field === "maxTradesPerDay" || field === "maxOpenPositions" || field === "maxTradesPerInterval"
        || field === "tradeIntervalMinutes" || field === "cooldownMinutes"
        ? Number(value)
        : value,
    }));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);

    try {
      const response = await fetch("/api/admin/risk-policy", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok || !result || typeof result !== "object") {
        const reason = result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error
          : "Risk policy could not be saved.";
        throw new Error(reason);
      }
      const saved = result as RiskPolicyValues & { limitsEffectiveFrom?: Record<string, string> };
      setSettings({ ...saved, approvedSymbols: [...saved.approvedSymbols], allowedVenues: [...saved.allowedVenues] });
      setMessage("Risk policy saved; every changed limit is in the audit trail with its effective-from time.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Risk policy could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const since = (field: string) => {
    const at = effectiveFrom[field];
    if (!at) return null;
    const parsed = new Date(at);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  };

  return (
    <form className="risk-policy-form" onSubmit={save}>
      {/* The real-money switch is the most consequential setting on the page, so it leads. */}
      <label className="risk-kill-switch risk-live-switch">
        <input
          checked={settings.liveExecutionEnabled}
          onChange={(event) => setSettings((current) => ({ ...current, liveExecutionEnabled: event.target.checked }))}
          type="checkbox"
        />
        <span>{settings.liveExecutionEnabled ? "REAL-MONEY EXECUTION IS ON" : "REAL-MONEY EXECUTION IS OFF"}</span>
        <small>
          When on, an order placed from the trading page is sent to Binance with the signed-in account&apos;s own live
          key, and real funds can move. There is no further prompt: this switch and the owner&apos;s instruction are the
          authorisation. When off, live venues are not selectable at all and orders go to the testnet or paper venue.
        </small>
      </label>
      <p className="policy-note" role="status">
        {liveChange.by
          ? `Last changed by ${liveChange.by}${liveChange.at ? ` at ${liveChange.at}` : ""}, recorded in the audit trail on every change.`
          : "This switch has not been changed since it was set; it is off by default and every change is audited with its actor and time."}
      </p>

      <div className="risk-settings-grid">
        <NumberField id="risk-per-trade" label="MAX RISK / TRADE (%)" value={settings.maxRiskPerTradePercent} min="0.01" step="0.01" detail="Percent of configured capital per trade." onChange={(value) => updateNumber("maxRiskPerTradePercent", value)} />
        <NumberField id="risk-open-exposure" label="MAX OPEN EXPOSURE (%)" value={settings.maxOpenExposurePercent} min="0.1" step="0.1" detail="Percent of configured capital held open at once." onChange={(value) => updateNumber("maxOpenExposurePercent", value)} />
        <NumberField id="risk-daily-loss" label="DAILY-LOSS HALT (%)" value={settings.dailyLossHaltPercent} min="0.1" step="0.1" detail="Daily loss that halts new order intents, as a percent of capital." onChange={(value) => updateNumber("dailyLossHaltPercent", value)} />
        <NumberField id="risk-trades-per-day" label="MAX TRADES / DAY" value={settings.maxTradesPerDay} min="1" step="1" detail="Whole order intents allowed per day." onChange={(value) => updateNumber("maxTradesPerDay", value)} />
        <NumberField id="risk-leverage" label="MAX LEVERAGE" value={settings.defaultMaxLeverage} min="0.1" step="0.1" detail="Multiplier applied to configured capital." onChange={(value) => updateNumber("defaultMaxLeverage", value)} />
        <NumberField id="risk-minimum-balance" label="MIN VERIFIED BALANCE (USD)" value={settings.minimumVerifiedBalanceUsd} min="0" step="1" detail="Lowest verified balance that passes the funds check." onChange={(value) => updateNumber("minimumVerifiedBalanceUsd", value)} />
        <NumberField id="risk-first-day-cap" label="FIRST 24H EXPOSURE (USD)" value={settings.first24HourExposureUsd} min="0" step="1" detail="USD notional allowed in the first 24 hours after arming." onChange={(value) => updateNumber("first24HourExposureUsd", value)} />
      </div>

      <div className="section-kicker risk-limits-kicker">LIMITS APPLIED TO EVERY ORDER, PAPER AND LIVE</div>
      <div className="risk-settings-grid">
        <NumberField
          id="risk-order-cap"
          label="MAX NOTIONAL / ORDER (USD)"
          value={settings.maxOrderNotionalUsd}
          min="0"
          step="1"
          detail={`Refuses one order above this size. ${UNLIMITED}`}
          effectiveFrom={since("maxOrderNotionalUsd")}
          onChange={(value) => updateNumber("maxOrderNotionalUsd", value)}
        />
        <NumberField
          id="risk-strategy-cap"
          label="MAX NOTIONAL / STRATEGY (USD)"
          value={settings.maxStrategyNotionalUsd}
          min="0"
          step="1"
          detail={`Refuses an order that would take one strategy's open notional above this. ${UNLIMITED}`}
          effectiveFrom={since("maxStrategyNotionalUsd")}
          onChange={(value) => updateNumber("maxStrategyNotionalUsd", value)}
        />
        <NumberField
          id="risk-open-positions"
          label="MAX OPEN POSITIONS"
          value={settings.maxOpenPositions}
          min="0"
          step="1"
          detail={`Working orders plus markets holding a filled position. ${UNLIMITED}`}
          effectiveFrom={since("maxOpenPositions")}
          onChange={(value) => updateNumber("maxOpenPositions", value)}
        />
        <NumberField
          id="risk-trades-per-interval"
          label="MAX TRADES / INTERVAL"
          value={settings.maxTradesPerInterval}
          min="0"
          step="1"
          detail={`Order intents allowed in the interval below. ${UNLIMITED}`}
          effectiveFrom={since("maxTradesPerInterval")}
          onChange={(value) => updateNumber("maxTradesPerInterval", value)}
        />
        <NumberField
          id="risk-interval"
          label="TRADE-CAP INTERVAL (MIN)"
          value={settings.tradeIntervalMinutes}
          min="1"
          max="1440"
          step="1"
          detail="The window the trade cap counts over."
          effectiveFrom={since("tradeIntervalMinutes")}
          onChange={(value) => updateNumber("tradeIntervalMinutes", value)}
        />
        <NumberField
          id="risk-cooldown"
          label="COOLDOWN AFTER A HALT (MIN)"
          value={settings.cooldownMinutes}
          min="0"
          max="1440"
          step="1"
          detail="Hold new orders back after a daily-loss halt or after the global kill switch is released. 0 means no cooldown."
          effectiveFrom={since("cooldownMinutes")}
          onChange={(value) => updateNumber("cooldownMinutes", value)}
        />
      </div>

      <label className="risk-policy-field risk-symbol-field" htmlFor="risk-approved-symbols">
        <span>APPROVED SITE SYMBOLS</span>
        <textarea
          id="risk-approved-symbols"
          rows={5}
          value={settings.approvedSymbols.join("\n")}
          onChange={(event) => setSettings((current) => ({
            ...current,
            approvedSymbols: event.target.value.split(/\r?\n/).map((symbol) => symbol.trim()).filter(Boolean),
          }))}
        />
        <small>One uppercase BASE-QUOTE product ID per line. User allow-lists can only narrow this site list.</small>
      </label>

      <label className="risk-policy-field risk-symbol-field" htmlFor="risk-allowed-venues">
        <span>ALLOWED VENUES</span>
        <textarea
          id="risk-allowed-venues"
          rows={3}
          value={settings.allowedVenues.join("\n")}
          onChange={(event) => setSettings((current) => ({
            ...current,
            allowedVenues: event.target.value.split(/\r?\n/).map((venue) => venue.trim()).filter(Boolean),
          }))}
        />
        <small>
          One lowercase venue id per line — for example dev-paper, binance-testnet, binance. Leave empty to allow every
          configured venue. An order whose venue is not in the list is refused and the refusal names the venue.
        </small>
      </label>

      <section className="risk-evaluator-checks" aria-labelledby="risk-evaluator-title">
        <div className="section-kicker" id="risk-evaluator-title">EVALUATOR CHECKS ON EVERY ORDER INTENT</div>
        <p>Stop-loss present · maximum-loss bound · verified funds · venue in the configured list · one-time live arm · per-user symbol allow-list narrowing the site list above · append-only audit reachable · every owner limit above. These are enforced in code on each intent; the values above are yours to set.</p>
      </section>

      <div className="risk-policy-actions">
        <button className="section-action" disabled={saving} type="submit">
          {saving ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : <Save aria-hidden="true" size={14} />}
          {saving ? "SAVING" : "SAVE RISK POLICY"}
        </button>
        {message && <span role="status">{message}</span>}
        {error && <span className="login-error" role="alert">{error}</span>}
      </div>
    </form>
  );
}
