"use client";

import { Bot, ExternalLink, RefreshCw, Send, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";

/**
 * The persistent bots this account owns (phase 30).
 *
 * This panel is the second half of `/bots`: the paper lab above it studies a strategy, and
 * this is where a strategy becomes a row the runner can actually execute. Publishing is one
 * press with no confirmation, because validation either accepts the rules or names the field
 * that is wrong — there is nothing to approve.
 *
 * A reached cap is shown beside the create control rather than disabling it: the owner can
 * still press create and reads the named cap and the current usage, which is the difference
 * between a limit that is explained and one that is hidden. The figures on a published bot
 * come from a recorded backtest of its published rules; when there is none, the row says so.
 *
 * Every mutation re-reads the list and the caps from the server rather than adjusting the
 * readout locally: deleting a bot frees a slot, and a panel that kept saying "10 of 10" (and
 * kept showing the cap message) after the delete would be telling the owner they are over a
 * cap they are no longer over.
 */

type BotState = "DRAFT" | "PUBLISHED" | "DELETED";

type BotView = {
  id: string;
  name: string;
  description: string;
  state: BotState;
  market: string;
  config: {
    name: string;
    description: string;
    market: string;
    entryRsiBelow: string;
    exitRsiAbove: string;
    sizePercent: string;
    stopLossPercent: string;
    dailyLossHaltPercent: string;
    budgetUsd: string;
    initialCapitalUsd: string;
  };
  definition: { id: string; version: number; text: string; rules: string[] } | null;
  templateSlug: string | null;
  publishedAt: string | null;
  deletedAt: string | null;
  latestBacktest: {
    ranAt?: string;
    createdAt: string;
    totalReturnPercent: string | null;
    maxDrawdownPercent: string | null;
    tradeCount: number | null;
    costAssumptions: string[];
  } | null;
};

type Capacity = { cap: number; usage: number; message: string | null };

type Caps = { bots: Capacity; venueConnections: Capacity };

type Problem = { field: string; message: string };

type Draft = {
  name: string;
  description: string;
  market: string;
  entryRsiBelow: string;
  exitRsiAbove: string;
  sizePercent: string;
  stopLossPercent: string;
  dailyLossHaltPercent: string;
  budgetUsd: string;
  initialCapitalUsd: string;
};

const EMPTY_DRAFT: Draft = {
  name: "",
  description: "",
  market: "BTC-USD",
  entryRsiBelow: "30",
  exitRsiAbove: "70",
  sizePercent: "25",
  stopLossPercent: "4",
  dailyLossHaltPercent: "2",
  budgetUsd: "25",
  initialCapitalUsd: "10000",
};

function formatDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.toISOString().slice(0, 16).replace("T", " ")} UTC` : null;
}

function percent(value: string | null) {
  return value === null ? "—" : `${value}%`;
}

function stateLabel(bot: BotView): string {
  if (bot.state === "DELETED") return "DELETED";
  if (bot.state === "PUBLISHED") return "PUBLISHED · STARTABLE";
  return "DRAFT";
}

export function ManagedBotsPanel() {
  const [bots, setBots] = useState<BotView[]>([]);
  const [caps, setCaps] = useState<Caps | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [problems, setProblems] = useState<Problem[]>([]);
  const [notice, setNotice] = useState("");

  const markets = useMemo(() => USD_WATCHLIST.map(({ productId }) => productId), []);
  const capReached = caps ? caps.bots.usage >= caps.bots.cap : false;

  const read = useCallback(async () => {
    const response = await fetch("/api/bot-builder", { cache: "no-store" });
    const result = (await response.json()) as { bots?: BotView[]; caps?: Caps; error?: string };
    if (!response.ok) throw new Error(result.error ?? "Bots could not be loaded.");
    return { bots: result.bots ?? [], caps: result.caps ?? null };
  }, []);

  useEffect(() => {
    let active = true;
    void read()
      .then((loaded) => {
        if (active) {
          setBots(loaded.bots);
          setCaps(loaded.caps);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Bots could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [read]);

  function update<K extends keyof Draft>(field: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function absorbCaps(next: Partial<Caps> | null | undefined) {
    if (!next?.bots) return;
    setCaps((current) => ({
      bots: next.bots ?? current?.bots ?? { cap: 0, usage: 0, message: null },
      venueConnections: next.venueConnections ?? current?.venueConnections ?? { cap: 0, usage: 0, message: null },
    }));
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("create");
    setError("");
    setProblems([]);
    setNotice("");
    try {
      const response = await fetch("/api/bot-builder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: draft }),
      });
      const result = (await response.json()) as {
        bot?: BotView;
        caps?: Caps;
        error?: string;
        problems?: Problem[];
      };
      if (!response.ok || !result.bot) {
        setProblems(result.problems ?? []);
        throw new Error(result.error ?? "The bot could not be created.");
      }
      setBots((current) => [result.bot!, ...current]);
      absorbCaps(result.caps);
      setDraft({ ...EMPTY_DRAFT, market: draft.market });
      setNotice(`Draft “${result.bot.name}” saved. Publish it to make it startable.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The bot could not be created.");
    } finally {
      setBusy(null);
    }
  }

  async function action(bot: BotView, kind: "publish" | "delete" | "share") {
    setBusy(`${kind}:${bot.id}`);
    setError("");
    setProblems([]);
    setNotice("");
    try {
      const path =
        kind === "publish"
          ? `/api/bot-builder/${encodeURIComponent(bot.id)}/publish`
          : kind === "share"
            ? `/api/bot-builder/${encodeURIComponent(bot.id)}/share`
            : `/api/bot-builder/${encodeURIComponent(bot.id)}`;
      const response = await fetch(path, {
        method: kind === "delete" ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: kind === "delete" ? undefined : "{}",
      });
      const result = (await response.json()) as {
        bot?: BotView;
        error?: string;
        problems?: Problem[];
        alreadyPublished?: boolean;
        stoppedActivation?: boolean;
        changed?: boolean;
        template?: { id: string; name: string };
      };
      if (!response.ok || !result.bot) {
        setProblems(result.problems ?? []);
        throw new Error(result.error ?? `The ${kind} could not be completed.`);
      }
      // The list and the caps are re-read from the server, so a delete that frees a slot is
      // reflected immediately instead of leaving a stale "10 of 10" and cap message on
      // screen. A failed re-read falls back to the row the action itself returned.
      const fresh = await read().catch(() => null);
      if (fresh) {
        setBots(fresh.bots);
        setCaps(fresh.caps);
      } else {
        setBots((current) => current.map((item) => (item.id === result.bot!.id ? result.bot! : item)));
      }
      if (kind === "publish") {
        setNotice(
          result.alreadyPublished
            ? `“${result.bot.name}” was already published; nothing changed.`
            : `“${result.bot.name}” is published and now appears in the trade page's strategy list.`,
        );
      } else if (kind === "share") {
        setNotice(
          result.changed
            ? `“${result.bot.name}” is now listed in the marketplace as “${result.template?.name ?? result.bot.name}”.`
            : `“${result.bot.name}” was already shared; the existing template is unchanged.`,
        );
      } else {
        setNotice(
          result.stoppedActivation
            ? `“${result.bot.name}” is deleted and its running activation was stopped. Its history stays readable.`
            : `“${result.bot.name}” is deleted. Its history stays readable.`,
        );
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `The ${kind} could not be completed.`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="managed-bots">
      <div className="managed-bots__caps" role="status">
        <strong>{caps ? `${caps.bots.usage} of ${caps.bots.cap} bots in use` : "Reading the bot cap…"}</strong>
        <span>
          {caps
            ? `Venue connections: ${caps.venueConnections.usage} of ${caps.venueConnections.cap}. Caps are tier data, edited in Admin → Fees.`
            : "The cap is admin data; it is read rather than assumed."}
        </span>
      </div>
      {capReached && caps?.bots.message ? (
        <p className="policy-disclaimer" role="alert">{caps.bots.message}</p>
      ) : null}

      <form className="managed-bots__form" onSubmit={create}>
        <div className="section-kicker">NEW BOT</div>
        <div className="managed-bots__grid">
          <label className="risk-policy-field">
            <span>NAME</span>
            <input
              maxLength={80}
              onChange={(event) => update("name", event.target.value)}
              placeholder="Daily BTC reversion"
              required
              value={draft.name}
            />
          </label>
          <label className="risk-policy-field">
            <span>MARKET</span>
            <select onChange={(event) => update("market", event.target.value)} value={draft.market}>
              {markets.map((market) => (
                <option key={market} value={market}>{market}</option>
              ))}
            </select>
          </label>
          <label className="risk-policy-field">
            <span>ENTRY RSI BELOW</span>
            <input inputMode="decimal" onChange={(event) => update("entryRsiBelow", event.target.value)} value={draft.entryRsiBelow} />
          </label>
          <label className="risk-policy-field">
            <span>EXIT RSI ABOVE</span>
            <input inputMode="decimal" onChange={(event) => update("exitRsiAbove", event.target.value)} value={draft.exitRsiAbove} />
          </label>
          <label className="risk-policy-field">
            <span>SIZE %</span>
            <input inputMode="decimal" onChange={(event) => update("sizePercent", event.target.value)} value={draft.sizePercent} />
          </label>
          <label className="risk-policy-field">
            <span>STOP LOSS %</span>
            <input inputMode="decimal" onChange={(event) => update("stopLossPercent", event.target.value)} value={draft.stopLossPercent} />
          </label>
          <label className="risk-policy-field">
            <span>DAILY HALT %</span>
            <input inputMode="decimal" onChange={(event) => update("dailyLossHaltPercent", event.target.value)} value={draft.dailyLossHaltPercent} />
          </label>
          <label className="risk-policy-field">
            <span>PER-ENTRY BUDGET USD</span>
            <input inputMode="decimal" onChange={(event) => update("budgetUsd", event.target.value)} value={draft.budgetUsd} />
          </label>
          <label className="risk-policy-field">
            <span>BACKTEST CAPITAL USD</span>
            <input inputMode="decimal" onChange={(event) => update("initialCapitalUsd", event.target.value)} value={draft.initialCapitalUsd} />
          </label>
        </div>
        <label className="risk-policy-field managed-bots__description">
          <span>DESCRIPTION</span>
          <input
            maxLength={280}
            onChange={(event) => update("description", event.target.value)}
            placeholder="What this bot does, in one sentence"
            value={draft.description}
          />
        </label>
        <div className="managed-bots__actions">
          <button className="section-action" disabled={busy !== null} type="submit">
            <Bot aria-hidden="true" size={14} />
            {busy === "create" ? "SAVING…" : "SAVE AS DRAFT"}
          </button>
          <span className="policy-disclaimer">
            A draft is not scheduled. Publish it below to validate it against the strategy schema and make it startable.
          </span>
        </div>
      </form>

      {error ? <p className="policy-disclaimer" role="alert">{error}</p> : null}
      {problems.length > 0 ? (
        <ul className="managed-bots__problems" aria-label="Validation problems">
          {problems.map((problem) => (
            <li key={`${problem.field}:${problem.message}`}>
              <strong>{problem.field}</strong> — {problem.message}
            </li>
          ))}
        </ul>
      ) : null}
      {notice ? <p className="policy-disclaimer" role="status">{notice}</p> : null}

      <div className="section-heading managed-bots__heading">
        <div>
          <div className="section-kicker">YOUR BOTS</div>
          <h3>Drafts, published rules and history</h3>
        </div>
        <span className="section-state">{loading ? "LOADING" : `${bots.length} ROW${bots.length === 1 ? "" : "S"}`}</span>
      </div>

      {!loading && bots.length === 0 ? (
        <p className="policy-disclaimer">No bots yet. Save a draft above, or clone a template from the marketplace.</p>
      ) : null}

      <ul className="managed-bot-list">
        {bots.map((bot) => (
          <li className={`managed-bot-row is-${bot.state.toLowerCase()}`} key={bot.id}>
            <div className="managed-bot-row__main">
              <div className="managed-bot-row__title">
                <strong>{bot.name}</strong>
                <span className="section-state">{stateLabel(bot)}</span>
                {bot.definition ? <span className="structure-chip">v{bot.definition.version}</span> : null}
                {bot.templateSlug ? <span className="structure-chip">FROM {bot.templateSlug}</span> : null}
              </div>
              <p>{bot.description || "No description."}</p>
              <div className="managed-bot-row__meta">
                <span>{bot.market}</span>
                <span>entry &lt; {bot.config.entryRsiBelow}</span>
                <span>exit &gt; {bot.config.exitRsiAbove}</span>
                <span>{bot.config.sizePercent}% size</span>
                <span>{bot.config.stopLossPercent}% stop</span>
                <span>${bot.config.budgetUsd} / entry</span>
                {bot.publishedAt ? <span>published {formatDate(bot.publishedAt)}</span> : null}
                {bot.deletedAt ? <span>deleted {formatDate(bot.deletedAt)}</span> : null}
              </div>
              {bot.definition ? (
                <details className="managed-bot-row__rules">
                  <summary>PUBLISHED RULES</summary>
                  <ul>
                    {bot.definition.rules.map((rule) => <li key={rule}>{rule}</li>)}
                  </ul>
                </details>
              ) : null}
            </div>
            <div className="managed-bot-row__side">
              <div className="managed-bot-row__figures">
                {bot.latestBacktest ? (
                  <>
                    <span>BACKTEST RETURN <strong>{percent(bot.latestBacktest.totalReturnPercent)}</strong></span>
                    <span>MAX DRAWDOWN <strong>{percent(bot.latestBacktest.maxDrawdownPercent)}</strong></span>
                    <span>TRADES <strong>{bot.latestBacktest.tradeCount ?? "—"}</strong></span>
                    <span>RECORDED {formatDate(bot.latestBacktest.createdAt)}</span>
                  </>
                ) : (
                  <span>NO BACKTEST RECORDED FOR THESE RULES — NO FIGURE SHOWN</span>
                )}
              </div>
              <div className="managed-bot-row__actions">
                {bot.state === "DRAFT" ? (
                  <button
                    className="section-action"
                    disabled={busy !== null}
                    onClick={() => void action(bot, "publish")}
                    type="button"
                  >
                    <Send aria-hidden="true" size={14} />
                    {busy === `publish:${bot.id}` ? "PUBLISHING…" : "PUBLISH"}
                  </button>
                ) : null}
                {bot.state === "PUBLISHED" ? (
                  <>
                    <a className="section-action" href="/trade">
                      START ON TRADE PAGE <ExternalLink aria-hidden="true" size={13} />
                    </a>
                    <button
                      className="section-action"
                      disabled={busy !== null}
                      onClick={() => void action(bot, "share")}
                      type="button"
                    >
                      <RefreshCw aria-hidden="true" size={13} />
                      {busy === `share:${bot.id}` ? "SHARING…" : "SHARE TO MARKETPLACE"}
                    </button>
                  </>
                ) : null}
                {bot.state !== "DELETED" ? (
                  <button
                    className="section-action"
                    disabled={busy !== null}
                    onClick={() => void action(bot, "delete")}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={14} />
                    {busy === `delete:${bot.id}` ? "DELETING…" : "DELETE"}
                  </button>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
