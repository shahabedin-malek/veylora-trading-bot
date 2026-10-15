"use client";

import { LoaderCircle, Save } from "lucide-react";
import { useState, type FormEvent } from "react";

type RiskPolicyValues = {
  maxRiskPerTradePercent: string;
  maxOpenExposurePercent: string;
  dailyLossHaltPercent: string;
  maxTradesPerDay: number;
  defaultMaxLeverage: string;
  minimumVerifiedBalanceUsd: string;
  first24HourExposureUsd: string;
  approvedSymbols: string[];
  killSwitchActive: boolean;
};

function NumberField({
  id,
  label,
  value,
  min,
  max,
  step,
  detail,
  onChange,
}: {
  id: string;
  label: string;
  value: string | number;
  min: string;
  max?: string;
  step: string;
  detail: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="risk-policy-field" htmlFor={id}>
      <span>{label}</span>
      <input id={id} type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(event.target.value)} />
      <small>{detail}</small>
    </label>
  );
}

export function RiskPolicyForm({ initialSettings }: { initialSettings: RiskPolicyValues }) {
  const [settings, setSettings] = useState(initialSettings);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function updateNumber(field: keyof RiskPolicyValues, value: string) {
    setSettings((current) => ({
      ...current,
      [field]: field === "maxTradesPerDay" ? Number(value) : value,
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
      setSettings(result as RiskPolicyValues);
      setMessage("Risk policy saved and audit recorded.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Risk policy could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="risk-policy-form" onSubmit={save}>
      <div className="risk-settings-grid">
        <NumberField id="risk-per-trade" label="MAX RISK / TRADE (%)" value={settings.maxRiskPerTradePercent} min="0.01" max="1" step="0.01" detail="Can only be tightened below 1%." onChange={(value) => updateNumber("maxRiskPerTradePercent", value)} />
        <NumberField id="risk-open-exposure" label="MAX OPEN EXPOSURE (%)" value={settings.maxOpenExposurePercent} min="0.1" max="25" step="0.1" detail="Can only be tightened below 25%." onChange={(value) => updateNumber("maxOpenExposurePercent", value)} />
        <NumberField id="risk-daily-loss" label="DAILY-LOSS HALT (%)" value={settings.dailyLossHaltPercent} min="0.1" max="2" step="0.1" detail="Can only be tightened below 2%." onChange={(value) => updateNumber("dailyLossHaltPercent", value)} />
        <NumberField id="risk-trades-per-day" label="MAX TRADES / DAY" value={settings.maxTradesPerDay} min="1" max="10" step="1" detail="Maximum approved cap: 10." onChange={(value) => updateNumber("maxTradesPerDay", value)} />
        <NumberField id="risk-leverage" label="MAX LEVERAGE" value={settings.defaultMaxLeverage} min="0.1" max="1" step="0.1" detail="Maximum approved cap: 1×." onChange={(value) => updateNumber("defaultMaxLeverage", value)} />
        <NumberField id="risk-minimum-balance" label="MIN VERIFIED BALANCE (USD)" value={settings.minimumVerifiedBalanceUsd} min="20" step="1" detail="Cannot be lowered below USD 20." onChange={(value) => updateNumber("minimumVerifiedBalanceUsd", value)} />
        <NumberField id="risk-first-day-cap" label="FIRST 24H EXPOSURE (USD)" value={settings.first24HourExposureUsd} min="0" max="20" step="1" detail="Cannot exceed USD 20." onChange={(value) => updateNumber("first24HourExposureUsd", value)} />
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

      <label className="risk-kill-switch">
        <input
          checked={settings.killSwitchActive}
          onChange={(event) => setSettings((current) => ({ ...current, killSwitchActive: event.target.checked }))}
          type="checkbox"
        />
        <span>ENGAGE KILL SWITCH</span>
        <small>When engaged, the evaluator refuses every order intent.</small>
      </label>

      <section className="risk-locked-controls" aria-labelledby="risk-locked-title">
        <div className="section-kicker" id="risk-locked-title">LOCKED SAFEGUARDS</div>
        <p>Stop-loss and maximum-loss bound · verified funds · approved venue · one-time live arm · per-user symbol allow-list · append-only audit · withdrawals permanently disabled.</p>
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