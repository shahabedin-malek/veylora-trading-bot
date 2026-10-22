"use client";

import { Copy, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * The strategy marketplace (phase 30).
 *
 * Every card either shows the figures of a real recorded backtest, with its date and cost
 * assumptions, or says that no backtest exists. There is no third state and no placeholder
 * return: a number here is always a row someone can inspect.
 *
 * Cloning creates a draft owned by the caller and records the template slug on it. The
 * template itself never changes, so two accounts cloning the same rules get independent
 * histories.
 */

type Performance = {
  runId: string;
  ranAt: string;
  initialCapitalUsd: string | null;
  finalCapitalUsd: string | null;
  returnPercent: string | null;
  maxDrawdownPercent: string | null;
  winRatePercent: string | null;
  tradeCount: number | null;
};

type Template = {
  id: string;
  name: string;
  description: string;
  author: string;
  market: string;
  builtIn: boolean;
  config: {
    name: string;
    market: string;
    entryRsiBelow: string;
    exitRsiAbove: string;
    sizePercent: string;
    stopLossPercent: string;
    budgetUsd: string;
  };
  performance: Performance | null;
  performanceNote: string;
};

function figure(value: string | null) {
  return value === null ? "—" : `${value}%`;
}

export function MarketplacePanel() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/marketplace", { cache: "no-store" })
      .then(async (response) => {
        const result = (await response.json()) as { templates?: Template[]; error?: string };
        if (!response.ok) throw new Error(result.error ?? "The marketplace could not be loaded.");
        if (active) setTemplates(result.templates ?? []);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "The marketplace could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function clone(template: Template) {
    setBusy(template.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/marketplace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: template.id }),
      });
      const result = (await response.json()) as { bot?: { id: string; name: string }; error?: string };
      if (!response.ok || !result.bot) throw new Error(result.error ?? "The template could not be cloned.");
      setNotice(
        `Cloned “${template.name}” into your draft “${result.bot.name}”. It is independent of the template; edit and publish it from the bot builder.`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The template could not be cloned.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="marketplace">
      <div className="marketplace__toolbar">
        <span className="section-state">{loading ? "LOADING" : `${templates.length} TEMPLATE${templates.length === 1 ? "" : "S"}`}</span>
        <a className="section-action" href="/bots">OPEN BOT BUILDER <ExternalLink aria-hidden="true" size={13} /></a>
      </div>
      {error ? <p className="policy-disclaimer" role="alert">{error}</p> : null}
      {notice ? <p className="policy-disclaimer" role="status">{notice}</p> : null}

      <ul className="marketplace-grid">
        {templates.map((template) => (
          <li className="marketplace-card" key={template.id}>
            <div className="marketplace-card__heading">
              <div>
                <strong>{template.name}</strong>
                <span>{template.author}{template.builtIn ? " · BUILT IN" : " · SHARED"}</span>
              </div>
              <span className="structure-chip">{template.market}</span>
            </div>
            <p>{template.description}</p>
            <dl className="marketplace-card__rules">
              <div><dt>ENTRY</dt><dd>RSI-14 crosses below {template.config.entryRsiBelow}</dd></div>
              <div><dt>EXIT</dt><dd>RSI-14 crosses above {template.config.exitRsiAbove}</dd></div>
              <div><dt>SIZE</dt><dd>{template.config.sizePercent}% of equity</dd></div>
              <div><dt>STOP</dt><dd>{template.config.stopLossPercent}%</dd></div>
            </dl>
            <div className="marketplace-card__performance">
              {template.performance ? (
                <>
                  <div><span>RETURN</span><strong>{figure(template.performance.returnPercent)}</strong></div>
                  <div><span>MAX DRAWDOWN</span><strong>{figure(template.performance.maxDrawdownPercent)}</strong></div>
                  <div><span>WIN RATE</span><strong>{figure(template.performance.winRatePercent)}</strong></div>
                  <div><span>TRADES</span><strong>{template.performance.tradeCount ?? "—"}</strong></div>
                </>
              ) : (
                <p className="marketplace-card__unmeasured">NO BACKTEST RECORDED · NO FIGURE SHOWN</p>
              )}
            </div>
            <small>{template.performanceNote}</small>
            <button className="section-action" disabled={busy !== null} onClick={() => void clone(template)} type="button">
              <Copy aria-hidden="true" size={14} />
              {busy === template.id ? "CLONING…" : "CLONE INTO A DRAFT"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
