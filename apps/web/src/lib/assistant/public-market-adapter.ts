import { isDevelopmentMode } from "@/lib/dev-mode/mode";
import {
  AI_GATEWAY_CHAT_URL,
  createGatewayTransport,
  runAssistantLoop,
  type AssistantLoopInput,
  type AssistantLoopResult,
  type AssistantMessage,
  type AssistantTransport,
  type TokenUsage,
  type ToolCall,
  type ToolExecutor,
} from "@/lib/assistant/loop";
import { ASSISTANT_TOOL_DEFINITIONS } from "@/lib/assistant/tools";
import { redactTranscript } from "@/lib/assistant/citations";

/**
 * Model access for the assistant: who it talks to, what it is told, and whether it can
 * talk at all.
 *
 * The tool-calling loop itself lives in `loop.ts`, because the streaming route needs the
 * same loop with a different transport. What stays here is configuration and the
 * non-streaming entry point, which is the one the tests drive: `askMarketAssistant`
 * answers with the whole reply, and the route answers with the same loop streamed.
 */

export type MarketAssistantStatus = {
  adapterEnabled: true;
  target: "Vercel AI Gateway";
  modelConfigured: boolean;
  model: string | null;
};

export type { AssistantMessage, ToolCall, ToolExecutor };

export type MarketAssistantResult =
  | { status: "unconfigured"; configuration: MarketAssistantStatus }
  | {
      status: "available";
      configuration: MarketAssistantStatus;
      reply: string;
      model: string;
      toolCalls: string[];
      usage: TokenUsage;
    };

/**
 * What the model is told, in the order that matters.
 *
 * The first two rules are the ones the phase is about: use the tools, and never state a
 * figure that did not come from one. The third keeps the assistant inside its lane — it
 * reads and it may place a *paper* order through a tool that is itself restricted in code,
 * and it never claims to have done anything else. The last rule is stated because a model
 * repeating a user's pasted key back into its answer would put that key in a transcript.
 */
export const MARKET_ASSISTANT_SYSTEM_PROMPT = [
  "You are Veylora's assistant for one signed-in owner's account and for public market data.",
  "Always call the provided tools before answering a question about the owner's balances, positions, orders, ledger or alerts, or about a market price, candle or indicator.",
  "Never invent a balance, a position, a price, a fee or an order. If a tool refuses or fails, say which data could not be read and stop there — do not estimate, interpolate or use your own knowledge of markets as if it were a reading.",
  "Never state a number that did not appear in a tool result or in the conversation.",
  "The place_paper_order tool is a simulation on the development paper venue: no exchange is contacted and no real funds move. Never claim to have placed, cancelled or modified a real order, moved funds, or changed a setting.",
  "When you use data, name the source and how fresh it is, and keep the answer short enough to read on a dashboard.",
  "Never repeat a credential, key, token or password from the conversation — if one appears, say it should be rotated and do not echo it.",
].join(" ");

/** The tool definitions sent with every request, from the one typed list. */
export const MARKET_ASSISTANT_TOOLS = ASSISTANT_TOOL_DEFINITIONS;

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

/**
 * Which names would make the assistant answer. Names only — the route puts them
 * in its 503 so an unconfigured deployment says what to set, never a value.
 */
export function getMissingMarketAssistantConfiguration(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = [];
  if (!configuredValue(env.AI_GATEWAY_MODEL)) missing.push("AI_GATEWAY_MODEL");
  if (!(configuredValue(env.AI_GATEWAY_API_KEY) ?? configuredValue(env.VERCEL_OIDC_TOKEN))) {
    missing.push("AI_GATEWAY_API_KEY");
  }
  return missing;
}

/** The credential the request is authorized with, or null. */
export function getMarketAssistantAuthorization(env: NodeJS.ProcessEnv = process.env): string | null {
  return configuredValue(env.AI_GATEWAY_API_KEY) ?? configuredValue(env.VERCEL_OIDC_TOKEN);
}

/**
 * Where the model is asked, from the environment.
 *
 * The gateway URL is a constant, with one development affordance: a local stand-in can be
 * named in `AI_GATEWAY_CHAT_URL` so the streaming path can be exercised end to end
 * without a provider account. Outside development mode only an `https` URL is honoured,
 * so a misconfigured deployment cannot be pointed at a plaintext endpoint by a variable.
 */
export function gatewayChatUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AI_GATEWAY_CHAT_URL?.trim();
  if (!configured) return AI_GATEWAY_CHAT_URL;
  if (isDevelopmentMode(env)) return configured;
  try {
    return new URL(configured).protocol === "https:" ? configured : AI_GATEWAY_CHAT_URL;
  } catch {
    return AI_GATEWAY_CHAT_URL;
  }
}

export function createMarketAssistantTransport(input: {
  model: string;
  authorization: string;
  fetcher?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}): AssistantTransport {
  return createGatewayTransport({
    model: input.model,
    authorization: input.authorization,
    url: gatewayChatUrl(input.env ?? process.env),
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
  });
}

/**
 * One question through the shared loop: the entry point both surfaces use.
 *
 * The transport decides whether text arrives progressively; everything else — the system
 * prompt, the tool list, the round budget, the failure sentences — is here, so the
 * streamed route and the non-streaming call cannot drift apart.
 */
export function runMarketAssistant(input: {
  messages: readonly AssistantMessage[];
  executeTool: ToolExecutor;
  transport: AssistantTransport;
  onEvent?: AssistantLoopInput["onEvent"];
  maxRounds?: number;
}): Promise<AssistantLoopResult> {
  return runAssistantLoop({
    // Redacted here rather than by the caller, so no route can forget it: a credential
    // pasted into the chat box is replaced before it is ever serialized into a request.
    messages: input.messages.map((message) => ({ role: message.role, content: redactTranscript(message.content) })),
    systemPrompt: MARKET_ASSISTANT_SYSTEM_PROMPT,
    tools: MARKET_ASSISTANT_TOOLS,
    executeTool: input.executeTool,
    transport: input.transport,
    ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    ...(input.maxRounds ? { maxRounds: input.maxRounds } : {}),
  });
}

/**
 * The whole reply, in one value.
 *
 * The non-streaming transport reports its text through `onDelta` at the end of each round,
 * so this path and the streaming one share the loop's ordering, its tool budget and its
 * "no text at all" refusal.
 */
export async function askMarketAssistant(
  messages: readonly AssistantMessage[],
  executeTool: ToolExecutor,
  fetcher: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MarketAssistantResult> {
  const configuration = getMarketAssistantStatus(env);
  const authorization = getMarketAssistantAuthorization(env);
  if (!configuration.modelConfigured || !configuration.model || !authorization) {
    return { status: "unconfigured", configuration };
  }

  const transport = createMarketAssistantTransport({ model: configuration.model, authorization, fetcher, env });
  const result = await runMarketAssistant({
    messages,
    executeTool,
    // The one-value path: every round is a whole message, and the loop reports it as a
    // single delta, so a caller has exactly one place to read text from.
    transport: { complete: transport.complete, stream: (conversation, tools) => transport.complete(conversation, tools) },
  });

  return {
    status: "available",
    configuration,
    reply: result.reply,
    model: configuration.model,
    toolCalls: result.toolCalls,
    usage: result.usage,
  };
}
