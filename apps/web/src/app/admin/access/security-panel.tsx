"use client";

import { KeyRound, LoaderCircle, LogOut, RefreshCw, Save, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

/**
 * The owner's own account security, in one panel.
 *
 * Three things live here because they are three answers to the same question —
 * what stands between someone else and this account:
 *
 *   1. the authenticator: enrol, activate with a code, keep the backup codes;
 *   2. the policy: which scope demands a code, how long a verification lasts and
 *      how many wrong codes are tolerated before the lock;
 *   3. the sessions: which devices are signed in, and which to end.
 *
 * Two deliberate choices in how it reads. A scope that is switched on with no
 * activated authenticator is shown as *not enforced yet*, with the sentence that
 * says what to do about it — because a switch that looks armed and is not is worse
 * than an unarmed one. And the panel never shows a code or a secret twice: the
 * secret appears once under the QR, the backup codes appear once under a warning,
 * and returning to the panel shows only how many are left.
 */

type SecurityPolicy = {
  requireTotpForSignIn: boolean;
  requireTotpForTrading: boolean;
  requireTotpForFunding: boolean;
  stepUpMinutes: number;
  maxFailedAttempts: number;
  lockoutMinutes: number;
};

type ScopeState = { scope: "sign-in" | "trading" | "funding"; required: boolean; note: string | null };

type PolicyPayload = { policy: SecurityPolicy; persisted: boolean; enrolled: boolean; scopes: ScopeState[] };

type AuthenticatorPayload = {
  enrolled: boolean;
  pending: boolean;
  credential: { label: string; createdAt: string; activatedAt: string | null; failedAttempts: number; lockedUntil: string | null } | null;
  backupCodesRemaining: number;
};

type SessionRow = {
  id: string;
  deviceLabel: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  status: "ACTIVE" | "REVOKED" | "EXPIRED";
  isCurrent: boolean;
};

type EnrolmentOffer = {
  secret: string;
  otpauthUri: string;
  label: string;
  digits: number;
  periodSeconds: number;
  note: string;
};

const SCOPE_LABELS: Record<ScopeState["scope"], string> = {
  "sign-in": "Sign-in",
  trading: "Trading",
  funding: "Funding",
};

const SCOPE_FIELD: Record<ScopeState["scope"], keyof SecurityPolicy> = {
  "sign-in": "requireTotpForSignIn",
  trading: "requireTotpForTrading",
  funding: "requireTotpForFunding",
};

function asMessage(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "error" in value && typeof (value as { error: unknown }).error === "string") {
    return (value as { error: string }).error;
  }
  return fallback;
}

function shortMoment(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.toISOString().slice(0, 16).replace("T", " ")} UTC` : "unknown";
}

/** One read of the three things this panel shows, with the refusals named. */
async function readAccountSecurity(): Promise<{
  policy: PolicyPayload;
  authenticator: AuthenticatorPayload;
  sessions: SessionRow[];
}> {
  const [policyResponse, authenticatorResponse, sessionsResponse] = await Promise.all([
    fetch("/api/admin/security-policy", { cache: "no-store" }),
    fetch("/api/auth/totp", { cache: "no-store" }),
    fetch("/api/auth/sessions", { cache: "no-store" }),
  ]);
  const policyResult = (await policyResponse.json()) as PolicyPayload & { error?: string };
  const authenticatorResult = (await authenticatorResponse.json()) as AuthenticatorPayload & { error?: string };
  const sessionsResult = (await sessionsResponse.json()) as { sessions?: SessionRow[]; error?: string };
  if (!policyResponse.ok) throw new Error(policyResult.error ?? "Security policy could not be read.");
  if (!authenticatorResponse.ok) throw new Error(authenticatorResult.error ?? "Authenticator state could not be read.");
  if (!sessionsResponse.ok) throw new Error(sessionsResult.error ?? "Sessions could not be read.");
  return { policy: policyResult, authenticator: authenticatorResult, sessions: sessionsResult.sessions ?? [] };
}

export function SecurityPanel() {
  const [policyPayload, setPolicyPayload] = useState<PolicyPayload | null>(null);
  const [authenticator, setAuthenticator] = useState<AuthenticatorPayload | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [offer, setOffer] = useState<EnrolmentOffer | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [activationCode, setActivationCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [policyDraft, setPolicyDraft] = useState<SecurityPolicy | null>(null);
  const [busy, setBusy] = useState<null | "enrol" | "activate" | "disable" | "policy" | "sessions" | "revoke">(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const apply = useCallback((snapshot: Awaited<ReturnType<typeof readAccountSecurity>>) => {
    setPolicyPayload(snapshot.policy);
    setPolicyDraft(snapshot.policy.policy);
    setAuthenticator(snapshot.authenticator);
    setSessions(snapshot.sessions);
    // A re-read reflects *stored* state, and neither the enrolment secret nor the
    // backup codes are stored state: the secret is sealed the moment it is issued
    // and the codes exist only as digests. So any re-read — the refresh control,
    // or any other action — takes them off the screen. That is what "shown once"
    // means, and it is why the panel cannot be scrolled back to them later.
    setOffer(null);
    setBackupCodes(null);
    setError(null);
  }, []);

  /** Used after an action, where setting state is the point of the call. */
  const load = useCallback(async () => {
    try {
      apply(await readAccountSecurity());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Account security could not be read.");
    } finally {
      setLoading(false);
    }
  }, [apply]);

  // The first read resolves into state from a callback rather than from the effect
  // body, and it is guarded by `active` so a panel that unmounts mid-read cannot
  // set state on the way out.
  useEffect(() => {
    let active = true;
    void readAccountSecurity()
      .then((snapshot) => {
        if (active) apply(snapshot);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Account security could not be read.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [apply]);

  async function beginEnrolment(replace: boolean) {
    setBusy("enrol");
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/auth/totp", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replace }),
      });
      const result = (await response.json()) as EnrolmentOffer & { error?: string };
      if (!response.ok) throw new Error(asMessage(result, "Enrolment could not be started."));
      setBackupCodes(null);
      // The read is what clears one-time material, so the offer is set *after* it
      // rather than before: the secret is displayed from this response and from
      // nowhere else, not from anything the server will hand back again.
      await load();
      setOffer(result);
      setMessage("Scan the code, then activate with a code from the app. This secret is not shown again.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Enrolment could not be started.");
    } finally {
      setBusy(null);
    }
  }

  async function activate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("activate");
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/auth/totp/activate", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: activationCode }),
      });
      const result = (await response.json()) as { backupCodes?: string[]; note?: string; error?: string };
      if (!response.ok || !result.backupCodes) throw new Error(asMessage(result, "That code was not accepted."));
      const issued = result.backupCodes;
      setOffer(null);
      setActivationCode("");
      // Same rule as the offer: the read clears one-time material, so the codes are
      // set from this response *after* it. Their digests are all that is stored, so
      // no later read can produce them again.
      await load();
      setBackupCodes(issued);
      setMessage("Authenticator active. The backup codes below are shown once.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That code was not accepted.");
    } finally {
      setBusy(null);
    }
  }

  async function disable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("disable");
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/auth/totp", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: disableCode, reason: "Disabled from the security panel." }),
      });
      const result = (await response.json()) as { disabled?: boolean; error?: string };
      if (!response.ok) throw new Error(asMessage(result, "The authenticator could not be disabled."));
      setDisableCode("");
      setBackupCodes(null);
      setMessage("Authenticator disabled. Any scope that depended on it now says it is not enforced.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The authenticator could not be disabled.");
    } finally {
      setBusy(null);
    }
  }

  async function savePolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!policyDraft) return;
    setBusy("policy");
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/admin/security-policy", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy: policyDraft, reason: "Security policy edited in the admin panel." }),
      });
      const result = (await response.json()) as { policy?: SecurityPolicy; error?: string };
      if (!response.ok || !result.policy) throw new Error(asMessage(result, "Security policy could not be saved."));
      setMessage("Security policy saved and audited. Gated actions use it on their next request.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Security policy could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  async function revokeSession(sessionId: string) {
    setBusy("revoke");
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/auth/sessions", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revoke", sessionId, reason: "Ended from the session list." }),
      });
      const result = (await response.json()) as { deviceLabel?: string; error?: string };
      if (!response.ok) throw new Error(asMessage(result, "That session could not be revoked."));
      setMessage(`${result.deviceLabel ?? "That session"} is ended; its next request is refused.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That session could not be revoked.");
    } finally {
      setBusy(null);
    }
  }

  async function revokeOthers() {
    setBusy("sessions");
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/auth/sessions", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revoke-others", reason: "Every other session ended from the panel." }),
      });
      const result = (await response.json()) as { revoked?: number; error?: string };
      if (!response.ok) throw new Error(asMessage(result, "Other sessions could not be revoked."));
      setMessage(result.revoked
        ? `${result.revoked} other session${result.revoked === 1 ? "" : "s"} ended. This device stays signed in.`
        : "There were no other sessions to end.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Other sessions could not be revoked.");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="market-chart-empty" role="status">
        <strong>Reading account security</strong>
        <span>The authenticator, the policy and the session list are being fetched.</span>
      </div>
    );
  }

  const activeSessions = sessions.filter((session) => session.status === "ACTIVE");

  return (
    <div className="security-panel">
      {error && <p className="login-error" role="alert">{error}</p>}
      {message && <p className="security-panel-note" role="status">{message}</p>}

      <section className="security-block" aria-labelledby="security-authenticator-title">
        <div className="security-block-head">
          <h3 id="security-authenticator-title">Authenticator app</h3>
          <span className="section-state">
            {authenticator?.enrolled ? "ENROLLED" : offer ? "ENROLMENT OPEN" : "NOT ENROLLED"}
          </span>
        </div>

        {authenticator?.credential && (
          <dl className="market-source-details security-facts">
            <div><dt>Credential<small>{authenticator.credential.label}</small></dt><dd>{authenticator.credential.activatedAt ? "ACTIVE" : "PENDING"}</dd></div>
            <div><dt>Added<small>{shortMoment(authenticator.credential.createdAt)}</small></dt><dd>{authenticator.credential.activatedAt ? shortMoment(authenticator.credential.activatedAt) : "not activated"}</dd></div>
            <div><dt>Backup codes left<small>Each works once.</small></dt><dd>{authenticator.backupCodesRemaining} / 10</dd></div>
            <div>
              <dt>Wrong codes since the last accepted one<small>Then the account locks for the configured time.</small></dt>
              <dd>
                {authenticator.credential.lockedUntil
                  ? `LOCKED UNTIL ${shortMoment(authenticator.credential.lockedUntil)}`
                  : `${authenticator.credential.failedAttempts} counted`}
              </dd>
            </div>
          </dl>
        )}

        {offer && (
          <div className="security-enrolment">
            <QRCodeSVG value={offer.otpauthUri} size={164} level="M" marginSize={2} bgColor="#e5eeeb" fgColor="#0b1011" />
            <div className="security-enrolment-copy">
              <p>{offer.note}</p>
              <p className="security-secret">{offer.secret}</p>
              <p className="security-hint">Manual entry: {offer.digits} digits, {offer.periodSeconds}-second period. If you cannot scan, type the secret above into the app.</p>
              <form className="security-inline-form" onSubmit={activate}>
                <label className="risk-policy-field" htmlFor="totp-activation-code">
                  <span>CODE FROM THE APP</span>
                  <input
                    id="totp-activation-code"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    maxLength={8}
                    pattern="[0-9]*"
                    value={activationCode}
                    onChange={(event) => setActivationCode(event.target.value)}
                  />
                  <small>Six digits. Activation is what makes the authenticator count; until then it demands nothing.</small>
                </label>
                <button className="section-action" disabled={busy === "activate" || activationCode.length < 6} type="submit">
                  {busy === "activate" ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : <ShieldCheck aria-hidden="true" size={14} />}
                  {busy === "activate" ? "CHECKING" : "ACTIVATE"}
                </button>
              </form>
            </div>
          </div>
        )}

        {backupCodes && (
          <div className="security-backup-codes" role="status">
            <strong>Backup codes — shown once</strong>
            <ul>
              {backupCodes.map((code) => <li key={code}>{code}</li>)}
            </ul>
            <p>Each code works once, and they are stored only as digests: this list cannot be shown again. Keep them somewhere other than this device.</p>
          </div>
        )}

        <div className="risk-policy-actions">
          {!authenticator?.enrolled && !offer && (
            <button className="section-action" disabled={busy === "enrol"} onClick={() => void beginEnrolment(false)} type="button">
              {busy === "enrol" ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : <KeyRound aria-hidden="true" size={14} />}
              {busy === "enrol" ? "STARTING" : "BEGIN ENROLMENT"}
            </button>
          )}
          {authenticator?.enrolled && (
            <button className="section-action" disabled={busy === "enrol"} onClick={() => void beginEnrolment(true)} type="button">
              <RefreshCw aria-hidden="true" size={14} />
              REPLACE (NEEDS A FRESH SIGN-IN)
            </button>
          )}
        </div>

        {authenticator?.enrolled && (
          <form className="security-inline-form" onSubmit={disable}>
            <label className="risk-policy-field" htmlFor="totp-disable-code">
              <span>CODE OR BACKUP CODE TO DISABLE</span>
              <input
                id="totp-disable-code"
                autoComplete="one-time-code"
                value={disableCode}
                onChange={(event) => setDisableCode(event.target.value)}
              />
              <small>A backup code works here, and it works while the account is locked — that is what they are for.</small>
            </label>
            <button className="section-action" disabled={busy === "disable" || disableCode.trim().length < 6} type="submit">
              {busy === "disable" ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : <Trash2 aria-hidden="true" size={14} />}
              {busy === "disable" ? "DISABLING" : "DISABLE AUTHENTICATOR"}
            </button>
          </form>
        )}
      </section>

      <section className="security-block" aria-labelledby="security-policy-title">
        <div className="security-block-head">
          <h3 id="security-policy-title">What needs a code</h3>
          <span className="section-state">{policyPayload?.persisted ? "POLICY SAVED" : "NOT YET SAVED"}</span>
        </div>
        <p>Each scope is separate, and every one of them is off until you turn it on. A scope that is on without an activated authenticator is not enforced, and says so.</p>

        {policyDraft && (
          <form className="security-policy-form" onSubmit={savePolicy}>
            <ul className="chaingpt-admin-list">
              {(["sign-in", "trading", "funding"] as const).map((scope) => {
                const field = SCOPE_FIELD[scope];
                const required = policyDraft[field] as boolean;
                const note = policyPayload?.scopes.find((entry) => entry.scope === scope)?.note ?? null;
                return (
                  <li className="chaingpt-admin-row" key={scope}>
                    <label className="chaingpt-admin-toggle" htmlFor={`security-scope-${scope}`}>
                      <span className="chaingpt-admin-copy">
                        <span>{SCOPE_LABELS[scope]}</span>
                        <small>
                          {note
                            ?? (scope === "sign-in"
                              ? "A code is required to finish signing in."
                              : `A code is required within the step-up window before ${scope === "trading" ? "an order is placed or cancelled" : "a venue key is saved, verified or removed"}.`)}
                        </small>
                      </span>
                      <input
                        id={`security-scope-${scope}`}
                        type="checkbox"
                        checked={required}
                        onChange={(event) => setPolicyDraft((current) => current && ({ ...current, [field]: event.target.checked }))}
                      />
                      <span className="chaingpt-toggle-state">{required ? (note ? "ON / NOT ENFORCED" : "ON") : "OFF"}</span>
                    </label>
                  </li>
                );
              })}
            </ul>

            <div className="risk-settings-grid">
              <label className="risk-policy-field" htmlFor="security-step-up">
                <span>STEP-UP WINDOW (MINUTES)</span>
                <input
                  id="security-step-up"
                  type="number"
                  min={1}
                  max={120}
                  step={1}
                  value={policyDraft.stepUpMinutes}
                  onChange={(event) => setPolicyDraft((current) => current && ({ ...current, stepUpMinutes: Number(event.target.value) }))}
                />
                <small>How long an accepted code keeps a gated action unlocked on one device.</small>
              </label>
              <label className="risk-policy-field" htmlFor="security-max-attempts">
                <span>WRONG CODES BEFORE LOCKOUT</span>
                <input
                  id="security-max-attempts"
                  type="number"
                  min={1}
                  max={20}
                  step={1}
                  value={policyDraft.maxFailedAttempts}
                  onChange={(event) => setPolicyDraft((current) => current && ({ ...current, maxFailedAttempts: Number(event.target.value) }))}
                />
                <small>Counted per credential; any accepted code resets the count.</small>
              </label>
              <label className="risk-policy-field" htmlFor="security-lockout">
                <span>LOCKOUT DURATION (MINUTES)</span>
                <input
                  id="security-lockout"
                  type="number"
                  min={1}
                  max={1440}
                  step={1}
                  value={policyDraft.lockoutMinutes}
                  onChange={(event) => setPolicyDraft((current) => current && ({ ...current, lockoutMinutes: Number(event.target.value) }))}
                />
                <small>The lock lifts by itself after this; a backup code works while it is on.</small>
              </label>
            </div>

            <div className="risk-policy-actions">
              <button className="section-action" disabled={busy === "policy"} type="submit">
                {busy === "policy" ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : <Save aria-hidden="true" size={14} />}
                {busy === "policy" ? "SAVING" : "SAVE SECURITY POLICY"}
              </button>
              <span className="security-hint">The change applies to gated actions immediately; nothing is cached and nothing is restarted.</span>
            </div>
          </form>
        )}
      </section>

      <section className="security-block" aria-labelledby="security-sessions-title">
        <div className="security-block-head">
          <h3 id="security-sessions-title">Signed-in devices</h3>
          <span className="section-state">{activeSessions.length} ACTIVE</span>
        </div>
        <p>Every session is one device. Ending one is effective on that device&rsquo;s next request; it cannot be undone but does not disturb the others.</p>

        <ul className="security-session-list">
          {sessions.map((session) => (
            <li key={session.id} className={`security-session security-session--${session.status.toLowerCase()}`}>
              <div className="security-session-head">
                <strong>{session.deviceLabel}</strong>
                {session.isCurrent && <span className="security-badge">THIS DEVICE</span>}
                <span className="section-state">{session.status}</span>
              </div>
              <dl className="security-session-facts">
                <div><dt>IP</dt><dd>{session.ipAddress ?? "not observed"}</dd></div>
                <div><dt>Signed in</dt><dd>{shortMoment(session.createdAt)}</dd></div>
                <div><dt>Last seen</dt><dd>{shortMoment(session.lastSeenAt)}</dd></div>
                <div><dt>Ends</dt><dd>{shortMoment(session.expiresAt)}</dd></div>
              </dl>
              {session.status === "ACTIVE" && !session.isCurrent && (
                <button
                  className="section-action security-session-revoke"
                  disabled={busy === "revoke"}
                  onClick={() => void revokeSession(session.id)}
                  type="button"
                >
                  <LogOut aria-hidden="true" size={14} />
                  END THIS SESSION
                </button>
              )}
            </li>
          ))}
        </ul>

        <div className="risk-policy-actions">
          <button className="section-action" disabled={busy === "sessions" || activeSessions.length < 2} onClick={() => void revokeOthers()} type="button">
            {busy === "sessions" ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : <ShieldOff aria-hidden="true" size={14} />}
            {busy === "sessions" ? "ENDING" : "SIGN OUT EVERYWHERE ELSE"}
          </button>
          <button className="section-action" disabled={busy !== null} onClick={() => void load()} type="button">
            <RefreshCw aria-hidden="true" size={14} />
            REFRESH
          </button>
        </div>
      </section>
    </div>
  );
}
