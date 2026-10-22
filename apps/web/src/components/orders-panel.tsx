"use client";

import { Ban, RefreshCw, RotateCcw, Send } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { isStepUpCancelled, useStepUp } from "@/components/step-up-prompt";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";

/**
 * The order panel: place a paper order, watch the lifecycle, cancel what is live.
 *
 * Everything it shows comes from the API — including each status's label and the
 * sentence that explains it (`ORDER_STATUS_DETAIL` on the server) and the reason
 * for every refusal. The panel therefore cannot invent a status it has no words
 * for, which is the point: a state on screen that nobody can explain is the thing
 * this phase exists to remove.
 *
 * The idempotency key field is deliberately left empty by default. An empty key
 * means "this intent, whatever it is" — so submitting the same order twice
 * returns the first order instead of placing a second one, and typing a key is how
 * a person asks for a deliberate repeat. The panel says which of the two happened
 * in the answer it shows.
 *
 * Submitting goes through the shared step-up prompt (phase 10), so when the owner
 * has turned the trading scope on, a code is asked for before the order exists —
 * and the order is replayed afterwards with the same idempotency key, which is
 * still its first use because the route refused before reading anything.
 */

type OrderStatus = "CREATED" | "SUBMITTED" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | "FAILED" | "RECONCILED";

type ReasonResource = { code: string; message: string; retryable: boolean; detail?: string; providerId?: string; variable?: string };

type OrderResource = {
  id: string;
  venue: string;
  market: string;
  side: string;
  orderType: string;
  status: OrderStatus;
  statusLabel: string;
  statusDetail: string;
  terminal: boolean;
  requestedQuantity: string;
  filledQuantity: string;
  remainingQuantity: string;
  clientOrderId: string;
  venueOrderId: string | null;
  idempotencyKey: string | null;
  limitPrice: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  lastAttemptReason: string | null;
  submittedAt: string | null;
  createdAt: string;
};

type LifecycleEntry = { status: OrderStatus; label: string; detail: string; terminal: boolean };

type OrdersPayload = {
  orders: OrderResource[];
  count: number;
  lifecycle: LifecycleEntry[];
  venue: {
    id: string;
    label: string;
    environment: "paper" | "testnet" | "live";
    paper: boolean;
    testnetRoutingEnabled: boolean;
    liveExecutionEnabled: boolean;
    available: boolean;
    detail: string;
  };
  retry: { detail: string };
  reconciliation: { intervalMinutes: number; cadence: string; detail: string };
};

/** What a pre-trade evaluation noticed. Reported beside the answer, never a refusal. */
type PreflightCheck = {
  name: string;
  status: "ok" | "notice" | "unavailable" | "not-applicable";
  code?: string;
  detail: string;
};

type PreTradeReport = {
  evaluatedAt: string;
  notices: PreflightCheck[];
  checks: PreflightCheck[];
  summary: string;
};

/** The dry comparison: what the testnet would have been asked for the same order. */
type TestnetComparison = {
  market: string;
  mappedPair: string | null;
  testnetRoutingEnabled: boolean;
  testnetKeyLabel: string | null;
  testnetKeyReadOnly: boolean | null;
  wouldPlaceOnTestnet: boolean;
  detail: string;
};

type OutcomePayload = {
  outcome?: string;
  attempts?: number;
  idempotencyKey?: string;
  reason?: ReasonResource;
  order?: OrderResource | null;
  error?: string;
  detail?: string;
  code?: string;
  requested?: string;
  /** Present when a switch stopped the attempt, naming it and its state. */
  switch?: { name: string; state: boolean; panel: string } | null;
  /** Phase 25: the owner's caps that refused it, each with the value it saw. */
  limits?: { reason: string; limit: string; cap: string | null; observed: string; scope: string }[];
  reasons?: string[];
  preflight?: PreTradeReport;
  testnetComparison?: TestnetComparison;
  routing?: string;
};

const ORDER_TYPES = ["MARKET", "LIMIT"] as const;
const SIDES = ["BUY", "SELL"] as const;
/** The four words a submission may name; `auto` follows the admin switches. */
type ExecutionTarget = "auto" | "paper" | "testnet" | "live";

function dollarsToCents(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) return null;
  const cents = Math.round(Number(trimmed) * 100);
  return Number.isFinite(cents) ? cents : null;
}

function shortKey(value: string | null) {
  if (!value) return "—";
  return `${value.slice(0, 10)}…${value.slice(-4)}`;
}

function when(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.toISOString().slice(11, 19)} UTC` : "—";
}

/**
 * A failed read, in a sentence that says what was not read. A browser's own
 * "Failed to fetch" names neither the surface nor the cause, so a transport failure is
 * translated here rather than printed as-is; a refusal the route explained keeps its words.
 */
function readFailure(reason: unknown): string {
  if (reason instanceof Error) {
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(reason.message)) {
      return "The orders API could not be reached from this browser, so no order state was read.";
    }
    return reason.message;
  }
  return "Orders could not be loaded.";
}

export function OrdersPanel() {
  const stepUp = useStepUp();
  const [payload, setPayload] = useState<OrdersPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [lastAnswer, setLastAnswer] = useState<OutcomePayload | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [market, setMarket] = useState<string>(USD_WATCHLIST[0].productId);
  const [side, setSide] = useState<(typeof SIDES)[number]>("BUY");
  const [orderType, setOrderType] = useState<(typeof ORDER_TYPES)[number]>("MARKET");
  const [quantity, setQuantity] = useState("0.001");
  const [limitPrice, setLimitPrice] = useState("");
  const [notionalUsd, setNotionalUsd] = useState("100");
  const [verifiedBalanceUsd, setVerifiedBalanceUsd] = useState("250");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [execution, setExecution] = useState<ExecutionTarget>("auto");
  const [comparison, setComparison] = useState<TestnetComparison | null>(null);
  const [comparing, setComparing] = useState(false);
  const [lastSubmission, setLastSubmission] = useState<{ body: string; key: string } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/trading/orders", { cache: "no-store" });
      const result = (await response.json()) as OrdersPayload & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Orders could not be loaded.");
      setPayload(result);
      setError("");
    } catch (reason) {
      setError(readFailure(reason));
    } finally {
      setLoading(false);
    }
  }

  // The first read is done here rather than by calling `load` directly: a state
  // update inside an effect body would render twice before the response arrives,
  // so every set here happens after an await.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/trading/orders", { cache: "no-store" });
        const result = (await response.json()) as OrdersPayload & { error?: string };
        if (!active) return;
        if (!response.ok) throw new Error(result.error ?? "Orders could not be loaded.");
        setPayload(result);
        setError("");
      } catch (reason) {
        if (active) setError(readFailure(reason));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  function draftBody() {
    const notional = dollarsToCents(notionalUsd);
    const balance = dollarsToCents(verifiedBalanceUsd);
    if (notional === null || notional <= 0) {
      setError("Notional must be a US dollar amount, for example 100 or 100.50.");
      return null;
    }
    if (balance === null) {
      setError("Verified balance must be a US dollar amount.");
      return null;
    }
    return JSON.stringify({
      market,
      side,
      orderType,
      quantity: quantity.trim(),
      ...(orderType === "LIMIT" ? { limitPrice: limitPrice.trim() } : {}),
      notionalUsdCents: notional,
      verifiedBalanceCents: balance,
      execution,
      ...(idempotencyKey.trim() ? { idempotencyKey: idempotencyKey.trim() } : {}),
    });
  }

  /**
   * The dry comparison, fetched on demand.
   *
   * It is a separate read and never part of a submission: the owner compares the live
   * configuration with the testnet when they want to, and the comparison cannot stand
   * between them and the exchange.
   */
  async function compare() {
    setComparing(true);
    setError("");
    try {
      const response = await fetch(`/api/trading/orders/comparison?market=${encodeURIComponent(market)}`, { cache: "no-store" });
      const result = (await response.json()) as { report?: TestnetComparison; error?: string };
      if (!response.ok || !result.report) throw new Error(result.error ?? "The comparison could not be built.");
      setComparison(result.report);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The comparison could not be built.");
    } finally {
      setComparing(false);
    }
  }

  async function send(body: string, key: string, mode: "submit" | "resubmit") {
    setSubmitting(true);
    setNotice("");
    setError("");
    try {
      const response = await stepUp.send("/api/trading/orders", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
        body,
      });
      const result = (await response.json()) as OutcomePayload;
      setLastAnswer(result);
      if (!response.ok && !result.order && !result.reason) throw new Error(result.error ?? "The order was not accepted.");
      if (result.order) {
        setPayload((current) => {
          if (!current) return current;
          const orders = [result.order as OrderResource, ...current.orders.filter((order) => order.id !== result.order?.id)];
          return { ...current, orders, count: orders.length };
        });
      }
      const outcome = result.outcome ?? "answered";
      const message =
        mode === "resubmit"
          ? `The same order was sent again with the same key (${outcome}). ${result.reason?.message ?? ""}`.trim()
          : `${outcome.toUpperCase()} — ${result.reason?.message ?? "The order was recorded."}`;
      setNotice(message);
      setLastSubmission({ body, key });
      void load();
    } catch (reason) {
      setError(
        isStepUpCancelled(reason)
          ? "No code was given, so nothing was submitted and no order exists."
          : reason instanceof Error ? reason.message : "The order could not be submitted.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draftBody();
    if (!body) return;
    await send(body, idempotencyKey.trim(), "submit");
  }

  async function cancel(order: OrderResource) {
    setBusyOrderId(order.id);
    setNotice("");
    setError("");
    try {
      const response = await stepUp.send(`/api/trading/orders/${encodeURIComponent(order.id)}/cancel`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Cancelled from the trading page." }),
      });
      const result = (await response.json()) as OutcomePayload;
      setLastAnswer(result);
      if (!response.ok && !result.reason) throw new Error(result.error ?? "The cancel was refused.");
      setNotice(`${(result.outcome ?? "answered").toUpperCase()} — ${result.reason?.message ?? "The cancel was recorded."}`);
      void load();
    } catch (reason) {
      setError(
        isStepUpCancelled(reason)
          ? "No code was given, so the cancel was not sent and the order is unchanged."
          : reason instanceof Error ? reason.message : "The order could not be cancelled.",
      );
    } finally {
      setBusyOrderId(null);
    }
  }

  return (
    <div className="orders-panel">
      {stepUp.prompt}
      <div className="orders-panel__state" role="status">
        {/* Three environments, three words: a testnet is not paper and neither is live. */}
        {loading
          ? "LOADING ORDERS"
          : !payload
            ? "ORDERS UNAVAILABLE"
            : `${payload.count} ORDER(S) · ${
                payload.venue.environment === "testnet"
                  ? "TESTNET VENUE"
                  : payload.venue.environment === "live"
                    ? "LIVE VENUE"
                    : "PAPER VENUE"
              }`}
      </div>
      <p className="orders-panel__note">
        {payload?.venue.detail ?? "The venue and its order count are unknown, because the read failed. The reason is shown below."}{" "}
        {payload?.retry.detail}
      </p>

      <form aria-label="Order ticket" className="orders-panel__form" id="order-ticket" onSubmit={submit}>
        <label>
          <span>Market</span>
          <select value={market} onChange={(event) => setMarket(event.target.value)}>
            {USD_WATCHLIST.map(({ productId, name }) => (
              <option key={productId} value={productId}>{productId} · {name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Side</span>
          <select value={side} onChange={(event) => setSide(event.target.value as (typeof SIDES)[number])}>
            {SIDES.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label>
          <span>Type</span>
          <select value={orderType} onChange={(event) => setOrderType(event.target.value as (typeof ORDER_TYPES)[number])}>
            {ORDER_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        {/*
          * Where the order goes, as a choice rather than a hidden fact. ROUTING is the
          * default and follows the admin switches; naming a venue is how a person asks for
          * one specifically, and how "live, with the switch off" gets its named answer. It
          * is a venue selector, not a confirmation: when live is switched on, ROUTING
          * already means live and nothing further is asked.
          */}
        <label>
          <span>Execution</span>
          <select value={execution} onChange={(event) => setExecution(event.target.value as ExecutionTarget)}>
            <option value="auto">ROUTING · {payload?.venue.environment ?? "paper"}</option>
            <option value="paper">PAPER · moves no money</option>
            <option value="testnet">TESTNET · sandbox key</option>
            <option value="live">
              LIVE · real funds{payload?.venue.liveExecutionEnabled === false ? " — switch off in /admin/risk" : ""}
            </option>
          </select>
        </label>
        <label>
          <span>Quantity</span>
          <input inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
        </label>
        {orderType === "LIMIT" ? (
          <label>
            <span>Limit price (USD)</span>
            <input inputMode="decimal" value={limitPrice} onChange={(event) => setLimitPrice(event.target.value)} placeholder="2400" />
          </label>
        ) : null}
        <label>
          <span>Notional (USD)</span>
          <input inputMode="decimal" value={notionalUsd} onChange={(event) => setNotionalUsd(event.target.value)} />
        </label>
        <label>
          <span>Verified balance (USD)</span>
          <input inputMode="decimal" value={verifiedBalanceUsd} onChange={(event) => setVerifiedBalanceUsd(event.target.value)} />
        </label>
        <label>
          <span>Idempotency key (optional)</span>
          <input
            value={idempotencyKey}
            onChange={(event) => setIdempotencyKey(event.target.value)}
            placeholder="empty: an identical order resolves to the same one"
          />
        </label>
        <div className="orders-panel__actions">
          <button type="submit" disabled={submitting}>
            <Send aria-hidden="true" size={13} />{" "}
            {submitting
              ? "Submitting…"
              : `Submit ${execution === "auto" ? (payload?.venue.environment ?? "paper") : execution} order`}
          </button>
          <button type="button" className="orders-panel__secondary" disabled={comparing} onClick={() => void compare()}>
            {comparing ? "Comparing…" : "Compare with testnet"}
          </button>
          <button
            type="button"
            className="orders-panel__secondary"
            disabled={submitting || !lastSubmission}
            onClick={() => lastSubmission && void send(lastSubmission.body, lastSubmission.key, "resubmit")}
          >
            <RotateCcw aria-hidden="true" size={13} /> Send the same order again
          </button>
          <button type="button" className="orders-panel__secondary" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" size={13} /> Refresh
          </button>
        </div>
      </form>

      {notice ? <p className="orders-panel__notice" role="status">{notice}</p> : null}
      {error ? <p className="orders-panel__error" role="alert">{error}</p> : null}

      {/*
        * What a switch refused, with the switch's own name and state — the sentence the
        * owner needs is "this is off in /admin/risk", not "bad request".
        */}
      {lastAnswer?.switch ? (
        <p className="orders-panel__reason orders-panel__reason--failed">
          <span className="orders-panel__reason-code">{lastAnswer.code}</span>
          <span>{lastAnswer.error}</span>
          <span className="orders-panel__reason-detail">
            {lastAnswer.switch.name} = {String(lastAnswer.switch.state)} · editable at {lastAnswer.switch.panel}
          </span>
        </p>
      ) : null}

      {/*
        * The pre-trade report. It is shown whatever the outcome, including when every check
        * passed, because "nothing to report" is itself the reading the owner asked for.
        */}
      {lastAnswer?.preflight ? (
        <div className="orders-panel__preflight">
          <p role="status">{lastAnswer.preflight.summary}</p>
          {lastAnswer.preflight.notices.length > 0 ? (
            <ul>
              {lastAnswer.preflight.notices.map((check) => (
                <li key={`${check.name}-${check.code ?? "notice"}`}>
                  <strong>{check.code ?? check.name}</strong> {check.detail}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {lastAnswer?.testnetComparison ? (
        <p className="orders-panel__note" role="status">
          <strong>Testnet comparison (dry, nothing placed):</strong> {lastAnswer.testnetComparison.detail}
        </p>
      ) : null}

      {comparison ? (
        <p className="orders-panel__note" role="status">
          <strong>Testnet comparison (dry, nothing placed):</strong> {comparison.detail}
        </p>
      ) : null}

      {lastAnswer?.limits && lastAnswer.limits.length > 0 ? (
        <ul className="orders-panel__reason orders-panel__reason--failed" role="alert">
          {lastAnswer.limits.map((limit) => (
            <li key={`${limit.limit}-${limit.reason}`}>
              <span className="orders-panel__reason-code">{limit.limit}</span>
              <span>
                {limit.cap === null ? limit.observed : `${limit.observed} against a cap of ${limit.cap}`} ({limit.scope} limit, {limit.reason})
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {lastAnswer?.reason ? (
        <p className={`orders-panel__reason orders-panel__reason--${lastAnswer.outcome === "failed" ? "failed" : "ok"}`}>
          <span className="orders-panel__reason-code">{lastAnswer.reason.code}</span>
          <span>{lastAnswer.reason.message}</span>
          {lastAnswer.reason.detail ? <span className="orders-panel__reason-detail">{lastAnswer.reason.detail}</span> : null}
          {lastAnswer.idempotencyKey ? <span className="orders-panel__reason-detail">key {shortKey(lastAnswer.idempotencyKey)}</span> : null}
        </p>
      ) : null}

      <ul className="orders-panel__list">
        {(payload?.orders ?? []).map((order) => (
          <li key={order.id} className={`orders-panel__row orders-panel__row--${order.status.toLowerCase()}`}>
            <div className="orders-panel__row-head">
              <strong>{order.market} · {order.side} · {order.orderType}</strong>
              <span className="orders-panel__status" title={order.statusDetail}>{order.statusLabel}</span>
            </div>
            <p className="orders-panel__row-detail">{order.statusDetail}</p>
            <dl className="orders-panel__facts">
              <div><dt>requested</dt><dd>{order.requestedQuantity}</dd></div>
              <div><dt>executed</dt><dd>{order.filledQuantity}</dd></div>
              <div><dt>still live</dt><dd>{order.remainingQuantity}</dd></div>
              <div><dt>attempts</dt><dd>{order.attempts}</dd></div>
              <div><dt>venue order</dt><dd>{order.venueOrderId ?? "—"}</dd></div>
              <div><dt>submitted</dt><dd>{when(order.submittedAt)}</dd></div>
              <div><dt>key</dt><dd>{shortKey(order.idempotencyKey)}</dd></div>
            </dl>
            {order.lastAttemptReason ? <p className="orders-panel__row-reason">Last attempt: {order.lastAttemptReason}</p> : null}
            {order.terminal ? null : (
              <button type="button" onClick={() => void cancel(order)} disabled={busyOrderId === order.id}>
                <Ban aria-hidden="true" size={13} /> {busyOrderId === order.id ? "Cancelling…" : "Cancel order"}
              </button>
            )}
          </li>
        ))}
        {!loading && (payload?.orders.length ?? 0) === 0 ? <li className="orders-panel__empty">No orders yet. Submit one above and it appears here with its state.</li> : null}
      </ul>

      {payload ? (
        <details className="orders-panel__lifecycle">
          <summary>Every status this panel can show ({payload.lifecycle.length})</summary>
          <dl>
            {payload.lifecycle.map((entry) => (
              <div key={entry.status}>
                <dt>{entry.label}{entry.terminal ? " · terminal" : ""}</dt>
                <dd>{entry.detail}</dd>
              </div>
            ))}
          </dl>
          <p className="orders-panel__reconcile">{payload.reconciliation.detail} {payload.reconciliation.cadence}</p>
        </details>
      ) : null}
    </div>
  );
}
