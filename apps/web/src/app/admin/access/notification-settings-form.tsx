"use client";

import { LoaderCircle, Save } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { NotificationChannelView, NotificationSettings } from "@/lib/notifications/settings";

type SettingsPayload = { settings: NotificationSettings; channels: NotificationChannelView[] };

export function NotificationSettingsForm({
  initialSettings,
  initialChannels,
}: {
  initialSettings: NotificationSettings | null;
  initialChannels: NotificationChannelView[];
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [channels, setChannels] = useState(initialChannels);
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
      const response = await fetch("/api/admin/notifications", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok || !result || typeof result !== "object") {
        const refusal = result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error
          : "Notification settings could not be saved.";
        throw new Error(refusal);
      }
      const payload = result as SettingsPayload;
      setSettings(payload.settings);
      setChannels(payload.channels);
      setMessage("Notification settings saved and audited.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Notification settings could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return (
      <div className="market-chart-empty" role="status">
        <strong>Notification settings storage unavailable</strong>
        <span>Apply the database migration before managing delivery channels.</span>
      </div>
    );
  }

  return (
    <form className="chaingpt-admin-form" onSubmit={save}>
      <ul className="chaingpt-admin-list">
        {channels.map((channel) => (
          <li className={`chaingpt-admin-row notification-channel notification-channel--${channel.state.toLowerCase()}`} key={channel.id}>
            <label className="chaingpt-admin-toggle" htmlFor={`notification-${channel.id}`}>
              <span className="chaingpt-admin-copy">
                <span>{channel.label}</span>
                <small>{channel.message}</small>
                {channel.missingVariables.length > 0 && (
                  <small className="notification-channel__missing">SET {channel.missingVariables.join(", ")}</small>
                )}
              </span>
              <input
                id={`notification-${channel.id}`}
                type="checkbox"
                checked={channel.id === "IN_APP" ? settings.inAppEnabled : channel.id === "EMAIL" ? settings.emailEnabled : settings.telegramEnabled}
                onChange={(event) => setSettings((current) => current && ({
                  ...current,
                  ...(channel.id === "IN_APP"
                    ? { inAppEnabled: event.target.checked }
                    : channel.id === "EMAIL"
                      ? { emailEnabled: event.target.checked }
                      : { telegramEnabled: event.target.checked }),
                }))}
              />
              <span className="chaingpt-toggle-state">
                {channel.id === "IN_APP" ? (settings.inAppEnabled ? "ON" : "OFF")
                  : channel.id === "EMAIL" ? (settings.emailEnabled ? "ON" : "OFF")
                    : (settings.telegramEnabled ? "ON" : "OFF")}
              </span>
            </label>
            <span className="notification-channel__state">{channel.state.replaceAll("_", " ")}</span>
          </li>
        ))}
      </ul>

      <div className="notification-settings-grid">
        <label>
          <span>QUIET HOURS (UTC)</span>
          <span className="notification-settings-times">
            <input
              aria-label="Quiet hours start"
              inputMode="numeric"
              onChange={(event) => setSettings((current) => current && { ...current, quietHoursStart: event.target.value })}
              pattern="^([01]\d|2[0-3]):[0-5]\d$"
              placeholder="22:00"
              value={settings.quietHoursStart}
            />
            <span>TO</span>
            <input
              aria-label="Quiet hours end"
              inputMode="numeric"
              onChange={(event) => setSettings((current) => current && { ...current, quietHoursEnd: event.target.value })}
              pattern="^([01]\d|2[0-3]):[0-5]\d$"
              placeholder="07:00"
              value={settings.quietHoursEnd}
            />
          </span>
        </label>
        <label className="chaingpt-admin-toggle" htmlFor="notification-quiet-hours">
          <span className="chaingpt-admin-copy">
            <span>Pause delivery during quiet hours</span>
            <small>Alerts are queued, not dropped, and delivered when the window closes.</small>
          </span>
          <input
            id="notification-quiet-hours"
            type="checkbox"
            checked={settings.quietHoursEnabled}
            onChange={(event) => setSettings((current) => current && { ...current, quietHoursEnabled: event.target.checked })}
          />
          <span className="chaingpt-toggle-state">{settings.quietHoursEnabled ? "ON" : "OFF"}</span>
        </label>
        <label>
          <span>DEFAULT COOLDOWN (MINUTES)</span>
          <input
            inputMode="numeric"
            min={1}
            onChange={(event) => setSettings((current) => current && {
              ...current,
              defaultCooldownMinutes: Number(event.target.value) || 0,
            })}
            type="number"
            value={settings.defaultCooldownMinutes}
          />
          <small>A new rule starts with this gap between fires. Each rule keeps the value it was created with.</small>
        </label>
      </div>

      <div className="chaingpt-admin-actions">
        <button className="section-action" disabled={saving} type="submit">
          {saving ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : <Save aria-hidden="true" size={14} />}
          {saving ? "SAVING" : "SAVE NOTIFICATION SETTINGS"}
        </button>
        {message && <span role="status">{message}</span>}
        {error && <span className="login-error" role="alert">{error}</span>}
      </div>
      <p className="chaingpt-admin-disclosure">
        Resend and Telegram credentials are environment variables, never stored or displayed here. A channel that is on
        without its credentials says which variable is missing; the other channels keep working.
      </p>
    </form>
  );
}
