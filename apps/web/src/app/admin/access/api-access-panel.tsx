"use client";

import { Check, Copy, KeyRound, LoaderCircle, Plus, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ApiScope } from "@/lib/api/keys";

/**
 * The owner's public-API panel (phase 32).
 *
 * The one-time block is the only place a key exists in the browser, and it is held in state
 * until dismissed: the list below can only ever show a prefix because the server only ever
 * sends a prefix. An approval is a row with its notional and expiry, not a modal that hides
 * the reason a trade did not happen.
 */

type KeyView = {
  id: string;
  label: string;
  prefix: string;
  scopes: ApiScope[];
  agentAccountId: string | null;
  rateLimitPerMinute: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

type AgentView = {
  id: string;
  name: string;
  status: string;
  approvalThresholdUsdCents: number | null;
  createdAt: string;
  keyCount: number;
};

type ApprovalView = {
  id: string;
  status: string;
  effectiveStatus: string;
  expired: boolean;
  market: string;
  side: string;
  quantity: string;
  notionalUsdCents: number;
  expiresAt: string;
  createdAt: string;
  orderId: string | null;
  agentAccountId: string;
  agentAccountName: string;
  keyPrefix: string | null;
};

type Directory = {
  keys: KeyView[];
  agents: AgentView[];
  approvals: ApprovalView[];
  defaults: { rateLimitPerMinute: number; approvalTtlMinutes: number };
  docs: string;
};

const SCOPES: Array<{ key: ApiScope; label: string; detail: string }> = [
  { key: "read", label: "read", detail: "Account, balances, ledger, orders and market data." },
  { key: "trade", label: "trade", detail: "Paper orders in the dedicated agent account only." },
  { key: "agent", label: "agent", detail: "Read that agent account and its approvals." },
];

function shortTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace("T", " ").slice(0, 19) : value;
}

function dollars(cents: number | null): string {
  return cents === null ? "no approval threshold" : `$${(cents / 100).toFixed(2)}`;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function messageFrom(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") {
    return payload.error;
  }
  return fallback;
}

async function loadDirectory(): Promise<Directory> {
  const response = await fetch("/api/admin/api-keys", { credentials: "same-origin", cache: "no-store" });
  const payload = await readJson(response);
  if (!response.ok || !payload || typeof payload !== "object") {
    throw new Error(messageFrom(payload, "Public API settings could not be read."));
  }
  return payload as Directory;
}

export function ApiAccessPanel() {
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const [agentName, setAgentName] = useState("");
  const [thresholdDollars, setThresholdDollars] = useState("");

  const [keyLabel, setKeyLabel] = useState("");
  const [scopes, setScopes] = useState<ApiScope[]>(["read"]);
  const [agentAccountId, setAgentAccountId] = useState("");
  const [rateLimit, setRateLimit] = useState("60");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setDirectory(await loadDirectory());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Public API settings could not be read.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void loadDirectory()
      .then((loaded) => {
        if (active) setDirectory(loaded);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Public API settings could not be read.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function post(action: string, body: Record<string, unknown>, tag: string): Promise<Record<string, unknown> | null> {
    setBusy(tag);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/api-keys", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...body }),
      });
      const payload = await readJson(response);
      if (!response.ok || !payload || typeof payload !== "object") {
        throw new Error(messageFrom(payload, "The change could not be saved."));
      }
      await refresh();
      return payload as Record<string, unknown>;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The change could not be saved.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function createAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const dollarsValue = thresholdDollars.trim() === "" ? null : Number(thresholdDollars);
    if (dollarsValue !== null && (!Number.isFinite(dollarsValue) || dollarsValue < 0)) {
      setError("The approval threshold must be a dollar amount, or empty for none.");
      return;
    }
    const payload = await post(
      "create-agent",
      {
        name: agentName,
        approvalThresholdUsdCents: dollarsValue === null ? null : Math.round(dollarsValue * 100),
      },
      "agent",
    );
    if (payload) {
      setAgentName("");
      setThresholdDollars("");
      setNotice("Agent account created. Issue a trade key bound to it.");
    }
  }

  async function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = await post(
      "create-key",
      {
        label: keyLabel,
        scopes,
        agentAccountId: agentAccountId || null,
        rateLimitPerMinute: Number(rateLimit),
      },
      "key",
    );
    if (!payload || typeof payload.secret !== "string" || !payload.key || typeof payload.key !== "object") return;
    const key = payload.key as { label?: string };
    setSecret({ label: key.label ?? keyLabel, value: payload.secret });
    setKeyLabel("");
    setCopied(false);
    setNotice("Key created. Copy it now; the server will not show it again.");
  }

  async function revoke(key: KeyView) {
    const payload = await post("revoke-key", { keyId: key.id }, `revoke:${key.id}`);
    if (payload) setNotice(`Key ${key.prefix} is revoked. The next request with it answers 401.`);
  }

  async function decide(approval: ApprovalView, decision: "APPROVE" | "DENY") {
    const payload = await post(
      "decide-approval",
      { approvalId: approval.id, decision },
      `${decision}:${approval.id}`,
    );
    if (payload) {
      setNotice(
        decision === "APPROVE"
          ? `Approved ${approval.agentAccountName}'s ${approval.side} ${approval.market} order.`
          : `Denied ${approval.agentAccountName}'s ${approval.side} ${approval.market} order.`,
      );
    }
  }

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function toggleScope(scope: ApiScope, checked: boolean) {
    setScopes((current) => {
      const next = checked ? [...new Set([...current, scope])] : current.filter((value) => value !== scope);
      return next.length > 0 ? next : ["read"];
    });
  }

  const pending = directory?.approvals.filter((approval) => approval.effectiveStatus === "PENDING") ?? [];

  return (
    <div className="signal-settings">
      <div className="chaingpt-admin-actions">
        <button className="section-action" disabled={loading} onClick={() => void refresh()} type="button">
          {loading ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : <RefreshCw aria-hidden="true" size={14} />}
          {loading ? "READING" : "REFRESH"}
        </button>
        <a className="section-action" href="/docs/api">API &amp; MCP DOCS</a>
        {notice && <span role="status">{notice}</span>}
        {error && <span className="login-error" role="alert">{error}</span>}
      </div>

      {secret && (
        <div className="signal-credential" role="status" aria-live="polite">
          <strong>KEY FOR {secret.label}</strong>
          <p>This is the only time the key is shown. Store it in the client&apos;s secret store, not in a file or a prompt.</p>
          <code>{secret.value}</code>
          <div className="chaingpt-admin-actions">
            <button className="section-action" onClick={() => void copySecret()} type="button">
              {copied ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
              {copied ? "COPIED" : "COPY KEY"}
            </button>
            <button className="section-action" onClick={() => setSecret(null)} type="button">DISMISS</button>
          </div>
        </div>
      )}

      <div className="signal-settings__grid">
        <form className="chaingpt-admin-form" onSubmit={createAgent}>
          <h3><ShieldCheck aria-hidden="true" size={15} /> Agent account</h3>
          <p className="chaingpt-admin-disclosure">
            A separate ledger account for one external agent. A trade key can place orders here and nowhere else.
            The threshold is optional: an order above it becomes a pending approval instead of an order.
          </p>
          <label>
            <span>NAME</span>
            <input
              maxLength={60}
              minLength={2}
              onChange={(event) => setAgentName(event.target.value)}
              placeholder="Research agent"
              required
              value={agentName}
            />
          </label>
          <label>
            <span>APPROVAL THRESHOLD (USD, OPTIONAL)</span>
            <input
              inputMode="decimal"
              min={0}
              onChange={(event) => setThresholdDollars(event.target.value)}
              placeholder="Leave empty to execute every order"
              step="0.01"
              type="number"
              value={thresholdDollars}
            />
          </label>
          <button className="section-action" disabled={busy === "agent"} type="submit">
            {busy === "agent" ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : <Plus aria-hidden="true" size={14} />}
            {busy === "agent" ? "CREATING" : "CREATE AGENT ACCOUNT"}
          </button>
        </form>

        <form className="chaingpt-admin-form" onSubmit={createKey}>
          <h3><KeyRound aria-hidden="true" size={15} /> Issue a key</h3>
          <label>
            <span>LABEL</span>
            <input
              maxLength={80}
              minLength={2}
              onChange={(event) => setKeyLabel(event.target.value)}
              placeholder="Backtest reader"
              required
              value={keyLabel}
            />
          </label>
          <fieldset className="api-key-scopes">
            <legend>SCOPES</legend>
            {SCOPES.map((scope) => (
              <label className="chaingpt-admin-toggle" htmlFor={`api-scope-${scope.key}`} key={scope.key}>
                <span className="chaingpt-admin-copy">
                  <span>{scope.label}</span>
                  <small>{scope.detail}</small>
                </span>
                <input
                  checked={scopes.includes(scope.key)}
                  id={`api-scope-${scope.key}`}
                  onChange={(event) => toggleScope(scope.key, event.target.checked)}
                  type="checkbox"
                />
                <span className="chaingpt-toggle-state">{scopes.includes(scope.key) ? "ON" : "OFF"}</span>
              </label>
            ))}
          </fieldset>
          <label>
            <span>AGENT ACCOUNT (REQUIRED FOR TRADE / AGENT)</span>
            <select onChange={(event) => setAgentAccountId(event.target.value)} value={agentAccountId}>
              <option value="">No agent account</option>
              {(directory?.agents ?? []).map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>RATE LIMIT (REQUESTS / MINUTE)</span>
            <input
              inputMode="numeric"
              max={600}
              min={1}
              onChange={(event) => setRateLimit(event.target.value)}
              required
              type="number"
              value={rateLimit}
            />
          </label>
          <button className="section-action" disabled={busy === "key"} type="submit">
            {busy === "key" ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : <KeyRound aria-hidden="true" size={14} />}
            {busy === "key" ? "ISSUING" : "ISSUE KEY"}
          </button>
        </form>
      </div>

      <div className="market-history-table-wrap">
        <table className="market-history-table">
          <caption>Issued keys. Only the prefix is retrievable.</caption>
          <thead>
            <tr>
              <th scope="col">Label</th>
              <th scope="col">Prefix</th>
              <th scope="col">Scopes</th>
              <th scope="col">Agent account</th>
              <th scope="col">Limit</th>
              <th scope="col">Last used</th>
              <th scope="col">State</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {(directory?.keys ?? []).map((key) => {
              const agent = directory?.agents.find((candidate) => candidate.id === key.agentAccountId);
              return (
                <tr key={key.id}>
                  <td>{key.label}</td>
                  <td><code>{key.prefix}…</code></td>
                  <td>{key.scopes.join(", ")}</td>
                  <td>{agent?.name ?? "—"}</td>
                  <td>{key.rateLimitPerMinute}/min</td>
                  <td>{shortTime(key.lastUsedAt)}</td>
                  <td>{key.revokedAt ? `REVOKED ${shortTime(key.revokedAt)}` : "ACTIVE"}</td>
                  <td>
                    {key.revokedAt ? (
                      <span>—</span>
                    ) : (
                      <button
                        className="section-action"
                        disabled={busy === `revoke:${key.id}`}
                        onClick={() => void revoke(key)}
                        type="button"
                      >
                        {busy === `revoke:${key.id}` ? "REVOKING" : "REVOKE"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!loading && (directory?.keys.length ?? 0) === 0 && (
              <tr><td colSpan={8}>No keys yet. Issue one above.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="market-history-table-wrap">
        <table className="market-history-table">
          <caption>
            Agent accounts. Approvals past their expiry read EXPIRED and cannot be approved.
            {pending.length > 0 ? ` ${pending.length} pending.` : ""}
          </caption>
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Status</th>
              <th scope="col">Threshold</th>
              <th scope="col">Keys</th>
              <th scope="col">Created</th>
            </tr>
          </thead>
          <tbody>
            {(directory?.agents ?? []).map((agent) => (
              <tr key={agent.id}>
                <td>{agent.name}</td>
                <td>{agent.status}</td>
                <td>{dollars(agent.approvalThresholdUsdCents)}</td>
                <td>{agent.keyCount}</td>
                <td>{shortTime(agent.createdAt)}</td>
              </tr>
            ))}
            {!loading && (directory?.agents.length ?? 0) === 0 && (
              <tr><td colSpan={5}>No agent account yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="market-history-table-wrap">
        <table className="market-history-table">
          <caption>Approval records</caption>
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Order</th>
              <th scope="col">Notional</th>
              <th scope="col">Key</th>
              <th scope="col">Created</th>
              <th scope="col">Expires</th>
              <th scope="col">State</th>
              <th scope="col">Decision</th>
            </tr>
          </thead>
          <tbody>
            {(directory?.approvals ?? []).map((approval) => (
              <tr key={approval.id}>
                <td>{approval.agentAccountName}</td>
                <td>{approval.side} {approval.market} · {approval.quantity}</td>
                <td>${(approval.notionalUsdCents / 100).toFixed(2)}</td>
                <td>{approval.keyPrefix ? `${approval.keyPrefix}…` : "owner"}</td>
                <td>{shortTime(approval.createdAt)}</td>
                <td>{shortTime(approval.expiresAt)}</td>
                <td>{approval.effectiveStatus}{approval.orderId ? ` · ${approval.orderId}` : ""}</td>
                <td>
                  {approval.effectiveStatus === "PENDING" ? (
                    <div className="chaingpt-admin-actions">
                      <button
                        className="section-action"
                        disabled={busy === `APPROVE:${approval.id}`}
                        onClick={() => void decide(approval, "APPROVE")}
                        type="button"
                      >
                        <Check aria-hidden="true" size={13} /> APPROVE
                      </button>
                      <button
                        className="section-action"
                        disabled={busy === `DENY:${approval.id}`}
                        onClick={() => void decide(approval, "DENY")}
                        type="button"
                      >
                        <X aria-hidden="true" size={13} /> DENY
                      </button>
                    </div>
                  ) : (
                    <span>{approval.effectiveStatus === "EXPIRED" ? "expired before decision" : "—"}</span>
                  )}
                </td>
              </tr>
            ))}
            {!loading && (directory?.approvals.length ?? 0) === 0 && (
              <tr><td colSpan={8}>No approval has been requested.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
