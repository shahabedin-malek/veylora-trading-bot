"use client";

import { LoaderCircle, Save } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  INTEGRATION_FEATURES,
  type IntegrationFeatureSettings,
} from "@/lib/integrations/features";

export function IntegrationSettingsForm({
  initialSettings,
}: {
  initialSettings: IntegrationFeatureSettings | null;
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
      const response = await fetch("/api/admin/integrations", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok || !result || typeof result !== "object") {
        const reason = result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error
          : "Integration switches could not be saved.";
        throw new Error(reason);
      }
      setSettings(result as IntegrationFeatureSettings);
      setMessage("Integration switches saved and audited.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Integration switches could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return (
      <div className="market-chart-empty" role="status">
        <strong>Settings storage unavailable</strong>
        <span>Apply the database migration before managing integration switches.</span>
      </div>
    );
  }

  return (
    <form className="chaingpt-admin-form" onSubmit={save}>
      <ul className="chaingpt-admin-list">
        {INTEGRATION_FEATURES.map((feature) => (
          <li className="chaingpt-admin-row" key={feature.key}>
            <label className="chaingpt-admin-toggle" htmlFor={`integration-${feature.key}`}>
              <span className="chaingpt-admin-copy">
                <span>{feature.name}</span>
                <small>{feature.detail}</small>
              </span>
              <input
                id={`integration-${feature.key}`}
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
          {saving ? "SAVING" : "SAVE INTEGRATION SETTINGS"}
        </button>
        {message && <span role="status">{message}</span>}
        {error && <span className="login-error" role="alert">{error}</span>}
      </div>        <p className="chaingpt-admin-disclosure">All switches default off. Database, auth, session, encryption, and provider secrets are deployment-managed and never displayed or edited here. Tavily uses keyless Search/Extract only. SandBase is called with the deployment&apos;s own key, which the readiness list reports as configured or missing.</p>
    </form>
  );
}