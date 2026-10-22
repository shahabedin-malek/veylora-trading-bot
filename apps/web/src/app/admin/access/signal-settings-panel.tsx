"use client";

import { LoaderCircle, RefreshCw, Send, ShieldAlert, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

/**
 * Signals in, webhooks out (phase 31), on the admin access page.
 *
 * Two rules shape the UI:
 *
 *  - **A secret is shown once.** Creating a token or an endpoint renders the credential in a
 *    block the owner copies before leaving; the list itself only ever shows a masked prefix,
 *    a URL and a health state. Nothing on this page can ask the server for a secret again,
 *    because no route selects one.
 *  - **A refusal is a sentence, not a colour.** The signal log shows every attempt with the
 *    reason and the bound that refused it, including duplicates and bad signatures, so an
 *    operator reading the table knows what to change rather than that something failed.
 */

type TokenView = {
  id: string;
  label: string;
  tokenPrefix: string;
  replayWindowSeconds: number;
  status: string;
  lastUsedAt: string | null;
  createdAt: string;
};

type SignalEventView = {
  id: string;
  receivedAt: string;
  signalId: string | null;
  source: string;
  tokenPrefix: string | null;
  signatureStatus: string;
  decision: string;
  reasonCode: string;
  reasonLabel: string;
  reasonMessage: string;
  action: string | null;
  market: string | null;
  notionalUsd: string | null;
  orderId: string | null;
  duplicateOfId: string | null;
};

type SubscriptionView = {
  id: string;
  label: string;
  url: string;
  eventType: string;
  active: boolean;
  health: string;
  consecutiveFailures: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
};

type DeliveryView = {
  id: string;
  subscriptionLabel: string;
  eventType: string;
  attempt: number;
  status: string;
  responseStatus: number | null;
  error: string | null;
  attemptedAt: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
};

type Credential = { label: string; endpoint: string; token: string; secret: string };
type WebhookSecretView = { label: string; url: string; secret: string };

function shortTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace("T", " ").slice(0, 19) : value;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function refusalFrom(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") {
    return payload.error;
  }
  return fallback;
}

type LoadedSettings = {
  signals: { tokens: TokenView[]; events: SignalEventView[]; note?: string };
  webhooks: { subscriptions: SubscriptionView[]; deliveries: DeliveryView[]; eventTypes?: string[] } | null;
};

/** One read of both surfaces. A webhook failure does not hide the signal log. */
async function loadSignalSettings(): Promise<LoadedSettings> {
  const [signalsResponse, webhooksResponse] = await Promise.all([
    fetch("/api/signals", { credentials: "same-origin", cache: "no-store" }),
    fetch("/api/webhooks", { credentials: "same-origin", cache: "no-store" }),
  ]);
  const signals = await readJson(signalsResponse);
  if (!signalsResponse.ok || !signals || typeof signals !== "object") {
    throw new Error(refusalFrom(signals, "Signal settings could not be read."));
  }
  const webhooks = await readJson(webhooksResponse);
  return {
    signals: signals as LoadedSettings["signals"],
    webhooks:
      webhooksResponse.ok && webhooks && typeof webhooks === "object"
        ? (webhooks as NonNullable<LoadedSettings["webhooks"]>)
        : null,
  };
}

async function copy(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function SignalSettingsPanel() {
  const [tokens, setTokens] = useState<TokenView[] | null>(null);
  const [events, setEvents] = useState<SignalEventView[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionView[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryView[]>([]);
  const [eventTypes, setEventTypes] = useState<string[]>(["trade.placed", "alert.triggered", "strategy.decision", "webhook.test"]);
  const [note, setNote] = useState<string | null>(null);
  const [credential, setCredential] = useState<Credential | null>(null);
  const [webhookSecret, setWebhookSecret] = useState<WebhookSecretView | null>(null);
  const [windows, setWindows] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((loaded: LoadedSettings) => {
    setTokens(loaded.signals.tokens);
    setEvents(loaded.signals.events);
    if (loaded.signals.note) setNote(loaded.signals.note);
    if (loaded.webhooks) {
      setSubscriptions(loaded.webhooks.subscriptions);
      setDeliveries(loaded.webhooks.deliveries);
      if (loaded.webhooks.eventTypes?.length) setEventTypes(loaded.webhooks.eventTypes);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await loadSignalSettings());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Signal settings could not be read.");
      setTokens(null);
    }
  }, [apply]);

  useEffect(() => {
    let active = true;
    void loadSignalSettings()
      .then((loaded) => {
        if (active) apply(loaded);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Signal settings could not be read.");
        setTokens(null);
      });
    return () => {
      active = false;
    };
  }, [apply]);

  async function send(url: string, method: string, body: unknown, label: string) {
    setBusy(label);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch(url, {
        method,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(refusalFrom(payload, "The change was refused."));
      await refresh();
      return payload;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The change was refused.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function createToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const label = String(form.get("label") ?? "").trim();
    const windowSeconds = Number(form.get("window") ?? 300);
    if (!label) {
      setError("Give the token a label so the signal log is readable.");
      return;
    }
    setCredential(null);
    const payload = await send("/api/signals", "POST", { label, replayWindowSeconds: windowSeconds }, "token");
    if (!payload || typeof payload !== "object") return;
    const created = payload as {
      token: TokenView;
      credential: { token: string; secret: string };
    };
    setCredential({
      label: created.token.label,
      token: created.credential.token,
      secret: created.credential.secret,
      endpoint: `${window.location.origin}/api/signals/${created.credential.token}`,
    });
    setMessage(`Signal token "${created.token.label}" created. Copy the secret now — it is shown once.`);
    event.currentTarget.reset();
  }

  async function saveWindow(tokenId: string) {
    const value = Number(windows[tokenId]);
    const payload = await send("/api/signals", "PATCH", { tokenId, replayWindowSeconds: value }, `window-${tokenId}`);
    if (payload) setMessage(`Replay window saved: ${value < 30 ? 30 : value > 3_600 ? 3_600 : value} seconds.`);
  }

  async function revokeToken(token: TokenView) {
    if (!window.confirm(`Revoke "${token.label}"? Signals using it will be refused and logged.`)) return;
    const payload = await send("/api/signals", "PATCH", { tokenId: token.id, status: "REVOKED" }, `revoke-${token.id}`);
    if (payload) setMessage(`Token "${token.label}" revoked. Its log entries are kept.`);
  }

  async function createWebhook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const url = String(form.get("url") ?? "").trim();
    const eventType = String(form.get("eventType") ?? "");
    const label = String(form.get("label") ?? "").trim();
    setWebhookSecret(null);
    const payload = await send("/api/webhooks", "POST", { action: "create", url, eventType, label }, "webhook");
    if (!payload || typeof payload !== "object") return;
    const created = payload as { subscription: SubscriptionView; secret: string };
    setWebhookSecret({ label: created.subscription.label, url: created.subscription.url, secret: created.secret });
    setMessage(`Endpoint "${created.subscription.label}" added. Copy the signing secret now — it is shown once.`);
    event.currentTarget.reset();
  }

  async function toggleEndpoint(subscription: SubscriptionView) {
    const payload = await send(
      "/api/webhooks",
      "POST",
      { action: subscription.active ? "pause" : "resume", id: subscription.id },
      `toggle-${subscription.id}`,
    );
    if (payload) setMessage(`"${subscription.label}" ${subscription.active ? "paused" : "resumed"}.`);
  }

  async function revokeEndpoint(subscription: SubscriptionView) {
    if (!window.confirm(`Revoke "${subscription.label}"? It stops receiving deliveries; its history stays.`)) return;
    const payload = await send("/api/webhooks", "POST", { action: "revoke", id: subscription.id }, `revoke-${subscription.id}`);
    if (payload) setMessage(`Endpoint "${subscription.label}" revoked.`);
  }

  async function sendTest() {
    const payload = await send("/api/webhooks", "POST", { action: "test" }, "test");
    if (!payload || typeof payload !== "object") return;
    const result = payload as { queued: number; delivered: number; failed: number; note?: string };
    setMessage(
      result.note ??
        `Test event: ${result.queued} queued, ${result.delivered} delivered, ${result.failed} failed. See the delivery record.`,
    );
  }

  async function copyValue(value: string, what: string) {
    const ok = await copy(value);
    if (ok) setMessage(`${what} copied to the clipboard.`);
    else setError(`${what} could not be copied; select it and copy manually.`);
  }

  if (tokens === null) {
    return (
      <div className="market-chart-empty" role="status">
        <strong>Signal storage unavailable</strong>
        <span>{error ?? "Apply the database migration before managing signal tokens."}</span>
      </div>
    );
  }

  return (
    <div className="chaingpt-admin-form">
      {credential && (
        <div className="signal-credential" role="alert">
          <strong>NEW SIGNAL CREDENTIAL — SHOWN ONCE</strong>
          <p>
            Paste these into your alert provider. The endpoint is the URL; the secret is never stored in a readable
            form and cannot be retrieved again.
          </p>
          <dl>
            <div>
              <dt>ENDPOINT</dt>
              <dd><code>{credential.endpoint}</code></dd>
            </div>
            <div>
              <dt>TOKEN</dt>
              <dd><code>{credential.token}</code></dd>
            </div>
            <div>
              <dt>SIGNING SECRET</dt>
              <dd><code>{credential.secret}</code></dd>
            </div>
          </dl>
          <div className="chaingpt-admin-actions">
            <button className="section-action" onClick={() => void copyValue(credential.endpoint, "Endpoint")} type="button">
              COPY ENDPOINT
            </button>
            <button className="section-action" onClick={() => void copyValue(credential.secret, "Signing secret")} type="button">
              COPY SECRET
            </button>
            <button className="section-action" onClick={() => setCredential(null)} type="button">
              I HAVE COPIED IT
            </button>
          </div>
          <p className="chaingpt-admin-disclosure">
            Sign `<code>{"<timestamp>.<raw body>"}</code>` with HMAC-SHA256 and send{" "}
            <code>X-Signal-Timestamp</code> and <code>X-Signal-Signature: sha256=&lt;hex&gt;</code>. The body is{" "}
            <code>{'{"signalId":"tv-1","action":"enter","market":"BTC-USD","sizeUsd":"25"}'}</code>.
          </p>
        </div>
      )}

      {webhookSecret && (
        <div className="signal-credential" role="alert">
          <strong>NEW WEBHOOK SIGNING SECRET — SHOWN ONCE</strong>
          <p>
            {webhookSecret.label} at <code>{webhookSecret.url}</code> verifies each delivery with this secret.
          </p>
          <dl>
            <div>
              <dt>SIGNING SECRET</dt>
              <dd><code>{webhookSecret.secret}</code></dd>
            </div>
          </dl>
          <div className="chaingpt-admin-actions">
            <button className="section-action" onClick={() => void copyValue(webhookSecret.secret, "Webhook secret")} type="button">
              COPY WEBHOOK SECRET
            </button>
            <button className="section-action" onClick={() => setWebhookSecret(null)} type="button">
              I HAVE COPIED IT
            </button>
          </div>
        </div>
      )}

      <div className="section-heading">
        <div>
          <div className="section-kicker">ADMIN / SIGNALS IN</div>
          <h3>Inbound signal tokens</h3>
        </div>
        <span className="section-state">SIGNED + REPLAY PROTECTED</span>
      </div>
      <form onSubmit={createToken}>
        <div className="notification-settings-grid">
          <label>
            <span>LABEL</span>
            <input aria-label="Signal token label" name="label" placeholder="TradingView BTC alerts" required />
            <small>Shown in the signal log instead of the token.</small>
          </label>
          <label>
            <span>REPLAY WINDOW (SECONDS)</span>
            <input aria-label="Replay window seconds" defaultValue={300} max={3600} min={30} name="window" type="number" />
            <small>How old a signed request may be. 30–3600; duplicates are refused separately by signal id.</small>
          </label>
        </div>
        <div className="chaingpt-admin-actions">
          <button className="section-action" disabled={busy === "token"} type="submit">
            {busy === "token" ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : <ShieldAlert aria-hidden="true" size={14} />}
            CREATE SIGNAL TOKEN
          </button>
          <button className="section-action" onClick={() => void refresh()} type="button">
            <RefreshCw aria-hidden="true" size={14} /> REFRESH
          </button>
          {message && <span role="status">{message}</span>}
          {error && <span className="login-error" role="alert">{error}</span>}
        </div>
      </form>

      <ul className="chaingpt-admin-list">
        {tokens.length === 0 && <li className="chaingpt-admin-row"><span className="chaingpt-admin-copy"><span>No signal token yet</span><small>Create one, then send a signed request to its endpoint.</small></span></li>}
        {tokens.map((token) => (
          <li className="chaingpt-admin-row" key={token.id}>
            <div className="chaingpt-admin-copy">
              <span>{token.label}</span>
              <small>
                <code>{token.tokenPrefix}</code> · window {token.replayWindowSeconds}s · last used {shortTime(token.lastUsedAt)} ·{" "}
                {token.status}
              </small>
            </div>
            <div className="chaingpt-admin-actions">
              <input
                aria-label={`Replay window for ${token.label}`}
                defaultValue={windows[token.id] ?? String(token.replayWindowSeconds)}
                max={3600}
                min={30}
                onChange={(change) => setWindows((current) => ({ ...current, [token.id]: change.target.value }))}
                type="number"
              />
              <button className="section-action" disabled={busy === `window-${token.id}`} onClick={() => void saveWindow(token.id)} type="button">
                SAVE WINDOW
              </button>
              {token.status === "ACTIVE" && (
                <button className="section-action" disabled={busy === `revoke-${token.id}`} onClick={() => void revokeToken(token)} type="button">
                  <Trash2 aria-hidden="true" size={14} /> REVOKE
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <p className="chaingpt-admin-disclosure">{note}</p>

      <div className="section-heading">
        <div>
          <div className="section-kicker">ADMIN / SIGNAL LOG</div>
          <h3>Every attempt, accepted or not</h3>
        </div>
        <span className="section-state">APPEND-ONLY</span>
      </div>
      <div className="market-history-table-wrap">
        <table className="market-history-table">
          <thead>
            <tr>
              <th scope="col">Received (UTC)</th>
              <th scope="col">Source</th>
              <th scope="col">Token</th>
              <th scope="col">Signature</th>
              <th scope="col">Decision</th>
              <th scope="col">Reason</th>
              <th scope="col">Action</th>
              <th scope="col">Order</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 && (
              <tr><td colSpan={8}>No signal has reached this account yet.</td></tr>
            )}
            {events.map((event) => (
              <tr key={event.id}>
                <td>{shortTime(event.receivedAt)}</td>
                <td>{event.source}</td>
                <td>{event.tokenPrefix ?? "—"}</td>
                <td>{event.signatureStatus}</td>
                <td>{event.decision}</td>
                <td>
                  {event.reasonLabel}
                  <small>{event.reasonMessage}</small>
                  {event.duplicateOfId && <small>Original event {event.duplicateOfId}</small>}
                </td>
                <td>{event.action ? `${event.action} ${event.market ?? ""} ${event.notionalUsd ? `$${event.notionalUsd}` : ""}` : event.signalId ?? "—"}</td>
                <td>{event.orderId ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section-heading">
        <div>
          <div className="section-kicker">ADMIN / WEBHOOKS OUT</div>
          <h3>Signed deliveries with retries</h3>
        </div>
        <span className="section-state">BOUNDED BACKOFF</span>
      </div>
      <form onSubmit={createWebhook}>
        <div className="notification-settings-grid">
          <label>
            <span>RECEIVER URL</span>
            <input aria-label="Webhook receiver URL" name="url" placeholder="https://example.com/veylora" required />
            <small>https for public receivers; http only for localhost.</small>
          </label>
          <label>
            <span>EVENT TYPE</span>
            <select aria-label="Webhook event type" name="eventType" defaultValue="trade.placed">
              {eventTypes.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </label>
          <label>
            <span>LABEL</span>
            <input aria-label="Webhook label" name="label" placeholder="Local receiver" />
            <small>Optional; shown in the delivery record.</small>
          </label>
        </div>
        <div className="chaingpt-admin-actions">
          <button className="section-action" disabled={busy === "webhook"} type="submit">
            {busy === "webhook" ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : <ShieldAlert aria-hidden="true" size={14} />}
            ADD WEBHOOK ENDPOINT
          </button>
          <button className="section-action" disabled={busy === "test"} onClick={() => void sendTest()} type="button">
            {busy === "test" ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : <Send aria-hidden="true" size={14} />}
            SEND TEST EVENT
          </button>
        </div>
      </form>

      <ul className="chaingpt-admin-list">
        {subscriptions.length === 0 && <li className="chaingpt-admin-row"><span className="chaingpt-admin-copy"><span>No webhook endpoint yet</span><small>Add one, send a test event, then watch the delivery record below.</small></span></li>}
        {subscriptions.map((subscription) => (
          <li className="chaingpt-admin-row" key={subscription.id}>
            <div className="chaingpt-admin-copy">
              <span>
                {subscription.label} · {subscription.eventType}{" "}
                <strong className={subscription.health === "UNHEALTHY" ? "login-error" : undefined}>{subscription.health}</strong>
              </span>
              <small>{subscription.url}</small>
              <small>
                {subscription.active ? "ACTIVE" : "PAUSED"} · last attempt {shortTime(subscription.lastAttemptAt)} · last success{" "}
                {shortTime(subscription.lastSuccessAt)} · {subscription.consecutiveFailures} consecutive failure(s)
              </small>
              {subscription.lastError && <small className="login-error">{subscription.lastError}</small>}
            </div>
            <div className="chaingpt-admin-actions">
              <button className="section-action" onClick={() => void toggleEndpoint(subscription)} type="button">
                {subscription.active ? "PAUSE" : "RESUME"}
              </button>
              <button className="section-action" onClick={() => void revokeEndpoint(subscription)} type="button">
                <Trash2 aria-hidden="true" size={14} /> REVOKE
              </button>
            </div>
          </li>
        ))}
      </ul>

      <div className="market-history-table-wrap">
        <table className="market-history-table">
          <thead>
            <tr>
              <th scope="col">Created (UTC)</th>
              <th scope="col">Endpoint</th>
              <th scope="col">Event</th>
              <th scope="col">Attempt</th>
              <th scope="col">Status</th>
              <th scope="col">HTTP</th>
              <th scope="col">Answer</th>
              <th scope="col">Next attempt</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.length === 0 && (
              <tr><td colSpan={8}>No delivery has been attempted yet.</td></tr>
            )}
            {deliveries.map((delivery) => (
              <tr key={delivery.id}>
                <td>{shortTime(delivery.createdAt)}</td>
                <td>{delivery.subscriptionLabel}</td>
                <td>{delivery.eventType}</td>
                <td>{delivery.attempt}</td>
                <td className={delivery.status === "FAILED" ? "login-error" : undefined}>{delivery.status}</td>
                <td>{delivery.responseStatus ?? "—"}</td>
                <td>{delivery.error ?? "Delivered"}</td>
                <td>{shortTime(delivery.nextAttemptAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
