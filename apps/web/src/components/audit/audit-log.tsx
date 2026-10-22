"use client";

import { CircleAlert, Download, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * The audit view.
 *
 * The table is the trail itself: filters narrow it, a correlation id can be
 * followed across services with one click, and each row expands to the stored
 * before/after values and its chain hashes. The chain report above the list is
 * the honest part no competitor publishes — it names the first broken link, or
 * says the chain is intact and how many legacy rows predate hashing.
 *
 * Exports are plain links to the same filters, so what is on screen is what is
 * downloaded, and the manifest hash travels in the response header.
 */

type AuditEvent = {
  id: string;
  chainIndex: number | null;
  occurredAt: string;
  actorUserId: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  outcome: string;
  source: string | null;
  correlationId: string | null;
  hash: string | null;
  previousHash: string | null;
  before: unknown;
  after: unknown;
  payload: unknown;
};

type ChainReport = {
  ok: boolean;
  checked: number;
  chainLength: number;
  headIndex: number;
  headHash: string | null;
  gaps: { fromIndex: number; toIndex: number; markerId: string }[];
  legacyRows: number;
  firstBroken: {
    kind: "MODIFIED" | "LINK_BROKEN" | "MISSING";
    chainIndex: number;
    id: string | null;
    message: string;
    expected: string | null;
    actual: string | null;
  } | null;
  verifiedAt: string;
};

type RetentionView = { windowDays: number; updatedAt: string | null; updatedByUserId: string | null };

type AuditPayload = {
  events: AuditEvent[];
  total: number;
  limit: number;
  truncated: boolean;
  chain: ChainReport | null;
  retention: RetentionView;
  error?: string;
};

type Filters = {
  actor: string;
  target: string;
  action: string;
  correlationId: string;
  source: string;
  from: string;
  to: string;
};

const EMPTY_FILTERS: Filters = { actor: "", target: "", action: "", correlationId: "", source: "", from: "", to: "" };

function queryString(filters: Filters): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value.trim()) search.set(key, value.trim());
  }
  return search.toString();
}

async function requestAudit(next: Filters): Promise<{ payload: AuditPayload | null; error: string | null }> {
  const search = queryString(next);
  try {
    const response = await fetch(`/api/admin/audit?check=1${search ? `&${search}` : ""}`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    const payload = (await response.json().catch(() => null)) as AuditPayload | null;
    if (!response.ok || !payload) {
      return { payload: null, error: payload?.error ?? "The audit trail could not be read." };
    }
    return { payload, error: null };
  } catch {
    return { payload: null, error: "The audit trail could not be read." };
  }
}

function shortHash(hash: string | null): string {
  if (!hash) return "—";
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

function showValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export function AuditLog({ canManage }: { canManage: boolean }) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [data, setData] = useState<AuditPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retentionDays, setRetentionDays] = useState("0");
  const [retentionNotice, setRetentionNotice] = useState<string | null>(null);

  const load = useCallback(async (next: Filters) => {
    const result = await requestAudit(next);
    if (!result.payload) {
      setError(result.error);
      setData(null);
      setBusy(false);
      return;
    }
    setData(result.payload);
    setRetentionDays(String(result.payload.retention.windowDays));
    setError(null);
    setBusy(false);
  }, []);

  useEffect(() => {
    let active = true;
    void requestAudit(EMPTY_FILTERS).then((result) => {
      if (!active) return;
      if (!result.payload) {
        setError(result.error);
        return;
      }
      setData(result.payload);
      setRetentionDays(String(result.payload.retention.windowDays));
    });
    return () => {
      active = false;
    };
  }, []);

  const exportHref = useMemo(() => {
    const search = queryString(applied);
    return `/api/admin/audit/export?${search ? `${search}&` : ""}`;
  }, [applied]);

  async function verifyNow() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/audit", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify" }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { chain: ChainReport; retention: RetentionView; error?: string }
        | null;
      if (!response.ok || !payload) {
        setError(payload?.error ?? "The chain could not be verified.");
        return;
      }
      setData((current) => (current ? { ...current, chain: payload.chain, retention: payload.retention } : current));
    } catch {
      setError("The chain could not be verified.");
    } finally {
      setBusy(false);
    }
  }

  async function saveRetention() {
    setBusy(true);
    setError(null);
    setRetentionNotice(null);
    try {
      const response = await fetch("/api/admin/audit", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retention", windowDays: Number(retentionDays) }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { retention: RetentionView; error?: string }
        | null;
      if (!response.ok || !payload) {
        setError(payload?.error ?? "The retention window could not be saved.");
        return;
      }
      setData((current) => (current ? { ...current, retention: payload.retention } : current));
      setRetentionDays(String(payload.retention.windowDays));
      setRetentionNotice(
        payload.retention.windowDays === 0
          ? "Retention is off: every audit event is kept."
          : `Events older than ${payload.retention.windowDays} days are removed by the daily job, and each deletion writes its own audit event.`,
      );
    } catch {
      setError("The retention window could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const chain = data?.chain ?? null;

  return (
    <div className="audit-log">
      <section className="data-section" aria-labelledby="audit-chain-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">01 / TAMPER EVIDENCE</div>
            <h2 id="audit-chain-title">Hash chain</h2>
          </div>
          <span className={`section-state audit-chain-state ${chain && !chain.ok ? "is-broken" : ""}`}>
            {!chain ? "NOT CHECKED" : chain.ok ? "CHAIN INTACT" : "CHAIN BROKEN"}
          </span>
        </div>

        {!chain && <p className="policy-disclaimer">The chain has not been checked in this view.</p>}

        {chain && chain.ok && (
          <div className="audit-chain-summary" role="status">
            <ShieldCheck size={18} aria-hidden="true" />
            <div>
              <strong>
                {chain.checked} event{chain.checked === 1 ? "" : "s"} verified through link {chain.headIndex}.
              </strong>
              <p>
                Head {shortHash(chain.headHash)} · {chain.legacyRows} row
                {chain.legacyRows === 1 ? "" : "s"} predate hashing ·{" "}
                {chain.gaps.length === 0
                  ? "no gaps"
                  : `${chain.gaps.length} retention gap${chain.gaps.length === 1 ? "" : "s"} declared by its own marker`}
                . Checked {new Date(chain.verifiedAt).toLocaleString()}.
              </p>
            </div>
          </div>
        )}

        {chain && !chain.ok && chain.firstBroken && (
          <div className="audit-chain-summary is-broken" role="alert">
            <CircleAlert size={18} aria-hidden="true" />
            <div>
              <strong>
                First broken link at index {chain.firstBroken.chainIndex} · {chain.firstBroken.kind}
              </strong>
              <p>{chain.firstBroken.message}</p>
              <p>
                Expected <code>{shortHash(chain.firstBroken.expected)}</code>, found{" "}
                <code>{shortHash(chain.firstBroken.actual)}</code>.
              </p>
            </div>
          </div>
        )}

        <div className="audit-toolbar">
          <button type="button" className="ghost-button" onClick={() => void verifyNow()} disabled={busy}>
            <ShieldCheck size={14} aria-hidden="true" /> Verify now
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              setBusy(true);
              void load(applied);
            }}
            disabled={busy}
          >
            <RefreshCw size={14} aria-hidden="true" /> Refresh
          </button>
        </div>
      </section>

      <section className="data-section" aria-labelledby="audit-retention-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">02 / RETENTION</div>
            <h2 id="audit-retention-title">How long history is kept</h2>
          </div>
          <span className="section-state">{data?.retention.windowDays ? `${data.retention.windowDays} DAYS` : "KEEP ALL"}</span>
        </div>
        <p className="policy-disclaimer">
          Zero keeps every event. A window removes older events in the daily job; the job first writes an{" "}
          <code>AUDIT_RETENTION_APPLIED</code> marker naming the deleted range and tail hash, so the verifier treats
          that gap as declared rather than tampering.
        </p>
        <div className="audit-retention">
          <label>
            <span>Window in days</span>
            <input
              type="number"
              min={0}
              max={3650}
              step={1}
              value={retentionDays}
              onChange={(event) => setRetentionDays(event.target.value)}
              disabled={!canManage || busy}
            />
          </label>
          <button
            type="button"
            className="primary-button"
            onClick={() => void saveRetention()}
            disabled={!canManage || busy}
          >
            Save window
          </button>
        </div>
        {!canManage && (
          <p className="policy-disclaimer">Saving a retention window needs the audit.manage permission.</p>
        )}
        {retentionNotice && <p className="policy-disclaimer" role="status">{retentionNotice}</p>}
        {data?.retention.updatedAt && (
          <p className="policy-disclaimer">
            Last saved {new Date(data.retention.updatedAt).toLocaleString()}
            {data.retention.updatedByUserId ? ` by ${data.retention.updatedByUserId}` : ""}.
          </p>
        )}
      </section>

      <section className="data-section" aria-labelledby="audit-events-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">03 / EVENTS</div>
            <h2 id="audit-events-title">The trail, newest first</h2>
          </div>
          <span className="section-state">
            {data ? `${data.events.length} OF ${data.total}` : "—"}
          </span>
        </div>

        <form
          className="audit-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied(filters);
            setBusy(true);
            void load(filters);
          }}
        >
          {(
            [
              ["actor", "Actor user id"],
              ["target", "Target id or type"],
              ["action", "Action contains"],
              ["correlationId", "Correlation id"],
              ["source", "Source"],
              ["from", "From"],
              ["to", "To"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              <span>{label}</span>
              <input
                type={key === "from" || key === "to" ? "date" : "text"}
                value={filters[key]}
                onChange={(event) => setFilters((current) => ({ ...current, [key]: event.target.value }))}
              />
            </label>
          ))}
          <div className="audit-filters__actions">
            <button type="submit" className="primary-button" disabled={busy}>
              Apply filters
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setApplied(EMPTY_FILTERS);
                setBusy(true);
                void load(EMPTY_FILTERS);
              }}
              disabled={busy}
            >
              Clear
            </button>
            <a className="ghost-button" href={exportHref} download>
              <Download size={14} aria-hidden="true" /> JSON
            </a>
            <a className="ghost-button" href={`${exportHref}&format=csv`} download>
              <Download size={14} aria-hidden="true" /> CSV
            </a>
          </div>
        </form>

        {error && (
          <p className="policy-disclaimer" role="alert">
            {error}
          </p>
        )}
        {!data && !error && <p className="policy-disclaimer" role="status">Reading the audit trail…</p>}
        {data?.truncated && (
          <p className="policy-disclaimer" role="status">
            Showing the newest {data.limit} of {data.total} matching events. Narrow the filters or export the range.
          </p>
        )}

        {data && data.events.length === 0 && !error && (
          <p className="policy-disclaimer">No audit event matches these filters.</p>
        )}

        <ol className="audit-events">
          {data?.events.map((event) => (
            <li key={event.id} className={`audit-event ${event.outcome !== "SUCCESS" ? "is-failure" : ""}`}>
              <div className="audit-event__head">
                <span className="audit-event__index">{event.chainIndex ?? "legacy"}</span>
                <strong>{event.action}</strong>
                <span className="audit-event__time">{new Date(event.occurredAt).toLocaleString()}</span>
              </div>
              <dl className="audit-event__facts">
                <div>
                  <dt>Actor</dt>
                  <dd>{event.actorUserId ?? "system"}</dd>
                </div>
                <div>
                  <dt>Target</dt>
                  <dd>
                    {event.objectType}
                    {event.objectId ? ` · ${event.objectId}` : ""}
                  </dd>
                </div>
                <div>
                  <dt>Outcome</dt>
                  <dd>{event.outcome}</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>{event.source ?? "—"}</dd>
                </div>
                <div>
                  <dt>Correlation</dt>
                  <dd>
                    {event.correlationId ? (
                      <button
                        type="button"
                        className="audit-link-button"
                        onClick={() => {
                          const next = { ...EMPTY_FILTERS, correlationId: event.correlationId ?? "" };
                          setFilters(next);
                          setApplied(next);
                          setBusy(true);
                          void load(next);
                        }}
                      >
                        {event.correlationId}
                      </button>
                    ) : (
                      "—"
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Hash</dt>
                  <dd title={event.hash ?? undefined}>{shortHash(event.hash)}</dd>
                </div>
              </dl>
              <details className="audit-event__details">
                <summary>Before, after and payload</summary>
                <div className="audit-event__values">
                  <div>
                    <span>Before</span>
                    <pre>{showValue(event.before)}</pre>
                  </div>
                  <div>
                    <span>After</span>
                    <pre>{showValue(event.after)}</pre>
                  </div>
                  <div>
                    <span>Payload</span>
                    <pre>{showValue(event.payload)}</pre>
                  </div>
                </div>
              </details>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
