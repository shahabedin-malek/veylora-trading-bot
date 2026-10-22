"use client";

import {
  ArrowUpFromLine,
  Ban,
  CircleAlert,
  Clock,
  ExternalLink,
  Radio,
  RefreshCw,
  Send,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { quoteWithdrawal } from "@/lib/fees/amounts";
import { REQUEST_ID_HEADER } from "@/lib/observability/request-id";

/**
 * The withdrawal surface.
 *
 * Everything this panel says is read from the server on each load — what can be spent, what
 * is already held, what each network costs, how long the owner's own new-address window is,
 * and where every withdrawal currently stands. It decides nothing. It does not know the
 * sending wallet, it does not know a confirmation count, it does not decide that a withdrawal
 * succeeded, and it never shows a figure the server did not send: the panel has to stay honest
 * when the deployment has no sending wallet, when a network cannot be reached, and when a
 * transfer is real but has not been confirmed — three cases where a client that guessed would
 * show money that moved when it did not.
 *
 * Two details of the form are deliberate.
 *
 * **The idempotency key changes with the intent and only with the intent.** A key is minted
 * when the form is filled and re-minted whenever the network, the destination or the amount
 * changes — so a resubmitted request that the network dropped resolves to the same withdrawal,
 * while a genuinely different withdrawal is a different request. Reusing a key across a changed
 * amount would be answered with the *original* withdrawal, which is the one way this form could
 * lie about what the owner asked for.
 *
 * **A cancellation is offered as an attempt, in those words.** The panel says \"ASK TO CANCEL\"
 * and the outcome says a replacement is in flight, because that is what happened: on a chain
 * that counts nonces, taking a transfer back means sending another transaction for the same
 * nonce and a higher fee, and which one is mined is the network's answer, not this page's.
 */

type SerializedReason = {
  code: string;
  message: string;
  retryable: boolean;
  variable?: string;
  providerId?: string;
  detail?: string;
};

type Withdrawal = {
  id: string;
  network: string;
  networkDisplayName: string;
  chainId: number;
  asset: string;
  decimals: number;
  amount: string;
  amountMinor: string;
  fee: string;
  feeMinor: string;
  net: string;
  netMinor: string;
  destination: string;
  destinationDisplay: string;
  status: "REFUSED" | "HELD" | "RESERVED" | "BROADCAST_FAILED" | "BROADCAST" | "CONFIRMED" | "CANCELLED" | "FAILED";
  statusLabel: string;
  statusSummary: string;
  reason: SerializedReason | null;
  txHash: string | null;
  explorerUrl: string | null;
  cancelTxHash: string | null;
  cancelExplorerUrl: string | null;
  nonce: number | null;
  fromAddress: string | null;
  confirmations: number;
  confirmationsRequired: number | null;
  holdUntil: string | null;
  expiresAt: string;
  timeoutAt: string | null;
  broadcastAt: string | null;
  confirmedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  releasedAt: string | null;
  attempts: number;
  createdAt: string;
  cancellable: boolean;
  cancellationReason: SerializedReason | null;
  simulated: boolean;
};

type WithdrawalNetwork = {
  slug: string;
  chainId: number;
  displayName: string;
  confirmations: number;
  fee: string;
  feeLabel: string;
  networkCost: string;
  networkCostLabel: string;
  token: { symbol: string; displayName: string; address: string; decimals: number; note?: string };
  ready: boolean;
};

type WithdrawalResponse = {
  configured?: boolean;
  availability?: SerializedReason | null;
  problems?: string[];
  broadcastMode?: "onchain" | "simulated";
  hotWalletAddress?: string | null;
  hotWalletExplorerUrl?: string | null;
  newAddressWindowMinutes?: number;
  windowLabel?: string;
  windowSource?: "owner-setting" | "deployment-default";
  requestExpiryMinutes?: number;
  cancelAfterMinutes?: number;
  feeByAsset?: Record<string, string>;
  networkCostByAsset?: Record<string, string>;
  feeSource?: "owner-schedule" | "free-defaults" | "deployment-default";
  networks?: WithdrawalNetwork[];
  balances?: { asset: string; decimals: number; available: string; availableMinor: string; held: string; heldMinor: string }[];
  withdrawals?: Withdrawal[];
  run?: {
    live: number;
    releasedFromHold: number;
    broadcast: number;
    broadcastFailed: number;
    confirmed: number;
    cancelled: number;
    failed: number;
    pending: number;
    worked: boolean;
    reason: SerializedReason | null;
  };
  error?: string;
};

/** A key for one intent. `crypto.randomUUID` where the browser has it, and never reused. */
function newIntentKey(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // A browser without the API is not a reason to refuse a withdrawal; a random key is
    // still a key, and the server holds it unique.
  }
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function request(path: string, init?: RequestInit): Promise<WithdrawalResponse> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...init });
  } catch (reason) {
    // A rejected fetch never reaches the response branch, so the panel would otherwise
    // stay on "Reading your withdrawal routes…" with no way to learn why.
    const detail = reason instanceof Error ? reason.message : "the request was rejected";
    return { error: `The withdrawals API could not be reached from this browser (${detail}), so no route was read.` };
  }
  const payload: unknown = await response.json().catch(() => null);
  const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  if (!response.ok) {
    const serverReason = typeof record.error === "string" ? record.error : null;
    const requestId = response.headers.get(REQUEST_ID_HEADER);
    const refusal = serverReason ?? `Withdrawals answered ${response.status} and returned no withdrawal data.`;
    return { error: requestId ? `${refusal} (request ${requestId})` : refusal };
  }
  return payload as WithdrawalResponse;
}

function HashLink({ hash, url, label }: { hash: string; url: string | null; label?: string }) {
  const short = `${hash.slice(0, 10)}…${hash.slice(-8)}`;
  if (!url) return <span className="withdraw-hash" title={hash}>{label ? `${label} ${short}` : short}</span>;
  return (
    <a className="withdraw-hash withdraw-hash--link" href={url} rel="noreferrer noopener" target="_blank" title={hash}>
      {label ? `${label} ${short}` : short}
      <ExternalLink aria-hidden="true" size={11} />
    </a>
  );
}

function when(value: string | null): string {
  if (!value) return "—";
  return value.replace("T", " ").slice(0, 19);
}

export function WithdrawPanel() {
  const [data, setData] = useState<WithdrawalResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [network, setNetwork] = useState<string>("");
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [intentKey, setIntentKey] = useState(() => newIntentKey());
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<SerializedReason | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const load = useCallback(async (path: string, init?: RequestInit) => {
    setBusy(true);
    try {
      const result = await request(path, init);
      if (result.error) {
        setError(result.error);
        return null;
      }
      setError(null);
      setData(result);
      return result;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await request("/api/withdrawals");
      if (cancelled) return;
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      setData(result);
      // Open on the first network this deployment can actually send on, so a person
      // arriving to withdraw is not shown a route that cannot carry the money.
      setNetwork((current) => current || (result.networks ?? []).find((candidate) => candidate.ready)?.slug || (result.networks ?? [])[0]?.slug || "");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Any change to what is being asked for is a different request, so it gets a fresh key. */
  function resetIntent(setter: (value: string) => void) {
    return (value: string) => {
      setter(value);
      setIntentKey(newIntentKey());
      setRefusal(null);
      setNotice(null);
    };
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setRefusal(null);
    setNotice(null);
    try {
      const response = await fetch("/api/withdrawals", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "idempotency-key": intentKey },
        body: JSON.stringify({ network, destination, amount }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
      if (!response.ok) {
        const serverRefusal = record.reason;
        setRefusal(
          typeof serverRefusal === "object" && serverRefusal !== null
            ? (serverRefusal as SerializedReason)
            : { code: "UNKNOWN", message: typeof record.error === "string" ? record.error : "The withdrawal was refused.", retryable: false },
        );
        // The balance may have moved under the request, so the figures are re-read rather
        // than left showing what the page was opened with.
        await load("/api/withdrawals");
        return;
      }
      setNotice(
        `Withdrawal ${String((record.withdrawal as { id?: string } | undefined)?.id ?? "")} was accepted and the amount is now held.`,
      );
      setAmount("");
      setIntentKey(newIntentKey());
      await load("/api/withdrawals");
    } catch (failure) {
      setRefusal({
        code: "UNKNOWN",
        message: failure instanceof Error ? failure.message : "The request could not be sent.",
        retryable: true,
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function checkNow() {
    setNotice(null);
    await load("/api/withdrawals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "check" }),
    });
  }

  async function askToCancel(id: string) {
    setCancelling(id);
    setNotice(null);
    try {
      const response = await fetch(`/api/withdrawals/${encodeURIComponent(id)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
      if (!response.ok) {
        const serverRefusal = record.reason;
        setRefusal(
          typeof serverRefusal === "object" && serverRefusal !== null
            ? (serverRefusal as SerializedReason)
            : { code: "UNKNOWN", message: typeof record.error === "string" ? record.error : "The cancellation was refused.", retryable: false },
        );
      } else if (record.outcome === "cancelled") {
        setNotice(`${id} was cancelled before it was sent, and the amount is back in the balance.`);
      } else if (record.outcome === "replacement-sent" || record.outcome === "replacement-already-sent") {
        setNotice(
          `${id}: a replacement transaction was sent at the same nonce. The network decides which one it mines — the next check settles it.`,
        );
      }
      await load("/api/withdrawals");
    } catch (failure) {
      setRefusal({
        code: "UNKNOWN",
        message: failure instanceof Error ? failure.message : "The cancellation could not be sent.",
        retryable: true,
      });
    } finally {
      setCancelling(null);
    }
  }

  const networks = data?.networks ?? [];
  const active = networks.find((candidate) => candidate.slug === network) ?? null;
  // The quote is the same arithmetic the server uses, applied to the strings the form
  // holds, so what the owner reads before submitting is the figure the ledger records.
  const quote = active && amount.trim()
    ? quoteWithdrawal({
        amount,
        fee: active.fee,
        networkCost: active.networkCost,
        asset: active.token.symbol,
        decimals: active.token.decimals,
      })
    : null;
  const withdrawals = data?.withdrawals ?? [];
  const live = withdrawals.filter((row) => row.status === "HELD" || row.status === "RESERVED" || row.status === "BROADCAST_FAILED" || row.status === "BROADCAST");

  if (!data && !error) {
    return <div className="market-chart-empty withdraw-body" role="status">Reading your withdrawal routes…</div>;
  }

  return (
    <div className="withdraw-body">
      <div className="withdraw-balances" role="status">
        <ShieldCheck aria-hidden="true" size={14} />
        <div>
          {data?.balances && data.balances.length > 0 ? (
            data.balances.map((balance) => (
              <strong key={balance.asset}>
                {balance.available} {balance.asset} available
                {balance.heldMinor !== "0" ? ` · ${balance.held} ${balance.asset} held` : ""}
              </strong>
            ))
          ) : (
            <strong>{error && !data ? "Withdrawals unavailable" : "Nothing to withdraw yet"}</strong>
          )}
          <span>
            Read from the ledger of record: the available figure is the sum of the entries in the account&apos;s spendable bucket, and the held
            figure is what is in flight to a wallet.
          </span>
        </div>
      </div>

      {data?.broadcastMode === "simulated" && (
        <div className="withdraw-simulation" role="status">
          <Radio aria-hidden="true" size={14} />
          <div>
            <strong>Transfers are being simulated on this deployment</strong>
            <span>
              The transfer is signed for real and nothing is broadcast. A confirmation here is this code keeping its own promise, not a chain
              moving money — set WITHDRAWAL_BROADCAST_MODE=onchain with a funded wallet to send for real.
            </span>
          </div>
        </div>
      )}

      {error && (
        <div className="market-chart-empty withdraw-refusal" role="alert">
          <strong>{error}</strong>
        </div>
      )}

      {data?.availability && (
        <div className="withdraw-refusal" role="status">
          <CircleAlert aria-hidden="true" size={14} />
          <div>
            <strong>{data.availability.message}</strong>
            {data.availability.variable && <span>Set {data.availability.variable} to enable withdrawals.</span>}
          </div>
        </div>
      )}

      {refusal && (
        <div className="withdraw-refusal" role="status">
          <CircleAlert aria-hidden="true" size={14} />
          <div>
            <strong>{refusal.message}</strong>
            <span>
              {refusal.code} · {refusal.retryable ? "asking again could change this" : "asking again would be refused the same way"}
              {refusal.variable ? ` · set ${refusal.variable}` : ""}
            </span>
          </div>
        </div>
      )}

      {notice && (
        <div className="withdraw-notice" role="status">
          <Send aria-hidden="true" size={14} />
          <span>{notice}</span>
        </div>
      )}

      {data?.problems && data.problems.length > 0 && (
        <div className="withdraw-refusal" role="status">
          <CircleAlert aria-hidden="true" size={14} />
          <div>
            <strong>This deployment&apos;s withdrawal configuration has a mistake in it</strong>
            {data.problems.map((problem) => (
              <span key={problem}>{problem}</span>
            ))}
          </div>
        </div>
      )}

      <form className="withdraw-form" onSubmit={(event) => void submit(event)}>
        <div className="withdraw-form__row">
          <label className="withdraw-field">
            <span>NETWORK</span>
            <select
              className="withdraw-input"
              onChange={(event) => resetIntent(setNetwork)(event.target.value)}
              value={network}
            >
              {networks.length === 0 && <option value="">{data ? "no network configured" : "network list unavailable"}</option>}
              {networks.map((candidate) => (
                <option key={candidate.slug} value={candidate.slug}>
                  {candidate.displayName} {candidate.ready ? "" : "— not ready"}
                </option>
              ))}
            </select>
          </label>
          <label className="withdraw-field">
            <span>AMOUNT ({active?.token.symbol ?? "asset"})</span>
            <input
              className="withdraw-input"
              inputMode="decimal"
              onChange={(event) => resetIntent(setAmount)(event.target.value)}
              placeholder="20"
              value={amount}
            />
          </label>
        </div>
        <label className="withdraw-field">
          <span>DESTINATION ADDRESS</span>
          <input
            className="withdraw-input"
            onChange={(event) => resetIntent(setDestination)(event.target.value)}
            placeholder="0x…"
            spellCheck={false}
            value={destination}
          />
        </label>
        {active && (
          <div className="withdraw-costs" role="status">
            <span>
              Platform fee <strong>{active.feeLabel}</strong>
            </span>
            <span>
              Network cost <strong>{active.networkCostLabel}</strong>{" "}
              <small>paid by the platform, never deducted</small>
            </span>
            <span>
              Wallet receives{" "}
              <strong>{quote?.valid ? `${quote.quote.arriving} ${active.token.symbol}` : "—"}</strong>
            </span>
          </div>
        )}
        <div className="withdraw-form__actions">
          <button className="section-action" disabled={submitting || !network || !destination || !amount} type="submit">
            <ArrowUpFromLine aria-hidden="true" size={13} />
            {submitting ? "REQUESTING…" : "REQUEST WITHDRAWAL"}
          </button>
          <span className="withdraw-form__note">
            {active
              ? `${active.feeLabel === "no fee" ? "No platform fee is deducted" : `A fee of ${active.fee} ${active.token.symbol} is deducted`} ` +
                `from the amount${quote?.valid ? `, so the wallet receives ${quote.quote.arriving} ${active.token.symbol}` : ""}. ` +
                `${active.confirmations} confirmation${active.confirmations === 1 ? "" : "s"} before it counts as done.`
              : data
                ? "No network is configured for withdrawals in this deployment."
                : "The network list could not be read, so no route is shown as configured."}
            {quote && !quote.valid ? ` ${quote.reason}` : ""}
            {active?.token.note ? ` ${active.token.note}` : ""}
          </span>
        </div>
      </form>

      {data && (
        <div className="withdraw-policy" role="status">
        <Clock aria-hidden="true" size={14} />
        <div>
          <strong>{data?.windowLabel ?? "no hold configured"}</strong>
          <span>
            The new-address window {data?.windowSource === "owner-setting" ? "saved in the admin settings" : "set on this deployment"}: it
            holds a first withdrawal to an address this account has never used, and {(data?.newAddressWindowMinutes ?? 0) === 0
              ? "it is zero now, so nothing is held."
              : "setting it to zero holds nothing."}{" "}
            An unsent request expires after {data?.requestExpiryMinutes ?? 0} minute
            {(data?.requestExpiryMinutes ?? 0) === 1 ? "" : "s"}, and a sent transfer can be asked back {data?.cancelAfterMinutes ?? 0} minute
            {(data?.cancelAfterMinutes ?? 0) === 1 ? "" : "s"} after it was broadcast. The price of a withdrawal is{" "}
            {active ? active.feeLabel : "configured per asset"},{" "}
            {data?.feeSource === "owner-schedule"
              ? "read from the stored fee table"
              : data?.feeSource === "free-defaults"
                ? "free because no fee table version is stored"
                : "this deployment's own value"}.
          </span>
          {data?.hotWalletAddress && (
            <span>
              Sending from{" "}
              {data.hotWalletExplorerUrl ? (
                <a className="withdraw-hash withdraw-hash--link" href={data.hotWalletExplorerUrl} rel="noreferrer noopener" target="_blank">
                  {data.hotWalletAddress}
                </a>
              ) : (
                <code>{data.hotWalletAddress}</code>
              )}
            </span>
          )}
        </div>
        </div>
      )}

      <div className="withdraw-actions">
        <button className="section-action" disabled={busy} onClick={() => void checkNow()} type="button">
          <RefreshCw aria-hidden="true" size={13} />
          {busy ? "CHECKING…" : "CHECK NOW"}
        </button>
        <span className="withdraw-actions__note">
          Asks the server to advance your withdrawals now: release a hold whose window has passed, send what is queued, read confirmations and
          settle — the same pass the runner makes every {data?.requestExpiryMinutes ? "few minutes" : "few minutes"} whether or not this page is
          open.
        </span>
      </div>

      {data?.run && (
        <div className="withdraw-run" role="status">
          <ShieldCheck aria-hidden="true" size={14} />
          <div>
            <strong>
              {data.run.live} in flight · {data.run.releasedFromHold} left the hold window · {data.run.broadcast} sent ·{" "}
              {data.run.broadcastFailed} refused by the network · {data.run.confirmed} confirmed · {data.run.cancelled} cancelled ·{" "}
              {data.run.failed} failed
            </strong>
            {data.run.reason && <span>{data.run.reason.message}</span>}
          </div>
        </div>
      )}

      {live.length > 0 && (
        <div className="withdraw-live" role="status">
          <Clock aria-hidden="true" size={14} />
          <div>
            <strong>{live.length} withdrawal(s) not finished yet</strong>
            {live.map((row) => (
              <span key={row.id}>
                {row.statusSummary}
                {row.status === "BROADCAST" ? ` · ${row.confirmations}/${row.confirmationsRequired ?? 0} confirmations` : ""}
                {row.holdUntil && row.status === "HELD" ? ` · held until ${when(row.holdUntil)}` : ""}
              </span>
            ))}
          </div>
        </div>
      )}

      {withdrawals.length === 0 ? (
        <div className="market-chart-empty" role="status">
          <strong>No withdrawals yet</strong>
          <span>Request one above. The amount is held the moment it is accepted, so nothing else can spend it, and every state change is audited.</span>
        </div>
      ) : (
        <ul className="withdraw-list" aria-label="Withdrawals">
          {withdrawals.map((row) => (
            <li className={`withdraw-item withdraw-item--${row.status.toLowerCase()}`} key={row.id}>
              <ArrowUpFromLine aria-hidden="true" size={14} />
              <div className="withdraw-item__main">
                <div className="withdraw-item__title">
                  <strong>
                    {row.amount} {row.asset}
                  </strong>
                  <span className={`withdraw-status withdraw-status--${row.status.toLowerCase()}`}>{row.statusLabel}</span>
                  <span className="withdraw-item__network">{row.networkDisplayName}</span>
                  {row.simulated && <span className="withdraw-badge">SIMULATED</span>}
                </div>
                <div className="withdraw-item__facts">
                  <span>
                    net {row.net} {row.asset} · fee {row.fee} {row.asset}
                  </span>
                  <span title={row.destinationDisplay}>to {row.destinationDisplay.slice(0, 10)}…{row.destinationDisplay.slice(-6)}</span>
                  {row.txHash && <HashLink hash={row.txHash} url={row.explorerUrl} />}
                  {row.cancelTxHash && <HashLink hash={row.cancelTxHash} label="replacement" url={row.cancelExplorerUrl} />}
                  {row.nonce !== null && <span>nonce {row.nonce}</span>}
                  {row.status === "BROADCAST" && (
                    <span>
                      {row.confirmations}/{row.confirmationsRequired ?? 0} confirmations
                    </span>
                  )}
                  <span>asked {when(row.createdAt)}</span>
                  {row.confirmedAt && <span>confirmed {when(row.confirmedAt)}</span>}
                  {row.releasedAt && <span>released {when(row.releasedAt)}</span>}
                  {row.attempts > 0 && <span>{row.attempts} attempt(s)</span>}
                </div>
                <p className="withdraw-item__reason">
                  {row.reason && <b>{row.reason.code.replaceAll("_", " ")}</b>} {row.statusSummary}
                  {row.holdUntil && row.status === "HELD" ? ` — the amount is held until ${when(row.holdUntil)}.` : ""}
                  {row.reason?.retryable ? " Asking again could change this." : ""}
                </p>
                {row.cancellable && (
                  <div className="withdraw-item__actions">
                    <button
                      className="section-action"
                      disabled={cancelling === row.id}
                      onClick={() => void askToCancel(row.id)}
                      type="button"
                    >
                      <Ban aria-hidden="true" size={13} />
                      {cancelling === row.id ? "ASKING…" : "ASK TO CANCEL"}
                    </button>
                    <span className="withdraw-item__actionnote">
                      {row.status === "BROADCAST"
                        ? "The network already holds this transfer, so a cancellation sends a replacement at the same nonce and a higher fee; the chain decides which one it mines."
                        : "Nothing was sent, so the amount goes straight back to the balance."}
                    </span>
                  </div>
                )}
                {!row.cancellable && row.cancellationReason && (
                  <p className="withdraw-item__actionnote">{row.cancellationReason.message}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="withdraw-footnote">
        A requested withdrawal holds the amount out of the spendable balance immediately, so two requests cannot spend it twice. The hold is
        released if the transfer fails, reverts or expires, and settled when the chain confirms it — the fee is taken at settlement, with the
        transfer that earned it.
      </p>
    </div>
  );
}
