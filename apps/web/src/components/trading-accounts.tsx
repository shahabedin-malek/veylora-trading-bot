"use client";

import { KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

type Venue = "binance" | "coinbase-advanced" | "kraken" | "wundertrading";
type Credential = {
  id: string;
  venue: Venue;
  label: string;
  verifiedAt?: string | null;
  createdAt: string;
};
type Balance = { asset: string; available: string; total: string };
type VerifyResult = { verifiedAt: string; balances?: Balance[]; profiles?: unknown[]; note: string };

const VENUES: { id: Venue; label: string }[] = [
  { id: "coinbase-advanced", label: "Coinbase Advanced" },
  { id: "kraken", label: "Kraken" },
  { id: "binance", label: "Binance" },
  { id: "wundertrading", label: "WunderTrading" },
];

function summarizeProfile(value: unknown, index: number) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { title: `Profile ${index + 1}`, exchange: "", status: "" };
  }
  const profile = value as Record<string, unknown>;
  const text = (key: string) => typeof profile[key] === "string" ? profile[key] as string : "";
  const title = text("name") || text("label") || text("exchange") || text("exchangeCode") || text("code") || text("id") || `Profile ${index + 1}`;
  const exchange = text("exchangeCode") || text("exchange") || text("exchangeFamily");
  const status = text("status");
  return { title, exchange, status };
}

function displayDate(value: string | null | undefined) {
  if (!value) return "Not verified";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.toISOString().slice(0, 16).replace("T", " ")} UTC` : "Not verified";
}

export function TradingAccounts({ allowedVenues }: { allowedVenues?: readonly Venue[] }) {
  const visibleVenues = allowedVenues ? VENUES.filter(({ id }) => allowedVenues.includes(id)) : VENUES;
  const [venue, setVenue] = useState<Venue>(allowedVenues?.[0] ?? "coinbase-advanced");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [balances, setBalances] = useState<Record<string, VerifyResult>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/trading/credentials", { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json() as { credentials?: Credential[]; error?: string };
        if (!response.ok) throw new Error(result.error ?? "Credentials could not be loaded.");
        if (active) setCredentials(result.credentials ?? []);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Credentials could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  async function connectAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setNotice("");
    setError("");
    try {
      const response = await fetch("/api/trading/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venue, label: label || undefined, apiKey, apiSecret }),
      });
      const result = await response.json() as { credential?: Credential; error?: string };
      if (!response.ok || !result.credential) throw new Error(result.error ?? "Credential could not be saved.");
      const credential = result.credential;
      setCredentials((current) => [credential, ...current]);
      setApiKey("");
      setApiSecret("");
      setLabel("");
      setNotice("Key encrypted and saved. Checking balance access.");
      await verifyAccount(credential.id, venue);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Credential could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function verifyAccount(credentialId: string, venueOverride?: Venue) {
    const selectedVenue = credentials.find((credential) => credential.id === credentialId)?.venue ?? venueOverride;
    setBusyId(credentialId);
    setNotice("");
    setError("");
    try {
      const response = await fetch(`/api/trading/credentials/${encodeURIComponent(credentialId)}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        cache: "no-store",
      });
      const result = await response.json() as VerifyResult & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Balance verification failed.");
      setBalances((current) => ({ ...current, [credentialId]: result }));
      setCredentials((current) => current.map((item) => item.id === credentialId ? { ...item, verifiedAt: result.verifiedAt } : item));
      setNotice(selectedVenue === "wundertrading"
        ? "WunderTrading profiles read successfully through its read endpoint."
        : "Balance read succeeded.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Balance verification failed.");
    } finally {
      setBusyId(null);
    }
  }

  async function revokeAccount(credentialId: string) {
    setBusyId(credentialId);
    setNotice("");
    setError("");
    try {
      const response = await fetch("/api/trading/credentials", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentialId }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Credential revocation failed.");
      setCredentials((current) => current.filter((item) => item.id !== credentialId));
      setBalances((current) => {
        const next = { ...current };
        delete next[credentialId];
        return next;
      });
      setNotice("Account key revoked.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Credential revocation failed.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="trading-account-grid">
      <form className="trading-credential-form" onSubmit={connectAccount}>
        <div className="section-kicker">CONNECT VENUE</div>
        <label className="trading-field">
          <span>Venue</span>
          <select value={venue} onChange={(event) => setVenue(event.target.value as Venue)}>
            {visibleVenues.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <label className="trading-field">
          <span>Account label</span>
          <input autoComplete="off" maxLength={64} onChange={(event) => setLabel(event.target.value)} value={label} />
        </label>
        <label className="trading-field">
          <span>API key</span>
          <input autoComplete="off" onChange={(event) => setApiKey(event.target.value)} required value={apiKey} />
        </label>
        <label className="trading-field">
          <span>{venue === "coinbase-advanced" ? "CDP private key (PEM)" : venue === "wundertrading" ? "WunderTrading secret key" : "API secret"}</span>
          <textarea
            autoComplete="new-password"
            onChange={(event) => setApiSecret(event.target.value)}
            required
            rows={venue === "coinbase-advanced" ? 5 : 3}
            value={apiSecret}
          />
        </label>
        {venue === "wundertrading" ? (
          <p className="trading-security-note">Enter a key for your own account only. Veylora sends it to WunderTrading’s <code>api_profile:read</code> and <code>strategy:read</code> endpoints and nowhere else; it is encrypted before storage and never displayed again.</p>
        ) : (
          <p className="trading-security-note">Enter a key for your own account only. Veylora stores it encrypted and calls balance-read endpoints; the key is not returned to the browser after saving. This is not a CDP Onramp application key.</p>
        )}
        <button className="trading-command" disabled={saving} type="submit">
          <KeyRound aria-hidden="true" size={14} />
          {saving ? "SAVING ENCRYPTED KEY" : "SAVE ENCRYPTED KEY"}
        </button>
        {error && <p className="trading-feedback trading-feedback--error" role="alert">{error}</p>}
        {notice && <p className="trading-feedback" role="status">{notice}</p>}
      </form>

      <div className="trading-connected-list" aria-live="polite">
        <div className="section-kicker">CONNECTED ACCOUNTS</div>
        {loading ? (
          <p className="trading-empty">Loading connected accounts…</p>
        ) : credentials.length === 0 ? (
          <p className="trading-empty">No exchange accounts connected.</p>
        ) : credentials.map((credential) => {
          const result = balances[credential.id];
          const busy = busyId === credential.id;
          return (
            <section className="trading-account-row" key={credential.id}>
              <div className="trading-account-row__heading">
                <div>
                  <strong>{credential.label}</strong>
                  <span>{VENUES.find((item) => item.id === credential.venue)?.label ?? credential.venue}</span>
                </div>
              </div>
              <div className="trading-account-row__meta">BALANCE CHECK · {displayDate(credential.verifiedAt)}</div>
              {result && (
                result.profiles ? (
                  result.profiles.length > 0 ? (
                    <ul className="trading-balance-list">
                      {result.profiles.map((profile, index) => {
                        const summary = summarizeProfile(profile, index);
                        return (
                          <li key={`${credential.id}-profile-${index}`}>
                            <strong>{summary.title}</strong>
                            <span>{summary.exchange || "WunderTrading profile"}</span>
                            <span>{summary.status}</span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : <p className="trading-empty">No connected WunderTrading API profiles were returned.</p>
                ) : (result.balances?.length ?? 0) > 0 ? (
                  <ul className="trading-balance-list">
                    {result.balances?.map((balance) => (
                      <li key={balance.asset}>
                        <strong>{balance.asset}</strong>
                        <span>{balance.available} available</span>
                        <span>{balance.total} total</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="trading-empty">Balance access verified; no non-zero spot balances returned.</p>
              )}
              <div className="trading-account-row__actions">
                <button className="trading-icon-command" disabled={busy} onClick={() => void verifyAccount(credential.id)} type="button">
                  <RefreshCw aria-hidden="true" size={13} /> {busy ? "CHECKING" : credential.venue === "wundertrading" ? "READ API PROFILES" : "VERIFY BALANCES"}
                </button>
                <button className="trading-icon-command trading-icon-command--danger" disabled={busy} onClick={() => void revokeAccount(credential.id)} type="button">
                  <Trash2 aria-hidden="true" size={13} /> REVOKE
                </button>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}