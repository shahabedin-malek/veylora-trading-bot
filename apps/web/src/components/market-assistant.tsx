"use client";

import { Send, Sparkles } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

type ChatMessage = { id: string; role: "user" | "assistant"; content: string };

type AssistantStatus = {
  adapterEnabled: boolean;
  target: string;
  modelConfigured: boolean;
  model: string | null;
} | null;

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

export function MarketAssistant() {
  const [status, setStatus] = useState<AssistantStatus>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getStatus().then((result) => { if (!cancelled) setStatus(result); });
    return () => { cancelled = true; };
  }, []);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    setError(null);
    setSending(true);

    const nextMessages = [...messages, { id: crypto.randomUUID(), role: "user" as const, content }];
    setMessages(nextMessages);
    setDraft("");

    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages.map(({ role, content: text }) => ({ role, content: text })),
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : "Assistant response is unavailable.";
        throw new Error(message);
      }
      if (!payload || typeof payload !== "object" || !("reply" in payload) || typeof payload.reply !== "string") {
        throw new Error("Assistant response was invalid.");
      }
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content: payload.reply as string }]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Assistant response is unavailable.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="data-section advisory-assistant" aria-labelledby="assistant-title">
      <div className="section-heading">
        <div>
          <div className="section-kicker">TOOL-USING · PUBLIC MARKET DATA</div>
          <h2 id="assistant-title">Market assistant</h2>
        </div>
        <span className="section-state">{status === null ? "CHECKING ADAPTER" : status.adapterEnabled ? "ASSISTANT ENABLED" : "ADAPTER DISABLED"}</span>
      </div>

      <div className={`assistant-model-state${status?.modelConfigured ? " is-configured" : ""}`} role="status">
        <Sparkles aria-hidden="true" size={14} />
        <span>{status?.modelConfigured ? `Model configured · ${status.model}` : "Model access not configured · Vercel AI Gateway"}</span>
      </div>

      <div className="assistant-transcript" aria-live="polite" aria-label="Assistant conversation">
        {messages.length === 0 ? (
          <div className="assistant-empty">
            <strong>Ask the assistant</strong>
            <span>It can call tools to fetch public Coinbase quotes and RSI. Order placement and fund movement stay in the app&apos;s authenticated routes.</span>
          </div>
        ) : messages.map((message) => (
          <div className={`assistant-message assistant-message--${message.role}`} key={message.id}>
            <span>{message.role === "user" ? "YOU" : "ASSISTANT"}</span>
            <p>{message.content}</p>
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
            placeholder="e.g. What is the BTC-USD RSI-14 right now?"
            rows={2}
            value={draft}
          />
        </label>
        <button disabled={!status?.modelConfigured || sending || !draft.trim()} type="submit">
          <Send aria-hidden="true" size={14} />
          {sending ? "ASKING" : "SEND"}
        </button>
      </form>
      {!status?.modelConfigured && <p className="assistant-advisory-note">The adapter is ready, but model access is not configured. No prompt is sent.</p>}
      {error && <p className="login-error" role="alert">{error}</p>}
    </section>
  );
}
