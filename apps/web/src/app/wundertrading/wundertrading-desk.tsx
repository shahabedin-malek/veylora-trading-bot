"use client";

import { LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { WunderTradingFeatureSettings } from "@/lib/wundertrading/features";

type ReadView = "profiles" | "live" | "history";
type Credential = { id: string; label: string; venue: string };
type ReadOption = { id: ReadView; label: string; setting: keyof WunderTradingFeatureSettings };

const READ_OPTIONS: readonly ReadOption[] = [
  { id: "profiles", label: "API profiles", setting: "apiProfilesEnabled" },
  { id: "live", label: "Live strategies", setting: "liveStrategiesEnabled" },
  { id: "history", label: "Strategy history", setting: "strategyHistoryEnabled" },
];

function responseError(result: unknown, fallback: string) {
  return new Error(
    result && typeof result === "object" && "error" in result && typeof result.error === "string"
      ? result.error
      : fallback,
  );
}

export function WunderTradingDesk({ settings }: { settings: WunderTradingFeatureSettings | null }) {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [credentialId, setCredentialId] = useState("");
  const [view, setView] = useState<ReadView>("profiles");
  const [data, setData] = useState<unknown>(null);
  const [loadingCredentials, setLoadingCredentials] = useState(true);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/trading/credentials", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        const result: unknown = await response.json().catch(() => null);
        if (!response.ok) throw responseError(result, "WunderTrading credentials could not be loaded.");
        if (!result || typeof result !== "object" || !("credentials" in result) || !Array.isArray(result.credentials)) {
          throw new Error("WunderTrading credentials returned an invalid response.");
        }
        const credentialResult = result as { credentials: Credential[] };
        const wunderCredentials = credentialResult.credentials.filter((credential) => credential.venue === "wundertrading");
        if (active) {
          setCredentials(wunderCredentials);
          setCredentialId(wunderCredentials[0]?.id ?? "");
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "WunderTrading credentials could not be loaded.");
      })
      .finally(() => {
        if (active) setLoadingCredentials(false);
      });
    return () => { active = false; };
  }, []);

  const selectedOption = READ_OPTIONS.find((option) => option.id === view)
    ?? { id: "profiles", label: "API profiles", setting: "apiProfilesEnabled" };

  function selectView(nextView: ReadView) {
    setView(nextView);
    setData(null);
    setError(null);
  }

  function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, currentView: ReadView) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const currentIndex = READ_OPTIONS.findIndex((option) => option.id === currentView);
    const offset = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (currentIndex + offset + READ_OPTIONS.length) % READ_OPTIONS.length;
    const nextOption = READ_OPTIONS[nextIndex];
    if (!nextOption) return;
    selectView(nextOption.id);
    document.getElementById(`wundertrading-tab-${nextOption.id}`)?.focus();
  }

  async function loadData() {
    if (!settings?.[selectedOption.setting] || !credentialId) return;
    setLoadingData(true);
    setError(null);
    setData(null);
    try {
      const query = new URLSearchParams({ view, credentialId });
      const response = await fetch(`/api/trading/wundertrading?${query}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) throw responseError(result, "WunderTrading data could not be read.");
      if (!result || typeof result !== "object" || !("data" in result)) {
        throw new Error("WunderTrading returned an invalid response.");
      }
      setData(result.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "WunderTrading data could not be read.");
    } finally {
      setLoadingData(false);
    }
  }

  return (
    <div className="wundertrading-desk">
      <div className="wundertrading-read-toolbar">
        <label className="trading-field" htmlFor="wundertrading-account">
          <span>YOUR WUNDERTRADING KEY</span>
          <select
            id="wundertrading-account"
            value={credentialId}
            onChange={(event) => {
              setCredentialId(event.target.value);
              setData(null);
            }}
            disabled={loadingCredentials || credentials.length === 0}
          >
            {credentials.length === 0 ? <option value="">No key connected</option> : credentials.map((credential) => (
              <option key={credential.id} value={credential.id}>{credential.label}</option>
            ))}
          </select>
        </label>
        <nav className="wundertrading-tabs" aria-label="WunderTrading read views" role="tablist">
          {READ_OPTIONS.map((option) => (
            <button
              aria-selected={view === option.id}
              className={view === option.id ? "is-selected" : undefined}
              aria-controls="wundertrading-read-panel"
              id={`wundertrading-tab-${option.id}`}
              key={option.id}
              onClick={() => selectView(option.id)}
              onKeyDown={(event) => handleTabKeyDown(event, option.id)}
              role="tab"
              type="button"
            >
              {option.label}
            </button>
          ))}
        </nav>
        <button
          className="section-action"
          disabled={!settings?.[selectedOption.setting] || !credentialId || loadingData}
          onClick={() => void loadData()}
          type="button"
        >
          {loadingData ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : <RefreshCw aria-hidden="true" size={13} />}
          {loadingData ? "READING" : `LOAD ${selectedOption.label.toUpperCase()}`}
        </button>
      </div>

      <div id="wundertrading-read-panel" role="tabpanel" aria-labelledby={`wundertrading-tab-${view}`}>
        {!settings ? (
          <div className="market-chart-empty" role="status"><strong>Feature settings unavailable</strong><span>The settings row did not load, so the switches for these reads are unknown.</span></div>
        ) : !settings[selectedOption.setting] ? (
          <div className="market-chart-empty" role="status"><strong>{selectedOption.label} switched off</strong><span>Off in Access &amp; Integrations → WunderTrading feature switches. Turn it on there and this read becomes available.</span></div>
        ) : loadingCredentials ? (
          <div className="market-chart-empty" role="status"><strong>Loading your keys</strong></div>
        ) : credentials.length === 0 ? (
          <div className="market-chart-empty" role="status"><strong>No WunderTrading key connected</strong><span>Add your own key above. Start with profile and strategy read permissions only.</span></div>
        ) : error ? (
          <div className="market-chart-empty" role="alert"><strong>Read failed</strong><span>{error}</span></div>
        ) : data === null ? (
          <div className="market-chart-empty" role="status"><strong>Ready to read {selectedOption.label.toLowerCase()}</strong><span>No provider request is made until you press the load button.</span></div>
        ) : (
          <pre className="wundertrading-response" aria-label={`${selectedOption.label} response`}>{JSON.stringify(data, null, 2)}</pre>
        )}
      </div>

      <div className="wundertrading-order-status" aria-label="Trading action status">
        <div><strong>MARKET ENTER</strong><span>{settings?.openTradesEnabled ? "SWITCH ON · NO ORDER CALL" : "OFF IN ADMIN"}</span></div>
        <div><strong>MARKET CLOSE</strong><span>{settings?.closeTradesEnabled ? "SWITCH ON · NO ORDER CALL" : "OFF IN ADMIN"}</span></div>
        <p>These switches control the reads on this page. Veylora has no order or withdrawal call to WunderTrading, so no switch here can move funds.</p>
      </div>
    </div>
  );
}