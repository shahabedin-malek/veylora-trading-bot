"use client";

import { ArrowDownToLine, Check, CircleAlert, Clock, Copy, ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { REQUEST_ID_HEADER } from "@/lib/observability/request-id";

/**
 * The deposit surface.
 *
 * Everything this panel says is read from the server on each load — the address,
 * which networks exist, what the token is, how deep a transfer has to be before
 * it counts, and where each arrival currently stands. It decides nothing: it does
 * not know a deposit address, it does not know a confirmation count, and it never
 * shows a number the server did not send. That is deliberate, because the panel
 * has to stay honest when the deployment is not configured, when a chain cannot be
 * reached, and when a transfer is real but was never credited — three cases where
 * a client that guessed would show money that does not exist.
 */

type SerializedReason = {
  code: string;
  message: string;
  retryable: boolean;
  variable?: string;
  providerId?: string;
  detail?: string;
};

type DepositNetwork = {
  slug: string;
  chainId: number;
  displayName: string;
  nativeSymbol: string;
  testnet: boolean;
  enabled: boolean;
  status: "ready" | "disabled" | "missing-rpc" | "missing-token" | "invalid-config";
  missing: string[];
  problems: string[];
  token: { symbol: string; displayName: string; address: string; decimals: number; note?: string } | null;
  confirmations: number;
  minimumAmount: string;
  address: string | null;
  derivationPath: string | null;
  depositCount: number;
};

type Deposit = {
  id: string;
  network: string;
  networkDisplayName: string;
  chainId: number;
  tokenSymbol: string;
  tokenAddress: string | null;
  amount: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  confirmations: number;
  confirmationsRequired: number;
  status: "PENDING" | "CREDITED" | "REVERTED" | "BELOW_DUST" | "TOKEN_DISABLED" | "UNMATCHED";
  stateLabel: string;
  reasonCode: string | null;
  reasonMessage: string | null;
  origin: "WATCHER" | "UNFILTERED";
  observedAt: string;
  creditedAt: string | null;
  wait: string | null;
  explorerUrl: string | null;
};

type DepositRun = {
  networks: number;
  scanned: number;
  observations: number;
  recorded: number;
  duplicates: number;
  credited: number;
  reverted: number;
  awaiting: number;
  reason: SerializedReason | null;
  skipped: { network: string; code: string; message: string; variable: string | null }[];
  failed: { network: string; code: string; message: string; variable: string | null }[];
};

type DepositResponse = {
  configured?: boolean;
  availability?: SerializedReason | null;
  problems?: string[];
  watchIntervalMinutes?: number;
  networks?: DepositNetwork[];
  deposits?: Deposit[];
  creditedTotals?: { tokenSymbol: string; amount: string }[];
  run?: DepositRun;
  error?: string;
};

/**
 * Which network the panel opens on: the first one that actually has an address,
 * so a person arriving to fund an account is not shown a network this deployment
 * cannot yet receive on.
 */
function defaultNetworkSlug(data: DepositResponse): string | null {
  const networks = data.networks ?? [];
  return (networks.find((network) => network.address) ?? networks[0])?.slug ?? null;
}

/** A hash with no explorer for its network is still shown — as text, not a dead link. */
function HashLink({ hash, url }: { hash: string; url: string | null }) {
  const short = `${hash.slice(0, 10)}…${hash.slice(-8)}`;
  if (!url) return <span className="deposit-hash" title={hash}>{short}</span>;
  return (
    <a className="deposit-hash deposit-hash--link" href={url} rel="noreferrer noopener" target="_blank" title={hash}>
      {short}
      <ExternalLink aria-hidden="true" size={11} />
    </a>
  );
}

async function request(path: string, init?: RequestInit): Promise<DepositResponse> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...init });
  } catch (reason) {
    // A rejected fetch never reaches the response branch, so the panel would otherwise
    // stay on "Reading your deposit addresses…" with no way to learn why.
    const detail = reason instanceof Error ? reason.message : "the request was rejected";
    return { error: `The deposits API could not be reached from this browser (${detail}), so no deposit address was read.` };
  }
  const payload: unknown = await response.json().catch(() => null);
  const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  if (!response.ok) {
    const serverReason = typeof record.error === "string" ? record.error : null;
    const requestId = response.headers.get(REQUEST_ID_HEADER);
    const refusal = serverReason ?? `Deposits answered ${response.status} and returned no deposit data.`;
    return { error: requestId ? `${refusal} (request ${requestId})` : refusal };
  }
  return payload as DepositResponse;
}

export function DepositPanel() {
  const [data, setData] = useState<DepositResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await request("/api/deposits");
      if (cancelled) return;
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      setData(result);
      setSelected(defaultNetworkSlug(result));
    })();
    return () => { cancelled = true; };
  }, []);

  /**
   * Ask the server to scan now: the same run the scheduler makes, on demand.
   *
   * It takes no input from the browser — the server reads the chains and writes
   * what it finds — so asking for a check can never make something be credited
   * that arrived nowhere.
   */
  async function checkNow() {
    setBusy(true);
    try {
      const result = await request("/api/deposits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      setData(result);
      // A check that changed nothing must not move the person away from the
      // network they were reading, so the selection is only filled in when it is
      // empty or points at a network the answer no longer carries.
      setSelected((current) => {
        const networks = result.networks ?? [];
        if (current && networks.some((network) => network.slug === current)) return current;
        return defaultNetworkSlug(result);
      });
    } finally {
      setBusy(false);
    }
  }

  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      // A browser that refuses the clipboard is not an error to shout about: the
      // address is on screen and selectable, and the QR is right next to it.
      setCopied(false);
    }
  }

  const networks = data?.networks ?? [];
  const active = networks.find((network) => network.slug === selected) ?? null;
  const deposits = data?.deposits ?? [];
  const pending = deposits.filter((deposit) => deposit.status === "PENDING");
  const totals = data?.creditedTotals ?? [];

  if (!data && !error) {
    return <div className="market-chart-empty deposit-body" role="status">Reading your deposit addresses…</div>;
  }

  return (
    <div className="deposit-body">
      <div className="deposit-totals" role="status">
        <ShieldCheck aria-hidden="true" size={14} />
        <div>
          <strong>
            {error && !data
              ? "Deposits unavailable"
              : totals.length > 0
                ? totals.map(({ tokenSymbol, amount }) => `${amount} ${tokenSymbol}`).join(" · ")
                : "Nothing credited yet"}
          </strong>
          <span>credited to this account by the watcher, summed from the deposits that reached CREDITED</span>
        </div>
      </div>

      <div className="deposit-cadence">
        <Clock aria-hidden="true" size={14} />
        <span>
          {data
            ? `Watched every ${data.watchIntervalMinutes ?? 0} minute${(data.watchIntervalMinutes ?? 0) === 1 ? "" : "s"} and whenever you ask for a ` +
              "check. Detection, confirmations and crediting run on the server, so a deposit credits whether or not this page is open."
            : "The watcher's cadence is unknown, because the deposit read failed."}
        </span>
      </div>

      {error && (
        <div className="market-chart-empty deposit-refusal" role="alert">
          <strong>{error}</strong>
        </div>
      )}

      {data?.availability && (
        <div className="deposit-refusal" role="status">
          <CircleAlert aria-hidden="true" size={14} />
          <div>
            <strong>{data.availability.message}</strong>
            {data.availability.variable && <span>Set {data.availability.variable} to enable deposits.</span>}
          </div>
        </div>
      )}

      {data?.problems && data.problems.length > 0 && (
        <div className="deposit-refusal" role="status">
          <CircleAlert aria-hidden="true" size={14} />
          <div>
            <strong>This deployment&apos;s deposit configuration has a mistake in it</strong>
            {data.problems.map((problem) => <span key={problem}>{problem}</span>)}
          </div>
        </div>
      )}

      {networks.length > 0 && (
        <div className="deposit-network-tabs" role="tablist" aria-label="Deposit networks">
          {networks.map((network) => (
            <button
              aria-selected={network.slug === active?.slug}
              className={network.slug === active?.slug ? "deposit-network-tab deposit-network-tab--active" : "deposit-network-tab"}
              key={network.slug}
              onClick={() => { setSelected(network.slug); setCopied(false); }}
              role="tab"
              type="button"
            >
              <span>{network.displayName}</span>
              <small>{network.status === "ready" ? "READY" : network.status.replace("-", " ").toUpperCase()}</small>
            </button>
          ))}
        </div>
      )}

      {active && (
        <article className="deposit-address" aria-labelledby="deposit-address-title">
          <div className="deposit-address__details">
            <div className="deposit-address__head">
              <h3 id="deposit-address-title">{active.displayName} deposit address</h3>
              {active.testnet && <span className="deposit-badge deposit-badge--testnet">TESTNET</span>}
              <span className={`deposit-badge deposit-badge--${active.status}`}>{active.status.replace("-", " ").toUpperCase()}</span>
            </div>

            {active.address ? (
              <>
                <div className="deposit-address__value">
                  <code>{active.address}</code>
                  <button
                    className="section-action"
                    onClick={() => void copyAddress(active.address!)}
                    title="Copy address"
                    type="button"
                  >
                    {copied ? <Check aria-hidden="true" size={13} /> : <Copy aria-hidden="true" size={13} />}
                    {copied ? "COPIED" : "COPY"}
                  </button>
                </div>
                <dl className="deposit-address__facts">
                  <div>
                    <dt>NETWORK</dt>
                    <dd>{active.displayName} · chain {active.chainId}</dd>
                  </div>
                  <div>
                    <dt>SEND ONLY</dt>
                    <dd>
                      {active.token
                        ? `${active.token.symbol} · ${active.token.displayName}`
                        : `${active.nativeSymbol} — no deposit token is configured for this network`}
                    </dd>
                  </div>
                  <div>
                    <dt>TOKEN CONTRACT</dt>
                    <dd>{active.token ? active.token.address : "NOT CONFIGURED"}</dd>
                  </div>
                  <div>
                    <dt>CREDITED AFTER</dt>
                    <dd>{active.confirmations} confirmation{active.confirmations === 1 ? "" : "s"}</dd>
                  </div>
                  <div>
                    <dt>MINIMUM</dt>
                    <dd>{active.minimumAmount} {active.token?.symbol ?? ""} — below this it is recorded and never credited</dd>
                  </div>
                  <div>
                    <dt>DERIVED AT</dt>
                    <dd>{active.derivationPath ?? "UNAVAILABLE"}</dd>
                  </div>
                </dl>
                {active.token?.note && <p className="deposit-note">{active.token.note}</p>}
                {active.problems.length > 0 && (
                  <ul className="deposit-problems">
                    {active.problems.map((problem) => <li key={problem}>{problem}</li>)}
                  </ul>
                )}
              </>
            ) : (
              <div className="deposit-refusal" role="status">
                <CircleAlert aria-hidden="true" size={14} />
                <div>
                  <strong>No address was issued on {active.displayName}.</strong>
                  <span>
                    {active.missing.length > 0
                      ? `Set ${active.missing.join(", ")} to issue one.`
                      : "This network is not configured for deposits in this deployment."}
                  </span>
                </div>
              </div>
            )}
          </div>

          {active.address && (
            <div className="deposit-qr">
              <QRCodeSVG
                bgColor="#0b1011"
                fgColor="#e5eeeb"
                level="M"
                size={132}
                title={`${active.displayName} deposit address`}
                value={active.address}
              />
              <small>{active.displayName}</small>
            </div>
          )}
        </article>
      )}

      <div className="deposit-actions">
        <button className="section-action" disabled={busy} onClick={() => void checkNow()} type="button">
          <RefreshCw aria-hidden="true" size={13} />{busy ? "CHECKING…" : "CHECK NOW"}
        </button>
        <span className="deposit-actions__note">
          Asks the server to scan now. A check cannot credit a transfer that is not on chain, and a transfer already recorded is never counted
          twice.
        </span>
      </div>

      {data?.run && (
        <div className="deposit-run" role="status">
          <ShieldCheck aria-hidden="true" size={14} />
          <div>
            <strong>
              Scanned {data.run.scanned} of {data.run.networks} network(s) · {data.run.observations} transfer(s) seen · {data.run.recorded} new ·{" "}
              {data.run.duplicates} already known · {data.run.credited} credited · {data.run.reverted} reverted · {data.run.awaiting} still
              confirming
            </strong>
            {data.run.reason && <span>{data.run.reason.message}</span>}
            {/* A network that had nothing to read says so in its own words: "scanned
                0 of 1" on its own would read like a failure, and "the cursor is at
                the head of the chain" is the actual answer. */}
            {data.run.skipped.map((skip) => (
              <span key={`${skip.network}-${skip.code}`}>{skip.network}: {skip.message}</span>
            ))}
            {data.run.failed.map((failure) => (
              <span key={`${failure.network}-${failure.code}`}>{failure.network}: {failure.message}</span>
            ))}
          </div>
        </div>
      )}

      {pending.length > 0 && (
        <div className="deposit-pending" role="status">
          <Clock aria-hidden="true" size={14} />
          <div>
            <strong>{pending.length} transfer(s) on chain and not yet credited</strong>
            {pending.map((deposit) => (
              <span key={deposit.id}>{deposit.networkDisplayName}: {deposit.wait ?? `${deposit.confirmations} confirmation(s)`}</span>
            ))}
          </div>
        </div>
      )}

      {data && deposits.length === 0 ? (
        <div className="market-chart-empty" role="status">
          <strong>No transfers seen yet</strong>
          <span>Send {active?.token?.symbol ?? "the deposit token"} to the address above. It appears here as pending, then credited once it has the confirmations.</span>
        </div>
      ) : (
        <ul className="deposit-list" aria-label="Deposits">
          {deposits.map((deposit) => (
            <li className={`deposit-item deposit-item--${deposit.status.toLowerCase()}`} key={deposit.id}>
              <ArrowDownToLine aria-hidden="true" size={14} />
              <div className="deposit-item__main">
                <div className="deposit-item__title">
                  <strong>{deposit.amount} {deposit.tokenSymbol}</strong>
                  <span className={`deposit-status deposit-status--${deposit.status.toLowerCase()}`}>{deposit.stateLabel.replace("_", " ")}</span>
                  <span className="deposit-item__network">{deposit.networkDisplayName}</span>
                  {deposit.origin === "UNFILTERED" && <span className="deposit-badge">WIDE SCAN</span>}
                </div>
                <div className="deposit-item__facts">
                  <HashLink hash={deposit.txHash} url={deposit.explorerUrl} />
                  <span>log {deposit.logIndex}</span>
                  <span>block {deposit.blockNumber}</span>
                  <span>{deposit.confirmations}/{deposit.confirmationsRequired} confirmations</span>
                  <span>{deposit.creditedAt ? `credited ${deposit.creditedAt}` : `seen ${deposit.observedAt}`}</span>
                </div>
                {(deposit.reasonMessage || deposit.wait) && (
                  <p className="deposit-item__reason">
                    {deposit.reasonCode && <b>{deposit.reasonCode.replaceAll("_", " ")}</b>} {deposit.reasonMessage ?? deposit.wait}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="deposit-footnote">
        The credited figure above is the sum of deposits that reached CREDITED on this deployment. It is what the chain paid in — not a trading
        balance and not a ledger entry; the ledger is a later phase, and nothing here moves funds.
      </p>
    </div>
  );
}
