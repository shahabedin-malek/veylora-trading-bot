"use client";

import { KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { isStepUpCancelled, useStepUp } from "@/components/step-up-prompt";
import {
  CAPABILITY_LABELS,
  PERMISSION_LABELS,
  VENUE_CAPABILITIES,
  VENUE_CUSTODY_STATEMENT,
  VENUE_IDS,
  VENUE_LABELS,
  type ConnectionHealth,
  type VenueCapability,
  type VenueHealthCheck,
  type VenueId,
  type VenuePermission,
} from "@/lib/venues/types";

type Credential = {
  id: string;
  venue: VenueId;
  label: string;
  /**
   * The scope the key was stored with. A read-only key is refused for trading by
   * name, and it is what the account page's import path reads with, so the list says
   * which one each key is rather than leaving the owner to remember.
   */
  readOnly: boolean;
  /** What this connection can be asked to do, from the server's own descriptor. */
  capabilities: VenueCapability[];
  /** Whether the venue answers a question about the key's permissions at all. */
  permissionReport: "venue" | "none";
  requestedPermissions: VenuePermission[];
  /** Null means the venue does not report permissions — not that there are none. */
  reportedPermissions: VenuePermission[] | null;
  verifiedAt?: string | null;
  health: ConnectionHealth;
  createdAt: string;
  /** Development only: last four of the key fingerprint, sent by the API in dev. */
  fingerprintLastFour?: string;
};
type VerifyResult = { health: VenueHealthCheck; note: string };

function displayDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.toISOString().slice(0, 16).replace("T", " ")} UTC` : null;
}

function capabilitiesSentence(capabilities: readonly VenueCapability[]) {
  return capabilities.map((capability) => CAPABILITY_LABELS[capability]).join(" · ");
}

/**
 * The venue keys this account can read and trade with, and what each one can do.
 *
 * Phase 20 made this panel a *view of the connection record* rather than a list of
 * names: every row states the capabilities the server will enforce, the permissions
 * that were requested, the permissions the venue itself reported (or says nothing
 * about), and when the connection was last checked and how long the venue took to
 * answer. Nothing here is inferred from the venue's name — the capabilities come from
 * the same descriptor the adapters enforce — so a new venue appears with the right
 * chips without this file changing.
 *
 * The panel also carries the one sentence the phase insists on in plain words:
 * {@link VENUE_CUSTODY_STATEMENT}. Funds stay at the venue; this product holds nothing
 * and can withdraw nothing.
 *
 * Saving, verifying and revoking a key all go through the shared step-up prompt,
 * because all three are funding-scope actions: a code is asked for before a key is
 * stored, before it is used to read a balance, and before it is removed — and only
 * when the owner has switched that scope on.
 */
export function TradingAccounts({ allowedVenues }: { allowedVenues?: readonly VenueId[] }) {
  const stepUp = useStepUp();
  const visibleVenues = allowedVenues ? VENUE_IDS.filter((id) => allowedVenues.includes(id)) : VENUE_IDS;
  const [venue, setVenue] = useState<VenueId>(allowedVenues?.[0] ?? "coinbase-advanced");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  // Read-only first: a new connection starts as the safest one it can be, and the
  // owner has to say explicitly that they want a key that can trade.
  const [readOnly, setReadOnly] = useState(true);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [checks, setChecks] = useState<Record<string, VerifyResult>>({});
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
      const response = await stepUp.send("/api/trading/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venue, label: label || undefined, apiKey, apiSecret, readOnly }),
      });
      const result = await response.json() as { credential?: Credential; error?: string };
      if (!response.ok || !result.credential) throw new Error(result.error ?? "Credential could not be saved.");
      const credential = result.credential;
      setCredentials((current) => [credential, ...current]);
      setApiKey("");
      setApiSecret("");
      setLabel("");
      setNotice("Key encrypted and saved. Checking the connection.");
      await verifyAccount(credential.id, venue);
    } catch (reason) {
      setError(
        isStepUpCancelled(reason)
          ? "No code was given, so the key was not saved and nothing was stored."
          : reason instanceof Error ? reason.message : "Credential could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function verifyAccount(credentialId: string, venueOverride?: VenueId) {
    const selectedVenue = credentials.find((credential) => credential.id === credentialId)?.venue ?? venueOverride;
    setBusyId(credentialId);
    setNotice("");
    setError("");
    try {
      const response = await stepUp.send(`/api/trading/credentials/${encodeURIComponent(credentialId)}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        cache: "no-store",
      });
      const result = await response.json() as VerifyResult & { error?: string };
      if (!response.ok || !result.health) throw new Error(result.error ?? "The venue check failed.");
      setChecks((current) => ({ ...current, [credentialId]: result }));
      setCredentials((current) =>
        current.map((item) =>
          item.id === credentialId
            ? {
                ...item,
                verifiedAt: result.health.ok ? result.health.checkedAt : item.verifiedAt,
                health: result.health.ok
                  ? { state: "HEALTHY", checkedAt: result.health.checkedAt, latencyMs: result.health.latencyMs }
                  : {
                      state: "FAILING",
                      checkedAt: result.health.checkedAt,
                      latencyMs: result.health.latencyMs,
                      error: result.health.error ?? "The venue did not answer.",
                    },
                reportedPermissions: result.health.permissions ?? item.reportedPermissions,
              }
            : item,
        ),
      );
      // A failed check is a result, not a broken page: the venue's own sentence is the
      // notice, so the owner reads the same text the row now carries.
      setNotice(
        result.health.ok
          ? `${result.health.evidence}. ${selectedVenue ? VENUE_LABELS[selectedVenue] : "The venue"} answered in ${result.health.latencyMs} ms.`
          : `The check failed and was recorded: ${result.health.error ?? "the venue did not answer"}`,
      );
    } catch (reason) {
      setError(
        isStepUpCancelled(reason)
          ? "No code was given, so the venue was not contacted."
          : reason instanceof Error ? reason.message : "The venue check failed.",
      );
    } finally {
      setBusyId(null);
    }
  }

  async function revokeAccount(credentialId: string) {
    setBusyId(credentialId);
    setNotice("");
    setError("");
    try {
      const response = await stepUp.send("/api/trading/credentials", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentialId }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Credential revocation failed.");
      setCredentials((current) => current.filter((item) => item.id !== credentialId));
      setChecks((current) => {
        const next = { ...current };
        delete next[credentialId];
        return next;
      });
      setNotice("Account key revoked. It cannot be used by any part of the platform from now on.");
    } catch (reason) {
      setError(
        isStepUpCancelled(reason)
          ? "No code was given, so the key is still connected."
          : reason instanceof Error ? reason.message : "Credential revocation failed.",
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="trading-account-grid">
      {stepUp.prompt}
      <form className="trading-credential-form" onSubmit={connectAccount}>
        <div className="section-kicker">CONNECT VENUE</div>
        <label className="trading-field">
          <span>Venue</span>
          <select value={venue} onChange={(event) => setVenue(event.target.value as VenueId)}>
            {visibleVenues.map((id) => <option key={id} value={id}>{VENUE_LABELS[id]}</option>)}
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
        <div className="trading-field trading-field--scope">
          <span>Key scope</span>
          <span className="trading-scope-choice">
            <input
              checked={readOnly}
              id="trading-credential-read-only"
              onChange={(event) => setReadOnly(event.target.checked)}
              type="checkbox"
            />
            <label htmlFor="trading-credential-read-only">
              Read-only — balances and history only. This key can never place an order or cancel one, and the account
              page can import with it.
            </label>
          </span>
        </div>
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
        <p className="trading-security-note">
          Requested permission: <strong>{readOnly ? "read" : "read, trade"}</strong>. Withdrawal permission is never
          requested or stored, so a key carrying it is refused here with the reason.{" "}
          {venue === "wundertrading"
            ? "Veylora sends a WunderTrading key to its read endpoints and nowhere else; it is encrypted before storage and never displayed again."
            : "Veylora stores the key encrypted and calls read endpoints; the key is not returned to the browser after saving."}
        </p>
        <button className="trading-command" disabled={saving} type="submit">
          <KeyRound aria-hidden="true" size={14} />
          {saving ? "SAVING ENCRYPTED KEY" : "SAVE ENCRYPTED KEY"}
        </button>
        {error && <p className="trading-feedback trading-feedback--error" role="alert">{error}</p>}
        {notice && <p className="trading-feedback" role="status">{notice}</p>}
      </form>

      <div className="trading-connected-list" aria-live="polite">
        <div className="section-kicker">CONNECTED ACCOUNTS</div>
        <p className="trading-custody-statement">{VENUE_CUSTODY_STATEMENT}</p>
        {loading ? (
          <p className="trading-empty">Loading connected accounts…</p>
        ) : credentials.length === 0 ? (
          <p className="trading-empty">No exchange accounts connected.</p>
        ) : credentials.map((credential) => {
          const result = checks[credential.id];
          const busy = busyId === credential.id;
          // `place` is reported by the order section, not here: it is a capability of this
          // build's order path (phase 21 gives it to the testnet only), so listing it as a
          // gap on every live key would describe the phase rather than the connection.
          const missing = VENUE_CAPABILITIES.filter(
            (capability) => capability !== "place" && !credential.capabilities.includes(capability),
          );
          return (
            <section className="trading-account-row" key={credential.id}>
              <div className="trading-account-row__heading">
                <div>
                  <strong>{credential.label}</strong>
                  <span>{VENUE_LABELS[credential.venue] ?? credential.venue}</span>
                  <span className={`trading-scope-badge${credential.readOnly ? " trading-scope-badge--read-only" : ""}`}>
                    {credential.readOnly ? "READ-ONLY KEY · CANNOT PLACE OR CANCEL AN ORDER" : "TRADE-CAPABLE KEY"}
                  </span>
                  {credential.fingerprintLastFour && (
                    <span className="trading-account-row__fingerprint">
                      KEY FINGERPRINT · LAST FOUR {credential.fingerprintLastFour}
                    </span>
                  )}
                </div>
                <span className={`trading-health trading-health--${credential.health.state.toLowerCase()}`}>
                  {credential.health.state === "UNCHECKED"
                    ? "NOT CHECKED YET"
                    : `${credential.health.state}${credential.health.latencyMs === null ? "" : ` · ${credential.health.latencyMs} ms`}`}
                </span>
              </div>

              <ul className="trading-capability-list">
                <li className="trading-capability">
                  CAN · {capabilitiesSentence(credential.capabilities)}
                </li>
                {missing.length > 0 && (
                  <li className="trading-capability trading-capability--absent">
                    CANNOT · {capabilitiesSentence(missing)}
                  </li>
                )}
              </ul>

              <div className="trading-account-row__meta">
                REQUESTED · {credential.requestedPermissions.length > 0
                  ? credential.requestedPermissions.map((permission) => PERMISSION_LABELS[permission]).join(", ")
                  : "not recorded"}
                {" — "}
                {credential.reportedPermissions === null
                  ? `VENUE-REPORTED · ${credential.permissionReport === "venue" ? "not answered by this venue" : "this venue does not report key permissions"}`
                  : `VENUE-REPORTED · ${credential.reportedPermissions.length > 0
                      ? credential.reportedPermissions.map((permission) => PERMISSION_LABELS[permission]).join(", ")
                      : "no permissions"}`}
              </div>

              <div className="trading-account-row__meta">
                LAST CHECK · {displayDate(credential.health.state === "UNCHECKED" ? null : credential.health.checkedAt) ?? "never"}
                {credential.health.state === "FAILING" && ` · FAILED · ${credential.health.error}`}
              </div>

              {result && (
                <>
                  {result.health.balances && result.health.balances.length > 0 ? (
                    <ul className="trading-balance-list">
                      {result.health.balances.map((balance) => (
                        <li key={balance.asset}>
                          <strong>{balance.asset}</strong>
                          <span>{balance.available} available</span>
                          <span>{balance.total} total</span>
                        </li>
                      ))}
                    </ul>
                  ) : result.health.items && result.health.items.length > 0 ? (
                    <ul className="trading-balance-list">
                      {result.health.items.map((item, index) => (
                        <li key={`${credential.id}-item-${index}`}>
                          <strong>{item.title}</strong>
                          <span>{item.detail || "WunderTrading profile"}</span>
                          <span>{result.health.evidence}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="trading-empty">{result.health.evidence}</p>
                  )}
                  <p className="trading-empty">{result.note}</p>
                </>
              )}

              <div className="trading-account-row__actions">
                <button className="trading-icon-command" disabled={busy} onClick={() => void verifyAccount(credential.id)} type="button">
                  <RefreshCw aria-hidden="true" size={13} /> {busy ? "CHECKING" : "CHECK CONNECTION"}
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
