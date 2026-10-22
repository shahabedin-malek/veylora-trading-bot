import { instrumentFetch, PROVIDER_IDS } from "@/lib/observability/provider-call";

/**
 * The tool-calling loop, and the two ways one model request can arrive.
 *
 * The loop is shared by the non-streaming call the tests drive and the streaming call
 * the panel drives, so "the assistant called these tools and then said this" is one
 * piece of code rather than two that agree today. What differs is only the transport:
 * `complete` returns a whole message, `stream` reports text as it arrives and returns
 * the same shape at the end. Both are OpenAI-compatible chat completions, which is what
 * the AI Gateway speaks.
 *
 * Two rules are enforced here rather than asked of the model:
 *
 *  - **The loop is bounded.** A model that keeps asking for tools is stopped at
 *    `MAX_TOOL_ROUNDS` with a sentence, not served forever.
 *  - **A truncated answer says so.** A provider that dies mid-stream throws
 *    {@link AssistantStreamError} carrying the text that did arrive, so the transcript
 *    can keep the partial answer and label it incomplete instead of presenting half a
 *    sentence as a whole one.
 */

export const MAX_TOOL_ROUNDS = 4;
export const MAX_REPLY_CHARACTERS = 8_000;
const REQUEST_TIMEOUT_MS = 20_000;

export type AssistantMessage = { role: "user" | "assistant"; content: string };

export type ToolCall = { id: string; name: string; arguments: string };

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export type TokenUsage = { inputTokens: number; outputTokens: number };

export type AssistantRound = {
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage | null;
};

export type ConversationEntry = Record<string, unknown>;

export type AssistantTransport = {
  complete: (conversation: readonly ConversationEntry[], tools: readonly unknown[]) => Promise<AssistantRound>;
  stream: (
    conversation: readonly ConversationEntry[],
    tools: readonly unknown[],
    onDelta: (text: string) => void,
  ) => Promise<AssistantRound>;
};

/** A provider failure, with the reason a caller can act on or display. */
export class AssistantProviderError extends Error {
  constructor(
    message: string,
    readonly kind: "unavailable" | "invalid" | "limit" = "unavailable",
  ) {
    super(message);
    this.name = "AssistantProviderError";
  }
}

/**
 * A stream that broke after some text had already been shown.
 *
 * `partial` is what the reader has seen. The answer keeps it and adds the notice:
 * discarding it would make the transcript disagree with the screen, and presenting it
 * without a notice would be a half sentence claiming to be whole.
 */
export class AssistantStreamError extends AssistantProviderError {
  constructor(
    message: string,
    readonly partial: string,
  ) {
    super(message, "unavailable");
    this.name = "AssistantStreamError";
  }
}

export type AssistantLoopEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; status: "started" | "ok" | "failed"; detail?: string }
  | { type: "usage"; usage: TokenUsage };

export type AssistantLoopResult = {
  reply: string;
  toolCalls: string[];
  usage: TokenUsage;
};

export type AssistantLoopInput = {
  messages: readonly AssistantMessage[];
  systemPrompt: string;
  tools: readonly unknown[];
  executeTool: ToolExecutor;
  transport: AssistantTransport;
  onEvent?: (event: AssistantLoopEvent) => void;
  maxRounds?: number;
};

function addUsage(total: TokenUsage, next: TokenUsage | null): TokenUsage {
  if (!next) return total;
  return { inputTokens: total.inputTokens + next.inputTokens, outputTokens: total.outputTokens + next.outputTokens };
}

/**
 * Run the conversation until the model answers in words, executing every tool it asks for.
 *
 * The tools the model requested are collected by name so the answer can cite them; the
 * results themselves go back into the conversation and nowhere else — what the owner sees
 * about the data used is built from the executor's own record, not from this list.
 */
export async function runAssistantLoop(input: AssistantLoopInput): Promise<AssistantLoopResult> {
  const conversation: ConversationEntry[] = [
    { role: "system", content: input.systemPrompt },
    ...input.messages.map((message) => ({ role: message.role, content: message.content })),
  ];
  const maxRounds = input.maxRounds ?? MAX_TOOL_ROUNDS;
  const toolCalls: string[] = [];
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let reply = "";

  const emit = (event: AssistantLoopEvent) => {
    try {
      input.onEvent?.(event);
    } catch {
      // A listener that throws (a closed stream, a disconnected browser) must not turn a
      // finished answer into a failed one: the work is done, the delivery is not.
    }
  };

  for (let round = 0; round < maxRounds; round += 1) {
    // Both transports are used through the same call: `stream` reports deltas and ends
    // with the whole message, `complete` reports the whole message and no deltas.
    let result: AssistantRound;
    const seenBefore = reply.length;
    try {
      result = await input.transport.stream(conversation, input.tools, (text) => {
        reply += text;
        emit({ type: "delta", text });
      });
    } catch (error) {
      if (error instanceof AssistantProviderError) {
        // Whatever arrived before the break is kept, and the caller is told the answer is
        // incomplete rather than being handed a partial sentence with no label.
        throw new AssistantStreamError(error.message, reply.slice(seenBefore));
      }
      throw error;
    }

    usage = addUsage(usage, result.usage);
    if (result.usage) emit({ type: "usage", usage: result.usage });

    if (result.content) {
      // A transport that reported no deltas (the non-streaming one, and a provider that
      // answered in one chunk) still produces a delta here, so a caller has exactly one
      // place to render text from.
      const alreadyStreamed = reply.length - seenBefore;
      const remaining = result.content.slice(alreadyStreamed);
      if (remaining) {
        reply += remaining;
        emit({ type: "delta", text: remaining });
      }
    }

    if (result.toolCalls.length === 0) {
      const text = reply.trim();
      if (!text) throw new AssistantProviderError("The assistant model returned no text for this question.", "invalid");
      return { reply: text.slice(0, MAX_REPLY_CHARACTERS), toolCalls, usage };
    }

    conversation.push({
      role: "assistant",
      content: result.content.length > 0 ? result.content : null,
      tool_calls: result.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    });

    for (const call of result.toolCalls) {
      toolCalls.push(call.name);
      emit({ type: "tool", name: call.name, status: "started" });
      let result_: unknown;
      let failed = false;
      try {
        const parsed: unknown = call.arguments ? JSON.parse(call.arguments) : {};
        const args = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
        result_ = await input.executeTool(call.name, args);
        failed = typeof result_ === "object" && result_ !== null && (result_ as { ok?: unknown }).ok === false;
      } catch (error) {
        failed = true;
        result_ = { ok: false, error: error instanceof Error ? error.message : "Tool execution failed." };
      }
      emit({
        type: "tool",
        name: call.name,
        status: failed ? "failed" : "ok",
        ...(failed ? { detail: sentenceOf(result_) } : {}),
      });
      conversation.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result_) });
    }
  }

  throw new AssistantProviderError(
    `The assistant asked to use tools more than ${maxRounds} times for one question, so it was stopped. Ask a narrower question.`,
    "limit",
  );
}

function sentenceOf(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && typeof (value as { error?: unknown }).error === "string") {
    return (value as { error: string }).error;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// The provider transport.
// ─────────────────────────────────────────────────────────────────────────────

export const AI_GATEWAY_CHAT_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";

export type GatewayTransportInput = {
  model: string;
  authorization: string;
  fetcher?: typeof fetch;
  url?: string;
};

function messageOf(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const message = (first as { message?: unknown }).message;
  return typeof message === "object" && message !== null ? (message as Record<string, unknown>) : null;
}

export function extractToolCalls(message: Record<string, unknown>): ToolCall[] {
  const raw = message.tool_calls;
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const fn = record.function;
    if (typeof record.id !== "string" || typeof fn !== "object" || fn === null) continue;
    const name = (fn as Record<string, unknown>).name;
    const args = (fn as Record<string, unknown>).arguments;
    if (typeof name !== "string") continue;
    calls.push({ id: record.id, name, arguments: typeof args === "string" ? args : "" });
  }
  return calls;
}

function usageOf(body: unknown): TokenUsage | null {
  if (typeof body !== "object" || body === null) return null;
  const usage = (body as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const record = usage as Record<string, unknown>;
  const input = record.prompt_tokens;
  const output = record.completion_tokens;
  if (typeof input !== "number" && typeof output !== "number") return null;
  return {
    inputTokens: typeof input === "number" && Number.isFinite(input) ? input : 0,
    outputTokens: typeof output === "number" && Number.isFinite(output) ? output : 0,
  };
}

/**
 * The AI Gateway, in both shapes.
 *
 * `stream` parses the provider's own server-sent events: `data:` lines carrying
 * OpenAI-compatible chunks, tool calls arriving in fragments keyed by index, and a final
 * chunk whose `usage` block is the only reported cost of the request (asked for with
 * `stream_options.include_usage`). A stream that ends without `[DONE]` is treated as a
 * break, because a truncated answer has to be labelled as one.
 */
export function createGatewayTransport(input: GatewayTransportInput): AssistantTransport {
  const request = instrumentFetch({ providerId: PROVIDER_IDS.aiGateway, ...(input.fetcher ? { fetcher: input.fetcher } : {}) });
  const url = input.url ?? AI_GATEWAY_CHAT_URL;
  const headers = {
    Authorization: `Bearer ${input.authorization}`,
    "Content-Type": "application/json",
  };

  async function post(conversation: readonly ConversationEntry[], tools: readonly unknown[], stream: boolean) {
    const response = await request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: input.model,
        stream,
        ...(stream ? { stream_options: { include_usage: true } } : {}),
        max_tokens: 800,
        messages: conversation,
        tools,
        tool_choice: "auto",
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return response;
  }

  return {
    async complete(conversation, tools) {
      const response = await post(conversation, tools, false);
      if (!response.ok) throw new AssistantProviderError(`The assistant model is unavailable (status ${response.status}).`);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new AssistantProviderError("The assistant model returned an unreadable response.", "invalid");
      }
      const message = messageOf(body);
      if (!message) throw new AssistantProviderError("The assistant model returned an invalid response.", "invalid");
      return {
        content: typeof message.content === "string" ? message.content : "",
        toolCalls: extractToolCalls(message),
        usage: usageOf(body),
      };
    },

    async stream(conversation, tools, onDelta) {
      const response = await post(conversation, tools, true);
      if (!response.ok) {
        // The provider refused before sending anything; there is no partial answer to keep.
        throw new AssistantProviderError(`The assistant model is unavailable (status ${response.status}).`);
      }
      const body = response.body;
      if (!body) throw new AssistantProviderError("The assistant model returned no stream.", "invalid");

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let usage: TokenUsage | null = null;
      let done = false;
      const calls = new Map<number, { id: string; name: string; args: string }>();

      try {
        while (!done) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") {
              done = true;
              break;
            }
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(payload) as Record<string, unknown>;
            } catch {
              continue;
            }
            const reported = usageOf(parsed);
            if (reported) usage = reported;

            const choices = parsed.choices;
            if (!Array.isArray(choices) || choices.length === 0) continue;
            const first = choices[0];
            if (typeof first !== "object" || first === null) continue;
            const delta = (first as { delta?: unknown }).delta;
            if (typeof delta !== "object" || delta === null) continue;
            const record = delta as Record<string, unknown>;

            if (typeof record.content === "string" && record.content.length > 0) {
              content += record.content;
              onDelta(record.content);
            }

            const toolDeltas = record.tool_calls;
            if (Array.isArray(toolDeltas)) {
              for (const entry of toolDeltas) {
                if (typeof entry !== "object" || entry === null) continue;
                const toolDelta = entry as Record<string, unknown>;
                const index = typeof toolDelta.index === "number" ? toolDelta.index : 0;
                const current = calls.get(index) ?? { id: "", name: "", args: "" };
                if (typeof toolDelta.id === "string") current.id = toolDelta.id;
                const fn = toolDelta.function;
                if (typeof fn === "object" && fn !== null) {
                  const name = (fn as Record<string, unknown>).name;
                  const args = (fn as Record<string, unknown>).arguments;
                  if (typeof name === "string" && name) current.name = name;
                  if (typeof args === "string") current.args += args;
                }
                calls.set(index, current);
              }
            }
          }
        }
      } catch (error) {
        throw new AssistantProviderError(error instanceof Error ? error.message : "The assistant stream failed.");
      } finally {
        reader.releaseLock();
      }

      // A stream that stopped without its terminator was cut off mid-answer. The text that
      // arrived has already been handed to `onDelta`, so the caller keeps it and labels it
      // incomplete — that is the loop's job, not this transport's.
      if (!done) {
        throw new AssistantProviderError("The assistant stream ended before the answer was complete.");
      }

      const toolCalls: ToolCall[] = [...calls.entries()]
        .sort(([left], [right]) => left - right)
        .flatMap(([index, call]) =>
          call.name
            ? [{ id: call.id || `call_${index}`, name: call.name, arguments: call.args }]
            : [],
        );

      return { content, toolCalls, usage };
    },
  };
}
