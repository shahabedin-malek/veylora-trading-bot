"use client";

import { CircleAlert, Download, FileJson, History, Link2, RefreshCw, Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { REQUEST_ID_HEADER } from "@/lib/observability/request-id";

/**
 * The account surface.
 *
 * It decides nothing. Every figure, every total and every sentence about where a
 * figure came from is read from the server on each load; the component knows no
 * balance, computes no total, and never adds two numbers together. That is the whole
 * reason the export is a link to the same view the page is rendering rather than a
 * second rendering of it — and it is why the totals under the history and the totals
 * in the file cannot disagree.
 *
 * Three details of the surface are deliberate.
 *
 *  - **Every block says its source and its as-of.** The badge beside a heading names
 *    the block's own source and the moment it was read, so a stale figure is obvious
 *    rather than merely old-looking.
 *  - **A filter is applied on purpose, not on every keystroke.** The date range and
 *    the type chips apply immediately because they are single decisions; the asset and
 *    the hash search are text, so they apply when the owner says so.
 *  - **The import is a separate act with a separate result.** Reading a venue is a
 *    network call to somebody else's system, so it happens only when asked for, and
 *    what comes back is displayed as external — never merged into the balances above.
 */

type FigureSource = { label: string; detail: string; asOf: string };

type BalanceAccount = {
  code: string;
  bucket: string;
  label: string;
  description: string;
  balanceMinor: string;
  balance: string;
  entries: number;
};

type AssetBalance = {
  asset: string;
  decimals: number;
  availableMinor: string;
  available: string;
  heldMinor: string;
  held: string;
  totalMinor: string;
  total: string;
  accounts: BalanceAccount[];
};

type Position = {
  market: string;
  asset: string;
  venues: string[];
  quantity: string;
  averageCostUsd: string | null;
  costBasisUsd: string | null;
  realisedPnlUsd: string;
  markPriceUsd: string | null;
  markSource: string | null;
  markAsOf: string | null;
  markFreshness: string | null;
  marketValueUsd: string | null;
  unrealisedPnlUsd: string | null;
  filledOrders: number;
  note: string | null;
};

type Pnl = {
  realisedUsd: string;
  unrealisedUsd: string | null;
  netUsd: string | null;
  pricedMarkets: number;
  unpricedMarkets: string[];
  sources: FigureSource[];
};

type PaperPerformanceOrder = {
  orderId: string;
  occurredAt: string;
  market: string;
  side: "BUY" | "SELL";
  orderType: string;
  status: string;
  statusLabel: string;
  requestedQuantity: string;
  filledQuantity: string;
  unitPriceUsd: string;
  notionalUsd: string;
  realisedUsd: string;
  outcome: "CLOSED" | "OPEN" | "NO_RESULT";
  outcomeDetail: string;
  markPriceUsd: string | null;
  markAsOf: string | null;
};

type PaperPerformance = {
  origin: "assistant";
  readAt: string;
  scope: string;
  summary: {
    orders: number;
    filledOrders: number;
    closedOrders: number;
    openOrders: number;
    unfilledOrders: number;
    realisedUsd: string;
    openUnrealisedUsd: string | null;
    openMarkets: string[];
    unpricedMarkets: string[];
    venues: string[];
  };
  orders: PaperPerformanceOrder[];
  markets: Position[];
  sources: FigureSource[];
  notes: string[];
};

type PeriodSummary = {
  from: string;
  to: string;
  assets: {
    asset: string;
    decimals: number;
    inflowMinor: string;
    inflow: string;
    outflowMinor: string;
    outflow: string;
    withdrawalFeesMinor: string;
    withdrawalFees: string;
    performanceFeesMinor: string;
    performanceFees: string;
    feesMinor: string;
    fees: string;
    netMinor: string;
    net: string;
    deposits: number;
    withdrawals: number;
  }[];
  trading: { realisedUsd: string; filledOrders: number; markets: string[] };
  sources: FigureSource[];
};

type HistoryRow = {
  id: string;
  occurredAt: string;
  category: string;
  type: string;
  status: string;
  asset: string;
  decimals: number;
  amountMinor: string;
  amount: string;
  detail: string;
  counterparty: string | null;
  txHash: string | null;
  reference: string;
  source: string;
};

type HistoryTotal = {
  asset: string;
  decimals: number;
  inMinor: string;
  inDecimal: string;
  outMinor: string;
  outDecimal: string;
  netMinor: string;
  netDecimal: string;
  lineCount: number;
  statementClosingMinor: string | null;
  statementClosingDecimal: string | null;
  balanceMinor: string;
  balanceDecimal: string;
};

type ExternalSource = {
  credentialId: string;
  venue: string;
  label: string;
  readOnly: boolean;
  status: "imported" | "failed";
  asOf: string;
  balances: { asset: string; available: string; total: string }[];
  trades: { id: string; summary: string; occurredAt: string | null }[];
  raw: unknown;
  reason: string | null;
  note: string;
};

type ExternalImport = {
  spendable: false;
  sources: ExternalSource[];
  skipped: { credentialId: string; venue: string; label: string; reason: string }[];
  asOf: string;
  note: string;
};

type AccountPayload = {
  readAt?: string;
  range?: { from: string; to: string };
  filter?: { asset: string | null; types: string[]; hash: string | null };
  balances?: AssetBalance[];
  positions?: Position[];
  pnl?: Pnl;
  summary?: PeriodSummary;
  paperPerformance?: PaperPerformance;
  history?: HistoryRow[];
  totals?: HistoryTotal[];
  sources?: FigureSource[];
  notes?: string[];
  external?: ExternalImport | null;
  markFailure?: string | null;
  error?: string;
};

const HISTORY_TYPES = [
  "DEPOSIT",
  "WITHDRAWAL",
  "DEPOSIT_CREDITED",
  "DEPOSIT_REVERSED",
  "WITHDRAWAL_RESERVED",
  "WITHDRAWAL_RELEASED",
  "WITHDRAWAL_SETTLED",
] as const;

function dateInputValue(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function displayMoment(value: string | null | undefined): string {
  if (!value) return "not read";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.toISOString().slice(0, 16).replace("T", " ")} UTC` : "not read";
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function SourceNote({ sources }: { sources: FigureSource[] }) {
  return (
    <ul className="account-sources">
      {sources.map((source) => (
        <li key={`${source.label}-${source.detail.slice(0, 24)}`}>
          <strong>{source.label}</strong>
          <span>{source.detail}</span>
          <span className="account-asof">AS OF {displayMoment(source.asOf)}</span>
        </li>
      ))}
    </ul>
  );
}

async function request(path: string): Promise<AccountPayload> {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin" });
  const payload: unknown = await response.json().catch(() => null);
  const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  if (!response.ok) {
    const serverReason = typeof record.error === "string" ? record.error : null;
    const requestId = response.headers.get(REQUEST_ID_HEADER);
    const refusal = serverReason ?? `The account view answered ${response.status} and returned nothing.`;
    return { error: requestId ? `${refusal} (request ${requestId})` : refusal };
  }
  return payload as AccountPayload;
}

function queryString(filter: { from: string; to: string; asset: string; hash: string; types: string[] }): string {
  const params = new URLSearchParams();
  if (filter.from) params.set("from", filter.from);
  if (filter.to) params.set("to", filter.to);
  if (filter.asset.trim()) params.set("asset", filter.asset.trim());
  if (filter.hash.trim()) params.set("hash", filter.hash.trim());
  if (filter.types.length > 0) params.set("type", filter.types.join(","));
  return params.toString();
}

export function AccountOverview() {
  const today = new Date();
  const [from, setFrom] = useState(dateInputValue(new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)));
  const [to, setTo] = useState(dateInputValue(today));
  const [asset, setAsset] = useState("");
  const [hash, setHash] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [data, setData] = useState<AccountPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);

  const filter = { from, to, asset, hash, types };
  const query = queryString(filter);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await request(`/api/account${query ? `?${query}` : ""}`);
    if (result.error) {
      setError(result.error);
      setLoading(false);
      return;
    }
    setError(null);
    setData((current) => ({ ...result, external: current?.external ?? null }));
    setLoading(false);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const result = await request(`/api/account${query ? `?${query}` : ""}`);
      if (cancelled) return;
      if (result.error) {
        setError(result.error);
        setLoading(false);
        return;
      }
      setError(null);
      setData((current) => ({ ...result, external: current?.external ?? null }));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [query]);

  async function importExternal() {
    setImporting(true);
    setImportNote(null);
    try {
      const result = await request(`/api/account?external=1${query ? `&${query}` : ""}`);
      if (result.error) {
        setError(result.error);
        return;
      }
      setData((current) => ({ ...(current ?? {}), ...result, external: result.external ?? null }));
      const sources = result.external?.sources ?? [];
      setImportNote(
        sources.length === 0
          ? "No read-only key is connected, so there was nothing to import. Mark a key read-only when you connect it, and this path will read it."
          : `Read ${sources.length} read-only key(s) at ${displayMoment(result.external?.asOf)}. These figures are external and are not part of the balances above.`,
      );
    } finally {
      setImporting(false);
    }
  }

  function toggleType(type: string) {
    setTypes((current) => (current.includes(type) ? current.filter((item) => item !== type) : [...current, type]));
  }

  const exportHref = (format: "csv" | "json") => `/api/account/export?format=${format}${query ? `&${query}` : ""}`;
  const paper = data?.paperPerformance ?? null;

  return (
    <div className="account-overview">
      {error && (
        <div className="market-chart-empty" role="alert">
          <CircleAlert aria-hidden="true" size={16} />
          <strong>The account view could not be read</strong>
          <span>{error}</span>
        </div>
      )}

      <section className="data-section" aria-labelledby="account-balances-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">01 / BALANCES</div>
            <h2 id="account-balances-title">What this account holds</h2>
          </div>
          <div className="account-read-actions">
            <button className="section-action" disabled={loading} onClick={() => void load()} type="button">
              <RefreshCw aria-hidden="true" className={loading ? "login-spinner" : undefined} size={14} />
              {loading ? "READING" : "READ AGAIN"}
            </button>
            <span className="section-state">READ {displayMoment(data?.readAt).toUpperCase()}</span>
          </div>
        </div>
        {(data?.balances?.length ?? 0) === 0 ? (
          <p className="trading-empty" role="status">
            This account holds nothing yet. A credited deposit is the first thing that appears here, and it appears
            because the ledger has an entry for it — not because a balance was stored.
          </p>
        ) : (
          <div className="account-balance-grid">
            {data?.balances?.map((balance) => (
              <article className="account-balance-card" key={balance.asset}>
                <header>
                  <Wallet aria-hidden="true" size={14} />
                  <strong>{balance.asset}</strong>
                  <span className="account-balance-total">{balance.total}</span>
                </header>
                <dl>
                  <div>
                    <dt>Spendable</dt>
                    <dd>{balance.available}</dd>
                  </div>
                  <div>
                    <dt>Held against a withdrawal</dt>
                    <dd>{balance.held}</dd>
                  </div>
                </dl>
                <ul className="account-provenance">
                  {balance.accounts.map((account) => (
                    <li key={account.code}>
                      <code>{account.code}</code>
                      <span>
                        {account.balance} · {account.entries} entr{account.entries === 1 ? "y" : "ies"}
                      </span>
                      <span className="account-asof">{account.description}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        )}
        <SourceNote sources={data?.sources ?? []} />
      </section>

      <section className="data-section" aria-labelledby="account-positions-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">02 / POSITIONS AND PROFIT</div>
            <h2 id="account-positions-title">Cost basis, marks and the result</h2>
          </div>
          <span className="section-state">
            REALISED {data?.pnl?.realisedUsd ?? "0"} USD · UNREALISED{" "}
            {data?.pnl?.unrealisedUsd ? `${data.pnl.unrealisedUsd} USD` : "UNAVAILABLE"}
          </span>
        </div>
        {data?.markFailure && (
          <p className="trading-security-note" role="status">
            No mark could be read for this account&apos;s markets: {data.markFailure} Positions are therefore shown
            without a market value or an unrealised figure rather than with an estimate.
          </p>
        )}
        {(data?.positions?.length ?? 0) === 0 ? (
          <p className="trading-empty" role="status">
            No filled order on this account, so there is no position to cost. Every order placed here goes to the
            development paper venue, and a position appears the moment one of those fills.
          </p>
        ) : (
          <div className="market-table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Market</th>
                  <th scope="col">Quantity</th>
                  <th scope="col">Average cost</th>
                  <th scope="col">Cost basis</th>
                  <th scope="col">Mark</th>
                  <th scope="col">Market value</th>
                  <th scope="col">Realised</th>
                  <th scope="col">Unrealised</th>
                </tr>
              </thead>
              <tbody>
                {data?.positions?.map((position) => (
                  <tr key={position.market}>
                    <th scope="row">
                      {position.market}
                      <span className="account-row-note">
                        {position.filledOrders} fill(s) · {position.venues.join(", ")}
                      </span>
                    </th>
                    <td>{position.quantity}</td>
                    <td>{position.averageCostUsd === null ? "—" : `${position.averageCostUsd} USD`}</td>
                    <td>{position.costBasisUsd === null ? "—" : `${position.costBasisUsd} USD`}</td>
                    <td>
                      {position.markPriceUsd === null ? (
                        <span className="account-unpriced">NO MARK</span>
                      ) : (
                        <>
                          {position.markPriceUsd} USD
                          <span className="account-row-note">{position.markSource}</span>
                          <span className="account-asof">AS OF {displayMoment(position.markAsOf)}</span>
                        </>
                      )}
                    </td>
                    <td>{position.marketValueUsd === null ? "—" : `${position.marketValueUsd} USD`}</td>
                    <td>{position.realisedPnlUsd} USD</td>
                    <td>{position.unrealisedPnlUsd === null ? "—" : `${position.unrealisedPnlUsd} USD`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data?.positions?.some((position) => position.note) && (
          <ul className="account-notes">
            {data?.positions
              ?.filter((position) => position.note)
              .map((position) => (
                <li key={`note-${position.market}`}>
                  <strong>{position.market}</strong> {position.note}
                </li>
              ))}
          </ul>
        )}
        <SourceNote sources={data?.pnl?.sources ?? []} />
      </section>

      <section className="data-section" aria-labelledby="account-history-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">03 / HISTORY</div>
            <h2 id="account-history-title">Every movement, filtered</h2>
          </div>
          <div className="account-export-actions">
            <a className="section-action" href={exportHref("csv")}>
              <Download aria-hidden="true" size={14} /> EXPORT CSV
            </a>
            <a className="section-action" href={exportHref("json")}>
              <FileJson aria-hidden="true" size={14} /> EXPORT JSON
            </a>
          </div>
        </div>

        <form className="account-filter" onSubmit={(event) => event.preventDefault()}>
          <label className="trading-field">
            <span>From</span>
            <input onChange={(event) => setFrom(event.target.value)} type="date" value={from} />
          </label>
          <label className="trading-field">
            <span>To</span>
            <input onChange={(event) => setTo(event.target.value)} type="date" value={to} />
          </label>
          <label className="trading-field">
            <span>Asset</span>
            <input maxLength={12} onChange={(event) => setAsset(event.target.value)} placeholder="USDT" value={asset} />
          </label>
          <label className="trading-field">
            <span>Transaction hash</span>
            <input
              maxLength={80}
              onChange={(event) => setHash(event.target.value)}
              placeholder="0x… or a watcher id"
              value={hash}
            />
          </label>
          <div className="account-type-chips" role="group" aria-label="Types">
            {HISTORY_TYPES.map((type) => (
              <button
                aria-pressed={types.includes(type)}
                className={`account-type-chip${types.includes(type) ? " is-on" : ""}`}
                key={type}
                onClick={() => toggleType(type)}
                type="button"
              >
                {type}
              </button>
            ))}
          </div>
        </form>

        {(data?.totals?.length ?? 0) > 0 && (
          <ul className="account-history-totals">
            {data?.totals?.map((total) => (
              <li key={total.asset}>
                <strong>{total.asset}</strong>
                <span>in {total.inDecimal}</span>
                <span>out {total.outDecimal}</span>
                <span className="account-history-net">net {total.netDecimal}</span>
                <span>
                  {total.lineCount} ledger line(s) · ledger closes at {total.statementClosingDecimal ?? "—"} · balance{" "}
                  {total.balanceDecimal}
                </span>
              </li>
            ))}
          </ul>
        )}

        {(data?.history?.length ?? 0) === 0 ? (
          <p className="trading-empty" role="status">
            Nothing matches this filter. A credited deposit appears twice by design — once as the arrival the watcher
            recorded and once as the ledger movement that credited it — and both share the transaction hash.
          </p>
        ) : (
          <div className="market-table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Category</th>
                  <th scope="col">Type · status</th>
                  <th scope="col">Asset</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Detail</th>
                  <th scope="col">Transaction</th>
                </tr>
              </thead>
              <tbody>
                {data?.history?.map((row) => (
                  <tr key={row.id}>
                    <td>{displayMoment(row.occurredAt)}</td>
                    <td>
                      <History aria-hidden="true" size={12} /> {row.category}
                      <span className="account-row-note">{row.source}</span>
                    </td>
                    <td>
                      {row.type}
                      <span className="account-row-note">{row.status}</span>
                    </td>
                    <td>{row.asset}</td>
                    <td data-signed={row.amountMinor.startsWith("-") ? "out" : "in"}>
                      {row.amount === "0" ? <span className="account-unpriced">no book movement</span> : row.amount}
                    </td>
                    <td>
                      {row.detail}
                      {row.counterparty && <span className="account-row-note">{row.counterparty}</span>}
                    </td>
                    <td>
                      {row.txHash ? <code title={row.txHash}>{shortId(row.txHash)}</code> : <span>—</span>}
                      <span className="account-row-note">{shortId(row.reference)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="trading-security-note">
          The totals above and the totals in the export are the same rows added up once: the export writes one line per
          row on screen and then a TOTAL line per asset, so a re-import of the file reconciles to the same figures.
        </p>
      </section>

      <section className="data-section" aria-labelledby="account-report-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">04 / PERIOD REPORT</div>
            <h2 id="account-report-title">What came in, what went out, what it earned</h2>
          </div>
          <span className="section-state">
            {data?.summary ? `${data.summary.from.slice(0, 10)} → ${data.summary.to.slice(0, 10)}` : "NO PERIOD"}
          </span>
        </div>
        {(data?.summary?.assets?.length ?? 0) === 0 && (data?.summary?.trading.filledOrders ?? 0) === 0 ? (
          <p className="trading-empty" role="status">
            Nothing moved and nothing traded in this period.
          </p>
        ) : (
          <>
            <div className="market-table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Asset</th>
                    <th scope="col">Inflow</th>
                    <th scope="col">Outflow</th>
                    <th scope="col">Fees</th>
                    <th scope="col">Net</th>
                    <th scope="col">Deposits / withdrawals</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.summary?.assets?.map((row) => (
                    <tr key={row.asset}>
                      <th scope="row">{row.asset}</th>
                      <td>{row.inflow}</td>
                      <td>{row.outflow}</td>
                      <td>
                        {row.fees}
                        {(row.performanceFees !== "0" || row.withdrawalFees !== "0") && (
                          <small className="fee-table-note">
                            {" "}
                            withdrawal {row.withdrawalFees} · performance {row.performanceFees}
                          </small>
                        )}
                      </td>
                      <td>{row.net}</td>
                      <td>
                        {row.deposits} / {row.withdrawals}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <th scope="row">TRADING RESULT</th>
                    <td colSpan={1}>{data?.summary?.trading.realisedUsd ?? "0"} USD</td>
                    <td colSpan={4}>
                      {data?.summary?.trading.filledOrders ?? 0} filled order(s)
                      {(data?.summary?.trading.markets.length ?? 0) > 0
                        ? ` on ${data?.summary?.trading.markets.join(", ")}`
                        : " — nothing was traded in this period"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <SourceNote sources={data?.summary?.sources ?? []} />
          </>
        )}
      </section>

      <section className="data-section" aria-labelledby="account-assistant-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">05 / ASSISTANT PAPER PERFORMANCE</div>
            <h2 id="account-assistant-title">How the assistant&apos;s paper orders played out</h2>
          </div>
          <span className="section-state">
            CLOSED {paper?.summary.realisedUsd ?? "0"} USD · OPEN{" "}
            {paper && paper.summary.openUnrealisedUsd !== null
              ? `${paper.summary.openUnrealisedUsd} USD`
              : "UNAVAILABLE"}
          </span>
        </div>
        <p className="trading-security-note">
          {paper?.scope ??
            "This block counts only paper orders placed by the assistant's place_paper_order tool; every other order is excluded."}
        </p>
        {(paper?.summary.orders ?? 0) === 0 ? (
          <p className="trading-empty" role="status">
            No paper order has been placed through the assistant yet. When it places one, the fill is costed here
            against the assistant&apos;s own book, so its result is never mixed with an order you placed yourself.
          </p>
        ) : (
          <>
            <p className="trading-security-note">
              {paper?.summary.orders} order(s): {paper?.summary.closedOrders} closed, {paper?.summary.openOrders} still
              open, {paper?.summary.unfilledOrders} with no fill · {paper?.summary.filledOrders} filled on{" "}
              {(paper?.summary.venues.length ?? 0) > 0 ? paper?.summary.venues.join(", ") : "no venue recorded"}
            </p>
            <div className="market-table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Market</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Requested</th>
                    <th scope="col">Filled</th>
                    <th scope="col">Entry</th>
                    <th scope="col">Notional</th>
                    <th scope="col">Realised</th>
                    <th scope="col">Mark now</th>
                  </tr>
                </thead>
                <tbody>
                  {paper?.orders.map((order) => (
                    <tr key={order.orderId}>
                      <td>{displayMoment(order.occurredAt)}</td>
                      <th scope="row">
                        {order.market}
                        <span className="account-row-note">
                          {order.side} · {order.orderType} · {order.statusLabel}
                        </span>
                      </th>
                      <td>
                        {order.outcome}
                        <span className="account-row-note">{order.outcomeDetail}</span>
                      </td>
                      <td>{order.requestedQuantity}</td>
                      <td>{order.filledQuantity}</td>
                      <td>{order.unitPriceUsd === "0" ? "—" : `${order.unitPriceUsd} USD`}</td>
                      <td>{order.notionalUsd} USD</td>
                      <td>{order.realisedUsd} USD</td>
                      <td>
                        {order.markPriceUsd === null ? (
                          <span className="account-unpriced">—</span>
                        ) : (
                          <>
                            {order.markPriceUsd} USD
                            <span className="account-asof">AS OF {displayMoment(order.markAsOf)}</span>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(paper?.markets.length ?? 0) > 0 && (
              <div className="market-table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Market</th>
                      <th scope="col">Held</th>
                      <th scope="col">Average cost</th>
                      <th scope="col">Cost basis</th>
                      <th scope="col">Realised</th>
                      <th scope="col">Mark</th>
                      <th scope="col">Market value</th>
                      <th scope="col">Unrealised</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paper?.markets.map((market) => (
                      <tr key={`paper-${market.market}`}>
                        <th scope="row">
                          {market.market}
                          <span className="account-row-note">{market.filledOrders} assistant fill(s)</span>
                        </th>
                        <td>{market.quantity}</td>
                        <td>{market.averageCostUsd === null ? "—" : `${market.averageCostUsd} USD`}</td>
                        <td>{market.costBasisUsd === null ? "—" : `${market.costBasisUsd} USD`}</td>
                        <td>{market.realisedPnlUsd} USD</td>
                        <td>
                          {market.markPriceUsd === null ? (
                            <span className="account-unpriced">NO MARK</span>
                          ) : (
                            <>
                              {market.markPriceUsd} USD
                              <span className="account-row-note">{market.markSource}</span>
                              <span className="account-asof">AS OF {displayMoment(market.markAsOf)}</span>
                            </>
                          )}
                        </td>
                        <td>{market.marketValueUsd === null ? "—" : `${market.marketValueUsd} USD`}</td>
                        <td>{market.unrealisedPnlUsd === null ? "—" : `${market.unrealisedPnlUsd} USD`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {paper?.markets.some((market) => market.note) && (
              <ul className="account-notes">
                {paper?.markets
                  .filter((market) => market.note)
                  .map((market) => (
                    <li key={`paper-note-${market.market}`}>
                      <strong>{market.market}</strong> {market.note}
                    </li>
                  ))}
              </ul>
            )}
            <SourceNote sources={paper?.sources ?? []} />
            <ul className="account-notes">
              {paper?.notes.map((note) => (
                <li key={`paper-how-${note.slice(0, 40)}`}>{note}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="data-section" aria-labelledby="account-external-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">06 / EXTERNAL, READ-ONLY IMPORTS</div>
            <h2 id="account-external-title">Accounts held somewhere else</h2>
          </div>
          <button className="section-action" disabled={importing} onClick={() => void importExternal()} type="button">
            {importing ? <RefreshCw aria-hidden="true" className="login-spinner" size={14} /> : <Link2 aria-hidden="true" size={14} />}
            {importing ? "READING VENUES" : "IMPORT FROM READ-ONLY KEYS"}
          </button>
        </div>
        <p className="trading-security-note">
          This path runs over the keys you labelled read-only when you connected them. What comes back is the
          venue&apos;s own record of an account held there: it is shown as external, it is never added to the balances
          above, and this deployment cannot move it. A trade-capable key is skipped by name, because a key that can
          place an order is not what this path is for.
        </p>
        {importNote && (
          <p className="trading-feedback" role="status">
            {importNote}
          </p>
        )}
        {(data?.external?.skipped?.length ?? 0) > 0 && (
          <ul className="account-notes">
            {data?.external?.skipped?.map((skip) => (
              <li key={skip.credentialId}>
                <strong>
                  {skip.label} ({skip.venue})
                </strong>{" "}
                {skip.reason}
              </li>
            ))}
          </ul>
        )}
        {(data?.external?.sources?.length ?? 0) === 0 ? (
          <p className="trading-empty" role="status">
            No read-only key has been read yet. Nothing here is inferred: press the button above and only the venues
            that answer appear.
          </p>
        ) : (
          <div className="account-external-grid">
            {data?.external?.sources?.map((source) => (
              <article className="account-external-card" key={source.credentialId}>
                <header>
                  <strong>{source.label}</strong>
                  <span>{source.venue}</span>
                  <span className="account-asof">AS OF {displayMoment(source.asOf)}</span>
                </header>
                {source.status === "failed" ? (
                  <p className="trading-feedback trading-feedback--error" role="alert">
                    Not read: {source.reason}
                  </p>
                ) : source.balances.length > 0 ? (
                  <ul className="trading-balance-list">
                    {source.balances.map((balance) => (
                      <li key={balance.asset}>
                        <strong>{balance.asset}</strong>
                        <span>{balance.available} available</span>
                        <span>{balance.total} total</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="trading-empty">{source.note}</p>
                )}
                {source.trades.length > 0 && (
                  <ul className="trading-balance-list">
                    {source.trades.map((trade) => (
                      <li key={trade.id}>
                        <strong>{trade.id}</strong>
                        <span>{trade.summary}</span>
                        <span>{displayMoment(trade.occurredAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </div>
        )}
        {data?.external && (
          <p className="policy-disclaimer" role="status">
            {data.external.note}
          </p>
        )}
      </section>

      {(data?.notes?.length ?? 0) > 0 && (
        <section className="data-section" aria-labelledby="account-notes-title">
          <div className="section-heading">
            <div>
              <div className="section-kicker">07 / HOW TO READ THIS PAGE</div>
              <h2 id="account-notes-title">What each figure is</h2>
            </div>
            <span className="section-state">NO STORED TOTALS</span>
          </div>
          <ul className="account-notes">
            {data?.notes?.map((note) => (
              <li key={note.slice(0, 40)}>{note}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
