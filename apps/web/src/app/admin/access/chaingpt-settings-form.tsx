"use client";

import { ExternalLink, LoaderCircle, Save } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  CHAINGPT_FEATURES,
  CHAINGPT_UPGRADE_URL,
  type ChainGPTFeatureSettings,
} from "@/lib/chaingpt/features";

export function ChainGPTSettingsForm({
  initialSettings,
}: {
  initialSettings: ChainGPTFeatureSettings | null;
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
      const response = await fetch("/api/admin/chaingpt", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok || !result || typeof result !== "object") {
        const reason = result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error
          : "ChainGPT settings could not be saved.";
        throw new Error(reason);
      }
      setSettings(result as ChainGPTFeatureSettings);
      setMessage("Link visibility saved and audited.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "ChainGPT settings could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return (
      <div className="market-chart-empty" role="status">
        <strong>Settings storage unavailable</strong>
        <span>Apply the database migration before managing ChainGPT links.</span>
      </div>
    );
  }

  return (
    <>
      <form className="chaingpt-admin-form" onSubmit={save}>
        <ul className="chaingpt-admin-list">
          {CHAINGPT_FEATURES.map((feature) => (
            <li className="chaingpt-admin-row" key={feature.key}>
              <label className="chaingpt-admin-toggle" htmlFor={`chaingpt-${feature.key}`}>
                <span className="chaingpt-admin-copy">
                  <span>{feature.name}</span>
                  <small>{feature.detail}</small>
                </span>
                <input
                  id={`chaingpt-${feature.key}`}
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
            {saving ? "SAVING" : "SAVE LINK SETTINGS"}
          </button>
          <a className="section-action" href={CHAINGPT_UPGRADE_URL} target="_blank" rel="noopener noreferrer">
                    VIEW PRICING / UPGRADE <ExternalLink aria-hidden="true" size={12} />
          </a>
          {message && <span role="status">{message}</span>}
          {error && <span className="login-error" role="alert">{error}</span>}
        </div>
      </form>
      <p className="chaingpt-admin-disclosure">These switches control external links only. Veylora does not use a ChainGPT API key, pass private account data, or place orders. Pricing opens ChainGPT; it does not change a plan or authorize spending.</p>
    </>
  );
}