/**
 * The AI providers, as declarations rather than call sites.
 *
 * Three services answer questions in this product — the Vercel AI Gateway (tool-calling
 * chat), ChainGPT's Web3 LLM (plain chat) and Tavily (keyless search and extract) — and
 * they differ in far more than their URLs. What this module states, once, is what each
 * one can do, which environment variable holds its key, and how it charges. The router
 * decides with these facts; the meter prices with them; the admin panel displays them.
 *
 * Three rules are structural here:
 *
 *  1. **A capability is declared, not assumed.** The assistant needs tool calling, so a
 *     provider without `tools` is never asked to answer one of its questions — the router
 *     skips it and says why, rather than sending a request the provider cannot honour.
 *  2. **A key is a name.** `keyEnv` is the variable to read, never its value: readiness is
 *     a boolean, and `describeProviders` has no field a secret could travel in.
 *  3. **Cost is a declared model, and absent when unset.** Token-billed providers price per
 *     million tokens; ChainGPT bills a credit per request; Tavily's keyless tier is free.
 *     A provider with no configured rate reports a null cost, never an invented one — the
 *     same rule the assistant's own meter already follows.
 */

export type AiTask = "text" | "search" | "extract";

/** What a caller needs from a provider, before the task itself. */
export type AiRequirement = AiTask | "tools" | "stream";

export type AiProviderId = "ai-gateway" | "chaingpt" | "tavily";

export type AiUnitKind = "tokens" | "requests";

/**
 * How a provider charges.
 *
 * Token rates come from the environment because they change with the model, and they are
 * dollars per million tokens in the deployment's own configuration — the same variables
 * phase 26 introduced for the assistant's own meter. A request-billed provider has a flat
 * price per call; null means "no price configured", which is reported as an unknown cost
 * rather than a zero one.
 */
export type AiCostModel =
  | {
      unit: "tokens";
      inputMicrosPerMillion: number | null;
      outputMicrosPerMillion: number | null;
    }
  | { unit: "requests"; microsPerRequest: number | null };

export type AiProvider = {
  id: AiProviderId;
  name: string;
  /** The tasks and features this provider can serve. */
  capabilities: readonly AiRequirement[];
  /** The environment variable that holds its key, or null when it is keyless. */
  keyEnv: string | null;
  detail: string;
  cost: AiCostModel;
};

/** A price in micro-dollars per million tokens, from dollars per million tokens. */
function pricePerMillion(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric * 1_000_000);
}

/** A flat price in micro-dollars, from dollars per call. */
function microsPerCall(value: string | undefined, fallback: number | null): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.round(numeric * 1_000_000);
}

/**
 * The registry.
 *
 * `ai-gateway` is the only provider that can carry the assistant's tool loop and its
 * streamed answer. `chaingpt` answers plain questions with its `general_assistant` model
 * and reports no token usage — its unit is a request. `tavily` is keyless and free at the
 * tier this deployment uses, so its cost defaults to zero rather than to null: zero is a
 * fact about the plan, null would be a missing price.
 */
export function aiProviders(env: NodeJS.ProcessEnv = process.env): readonly AiProvider[] {
  return [
    {
      id: "ai-gateway",
      name: "Vercel AI Gateway",
      capabilities: ["text", "tools", "stream"],
      keyEnv: "AI_GATEWAY_API_KEY",
      detail: "OpenAI-compatible chat with tool calling and server-sent streaming.",
      cost: {
        unit: "tokens",
        inputMicrosPerMillion: pricePerMillion(env.AI_GATEWAY_INPUT_USD_PER_MTOK),
        outputMicrosPerMillion: pricePerMillion(env.AI_GATEWAY_OUTPUT_USD_PER_MTOK),
      },
    },
    {
      id: "chaingpt",
      name: "ChainGPT Web3 LLM",
      capabilities: ["text"],
      keyEnv: "CHAINGPT_API_KEY",
      detail: "Web3-aware chat completion; one credit per request, no tool calling.",
      cost: {
        unit: "requests",
        microsPerRequest: microsPerCall(env.CHAINGPT_USD_PER_REQUEST, null),
      },
    },
    {
      id: "tavily",
      name: "Tavily",
      capabilities: ["search", "extract"],
      keyEnv: null,
      detail: "Keyless research search and page extraction.",
      cost: {
        unit: "requests",
        microsPerRequest: microsPerCall(env.TAVILY_USD_PER_REQUEST, 0),
      },
    },
  ];
}

export function providerById(id: AiProviderId, env: NodeJS.ProcessEnv = process.env): AiProvider | null {
  return aiProviders(env).find((provider) => provider.id === id) ?? null;
}

function configuredValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && !/^(replace|example|your.?)/i.test(trimmed) ? trimmed : null;
}

/**
 * The credential to send, or null. For the gateway a workload identity token is accepted
 * in place of an API key, which is how a Vercel deployment authenticates without one;
 * every other provider has exactly one variable.
 */
export function providerCredential(provider: AiProvider, env: NodeJS.ProcessEnv = process.env): string | null {
  if (provider.keyEnv === null) return null;
  const direct = configuredValue(env[provider.keyEnv]);
  if (direct) return direct;
  if (provider.id === "ai-gateway") return configuredValue(env.VERCEL_OIDC_TOKEN);
  return null;
}

/** Whether this provider's key is present. A boolean; the value is never returned. */
export function providerConfigured(provider: AiProvider, env: NodeJS.ProcessEnv = process.env): boolean {
  if (provider.keyEnv === null) return true;
  return providerCredential(provider, env) !== null;
}

export type AiProviderReadiness = {
  id: AiProviderId;
  name: string;
  capabilities: readonly AiRequirement[];
  keyEnv: string | null;
  configured: boolean;
  detail: string;
  cost: AiCostModel;
};

/** What the admin panel reads: capabilities, a configured flag, and a price model. */
export function describeProviders(env: NodeJS.ProcessEnv = process.env): AiProviderReadiness[] {
  return aiProviders(env).map((provider) => ({
    id: provider.id,
    name: provider.name,
    capabilities: provider.capabilities,
    keyEnv: provider.keyEnv,
    configured: providerConfigured(provider, env),
    detail: provider.detail,
    cost: provider.cost,
  }));
}

/** The variable names whose absence would leave a requirement unserved. */
export function missingProviderKeyNames(
  requirements: readonly AiRequirement[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return aiProviders(env)
    .filter((provider) => requirements.every((requirement) => provider.capabilities.includes(requirement)))
    .filter((provider) => !providerConfigured(provider, env))
    .map((provider) => provider.keyEnv)
    .filter((name): name is string => name !== null);
}

export type AiUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Requests actually made, for a request-billed provider. */
  requests: number;
};

export function emptyUsage(): AiUsage {
  return { inputTokens: 0, outputTokens: 0, requests: 0 };
}

/**
 * What one call cost, in micro-dollars, or null when the provider has no configured rate.
 *
 * The units matter: a token-billed provider prices input and output separately, and a
 * request-billed one prices the call. A negative or non-finite figure is not a price, so it
 * yields null rather than a negative cost.
 */
export function providerCostMicros(
  provider: AiProvider,
  usage: AiUsage,
): number | null {
  if (provider.cost.unit === "requests") {
    if (provider.cost.microsPerRequest === null) return null;
    return provider.cost.microsPerRequest * Math.max(1, usage.requests);
  }

  const { inputMicrosPerMillion, outputMicrosPerMillion } = provider.cost;
  if (inputMicrosPerMillion === null && outputMicrosPerMillion === null) return null;
  const micros =
    (Math.max(0, usage.inputTokens) * (inputMicrosPerMillion ?? 0)) / 1_000_000 +
    (Math.max(0, usage.outputTokens) * (outputMicrosPerMillion ?? 0)) / 1_000_000;
  if (!Number.isFinite(micros) || micros < 0) return null;
  return Math.round(micros);
}

/** The unit a provider's usage is measured in, for the record and the report. */
export function providerUnitKind(provider: AiProvider): AiUnitKind {
  return provider.cost.unit === "requests" ? "requests" : "tokens";
}
