"use client";

import { LoaderCircle, Save } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  WUNDERTRADING_FEATURES,
  type WunderTradingFeatureSettings,
} from "@/lib/wundertrading/features";

export function WunderTradingSettingsForm({
  initialSettings,
}: {
  initialSettings: WunderTradingFeatureSettings | null;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) return;

    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/admin/wundertrading", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok || !result || typeof result !== "object") {
        const reason = result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error
          : "WunderTrading settings could not be saved.";
        throw new Error(reason);
      }
      setSettings(result as WunderTradingFeatureSettings);
      setMessage("WunderTrading settings saved and audited.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "WunderTrading settings could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return (
      <div className="market-chart-empty" role="status">
        <strong>Settings storage unavailable</strong>
        <span>Apply the database migration before managing WunderTrading functions.</span>
      </div>
    );
  }

  return (
    <>
      <form className="chaingpt-admin-form" onSubmit={save}>
        <ul className="chaingpt-admin-list">
          {WUNDERTRADING_FEATURES.map((feature) => (
            <li className="chaingpt-admin-row" key={feature.key}>
              <label className="chaingpt-admin-toggle" htmlFor={`wundertrading-${feature.key}`}>
                <span className="chaingpt-admin-copy">
                  <span>{feature.name}</span>
                  <small>{feature.detail}</small>
                </span>
                <input
                  id={`wundertrading-${feature.key}`}
                  type="checkbox"
                  checked={settings[feature.key]}
                  onChange={(event) => setSettings((current) => current && ({
                    ...current,
                    [feature.key]: event.target.checked,
                  }))}
                />
                <span className="chaingpt-toggle-state">{settings[feature.key] ? "ON" : "OFF"}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="chaingpt-admin-actions">
          <button className="section-action" disabled={saving} type="submit">
            {saving ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : <Save aria-hidden="true" size={14} />}
            {saving ? "SAVING" : "SAVE WUNDERTRADING SETTINGS"}
          </button>
          {message && <span role="status">{message}</span>}
          {error && <span className="login-error" role="alert">{error}</span>}
        </div>
      </form>
      <p className="chaingpt-admin-disclosure">Each switch turns one WunderTrading read function on or off. No switch here places an order: Veylora calls only the read endpoints, and the keys stay encrypted at rest.</p>
    </>
  );
}