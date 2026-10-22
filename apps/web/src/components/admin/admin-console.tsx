"use client";

import { CircleAlert, RefreshCw, Save, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ledgerCorrectionEffectText,
  serializeAdminQuery,
  validateLedgerCorrection,
  type AdminBalanceRow,
  type AdminFilters,
  type AdminRow,
  type AdminSectionId,
  type AdminTimelineItem,
  type SavedAdminView,
} from "@/lib/admin/views";
import { REQUEST_ID_HEADER } from "@/lib/observability/request-id";

/**
 * The admin console's client surface.
 *
 * It owns no rule: the section vocabulary, the saved-view round trip and the
 * correction contract are the ones the API uses, imported from the same module.
 * The list is fetched per section + filter + column state, the current state is
 * written into the URL, and a saved view applies its stored query to that same
 * state — which is why a reload restores it.
 *
 * Failure is always a sentence. A refused request names what failed and clears
 * the loading state; there is no path where a panel spins forever because a
 * `fetch` rejected.
 */

export type SectionView = {
  id: AdminSectionId;
  label: string;
  description: string;
  columns: { key: string; label: string }[];
  defaultColumns: string[];
  filters: {
    key: string;
    label: string;
    kind: "text" | "select" | "date";
    placeholder?: string;
    options?: readonly string[];
  }[];
};

type ListPayload = {
  section: string;
  label: string;
  description: string;
  filters: AdminFilters;
  columns: string[];
  availableColumns: { key: string; label: string }[];
  rows: AdminRow[];
  total: number;
  readAt: string;
  truncated: boolean;
  error?: string;
};

type SearchPayload = {
  q: string;
  interpretedAs: { kind: string; value: string };
  matches: { kind: string; id: string; label: string; detail: string; subjectUserId: string | null }[];
  count: number;
  error?: string;
};

type RecordPayload = {
  type: string;
  id: string;
  title: string;
  subtitle: string;
  subjectUserId: string | null;
  fields: { label: string; value: string }[];
  balances: AdminBalanceRow[];
  reconciliation: { ok: boolean; differences: string[] } | null;
  timeline: AdminTimelineItem[];
  related: {
    ledger: number;
    decisions: number;
    deliveries: number;
    audit: number;
    signins: number;
    deposits: number;
    withdrawals: number;
    trades: number;
    support: number;
  };
  readAt: string;
  error?: string;
};

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    const response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...init });
    const payload: unknown = await response.json().catch(() => null);
    const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    if (!response.ok) {
      const reason = typeof record.error === "string" ? record.error : `The console answered ${response.status}.`;
      const requestId = response.headers.get(REQUEST_ID_HEADER);
      return { error: requestId ? `${reason} (request ${requestId})` : reason } as T;
    }
    return payload as T;
  } catch {
    return { error: `The console could not reach ${path}.` } as T;
  }
}

function moment(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.toISOString().slice(0, 16).replace("T", " ")} UTC` : value;
}

export function AdminConsole({
  sections,
  initialSection,
  initialFilters,
  initialColumns,
  initialError,
}: {
  sections: SectionView[];
  initialSection: AdminSectionId;
  initialFilters: AdminFilters;
  initialColumns: string[];
  initialError?: string;
}) {
  const [sectionId, setSectionId] = useState<AdminSectionId>(initialSection);
  const [filters, setFilters] = useState<AdminFilters>(initialFilters);
  const [columns, setColumns] = useState<string[]>(initialColumns);
  const [list, setList] = useState<ListPayload | null>(null);
  const [listError, setListError] = useState<string | null>(initialError ?? null);
  // Loading is derived from whether the query on screen has an answer, not set
  // synchronously by an effect: that keeps the render in step with the URL and
  // avoids a second render merely to say "still reading".
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [views, setViews] = useState<SavedAdminView[]>([]);
  const [viewName, setViewName] = useState("");
  const [viewMessage, setViewMessage] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResult, setSearchResult] = useState<SearchPayload | null>(null);
  const [searching, setSearching] = useState(false);
  const [detail, setDetail] = useState<RecordPayload | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const section = sections.find((candidate) => candidate.id === sectionId) ?? sections[0]!;
  const query = useMemo(() => serializeAdminQuery(sectionId, filters, columns), [sectionId, filters, columns]);
  const visibleList = list && list.section === sectionId && loadedQuery === query ? list : null;

  const loadViews = useCallback(async () => {
    const payload = await readJson<{ views: SavedAdminView[]; error?: string }>(`/api/admin/views?section=${sectionId}`);
    if (payload.error) {
      setViewMessage(payload.error);
      return;
    }
    setViews(payload.views ?? []);
  }, [sectionId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const payload = await readJson<{ views: SavedAdminView[]; error?: string }>(
        `/api/admin/views?section=${sectionId}`,
      );
      if (cancelled) return;
      if (payload.error) {
        setViewMessage(payload.error);
        return;
      }
      setViews(payload.views ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [sectionId, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      const payload = await readJson<ListPayload>(`/api/admin/console?${query}`, { signal: controller.signal });
      if (cancelled) return;
      setLoadedQuery(query);
      if (payload.error) {
        setListError(payload.error);
        setList(null);
        return;
      }
      setListError(null);
      setList(payload);
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [query, refreshKey]);

  const loading = loadedQuery !== query;

  useEffect(() => {
    window.history.replaceState(null, "", `/admin?${query}`);
  }, [query]);

  const openRecord = useCallback(async (type: string, id: string) => {
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    const payload = await readJson<RecordPayload>(
      `/api/admin/console/record?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`,
    );
    if (payload.error) {
      setDetailError(payload.error);
      setDetailLoading(false);
      return;
    }
    setDetail(payload);
    setDetailLoading(false);
  }, []);

  function changeSection(next: AdminSectionId) {
    const config = sections.find((candidate) => candidate.id === next);
    if (!config) return;
    setSectionId(next);
    setFilters({});
    setColumns(config.defaultColumns);
    setList(null);
    setViewMessage(null);
    setDetail(null);
    setDetailError(null);
  }

  function applyView(view: SavedAdminView) {
    const config = sections.find((candidate) => candidate.id === view.section);
    if (!config) return;
    setSectionId(view.section);
    setFilters(view.filters);
    setColumns(view.columns.length > 0 ? view.columns : config.defaultColumns);
    setViewMessage(`Applied “${view.name}”.`);
    setDetail(null);
  }

  async function saveView() {
    const result = await readJson<{ view?: SavedAdminView; error?: string }>("/api/admin/views", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: viewName, section: sectionId, filters, columns }),
    });
    if (result.error) {
      setViewMessage(result.error);
      return;
    }
    setViewMessage(`Saved “${result.view?.name}” with ${columns.length} column(s) and ${Object.keys(filters).length} filter(s).`);
    setViewName("");
    await loadViews();
  }

  async function removeView(view: SavedAdminView) {
    const result = await readJson<{ deleted?: boolean; error?: string }>(`/api/admin/views?id=${encodeURIComponent(view.id)}`, {
      method: "DELETE",
    });
    setViewMessage(result.error ?? `Deleted “${view.name}”.`);
    await loadViews();
  }

  async function runSearch() {
    if (searchTerm.trim().length < 2) {
      setSearchResult({ q: searchTerm, interpretedAs: { kind: "identifier", value: searchTerm }, matches: [], count: 0, error: "Search needs at least two characters." });
      return;
    }
    setSearching(true);
    const payload = await readJson<SearchPayload>(`/api/admin/console/search?q=${encodeURIComponent(searchTerm.trim())}`);
    setSearchResult(payload);
    setSearching(false);
  }

  function toggleColumn(key: string) {
    setColumns((current) => {
      if (current.includes(key)) {
        const next = current.filter((column) => column !== key);
        return next.length === 0 ? current : next;
      }
      return section.columns.map((column) => column.key).filter((column) => column === key || current.includes(column));
    });
  }

  const selectedColumns = section.columns.filter((column) => (visibleList?.columns ?? columns).includes(column.key));

  return (
    <div className="admin-console">
      <nav className="admin-console__sections" aria-label="Console sections">
        {sections.map((candidate) => (
          <button
            aria-current={candidate.id === sectionId ? "page" : undefined}
            className={`admin-console__section${candidate.id === sectionId ? " is-active" : ""}`}
            key={candidate.id}
            onClick={() => changeSection(candidate.id)}
            type="button"
          >
            {candidate.label}
          </button>
        ))}
      </nav>

      <section className="data-section" aria-labelledby="admin-console-search-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">CROSS-ENTITY SEARCH</div>
            <h2 id="admin-console-search-title">One box, every record</h2>
          </div>
          <span className="section-state">WALLET · HASH · USER ID · ORDER ID</span>
        </div>
        <form
          className="admin-console__search"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch();
          }}
        >
          <label className="trading-field">
            <span>Search term</span>
            <input
              maxLength={160}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="0x… wallet, 0x… hash, user id or order id"
              value={searchTerm}
            />
          </label>
          <button className="section-action" disabled={searching} type="submit">
            <Search aria-hidden="true" size={14} />
            {searching ? "SEARCHING" : "SEARCH"}
          </button>
        </form>
        {searchResult?.error && (
          <p className="admin-console__error" role="alert">
            <CircleAlert aria-hidden="true" size={14} /> {searchResult.error}
          </p>
        )}
        {searchResult && !searchResult.error && (
          <div className="admin-console__search-results" role="status">
            <p>
              Read <code>{searchResult.q}</code> as {searchResult.interpretedAs.kind}. {searchResult.count} record(s).
            </p>
            {searchResult.matches.length === 0 ? (
              <p className="trading-empty">Nothing matches. A seeded wallet, hash or order id is the fastest check.</p>
            ) : (
              <ul>
                {searchResult.matches.map((match) => (
                  <li key={`${match.kind}-${match.id}`}>
                    <button className="admin-console__link" onClick={() => void openRecord(match.kind === "user" ? "user" : match.kind, match.id)} type="button">
                      <strong>{match.label}</strong>
                      <span>{match.kind} · {match.detail}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="data-section" aria-labelledby="admin-console-list-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">SECTION / {section.label.toUpperCase()}</div>
            <h2 id="admin-console-list-title">{section.label}</h2>
            <p>{section.description}</p>
          </div>
          <span className="section-state">{loading ? "READING" : `${visibleList?.total ?? 0} ROW(S)`}</span>
        </div>

        <div className="admin-console__toolbar">
          <form className="admin-console__filters" onSubmit={(event) => event.preventDefault()}>
            {section.filters.map((filter) => (
              <label className="trading-field" key={filter.key}>
                <span>{filter.label}</span>
                {filter.kind === "select" ? (
                  <select
                    onChange={(event) => setFilters((current) => ({ ...current, [filter.key]: event.target.value }))}
                    value={filters[filter.key] ?? ""}
                  >
                    <option value="">Any</option>
                    {(filter.options ?? []).map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    maxLength={160}
                    onChange={(event) => setFilters((current) => ({ ...current, [filter.key]: event.target.value }))}
                    placeholder={filter.placeholder}
                    type={filter.kind === "date" ? "date" : "text"}
                    value={filters[filter.key] ?? ""}
                  />
                )}
              </label>
            ))}
            <button
              className="section-action"
              onClick={() => setFilters({})}
              type="button"
            >
              <X aria-hidden="true" size={14} /> CLEAR FILTERS
            </button>
          </form>

          <fieldset className="admin-console__columns">
            <legend>Columns</legend>
            {section.columns.map((column) => (
              <label key={column.key}>
                <input
                  checked={(visibleList?.columns ?? columns).includes(column.key)}
                  onChange={() => toggleColumn(column.key)}
                  type="checkbox"
                />
                {column.label}
              </label>
            ))}
          </fieldset>
        </div>

        <div className="admin-console__views">
          <div className="admin-console__views-head">
            <strong>Saved views</strong>
            <span>Stored for this owner, per section</span>
          </div>
          <div className="admin-console__views-list">
            {views.length === 0 ? (
              <span className="admin-console__muted">No saved view for this section yet.</span>
            ) : (
              views.map((view) => (
                <span className="admin-console__view" key={view.id}>
                  <button onClick={() => applyView(view)} type="button">{view.name}</button>
                  <button aria-label={`Delete ${view.name}`} onClick={() => void removeView(view)} type="button">
                    <Trash2 aria-hidden="true" size={12} />
                  </button>
                </span>
              ))
            )}
          </div>
          <div className="admin-console__save-view">
            <label className="trading-field">
              <span>Save this view as</span>
              <input maxLength={60} onChange={(event) => setViewName(event.target.value)} placeholder="Unsettled withdrawals" value={viewName} />
            </label>
            <button className="section-action" disabled={viewName.trim().length === 0} onClick={() => void saveView()} type="button">
              <Save aria-hidden="true" size={14} /> SAVE VIEW
            </button>
          </div>
          {viewMessage && <p className="admin-console__muted" role="status">{viewMessage}</p>}
        </div>

        {listError && (
          <p className="admin-console__error" role="alert">
            <CircleAlert aria-hidden="true" size={14} /> {listError}
          </p>
        )}
        {loading && !visibleList && <p className="admin-console__muted" role="status">Reading {section.label.toLowerCase()}…</p>}

        {visibleList && !listError && (
          <>
            <div className="market-history-table-wrap">
              <table className="market-history-table admin-console__table">
                <caption>
                  {section.label} · {visibleList.total} row(s), read {moment(visibleList.readAt)}. Select a row to read its full record and
                  timeline.
                </caption>
                <thead>
                  <tr>
                    {selectedColumns.map((column) => (
                      <th key={column.key} scope="col">{column.label}</th>
                    ))}
                    <th scope="col">Record</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleList.rows.map((entry) => (
                    <tr key={`${entry.recordType}-${entry.id}`}>
                      {selectedColumns.map((column) => (
                        <td key={column.key}>{entry.cells[column.key] ?? "—"}</td>
                      ))}
                      <td>
                        <button className="admin-console__link" onClick={() => void openRecord(entry.recordType, entry.id)} type="button">
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {visibleList.rows.length === 0 && (
              <p className="trading-empty" role="status">No row matches these filters. Clearing them reads the whole section again.</p>
            )}
            {visibleList.truncated && (
              <p className="admin-console__muted" role="status">
                Showing the first {visibleList.rows.length} of {visibleList.total} rows. Narrow the filters to read the rest.
              </p>
            )}
          </>
        )}
      </section>

      <section className="data-section" aria-labelledby="admin-console-record-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">DRILL-DOWN / ONE TIMELINE</div>
            <h2 id="admin-console-record-title">Record and timeline</h2>
          </div>
          <span className="section-state">
            {detail
              ? `${detail.related.signins} SIGN-IN(S) · ${detail.related.deposits} DEPOSIT(S) · ${detail.related.withdrawals} WITHDRAWAL(S) · ${detail.related.trades} TRADE(S) · ${detail.related.support} SUPPORT · ${detail.related.audit} AUDIT`
              : "NO ROW OPEN"}
          </span>
        </div>

        {detailLoading && <p className="admin-console__muted" role="status">Reading the record…</p>}
        {detailError && (
          <p className="admin-console__error" role="alert">
            <CircleAlert aria-hidden="true" size={14} /> {detailError}
          </p>
        )}
        {!detail && !detailLoading && !detailError && (
          <p className="trading-empty" role="status">
            Open a row above, or a search result, to read its fields, balances, ledger entries, strategy decisions,
            notification deliveries and audit events in one place.
          </p>
        )}

        {detail && (
          <div className="admin-console__record">
            <header>
              <div>
                <strong>{detail.title}</strong>
                <span>{detail.subtitle}</span>
              </div>
              <button className="section-action" onClick={() => setDetail(null)} type="button">
                <X aria-hidden="true" size={14} /> CLOSE
              </button>
            </header>

            <dl className="admin-console__fields">
              {detail.fields.map((field) => (
                <div key={`${field.label}-${field.value.slice(0, 20)}`}>
                  <dt>{field.label}</dt>
                  <dd>{field.value}</dd>
                </div>
              ))}
              <div>
                <dt>Record id</dt>
                <dd><code>{detail.id}</code></dd>
              </div>
            </dl>

            {detail.balances.length > 0 && (
              <div className="admin-console__balances">
                <div className="admin-console__balances-head">
                  <strong>Balances from the ledger</strong>
                  <span className={detail.reconciliation?.ok ? "is-ok" : "is-bad"}>
                    {detail.reconciliation?.ok ? "RECONCILES WITH /account" : "DOES NOT RECONCILE"}
                  </span>
                </div>
                <ul>
                  {detail.balances.map((balance) => (
                    <li key={balance.asset}>
                      <strong>{balance.asset}</strong>
                      <span>available {balance.available}</span>
                      <span>held {balance.held}</span>
                      <span>total {balance.total}</span>
                      <span>{balance.accounts.map((account) => account.code).join(" · ")}</span>
                    </li>
                  ))}
                </ul>
                {detail.reconciliation && !detail.reconciliation.ok && (
                  <ul className="admin-console__error">
                    {detail.reconciliation.differences.map((difference) => (
                      <li key={difference}>{difference}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {detail.subjectUserId && (
              <CorrectionForm
                balances={detail.balances}
                onDone={async () => {
                  await openRecord(detail.type, detail.id);
                  setRefreshKey((key) => key + 1);
                }}
                subjectUserId={detail.subjectUserId}
                subjectLabel={detail.title}
              />
            )}

            <div className="admin-console__timeline">
              <div className="admin-console__timeline-head">
                <strong>Timeline</strong>
                <span>{detail.timeline.length} event(s), newest first</span>
              </div>
              {detail.timeline.length === 0 ? (
                <p className="trading-empty" role="status">No ledger, decision, delivery or audit event exists for this record yet.</p>
              ) : (
                <ol>
                  {detail.timeline.map((item) => (
                    <li className={`admin-console__timeline-item admin-console__timeline-item--${item.category}`} key={item.id}>
                      <span className="admin-console__timeline-category">{item.category}</span>
                      <strong>{item.title}</strong>
                      <span>{item.detail}</span>
                      <time dateTime={item.occurredAt}>{moment(item.occurredAt)}</time>
                      <small>{item.source}</small>
                      {item.record && (
                        <button
                          className="admin-console__link"
                          onClick={() => void openRecord(item.record!.type, item.record!.id)}
                          type="button"
                        >
                          Open {item.record.type}
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function CorrectionForm({
  subjectUserId,
  subjectLabel,
  balances,
  onDone,
}: {
  subjectUserId: string;
  subjectLabel: string;
  balances: AdminBalanceRow[];
  onDone: () => Promise<void>;
}) {
  const [asset, setAsset] = useState(balances[0]?.asset ?? "USDT");
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState<"CREDIT" | "DEBIT">("CREDIT");
  const [decimals, setDecimals] = useState(balances[0]?.decimals ?? 6);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const balance = balances.find((candidate) => candidate.asset === asset.toUpperCase());
  const validation = validateLedgerCorrection({
    userId: subjectUserId,
    asset,
    amount,
    direction,
    decimals,
    reason,
    idempotencyKey: "preview-000000",
  });
  const effect = validation.valid
    ? ledgerCorrectionEffectText({
        value: validation.value,
        userLabel: subjectLabel,
        beforeAvailable: balance?.available ?? "0",
        beforeTotal: balance?.total ?? "0",
      })
    : null;

  async function submit() {
    setBusy(true);
    setMessage(null);
    setError(null);
    const idempotencyKey = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `admin-correction:${crypto.randomUUID()}`
      : `admin-correction:${Date.now()}`;
    const result = await readJson<{ message?: string; error?: string }>("/api/admin/console/correction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: subjectUserId, asset, amount, direction, decimals, reason, idempotencyKey }),
    });
    if (result.error) {
      setError(result.error);
      setBusy(false);
      return;
    }
    setMessage(result.message ?? "Posted and audited.");
    setAmount("");
    setReason("");
    setBusy(false);
    await onDone();
  }

  return (
    <div className="admin-console__correction">
      <div className="admin-console__correction-head">
        <strong>Correct this account&apos;s balance</strong>
        <span>Posts one balanced entry and writes its audit event in the same transaction.</span>
      </div>
      <div className="admin-console__correction-grid">
        <label className="trading-field">
          <span>Asset</span>
          <input maxLength={12} onChange={(event) => setAsset(event.target.value.toUpperCase())} value={asset} />
        </label>
        <label className="trading-field">
          <span>Direction</span>
          <select onChange={(event) => setDirection(event.target.value === "DEBIT" ? "DEBIT" : "CREDIT")} value={direction}>
            <option value="CREDIT">CREDIT — add to the account</option>
            <option value="DEBIT">DEBIT — remove from the account</option>
          </select>
        </label>
        <label className="trading-field">
          <span>Amount</span>
          <input inputMode="decimal" maxLength={32} onChange={(event) => setAmount(event.target.value)} placeholder="10.5" value={amount} />
        </label>
        <label className="trading-field">
          <span>Decimals</span>
          <input
            max={18}
            min={0}
            onChange={(event) => setDecimals(Number(event.target.value))}
            type="number"
            value={decimals}
          />
        </label>
        <label className="trading-field admin-console__correction-reason">
          <span>Reason (stored in the audit event)</span>
          <input maxLength={200} onChange={(event) => setReason(event.target.value)} placeholder="Correcting a mispriced deposit" value={reason} />
        </label>
      </div>
      <p className="admin-console__effect" role="note">
        {effect ?? "Fill the asset, amount, direction and reason to see exactly what this will change before it runs."}
      </p>
      <div className="admin-console__correction-actions">
        <button className="section-action" disabled={busy || !validation.valid} onClick={() => void submit()} type="button">
          {busy ? <RefreshCw aria-hidden="true" className="login-spinner" size={14} /> : null}
          {busy ? "POSTING" : `POST ${direction}`}
        </button>
        <span>Current {asset}: available {balance?.available ?? "0"}, total {balance?.total ?? "0"}.</span>
      </div>
      {message && <p className="admin-console__success" role="status">{message}</p>}
      {error && (
        <p className="admin-console__error" role="alert">
          <CircleAlert aria-hidden="true" size={14} /> {error}
        </p>
      )}
    </div>
  );
}
