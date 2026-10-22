"use client";

import { Send, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

/**
 * The assistant panel: one question, streamed, with the data it used shown beside it.
 *
 * Three things this component refuses to do, all of them the same refusal:
 *
 *  - It does not print a source the server did not report. The "data used" list under an
 *    answer is the route's own citation array, rendered — not a sentence parsed out of
 *    the model's prose.
 *  - It does not hide a failure. A tool that could not read something, a rate limit and a
 *    provider that died mid-answer each become text in the transcript, where the next
 *    person to read it can see why the answer is short.
 *  - It does not keep a credential. There is no transcript storage at all: the messages
 *    live in this component's state for as long as the page is open, and the server sends
 *    the redacted form of anything that looks like a key.
 */

type Citation = { tool: string; label: string; source: string; asOf: string | null; detail?: string };
type Failure = { tool: string; label: string; reason: string };
type ToolActivity = { name: string; status: "started" | "ok" | "failed"; detail?: string };

type AssistantStatus = {
  adapterEnabled: boolean;
  target: string;
  modelConfigured: boolean;
  model: string | null;
  pricingConfigured?: boolean;
  limits?: { requestsPerHour: number; requestsPerDay: number; tokensPerDay: number };
} | null;

type Consumption = {
  hourRequests: number;
  dayRequests: number;
  dayTokens: number;
  dayCostUsd: string | null;
  limits: { requestsPerHour: number; requestsPerDay: number; tokensPerDay: number };
};

type Turn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  failures?: Failure[];
  tools?: ToolActivity[];
  incomplete?: string | null;
  sending?: boolean;
};

const TOOL_LABELS: Record<string, string> = {
  get_account_balance: "reading your ledger balances",
  get_ledger_history: "reading your ledger statement",
  get_open_positions: "reading your positions",
  list_open_orders: "reading your open orders",
  list_market_alerts: "reading your alerts",
  get_market_quote: "reading a public quote",
  get_market_candles: "reading public candles",
  get_market_indicator: "computing an indicator",
  search_research: "searching the web",
  extract_research: "reading a page",
  search_social_posts: "searching public posts",
  place_paper_order: "placing a paper order",
};

async function getStatus(): Promise<AssistantStatus> {
  try {
    const response = await fetch("/api/assistant", { cache: "no-store" });
    const payload: unknown = await response.json();
    if (!response.ok || typeof payload !== "object" || payload === null ||
      !("adapterEnabled" in payload) || !("modelConfigured" in payload)) {
      return null;
    }
    return payload as NonNullable<AssistantStatus>;
  } catch {
    return null;
  }
}

const MAX_MESSAGE_CHARACTERS = 2_000;

/** "03:12:04Z" — the citation's own moment, never the browser's. */
function timeOf(asOf: string | null): string {
  if (!asOf) return "no as-of time";
  const parsed = new Date(asOf);
  return Number.isNaN(parsed.getTime()) ? "unreadable as-of time" : parsed.toISOString().slice(11, 19) + "Z";
}

export function MarketAssistant() {
  const [status, setStatus] = useState<AssistantStatus>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [consumption, setConsumption] = useState<Consumption | null>(null);
  const transcript = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getStatus().then((result) => { if (!cancelled) setStatus(result); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const node = transcript.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns, activity]);

  function patchTurn(id: string, patch: (turn: Turn) => Turn) {
    setTurns((current) => current.map((turn) => (turn.id === id ? patch(turn) : turn)));
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    setError(null);
    setSending(true);
    setActivity(null);

    const asked = [...turns, { id: crypto.randomUUID(), role: "user" as const, content }];
    const answerId = crypto.randomUUID();
    setTurns([...asked, { id: answerId, role: "assistant", content: "", citations: [], failures: [], tools: [], sending: true }]);
    setDraft("");

    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          messages: asked.map(({ role, content: text }) => ({ role, content: text })),
        }),
      });

      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || !contentType.includes("text/event-stream")) {
        // A refusal (a rate limit, an unconfigured deployment, a signed-out session) is
        // JSON with a sentence in it. It is shown as the error line and the empty answer
        // turn is removed, so the transcript never contains a blank assistant message.
        const payload: unknown = await response.json().catch(() => null);
        const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : "Assistant response is unavailable.";
        setTurns(asked);
        setError(message);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("The assistant stream was not readable.");
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((candidate) => candidate.startsWith("data:"));
          if (!line) continue;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
          } catch {
            continue;
          }
          handleEvent(answerId, payload);
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Assistant response is unavailable.");
      patchTurn(answerId, (turn) => ({ ...turn, sending: false }));
    } finally {
      setSending(false);
      setActivity(null);
      patchTurn(answerId, (turn) => ({ ...turn, sending: false }));
    }
  }

  function handleEvent(answerId: string, payload: Record<string, unknown>) {
    const type = payload.type;
    if (type === "delta" && typeof payload.text === "string") {
      patchTurn(answerId, (turn) => ({ ...turn, content: turn.content + (payload.text as string) }));
      return;
    }
    if (type === "tool" && typeof payload.name === "string") {
      const status_ = payload.status === "started" || payload.status === "ok" || payload.status === "failed" ? payload.status : "started";
      setActivity(status_ === "started" ? `Assistant is ${TOOL_LABELS[payload.name as string] ?? payload.name}…` : null);
      patchTurn(answerId, (turn) => ({
        ...turn,
        tools: [
          ...(turn.tools ?? []).filter((tool) => tool.name !== payload.name),
          { name: payload.name as string, status: status_, ...(typeof payload.detail === "string" ? { detail: payload.detail } : {}) },
        ],
      }));
      return;
    }
    if (type === "error") {
      const message = typeof payload.message === "string" ? payload.message : "The assistant request failed.";
      patchTurn(answerId, (turn) => ({ ...turn, incomplete: message }));
      return;
    }
    if (type === "done") {
      const answer = payload.answer;
      if (typeof answer === "object" && answer !== null) {
        const composed = answer as { text?: unknown; citations?: unknown; failures?: unknown };
        patchTurn(answerId, (turn) => ({
          ...turn,
          content: typeof composed.text === "string" ? composed.text : turn.content,
          citations: Array.isArray(composed.citations) ? (composed.citations as Citation[]) : [],
          failures: Array.isArray(composed.failures) ? (composed.failures as Failure[]) : [],
        }));
      }
      const usage = payload.consumption;
      if (typeof usage === "object" && usage !== null) setConsumption(usage as Consumption);
    }
  }

  return (
    <section className="data-section advisory-assistant" aria-labelledby="assistant-title">
      <div className="section-heading">
        <div>
          <div className="section-kicker">TOOL-USING · YOUR ACCOUNT + PUBLIC MARKET DATA</div>
          <h2 id="assistant-title">Assistant</h2>
        </div>
        <span className="section-state">{status === null ? "CHECKING ADAPTER" : status.adapterEnabled ? "ASSISTANT ON" : "ASSISTANT OFF IN ADMIN"}</span>
      </div>

      <div className={`assistant-model-state${status?.modelConfigured ? " is-configured" : ""}`} role="status">
        <Sparkles aria-hidden="true" size={14} />
        <span>{status?.modelConfigured ? `Model configured · ${status.model}` : "Model access not configured · Vercel AI Gateway"}</span>
      </div>

      <div className="assistant-transcript" aria-live="polite" aria-label="Assistant conversation" ref={transcript}>
        {turns.length === 0 ? (
          <div className="assistant-empty">
            <strong>Ask about your account, or about the market</strong>
            <span>
              The assistant calls tools to read your ledger balances, positions, orders, ledger history and alerts,
              and public Coinbase quotes, candles and indicators, plus web research and public social posts. Every
              answer lists the data it used and when it was read. Order placement and fund movement stay in the app&apos;s own authenticated
              routes — the only write here is a clearly-labelled paper order.
            </span>
            {status?.limits && (
              <span>
                Limits: {status.limits.requestsPerHour} questions per hour, {status.limits.requestsPerDay} per day,{" "}
                {status.limits.tokensPerDay.toLocaleString()} tokens per day.
              </span>
            )}
          </div>
        ) : turns.map((turn) => (
          <div className={`assistant-message assistant-message--${turn.role}`} key={turn.id}>
            <span>{turn.role === "user" ? "YOU" : "ASSISTANT"}</span>
            {turn.content ? <p>{turn.content}</p> : turn.role === "assistant" && turn.sending ? <p className="assistant-thinking">…</p> : null}

            {turn.tools && turn.tools.length > 0 && (
              <ul className="assistant-tools">
                {turn.tools.map((tool) => (
                  <li key={tool.name} className={tool.status === "failed" ? "is-failed" : undefined}>
                    {TOOL_LABELS[tool.name] ?? tool.name}
                    {tool.status === "started" ? "…" : tool.status === "failed" ? " — failed" : " ✓"}
                    {tool.detail ? ` ${tool.detail}` : ""}
                  </li>
                ))}
              </ul>
            )}

            {turn.citations && turn.citations.length > 0 && (
              <div className="assistant-sources">
                <span>DATA USED</span>
                <ul>
                  {turn.citations.map((citation, index) => (
                    <li key={`${citation.tool}-${index}`}>
                      <strong>{citation.label}</strong>
                      {" · "}
                      {citation.source}
                      {" · "}
                      {timeOf(citation.asOf)}
                      {citation.detail ? ` · ${citation.detail}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {turn.failures && turn.failures.length > 0 && (
              <div className="assistant-sources is-missing">
                <span>NOT READ</span>
                <ul>
                  {turn.failures.map((failure, index) => (
                    <li key={`${failure.tool}-${index}`}>
                      <strong>{failure.label}</strong>
                      {" · "}
                      {failure.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {turn.incomplete && <p className="assistant-incomplete" role="alert">{turn.incomplete}</p>}
          </div>
        ))}
      </div>

      <form className="assistant-compose" onSubmit={send}>
        <label>
          <span>MESSAGE</span>
          <textarea
            disabled={sending}
            maxLength={MAX_MESSAGE_CHARACTERS}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="e.g. What is my balance, and what is the BTC-USD RSI-14 right now?"
            rows={2}
            value={draft}
          />
        </label>
        <button disabled={sending || !draft.trim()} type="submit">
          <Send aria-hidden="true" size={14} />
          {sending ? "ASKING" : "SEND"}
        </button>
      </form>

      {activity && <p className="assistant-advisory-note" role="status">{activity}</p>}
      {consumption && (
        <p className="assistant-meter">
          Used this hour {consumption.hourRequests}/{consumption.limits.requestsPerHour} · today {consumption.dayRequests}/
          {consumption.limits.requestsPerDay} questions · {consumption.dayTokens.toLocaleString()}/
          {consumption.limits.tokensPerDay.toLocaleString()} tokens
          {consumption.dayCostUsd ? ` · about ${consumption.dayCostUsd} today` : " · cost not configured for this deployment"}
        </p>
      )}
      {!status?.modelConfigured && (
        <p className="assistant-advisory-note">
          Model access is not configured. Sending still works and reports which value is missing, so the request path is
          testable before the gateway key exists.
        </p>
      )}
      {error && <p className="login-error" role="alert">{error}</p>}
    </section>
  );
}
