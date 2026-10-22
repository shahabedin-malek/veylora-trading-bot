import { redactString, redactValue } from "@/lib/observability/logger";
import type { ToolExecutor } from "@/lib/assistant/loop";

/**
 * What an assistant answer is allowed to say it used.
 *
 * A citation is produced by the tool that ran, not by the model: the model is told to
 * name its sources, but the block the owner reads is assembled from the executor's own
 * record. That is the difference between "the assistant says it read the ledger" and
 * "the ledger was read, at this instant, and here is the row it returned" — and it is
 * why a citation can be asserted in a test without a model in the room.
 *
 * `asOf` is the source's own observation time (a quote's `observedAt`, a ledger read's
 * `readAt`, a candle's close time). It is never "now" on the server, because a number
 * presented with the wrong moment attached is a misleading number. When a source
 * genuinely has no observation time, it is null and the UI says so rather than
 * inventing one.
 */
export type AssistantCitation = {
  tool: string;
  label: string;
  source: string;
  asOf: string | null;
  detail?: string;
};

/** A tool that was asked for and did not answer, with the reason it gave. */
export type AssistantToolFailure = {
  tool: string;
  label: string;
  reason: string;
};

/** What the tools actually did during one answer. */
export type AssistantToolRecord = {
  citations: AssistantCitation[];
  failures: AssistantToolFailure[];
};

export function emptyToolRecord(): AssistantToolRecord {
  return { citations: [], failures: [] };
}

/**
 * The account questions this build can recognise.
 *
 * Deliberately a small, literal list of the things the owner asks about their own
 * money. The purpose is not natural-language understanding: it is the one guarantee
 * that has to hold when the model misbehaves — a question about *my balance* may not
 * be answered from the model's imagination, so if no account tool succeeded the answer
 * says it could not read the balance.
 */
export const ACCOUNT_TOPICS: readonly {
  topic: string;
  nouns: string;
  tools: readonly string[];
  pattern: RegExp;
}[] = [
  {
    topic: "balance",
    nouns: "your balance",
    tools: ["get_account_balance"],
    pattern: /\b(?:my|the|account|available|cash)\s+balances?\b|\bhow much (?:do i|have i|money|usdt|usdc|btc|eth)\b|\bwhat(?:'s| is) my balance\b|\bbalances?\b/i,
  },
  {
    topic: "positions",
    nouns: "your positions",
    tools: ["get_open_positions"],
    pattern: /\b(?:my|open)\s+positions?\b|\bwhat (?:am i|do i) (?:holding|hold)\b|\bmy holdings?\b|\bportfolio\b/i,
  },
  {
    topic: "orders",
    nouns: "your orders",
    tools: ["list_open_orders"],
    pattern: /\b(?:my|open|pending)\s+orders?\b|\border history\b|\bwhat orders\b/i,
  },
  {
    topic: "ledger",
    nouns: "your ledger history",
    tools: ["get_ledger_history"],
    pattern: /\b(?:my|the)\s+ledger\b|\bstatement\b|\b(?:my|recent)\s+(?:deposits?|withdrawals?|transactions?|history)\b|\bpnl\b|\bp&l\b/i,
  },
  {
    topic: "alerts",
    nouns: "your alerts",
    tools: ["list_market_alerts"],
    pattern: /\b(?:my|active)\s+alerts?\b|\bprice alerts?\b/i,
  },
];

/** The account topics a question touches, in the order {@link ACCOUNT_TOPICS} lists them. */
export function accountTopics(question: string): typeof ACCOUNT_TOPICS[number][] {
  return ACCOUNT_TOPICS.filter((entry) => entry.pattern.test(question));
}

/**
 * The sentence that stands in for data that could not be read.
 *
 * It names the missing thing and states that nothing was substituted, because "I could
 * not read it" and "it is zero" are different answers and only one of them is true.
 */
export function missingAccountSentence(topic: string, reason: string | null): string {
  const base = `I could not read ${topic}${reason ? ` — ${reason.replace(/\.$/, "")}` : ""}.`;
  return `${base} I have not estimated or substituted a figure for it.`;
}

/** "Data that could not be read: Ledger balances (The ledger could not be read.)" */
export function describeFailures(failures: readonly AssistantToolFailure[]): string | null {
  if (failures.length === 0) return null;
  const items = failures.map((failure) => `${failure.label} (${failure.reason})`);
  return `Could not read: ${items.join("; ")}.`;
}

export type ComposedAnswer = {
  /** The reply the transcript shows: the model's text plus any statement it owes. */
  text: string;
  citations: AssistantCitation[];
  failures: AssistantToolFailure[];
  /** The account topics that ended up unread, if any. */
  missingTopics: string[];
};

/**
 * The answer, with the statements the model cannot be trusted to remember.
 *
 * Three rules, all applied after the model has spoken:
 *
 *  1. A tool that failed is named in the answer, whatever the model chose to say.
 *  2. A question about the owner's own data that no tool answered gets an explicit
 *     "could not read" sentence, so a fluent guess is never the only thing on screen.
 *  3. Nothing is added when the tools answered and the question was about the market.
 *
 * The model's own text is kept as written: this function appends, it does not rewrite,
 * so a streamed answer is not silently replaced at the end of the stream.
 */
export function composeAnswer(input: {
  reply: string;
  record: AssistantToolRecord;
  question: string;
}): ComposedAnswer {
  const topics = accountTopics(input.question);
  const answered = new Set(input.record.citations.map((citation) => citation.tool));
  const missing = topics.filter((topic) => !topic.tools.some((tool) => answered.has(tool)));
  const failures = input.record.failures;
  const notes: string[] = [];

  const failureSentence = describeFailures(failures);
  if (failureSentence) notes.push(failureSentence);

  for (const topic of missing) {
    const failed = failures.find((failure) => topic.tools.includes(failure.tool));
    notes.push(missingAccountSentence(topic.nouns, failed?.reason ?? null));
  }

  const reply = input.reply.trim();
  return {
    text: notes.length === 0 ? reply : `${reply}\n\n${notes.join("\n")}`.trim(),
    citations: input.record.citations,
    failures,
    missingTopics: missing.map((topic) => topic.topic),
  };
}

/**
 * A user message as it may be sent to a provider.
 *
 * The same redaction pass the logger uses, because "a key never reaches a prompt" has
 * to hold for the text a person pastes into a chat box too — that is the likeliest way
 * a credential would arrive here. A message that *is* a secret becomes the marker and
 * nothing else, and the transcript the browser keeps is the redacted one it sent.
 */
export function redactTranscript(value: string): string {
  return redactString(value);
}

/** A tool result as it may be sent to a provider and stored in a transcript. */
export function redactToolResult(value: unknown): unknown {
  return redactValue(value) ?? null;
}

/**
 * Wrap a tool executor so every result is redacted on its way to the model.
 *
 * Belt and braces, and exported so the composition itself can be tested: the readers in
 * `tools.ts` are written to return only the fields they name, and this pass means a value
 * this build did not expect to be secret — a venue echoing a key back in an error, a memo
 * field holding a pasted token — still arrives at the provider as the marker. It is a
 * wrapper rather than a rule inside each reader because a rule that has to be remembered
 * per reader is a rule that will be missed once.
 */
export function withRedactedToolResults(execute: ToolExecutor): ToolExecutor {
  return async (name, args) => redactToolResult(await execute(name, args));
}

/** A one-line freshness phrase, for text that has to carry its own timestamp. */
export function freshness(asOf: string | null, now: Date = new Date()): string {
  if (!asOf) return "as-of time not reported";
  const at = Date.parse(asOf);
  if (!Number.isFinite(at)) return "as-of time not readable";
  const seconds = Math.max(0, Math.round((now.getTime() - at) / 1_000));
  if (seconds < 60) return `${seconds}s old`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m old`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h old`;
  return `${Math.round(seconds / 86_400)}d old`;
}
