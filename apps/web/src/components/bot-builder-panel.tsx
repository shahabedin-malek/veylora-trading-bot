"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { LockKeyhole, Play, Plus, Skull } from "lucide-react";
import {
  evaluateBacktestGate,
  LIVE_PATH_REQUIREMENTS,
  transitionBotState,
  validateBotConfiguration,
  type BacktestGateResult,
  type BotConfiguration,
  type BotState,
} from "@/lib/bot-builder/state-machine";
import type { BacktestResult } from "@/lib/backtesting/rsi-backtester";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";
import type { PaperCycleStatus, PaperTradingView } from "@/lib/paper-trading/engine";

type BotDraft = {
  id: string;
  config: BotConfiguration;
  state: BotState;
  backtest: BacktestResult | null;
  backtestGate: BacktestGateResult | null;
  backtestError: string | null;
  paperView: PaperTradingView;
  paperStatus: PaperCycleStatus | null;
  paperMessage: string | null;
  paperError: string | null;
};

const initialForm = {
  name: "",
  description: "",
  symbol: "BTC-USD",
  schedule: "DAILY_CLOSE",
  budgetCapUsd: "",
  maxTradeSizeUsd: "",
  stopLossPercent: "",
  dailyLossHaltPercent: "2",
  feeBps: "",
  slippageBps: "",
  buyRsiBelow: "30",
  sellRsiAbove: "70",
  maxDrawdownGatePercent: "20",
  minWinRateGatePercent: "40",
  minProfitFactorGate: "1.2",
} satisfies BotConfiguration;

const formFields: { key: keyof BotConfiguration; label: string; placeholder?: string }[] = [
  { key: "name", label: "STRATEGY NAME", placeholder: "RSI recovery" },
  { key: "description", label: "DESCRIPTION", placeholder: "What does this strategy test?" },
  { key: "budgetCapUsd", label: "PAPER BUDGET CAP (USD)", placeholder: "Required" },
  { key: "maxTradeSizeUsd", label: "PAPER MAX TRADE SIZE (USD)", placeholder: "At most 25% of budget" },
  { key: "stopLossPercent", label: "PAPER STOP-LOSS (%)", placeholder: "Required" },
  { key: "dailyLossHaltPercent", label: "PAPER DAILY-LOSS HALT (%)" },
  { key: "feeBps", label: "PAPER FEE (BPS / SIDE)", placeholder: "Required" },
  { key: "slippageBps", label: "PAPER SLIPPAGE (BPS / SIDE)", placeholder: "Required" },
  { key: "buyRsiBelow", label: "PAPER ENTRY RSI-14 CROSS BELOW" },
  { key: "sellRsiAbove", label: "PAPER EXIT RSI-14 CROSS ABOVE" },
  { key: "maxDrawdownGatePercent", label: "PAPER BACKTEST MAX DRAWDOWN (%)" },
  { key: "minWinRateGatePercent", label: "PAPER BACKTEST MIN WIN RATE (%)" },
  { key: "minProfitFactorGate", label: "PAPER BACKTEST MIN PROFIT FACTOR" },
];

function formatMetric(value: string | null, suffix = "") {
  if (value === null || !Number.isFinite(Number(value))) return "NOT AVAILABLE";
  return `${Number(value).toFixed(2)}${suffix}`;
}

function formatPaperCents(value: number | null) {
  return value === null ? "NOT ACTIVE" : `$${(value / 100).toFixed(2)} PAPER`;
}

function configFromPaperView(view: PaperTradingView): BotConfiguration {
  return {
    name: view.paperConfig.paperName,
    description: view.paperConfig.paperDescription,
    symbol: view.paperConfig.paperSymbol,
    schedule: "DAILY_CLOSE",
    budgetCapUsd: view.paperConfig.paperBudgetCapUsd,
    maxTradeSizeUsd: view.paperConfig.paperMaxTradeSizeUsd,
    stopLossPercent: view.paperConfig.paperStopLossPercent,
    dailyLossHaltPercent: view.paperConfig.paperDailyLossHaltPercent,
    feeBps: view.paperConfig.paperFeeBps,
    slippageBps: view.paperConfig.paperSlippageBps,
    buyRsiBelow: view.paperConfig.paperBuyRsiBelow,
    sellRsiAbove: view.paperConfig.paperSellRsiAbove,
    maxDrawdownGatePercent: view.paperConfig.paperMaxDrawdownGatePercent,
    minWinRateGatePercent: view.paperConfig.paperMinWinRateGatePercent,
    minProfitFactorGate: view.paperConfig.paperMinProfitFactorGate,
  };
}

function isPaperView(value: unknown): value is PaperTradingView {
  return typeof value === "object" && value !== null && "paperMode" in value && value.paperMode === "PAPER" &&
    "paperBotId" in value && typeof value.paperBotId === "string" && "paperConfig" in value;
}

/** Must match DEV_PAPER_SESSION_ID in src/lib/paper-trading/dev-seed.ts. */
const DEV_PAPER_SESSION_ID = "00000000-0000-4000-8000-000000000000";

function sessionId() {
  // Development shows the server's seeded paper session, so the strategies on
  // screen are the seeded draft/paper/stopped set. Every other mode keeps the
  // per-tab session, which is what keeps the PAPER store unshared in production.
  if (process.env.NODE_ENV === "development") return DEV_PAPER_SESSION_ID;
  const stored = window.sessionStorage.getItem("veylora-paper-session");
  if (stored) return stored;
  const created = window.crypto.randomUUID();
  window.sessionStorage.setItem("veylora-paper-session", created);
  return created;
}

export function BotBuilderPanel() {
  const [form, setForm] = useState<BotConfiguration>(initialForm);
  const [bots, setBots] = useState<BotDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [paperSessionId] = useState(() => typeof window === "undefined" ? "" : sessionId());
  const [loading, setLoading] = useState(true);
  const botsRef = useRef<BotDraft[]>([]);

  useEffect(() => {
    const currentPaperSessionId = paperSessionId;
    if (!currentPaperSessionId) return;
    void fetch(`/api/bots?paperSessionId=${encodeURIComponent(currentPaperSessionId)}`, { credentials: "same-origin" })
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok || !payload || typeof payload !== "object" || !("paperBots" in payload) || !Array.isArray(payload.paperBots)) {
          throw new Error("Paper session data is unavailable.");
        }
        const restored = payload.paperBots.filter(isPaperView).map((paperView) => ({
          id: paperView.paperBotId,
          config: configFromPaperView(paperView),
          state: paperView.paperState,
          backtest: null,
          backtestGate: null,
          backtestError: null,
          paperView,
          paperStatus: null,
          paperMessage: null,
          paperError: null,
        } satisfies BotDraft));
        setBots(restored);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Paper session data is unavailable."))
      .finally(() => setLoading(false));
  }, [paperSessionId]);

  useEffect(() => { botsRef.current = bots; }, [bots]);

  useEffect(() => {
    if (!paperSessionId) return;
    const interval = window.setInterval(() => {
      for (const bot of botsRef.current) {
        if (bot.state !== "PAPER") continue;
        void fetch(`/api/bots/${encodeURIComponent(bot.id)}/paper-cycle`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paperSessionId }),
        }).then(async (response) => {
          const payload: unknown = await response.json().catch(() => null);
          if (!response.ok || !payload || typeof payload !== "object" || !("paperView" in payload) || !isPaperView(payload.paperView)) return;
          setBots((current) => current.map((item) => item.id === bot.id
            ? { ...item, paperView: payload.paperView as PaperTradingView,
              paperStatus: "paperStatus" in payload && typeof payload.paperStatus === "string" ? payload.paperStatus as PaperCycleStatus : item.paperStatus,
              paperMessage: "paperMessage" in payload && typeof payload.paperMessage === "string" ? payload.paperMessage : item.paperMessage,
              paperError: null }
            : item));
        }).catch(() => undefined);
      }
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [paperSessionId]);

  function update(field: keyof BotConfiguration, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function createBot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const validation = validateBotConfiguration(form);
    if (!validation.valid) {
      setError(validation.error);
      return;
    }
    setBusyId("new-paper-bot");
    try {
      const currentPaperSessionId = paperSessionId || sessionId();
      const response = await fetch("/api/bots", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paperSessionId: currentPaperSessionId, paperConfig: validation.value }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== "object" || !("paperBot" in payload) || !isPaperView(payload.paperBot)) {
        const reason = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "Paper draft could not be created.";
        throw new Error(reason);
      }
      const paperView = payload.paperBot;
      const bot: BotDraft = {
        id: paperView.paperBotId,
        config: validation.value,
        state: paperView.paperState,
        backtest: null,
        backtestGate: null,
        backtestError: null,
        paperView,
        paperStatus: null,
        paperMessage: null,
        paperError: null,
      };
      setBots((current) => [bot, ...current]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Paper draft could not be created.");
    } finally {
      setBusyId(null);
    }
  }

  async function runBacktest(bot: BotDraft) {
    setError(null);
    setBusyId(bot.id);
    try {
      const response = await fetch("/api/backtest", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: bot.config.symbol,
          initialCapitalUsd: bot.config.budgetCapUsd,
          maxTradeSizeUsd: bot.config.maxTradeSizeUsd,
          stopLossPercent: bot.config.stopLossPercent,
          dailyLossHaltPercent: bot.config.dailyLossHaltPercent,
          feeBps: bot.config.feeBps,
          slippageBps: bot.config.slippageBps,
          buyRsiBelow: bot.config.buyRsiBelow,
          sellRsiAbove: bot.config.sellRsiAbove,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== "object" || !("barCount" in payload)) {
        const reason = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : "Full-period backtest is unavailable.";
        throw new Error(reason);
      }
      const result = payload as BacktestResult;
      const gate = evaluateBacktestGate(bot.config, result);
      setBots((current) => current.map((item) => item.id === bot.id
        ? { ...item, backtest: result, backtestGate: gate, backtestError: null }
        : item));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Backtest is unavailable.";
      setBots((current) => current.map((item) => item.id === bot.id
        ? { ...item, backtest: null, backtestGate: null, backtestError: message }
        : item));
    } finally {
      setBusyId(null);
    }
  }

  async function runPaperCycle(bot: BotDraft) {
    if (!paperSessionId) return;
    setBusyId(bot.id);
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(bot.id)}/paper-cycle`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paperSessionId }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!payload || typeof payload !== "object" || !("paperView" in payload) || !isPaperView(payload.paperView)) {
        const reason = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "Paper cycle is unavailable.";
        throw new Error(reason);
      }
      const paperView = payload.paperView;
      setBots((current) => current.map((item) => item.id === bot.id ? {
        ...item,
        paperView,
        state: paperView.paperState,
        paperStatus: "paperStatus" in payload && typeof payload.paperStatus === "string" ? payload.paperStatus as PaperCycleStatus : null,
        paperMessage: "paperMessage" in payload && typeof payload.paperMessage === "string" ? payload.paperMessage : null,
        paperError: response.ok ? null : "Fresh Coinbase paper cycle unavailable.",
      } : item));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Paper cycle is unavailable.";
      setBots((current) => current.map((item) => item.id === bot.id ? { ...item, paperError: message } : item));
    } finally {
      setBusyId(null);
    }
  }

  async function transition(bot: BotDraft, next: BotState) {
    if (!paperSessionId) return;
    const outcome = transitionBotState(bot.state, next, bot.backtestGate?.passed === true);
    if (!outcome.allowed) {
      setError(outcome.reason);
      return;
    }
    setError(null);
    setBusyId(bot.id);
    try {
      const endpoint = next === "KILLED" ? `/api/bots/${encodeURIComponent(bot.id)}/kill` : `/api/bots/${encodeURIComponent(bot.id)}/paper`;
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paperSessionId }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const candidate = payload && typeof payload === "object" && "paperView" in payload ? payload.paperView : null;
      if (!response.ok || !isPaperView(candidate)) {
        const reason = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : payload && typeof payload === "object" && "paperBacktestReasons" in payload && Array.isArray(payload.paperBacktestReasons)
            ? payload.paperBacktestReasons.join(" ")
            : "Paper state transition is unavailable.";
        throw new Error(reason);
      }
      setBots((current) => current.map((item) => item.id === bot.id ? {
        ...item,
        state: candidate.paperState,
        paperView: candidate,
        paperStatus: null,
        paperMessage: next === "PAPER" ? "Paper accounting initialized; cycle checks use current Coinbase data." : "Paper kill switch engaged; no further paper fills will run.",
        paperError: null,
      } : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Paper state transition is unavailable.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="bot-builder-workbench">
      <section className="data-section bot-builder-config" aria-labelledby="bot-config-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">PAPER ONLY · VIRTUAL LEDGER</div>
            <h2 id="bot-config-title">New strategy</h2>
          </div>
          <span className="section-state">DRAFT</span>
        </div>
        <form className="bot-builder-form" onSubmit={createBot}>
          {formFields.map(({ key, label, placeholder }) => (
            <label key={key}>
              <span>{label}</span>
              <input
                inputMode={key === "name" || key === "description" ? "text" : "decimal"}
                onChange={(event) => update(key, event.target.value)}
                placeholder={placeholder}
                required={key !== "description"}
                value={form[key]}
              />
            </label>
          ))}
          <label>
            <span>MARKET</span>
            <select onChange={(event) => update("symbol", event.target.value)} value={form.symbol}>
              {USD_WATCHLIST.map(({ productId }) => <option key={productId} value={productId}>{productId}</option>)}
            </select>
          </label>
          <label>
            <span>SCHEDULE</span>
            <select onChange={(event) => update("schedule", event.target.value)} value={form.schedule}>
              <option value="DAILY_CLOSE">Every completed daily candle close</option>
            </select>
          </label>
          <div className="bot-builder-logic">
            <span>INDICATOR</span><strong>RSI-14 · DAILY</strong>
            <span>ENTRY CONDITION</span><strong>Cross below {form.buyRsiBelow || "—"}</strong>
            <span>ENTRY ACTION</span><strong>BUY · capped at configured trade size</strong>
            <span>EXIT CONDITION</span><strong>Cross above {form.sellRsiAbove || "—"} or stop-loss</strong>
            <span>EXIT ACTION</span><strong>SELL · no order path configured</strong>
          </div>
          <p className="bot-builder-note">Paper fills use Coinbase public quotes, integer-cent accounting, and configured fees/slippage. This in-memory paper service is local-development only; checks run every 30 seconds while this page is open. No wallet, exchange, order, or withdrawal path is used.</p>
          <button className="section-action" disabled={busyId === "new-paper-bot"} type="submit"><Plus aria-hidden="true" size={14} />{busyId === "new-paper-bot" ? "CREATING PAPER DRAFT" : "CREATE PAPER DRAFT"}</button>
        </form>
        {error && <p className="login-error" role="alert">{error}</p>}
      </section>

      <section className="data-section bot-builder-list" aria-labelledby="bot-list-title">
        <div className="section-heading">
          <div><div className="section-kicker">PAPER STRATEGY STATE MACHINE</div><h2 id="bot-list-title">Strategies</h2></div>
          <span className="section-state">{bots.length} PAPER BOTS</span>
        </div>
        {loading ? (
          <div className="market-chart-empty" role="status"><strong>Loading paper session</strong></div>
        ) : bots.length === 0 ? (
          <div className="market-chart-empty" role="status"><strong>No paper strategies</strong><span>A paper draft enters paper accounting only after the server verifies a passing full-period backtest.</span></div>
        ) : (
          <div className="bot-builder-cards">
            {bots.map((bot) => (
              <article className="bot-builder-card" key={bot.id}>
                <div className="bot-builder-card__heading">
                  <div><strong>{bot.config.name}</strong><span>{bot.config.symbol} · PAPER · {bot.config.schedule.replaceAll("_", " ")}</span></div>
                  <b className={`bot-state bot-state--${bot.state.toLowerCase()}`}>{bot.state}</b>
                </div>
                {bot.config.description && <p className="bot-builder-card__description">{bot.config.description}</p>}
                <dl className="bot-builder-metrics">
                  <div><dt>PAPER BUDGET CAP</dt><dd>${bot.config.budgetCapUsd} PAPER</dd></div>
                  <div><dt>PAPER MAX TRADE</dt><dd>${bot.config.maxTradeSizeUsd} PAPER</dd></div>
                  <div><dt>PAPER CASH</dt><dd>{formatPaperCents(bot.paperView.paperCashBalanceCents)}</dd></div>
                  <div><dt>PAPER EQUITY</dt><dd>{formatPaperCents(bot.paperView.paperEquityCents)}</dd></div>
                  <div><dt>PAPER P&amp;L</dt><dd>{formatPaperCents(bot.paperView.paperPnlCents)}</dd></div>
                  <div><dt>PAPER FEES</dt><dd>{formatPaperCents(bot.paperView.paperFeesCents)}</dd></div>
                  <div><dt>PAPER POSITION VALUE</dt><dd>{formatPaperCents(bot.paperView.paperBudgetUsedCents)}</dd></div>
                  <div><dt>PAPER ORDERS TODAY</dt><dd>{bot.paperView.paperAccountingActive ? `${bot.paperView.paperTradesToday} PAPER` : "NOT ACTIVE"}</dd></div>
                  <div><dt>PAPER POSITION</dt><dd>{bot.paperView.paperPositionQuantity ?? "FLAT"}</dd></div>
                  <div><dt>PAPER MARK</dt><dd>{bot.paperView.paperMarkPrice ? `$${bot.paperView.paperMarkPrice} PAPER` : "WAITING FOR QUOTE"}</dd></div>
                  <div><dt>PAPER RISK STATE</dt><dd>{bot.state === "PAPER" ? "PAPER RISK ACTIVE · NO LIVE ORDERS" : bot.state === "KILLED" ? "PAPER KILL SWITCH ACTIVE" : "PAPER ACCOUNTING NOT STARTED"}</dd></div>
                </dl>
                {bot.backtestError && <p className="login-error" role="alert">Backtest unavailable: {bot.backtestError}</p>}
                {bot.paperError && <p className="login-error" role="alert">Paper cycle unavailable: {bot.paperError}</p>}
                {bot.state === "DRAFT" && !bot.backtestGate?.passed && (
                  <p className="bot-builder-card__description">
                    Paper mode stays unavailable until a full-period backtest passes the gate. The button is
                    present: run the backtest first and it becomes usable.
                  </p>
                )}
                <div className="bot-builder-actions">
                  {bot.state === "DRAFT" && <button disabled={busyId === bot.id} onClick={() => void runBacktest(bot)} type="button"><Play aria-hidden="true" size={14} />{busyId === bot.id ? "RUNNING FULL-YEAR BACKTEST" : "BACKTEST THIS STRATEGY"}</button>}
                  {bot.state === "DRAFT" && <button disabled={!bot.backtestGate?.passed || busyId === bot.id} onClick={() => void transition(bot, "PAPER")} type="button">{busyId === bot.id ? "VERIFYING PAPER GATE" : "START PAPER MODE"}</button>}
                  {bot.state === "PAPER" && <button disabled={busyId === bot.id} onClick={() => void runPaperCycle(bot)} type="button"><Play aria-hidden="true" size={14} />{busyId === bot.id ? "RUNNING PAPER CHECK" : "RUN PAPER CHECK"}</button>}
                  {bot.state !== "KILLED" && <button className="bot-kill-button" disabled={busyId === bot.id} onClick={() => void transition(bot, "KILLED")} type="button"><Skull aria-hidden="true" size={14} />KILL PAPER BOT</button>}
                  <span className="bot-live-state"><LockKeyhole aria-hidden="true" size={14} />ARMED / LIVE ARE NOT WIRED YET</span>
                </div>
                {bot.backtest && (
                  <div className="bot-backtest-summary" role="status">
                    <strong>{bot.backtestGate?.passed ? "FULL-PERIOD BACKTEST GATE PASSED" : "FULL-PERIOD BACKTEST GATE FAILED"}</strong>
                    <span>{bot.backtest.barCount} bars · {new Date(bot.backtest.periodStart).toISOString().slice(0, 10)} — {new Date(bot.backtest.periodEnd).toISOString().slice(0, 10)} · costs included</span>
                    <div className="bot-backtest-summary__metrics">
                      <span>FEES ${formatMetric(bot.backtest.totalFeesUsd)}</span>
                      <span>SLIPPAGE ${formatMetric(bot.backtest.totalSlippageUsd)}</span>
                      <span>MAX DD {formatMetric(bot.backtest.maxDrawdownPercent, "%")}</span>
                      <span>WIN RATE {formatMetric(bot.backtest.winRatePercent, "%")}</span>
                      <span>PROFIT FACTOR {formatMetric(bot.backtest.profitFactor)}</span>
                    </div>
                    {bot.backtestGate && !bot.backtestGate.passed && <ul>{bot.backtestGate.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
                    <small>A gate pass means the full-period metrics met your entered thresholds; it is not evidence of future profitability.</small>
                  </div>
                )}
                {bot.state === "PAPER" && (
                  <div className="paper-cycle-summary" role="status">
                    <strong>{bot.paperStatus ?? "PAPER CHECK ACTIVE"}</strong>
                    <span>{bot.paperMessage ?? "Paper checks run every 30 seconds while this page is open."}</span>
                    <span>PAPER LAST CHECK: {bot.paperView.paperLastCycleAt ? new Date(bot.paperView.paperLastCycleAt).toLocaleString() : "WAITING"}</span>
                    <span>PAPER SIGNAL CANDLE: {bot.paperView.paperLastProcessedCandleAt ? new Date(bot.paperView.paperLastProcessedCandleAt).toISOString().slice(0, 10) : "WAITING"}</span>
                    {bot.paperView.paperHaltedDate && <strong>PAPER DAILY-LOSS HALT · {bot.paperView.paperHaltedDate}</strong>}
                    <ul className="paper-audit-list" aria-label="Recent paper audit events">
                      {bot.paperView.paperAuditEvents.slice(0, 5).map((event, index) => (
                        <li key={`${event.paperOccurredAt}-${event.paperAction}-${index}`}>
                          <span>{event.paperAction}</span><span>{event.paperOutcome}</span><time dateTime={event.paperOccurredAt}>{new Date(event.paperOccurredAt).toLocaleTimeString()}</time>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {(bot.state === "ARMED" || bot.state === "LIVE") && (
                  <ul className="bot-live-lock-list">{LIVE_PATH_REQUIREMENTS.map((item) => <li key={item}>{item}</li>)}</ul>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}