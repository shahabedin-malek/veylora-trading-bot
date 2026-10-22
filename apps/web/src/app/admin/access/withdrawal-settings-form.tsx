"use client";

import { LoaderCircle, Save } from "lucide-react";
import { useState, type FormEvent } from "react";
import { MAX_NEW_ADDRESS_WINDOW_MINUTES } from "@/lib/withdrawals/limits";
import type { WithdrawalSettingsView } from "@/lib/withdrawals/settings";

export function WithdrawalSettingsForm({ initialSettings }: { initialSettings: WithdrawalSettingsView | null }) {
  const [settings, setSettings] = useState(initialSettings);
  const [minutes, setMinutes] = useState(initialSettings ? String(initialSettings.newAddressWindowMinutes) : "60");
  const [saving, setSaving] = useState(false);
  const [paused, setPaused] = useState(initialSettings?.paused ?? false);
  const [togglingPause, setTogglingPause] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pauseMessage, setPauseMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function togglePause() {
    setTogglingPause(true);
    setPauseMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/admin/withdrawals/pause", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: !paused }),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok || !result || typeof result !== "object") {
        const reason = result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error
          : "The switch could not be saved.";
        throw new Error(reason);
      }
      const saved = result as WithdrawalSettingsView;
      setPaused(saved.paused);
      setPauseMessage(
        saved.paused
          ? "Paused and audited. New withdrawal requests are refused and no reserved withdrawal is sent."
          : "Resumed and audited. Withdrawals are accepted again under the rules below.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The switch could not be saved.");
    } finally {
      setTogglingPause(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const parsed = Number(minutes.trim());
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error("Enter a whole number of minutes, 0 or more.");
      }
      const response = await fetch("/api/admin/withdrawals", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newAddressWindowMinutes: parsed }),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok || !result || typeof result !== "object") {
        const reason = result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error
          : "The withdrawal window could not be saved.";
        throw new Error(reason);
      }
      const saved = result as WithdrawalSettingsView;
      setSettings(saved);
      setPaused(saved.paused);
      setMinutes(String(saved.newAddressWindowMinutes));
      setMessage(
        saved.newAddressWindowMinutes === 0
          ? "Saved and audited. No first withdrawal is held."
          : `Saved and audited. A first withdrawal to a new address waits ${saved.newAddressWindowMinutes} minute${saved.newAddressWindowMinutes === 1 ? "" : "s"}.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The withdrawal window could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return (
      <div className="market-chart-empty" role="status">
        <strong>Settings storage unavailable</strong>
        <span>Apply the database migration before managing the withdrawal window.</span>
      </div>
    );
  }

  return (
    <>
      <div className={`chaingpt-admin-form${paused ? " is-paused" : ""}`} role="group" aria-label="Withdrawals pause switch">
        <div className="chaingpt-admin-copy">
          <span>
            <strong>{paused ? "WITHDRAWALS PAUSED" : "WITHDRAWALS RUNNING"}</strong>
            <small>
              {paused
                ? "Every new withdrawal request is refused and reserved withdrawals are not sent. Transfers already on chain are still confirmed and settled."
                : "New requests are accepted and reserved withdrawals are sent once their hold ends."}
              {settings.pausedChangedAt ? ` Last changed ${settings.pausedChangedAt}.` : ""}
            </small>
          </span>
        </div>
        <div className="chaingpt-admin-actions">
          <button
            className="section-action"
            disabled={togglingPause}
            onClick={togglePause}
            type="button"
          >
            {togglingPause ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : null}
            {togglingPause ? "SAVING" : paused ? "RESUME WITHDRAWALS" : "PAUSE WITHDRAWALS"}
          </button>
          {pauseMessage && <span role="status">{pauseMessage}</span>}
        </div>
      </div>

      <form className="chaingpt-admin-form" onSubmit={save}>
        <div className="chaingpt-admin-copy">
          <label htmlFor="withdrawal-new-address-window">
            <span>New-address window, in minutes</span>
            <small>
              How long a first withdrawal to an address this account has never used is held before it is queued. Zero holds
              nothing, which is a complete answer; the longest this build stores is {MAX_NEW_ADDRESS_WINDOW_MINUTES} minutes.
            </small>
          </label>
        </div>
        <input
          id="withdrawal-new-address-window"
          inputMode="numeric"
          min={0}
          step={1}
          type="number"
          value={minutes}
          onChange={(event) => setMinutes(event.target.value)}
        />
        <div className="chaingpt-admin-actions">
          <button className="section-action" disabled={saving} type="submit">
            {saving ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : <Save aria-hidden="true" size={14} />}
            {saving ? "SAVING" : "SAVE WITHDRAWAL WINDOW"}
          </button>
          {message && <span role="status">{message}</span>}
          {error && <span className="login-error" role="alert">{error}</span>}
        </div>
      </form>
      <dl className="market-source-details">
        <div>
          <dt>Window in force<small>what the withdrawal panel applies right now</small></dt>
          <dd>
            {settings.newAddressWindowMinutes} minute{settings.newAddressWindowMinutes === 1 ? "" : "s"}
            {settings.newAddressWindowMinutes === 0 ? " (nothing is held)" : ""}
          </dd>
        </div>
        <div>
          <dt>Where it comes from<small>a saved setting always beats the deployment&rsquo;s environment</small></dt>
          <dd>
            {settings.source === "owner-setting"
              ? `Saved here${settings.updatedAt ? ` · ${settings.updatedAt}` : ""}`
              : `Deployment default (${settings.deploymentDefaultMinutes} minutes) — no row has been saved yet`}
          </dd>
        </div>
      </dl>
      <p className="chaingpt-admin-disclosure">
        The window above applies to a first send to an unseen address and nothing else. There is no approval step in front of a
        withdrawal you ask for. The one control that stops outbound money is the pause switch: it refuses new requests and stops
        reserved withdrawals being sent, and it never reviews an individual request. Every change is written to the audit trail.
      </p>
    </>
  );
}
