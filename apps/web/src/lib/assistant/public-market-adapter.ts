const AI_GATEWAY_CHAT_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_TOOL_ROUNDS = 4;
const MAX_REPLY_CHARACTERS = 8_000;

export type MarketAssistantStatus = {
  adapterEnabled: true;
  target: "Vercel AI Gateway";
  modelConfigured: boolean;
  model: string | null;
};

export type AssistantMessage = { role: "user" | "assistant"; content: string };

export type ToolCall = { id: string; name: string; arguments: string };

export type MarketAssistantResult =
  | { status: "unconfigured"; configuration: MarketAssistantStatus }
  | {
      status: "available";
      configuration: MarketAssistantStatus;
      reply: string;
      model: string;
      toolCalls: string[];
    };

/** The assistant is tool-using: the system prompt advertises the tools below. */
export const MARKET_ASSISTANT_SYSTEM_PROMPT = [
  "You are Veylora's market assistant.",
  "You can call the provided tools to fetch public market data before answering.",
  "Never invent balances, positions, or order history: you only know what the conversation or a tool result gives you.",
  "Never place, modify, or cancel orders and never move funds — those actions live in the app's own authenticated routes.",
  "When you use data, name the source and how fresh it is.",
].join(" ");

export const MARKET_ASSISTANT_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_public_quote",
      description: "Fetch the latest public Coinbase quote (bid/ask) for a USD market symbol.",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string", description: "Coinbase product id, e.g. BTC-USD" } },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_public_rsi",
      description: "Compute the daily RSI-14 from public Coinbase candles for a USD market symbol.",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string", description: "Coinbase product id, e.g. BTC-USD" } },
        required: ["symbol"],
      },
    },
  },
] as const;

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<unknown>;

function configuredValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && !/^(replace|example|your.?)/i.test(trimmed) ? trimmed : null;
}

export function getMarketAssistantStatus(env: NodeJS.ProcessEnv = process.env): MarketAssistantStatus {
  const model = configuredValue(env.AI_GATEWAY_MODEL);
  const authorization = configuredValue(env.AI_GATEWAY_API_KEY) ?? configuredValue(env.VERCEL_OIDC_TOKEN);
  return {
    adapterEnabled: true,
    target: "Vercel AI Gateway",
    modelConfigured: Boolean(model && authorization),
    model,
  };
}

function extractMessage(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const message = (first as { message?: unknown }).message;
  return typeof message === "object" && message !== null ? (message as Record<string, unknown>) : null;
}

function extractToolCalls(message: Record<string, unknown>): ToolCall[] {
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

/**
 * Run the tool-calling conversation loop. The model may ask to call tools; each
 * call is executed server-side by {@link ToolExecutor} and fed back until the
 * model produces a final text reply.
 */
export async function askMarketAssistant(
  messages: readonly AssistantMessage[],
  executeTool: ToolExecutor,
  fetcher: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MarketAssistantResult> {
  const configuration = getMarketAssistantStatus(env);
  const authorization = configuredValue(env.AI_GATEWAY_API_KEY) ?? configuredValue(env.VERCEL_OIDC_TOKEN);
  if (!configuration.modelConfigured || !configuration.model || !authorization) {
    return { status: "unconfigured", configuration };
  }

  const conversation: Array<Record<string, unknown>> = [
    { role: "system", content: MARKET_ASSISTANT_SYSTEM_PROMPT },
    ...messages.map((message) => ({ role: message.role, content: message.content })),
  ];
  const toolCalls: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await fetcher(AI_GATEWAY_CHAT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${authorization}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: configuration.model,
        stream: false,
        max_tokens: 800,
        messages: conversation,
        tools: MARKET_ASSISTANT_TOOLS,
        tool_choice: "auto",
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error("Assistant model is unavailable.");

    const message = extractMessage(await response.json());
    if (!message) throw new Error("Assistant model returned an invalid response.");

    const calls = extractToolCalls(message);
    if (calls.length === 0) {
      const content = typeof message.content === "string" ? message.content.trim() : "";
      if (!content) throw new Error("Assistant model returned no text.");
      return {
        status: "available",
        configuration,
        reply: content.slice(0, MAX_REPLY_CHARACTERS),
        model: configuration.model,
        toolCalls,
      };
    }

    conversation.push({
      role: "assistant",
      content: typeof message.content === "string" ? message.content : null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    });

    for (const call of calls) {
      toolCalls.push(call.name);
      let result: unknown;
      try {
        const parsed: unknown = call.arguments ? JSON.parse(call.arguments) : {};
        result = await executeTool(call.name, typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {});
      } catch (error) {
        result = { error: error instanceof Error ? error.message : "Tool execution failed." };
      }
      conversation.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  throw new Error("Assistant exceeded the tool-call limit.");
}
