"use client";

import { BookOpenCheck, CircleAlert, Download, FileWarning, RefreshCw, ShieldCheck, Undo2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { REQUEST_ID_HEADER } from "@/lib/observability/request-id";

/**
 * The balance surface.
 *
 * Everything it shows is derived by the server from the ledger's entries, and it
 * decides nothing: it does not know a balance, it does not compute a total, and it
 * does not know what a movement means. Two consequences are deliberate.
 *
 *  - **The figure and its explanation are on the same screen.** A balance with no
 *    ledger behind it is the thing this phase exists to make impossible, so the
 *    statement is not behind a tab and the export is a link to the same rows.
 *  - **The ledger's own health is shown beside the balance.** If the book does not
 *    add up, the number above it cannot be trusted, and a panel that hid that
 *    would be showing a figure the ledger cannot reproduce.
 *
 * The one action it offers is the reversal, and it is offered as a two-step
 * button rather than a browser confirm: un-crediting a deposit is a deliberate
 * act, the second step says what it will do, and nothing about it is silent.
 */

type SerializedReason = {
  code: string;
  message: string;
  retryable: boolean;
  variable?: string;
  providerId?: string;
  detail?: string;
};

type Balance = {
  accountId: string;
  code: string;
  asset: string;
  decimals: number;
  bucket: string;
  label: string;
  balanceMinor: string;
  balance: string;
  entryCount: number;
  creditLineMinor: string | null;
};

type StatementLine = {
  entryId: string;
  transactionId: string;
  kind: string;
  occurredAt: string;
  asset: string;
  direction: "DEBIT" | "CREDIT";
  amount: string;
  amountMinor: string;
  accountCode: string;
  accountLabel: string;
  counterpartyCode: string | null;
  counterpartyLabel: string | null;
  sourceType: string | null;
  sourceId: string | null;
  memo: string | null;
  reversesTransactionId: string | null;
};

type StatementTotal = {
  asset: string;
  decimals: number;
  in: string;
  out: string;
  net: string;
  netMinor: string;
  opening: string;
  closing: string;
  lines: number;
};

type Statement = {
  from: string;
  to: string;
  lines: StatementLine[];
  totals: StatementTotal[];
  accounts: Balance[];
  headline: { asset: string; net: string; lines: number } | null;
};

type LedgerHealth = {
  status: "reachable" | "degraded" | "unknown";
  detail: string;
  counts: { accounts: number; transactions: number; entries: number };
  violations: { check: string; detail: string }[];
  checkedAt: string | null;
};

type LedgerResponse = {
  balances?: Balance[];
  platform?: Balance[];
  statement?: Statement;
  ledger?: LedgerHealth;
  reversed?: boolean;
  transactionId?: string;
  error?: string;
  reason?: SerializedReason;
};

/** `2026-10-16` for a date input, in UTC so the range the server reads is the one shown. */
function dateInputValue(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

async function request(path: string, init?: RequestInit): Promise<LedgerResponse> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...init });
  } catch (reason) {
    // A rejected fetch never reaches the response branch below, so without this the
    // panel would sit on "Reading your ledger…" forever. Name what was not read.
    const detail = reason instanceof Error ? reason.message : "the request was rejected";
    return { error: `The ledger API could not be reached from this browser (${detail}), so no balance was read.` };
  }
  const payload: unknown = await response.json().catch(() => null);
  const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  if (!response.ok) {
    const serverReason = typeof record.error === "string" ? record.error : null;
    const requestId = response.headers.get(REQUEST_ID_HEADER);
    const refusal = serverReason ?? `The ledger answered ${response.status} and returned no ledger data.`;
    return { error: requestId ? `${refusal} (request ${requestId})` : refusal };
  }
  return payload as LedgerResponse;
}

/** The statement for a range, exactly as the route serves it. Pure: no state. */
async function readStatement(range: { from: string; to: string }): Promise<LedgerResponse> {
  const query = new URLSearchParams({ from: range.from, to: range.to });
  return request(`/api/ledger?${query.toString()}`);
}

export function BalancePanel() {
  const today = new Date();
  const [from, setFrom] = useState(dateInputValue(new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)));
  const [to, setTo] = useState(dateInputValue(today));
  const [data, setData] = useState<LedgerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The line whose reversal is being confirmed, and the outcome of one that ran. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(async (range: { from: string; to: string }) => {
    const result = await readStatement(range);
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    setData(result);
  }, []);

  // The first read of a range happens here rather than through `load`: the state
  // is set after the await, so the render that follows is the one the server
  // answered, and the buttons and the reversal below reuse the same read.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await readStatement({ from, to });
      if (cancelled) return;
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      setData(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  async function reverse(line: StatementLine) {
    if (!line.sourceId) return;
    setBusy(true);
    setOutcome(null);
    try {
      const result = await request("/api/ledger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reverse-deposit",
          depositId: line.sourceId,
          memo: `Reversal requested from the balance panel for ${line.asset} ${line.amount}`,
        }),
      });
      setConfirming(null);
      if (result.error) {
        setOutcome({ ok: false, message: result.error });
      } else {
        setOutcome({
          ok: true,
          message: `The credit was compensated by transaction ${shortId(result.transactionId ?? "")}. Both movements are still on the statement.`,
        });
      }
      await load({ from, to });
    } finally {
      setBusy(false);
    }
  }

  const balances = data?.balances ?? [];
  const platform = data?.platform ?? [];
  const statement = data?.statement ?? null;
  const health = data?.ledger ?? null;
  const exportHref = `/api/ledger?format=csv&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  if (!data && !error) {
    return <div className="market-chart-empty balance-body" role="status">Reading your ledger…</div>;
  }

  return (
    <div className="balance-body">
      <div className="balance-holdings" role="status">
        <ShieldCheck aria-hidden="true" size={14} />
        <div>
          <strong>
            {error && !data
              ? "Balances unavailable"
              : balances.length > 0
                ? balances.map((balance) => `${balance.balance} ${balance.asset}`).join(" · ")
                : "No ledger account yet"}
          </strong>
          <span>
            Derived from the entries, never stored: this is the sum of every movement on your accounts, and a reversal or a new credit changes it by
            adding an entry, never by editing one.
          </span>
        </div>
      </div>

      {error && (
        <div className="balance-refusal" role="alert">
          <CircleAlert aria-hidden="true" size={14} />
          <div>
            <strong>{error}</strong>
          </div>
        </div>
      )}

      {health && (
        <div className={health.status === "reachable" ? "balance-health" : "balance-health balance-health--attention"} role="status">
          {health.status === "reachable" ? <BookOpenCheck aria-hidden="true" size={14} /> : <FileWarning aria-hidden="true" size={14} />}
          <div>
            <strong>
              {health.status === "reachable"
                ? `The ledger's invariants hold across ${health.counts.entries} entr(ies) and ${health.counts.transactions} transaction(s)`
                : `The ledger's invariants are not holding (${health.violations.length} violation(s))`}
            </strong>
            <span>{health.detail}</span>
            {health.violations.slice(0, 3).map((violation) => (
              <span key={`${violation.check}-${violation.detail}`}>
                {violation.check.replaceAll("_", " ")} · {violation.detail}
              </span>
            ))}
          </div>
        </div>
      )}

      {platform.length > 0 && (
        <div className="balance-counterparties">
          <span className="balance-counterparties__label">COUNTERPARTIES</span>
          <ul>
            {platform.map((balance) => (
              <li key={balance.accountId}>
                <code>{balance.code}</code>
                <span>{balance.balance} {balance.asset}</span>
                <small>{balance.label}</small>
              </li>
            ))}
          </ul>
          <p>
            Every movement has two sides. Your deposits debit the platform&apos;s treasury account — which is where the funds the platform holds are
            recorded — and credit yours, so no movement appears out of nowhere.
          </p>
        </div>
      )}

      <div className="balance-controls">
        <label>
          FROM
          <input
            aria-label="Statement from"
            className="balance-date"
            max={to}
            onChange={(event) => setFrom(event.target.value)}
            type="date"
            value={from}
          />
        </label>
        <label>
          TO
          <input
            aria-label="Statement to"
            className="balance-date"
            min={from}
            onChange={(event) => setTo(event.target.value)}
            type="date"
            value={to}
          />
        </label>
        <button className="section-action" disabled={busy} onClick={() => void load({ from, to })} type="button">
          <RefreshCw aria-hidden="true" size={13} />{busy ? "READING…" : "REFRESH"}
        </button>
        <a className="section-action" download href={exportHref}>
          <Download aria-hidden="true" size={13} />EXPORT CSV
        </a>
        <span className="balance-controls__note">
          The export is the statement below, row for row, with its total on the last line — so the file and the screen are the same reading.
        </span>
      </div>

      {outcome && (
        <div className={outcome.ok ? "balance-note" : "balance-refusal"} role="status">
          {outcome.ok ? <Undo2 aria-hidden="true" size={14} /> : <CircleAlert aria-hidden="true" size={14} />}
          <div>
            <strong>{outcome.message}</strong>
          </div>
        </div>
      )}

      {statement && statement.totals.length > 0 && (
        <div className="balance-totals" role="status">
          {statement.totals.map((total) => (
            <div key={total.asset}>
              <span className="balance-totals__asset">{total.asset}</span>
              <strong>{total.net}</strong>
              <span>
                in {total.in} · out {total.out} · opening {total.opening} · closing {total.closing} · {total.lines} line(s)
              </span>
            </div>
          ))}
        </div>
      )}

      {!statement || statement.lines.length === 0 ? (
        <div className="market-chart-empty" role="status">
          <strong>No ledger movement in this range</strong>
          <span>
            A credited deposit posts a balanced movement: the platform&apos;s treasury is debited and your available account is credited. Nothing has
            been posted to your accounts between {from} and {to}.
          </span>
        </div>
      ) : (
        <div className="balance-statement">
          <table className="balance-table">
            <caption>
              Statement {statement.from.slice(0, 10)} → {statement.to.slice(0, 10)}
            </caption>
            <thead>
              <tr>
                <th scope="col">WHEN</th>
                <th scope="col">KIND</th>
                <th scope="col">AMOUNT</th>
                <th scope="col">ACCOUNT</th>
                <th scope="col">COUNTERPARTY</th>
                <th scope="col">TRANSACTION</th>
                <th scope="col"><span className="balance-table__action">ACTION</span></th>
              </tr>
            </thead>
            <tbody>
              {statement.lines.map((line) => (
                <tr key={line.entryId}>
                  <td data-label="WHEN">{line.occurredAt.replace("T", " ").slice(0, 19)}</td>
                  <td data-label="KIND">
                    {line.kind.replaceAll("_", " ")}
                    {line.reversesTransactionId && (
                      <small className="balance-table__reversal"> reverses {shortId(line.reversesTransactionId)}</small>
                    )}
                  </td>
                  <td className={line.direction === "CREDIT" ? "balance-table__in" : "balance-table__out"} data-label="AMOUNT">
                    {line.direction === "DEBIT" ? "−" : "+"}{line.amount} {line.asset}
                  </td>
                  <td data-label="ACCOUNT">{line.accountLabel}</td>
                  <td data-label="COUNTERPARTY">{line.counterpartyLabel ?? "—"}</td>
                  <td data-label="TRANSACTION" title={line.transactionId}>{shortId(line.transactionId)}</td>
                  <td data-label="ACTION">
                    {line.kind === "DEPOSIT_CREDITED" && line.sourceId ? (
                      confirming === line.entryId ? (
                        <span className="balance-confirm">
                          <button className="section-action" disabled={busy} onClick={() => void reverse(line)} type="button">
                            <Undo2 aria-hidden="true" size={12} />REVERSE
                          </button>
                          <button className="section-action" onClick={() => setConfirming(null)} type="button">
                            CANCEL
                          </button>
                        </span>
                      ) : (
                        <button className="section-action" onClick={() => { setConfirming(line.entryId); setOutcome(null); }} type="button">
                          <Undo2 aria-hidden="true" size={12} />REVERSE?
                        </button>
                      )
                    ) : (
                      <span className="balance-table__none">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              {statement.totals.map((total) => (
                <tr key={`total-${total.asset}`}>
                  <td colSpan={2}>TOTAL</td>
                  <td>{total.net} {total.asset}</td>
                  <td colSpan={3}>opening {total.opening} → closing {total.closing}</td>
                  <td />
                </tr>
              ))}
            </tfoot>
          </table>
        </div>
      )}

      <p className="balance-footnote">
        Reversing a deposit costs nothing to try and cannot mint anything: it posts a compensating movement that debits your account and names the
        credit it undoes, which is why both lines stay on the statement afterwards. Entries are never edited or deleted.
      </p>
    </div>
  );
}
