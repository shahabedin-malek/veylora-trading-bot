import { instrumentFetch, PROVIDER_IDS } from "@/lib/observability/provider-call";
import { getChainGPTFeatureSettings } from "@/lib/chaingpt/settings";
import { searchTavily, extractTavily, type TavilySearchResult, type TavilyTopic } from "@/lib/tavily/client";
import {
  aiProviders,
  emptyUsage,
  providerById,
  providerConfigured,
  providerCredential,
  providerCostMicros,
  providerUnitKind,
  missingProviderKeyNames,
  type AiProvider,
  type AiProviderId,
  type AiRequirement,
  type AiTask,
  type AiUsage,
} from "@/lib/ai/provider";
import {
  recordAiRequest,
  type AiMeterStore,
  type AiRequestOutcome,
} from "@/lib/ai/meter";
import {
  AI_GATEWAY_CHAT_URL,
  AssistantProviderError,
  createGatewayTransport,
  type AssistantRound,
  type AssistantTransport,
  type ConversationEntry,
} from "@/lib/assistant/loop";
import { redactTranscript } from "@/lib/assistant/citations";
import { isDevelopmentMode } from "@/lib/dev-mode/mode";
import { auditCreate } from "@/lib/audit/record";

/**
 * Which provider answers which feature, what happens when it cannot, and what each
 * attempt costs.
 *
 * Routing is admin data, not an environment constant: the owner picks the ordered targets
 * for a feature in the admin panel, the change is audited, and the next request obeys it
 * without a redeploy. The environment still supplies what only a deployment can — keys,
 * the default model, and a local stand-in URL in development — and the defaults below are
 * built from it so an unconfigured deployment behaves exactly as phase 26 did.
 *
 * Four rules are enforced in code:
 *
 *  1. **Capabilities are checked before the call.** The assistant needs `tools` and
 *     `stream`; ChainGPT has neither, so putting it first in the assistant's route makes the
 *     router skip it, record why, and use the gateway — it does not send a request the
 *     provider cannot honour.
 *  2. **Fallback only on a retryable failure.** A network error, 408/425/429 or 5xx moves to
 *     the next target; a 400/401/403/404 stops, because retrying the same bad request at a
 *     second provider is spending money to get the same answer.
 *  3. **Every attempt is recorded**, including the one that failed, with its duration and
 *     its computed cost — so "the fallback was used" is a row, not a log line.
 *  4. **A key is read by name and never leaves.** Route plans expose provider ids and
 *     models; a missing key is reported as the variable to set.
 */

export const AI_FEATURES = ["assistant", "research", "strategy", "admin-probe"] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export type AiTarget = { providerId: AiProviderId; model: string | null };

export type AiRoutingSettings = {
  currency: string;
  /** How many units of the display currency one US dollar buys. */
  usdPerCurrencyUnit: string;
  monthlyBudgetUsd: string | null;
  routes: Record<AiFeature, AiTarget[]>;
};

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/;
const MAX_TARGETS = 3;
const MAX_MODEL_LENGTH = 200;

function configuredValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && !/^(replace|example|your.?)/i.test(trimmed) ? trimmed : null;
}

/** The task a feature needs from its provider. */
export function taskForFeature(feature: AiFeature): AiTask {
  return feature === "research" ? "search" : "text";
}

/** What a feature's answer needs from a provider beyond the task itself. */
export function requirementsForFeature(feature: AiFeature): AiRequirement[] {
  if (feature === "assistant") return ["text", "tools", "stream"];
  if (feature === "research") return ["search"];
  return ["text"];
}

/** The route an unconfigured deployment uses, built from what the environment supplies. */
export function defaultAiRoutingSettings(env: NodeJS.ProcessEnv = process.env): AiRoutingSettings {
  const gatewayModel = configuredValue(env.AI_GATEWAY_MODEL);
  const fallbackModel = configuredValue(env.AI_GATEWAY_FALLBACK_MODEL);
  const chainGptModel = configuredValue(env.CHAINGPT_MODEL) ?? "general_assistant";

  const gatewayTargets: AiTarget[] = [
    ...(gatewayModel ? [{ providerId: "ai-gateway" as const, model: gatewayModel }] : []),
    ...(fallbackModel ? [{ providerId: "ai-gateway" as const, model: fallbackModel }] : []),
  ];
  const chainGptTarget: AiTarget[] = [{ providerId: "chaingpt", model: chainGptModel }];

  return {
    currency: "USD",
    usdPerCurrencyUnit: "1",
    monthlyBudgetUsd: null,
    routes: {
      // The assistant requires tool calling, which only the gateway declares.
      assistant: [...gatewayTargets],
      // Strategy generation is plain text, so the web3 model answers first and the
      // gateway is the ordered fallback.
      strategy: [...chainGptTarget, ...gatewayTargets],
      research: [{ providerId: "tavily", model: null }],
      // The probe exercises the admin panel's own route, which is the only place a
      // plain-text fallback can be observed without spending a strategy run.
      "admin-probe": [...gatewayTargets, ...chainGptTarget],
    },
  };
}

export type AiRoutingValidation = { valid: true; value: AiRoutingSettings } | { valid: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normaliseTarget(value: unknown, feature: AiFeature): AiTarget | { error: string } {
  if (!isRecord(value)) return { error: "Each route target must be an object with a provider and a model." };
  const extra = Object.keys(value).filter((key) => key !== "providerId" && key !== "model");
  if (extra.length > 0) return { error: `A route target cannot carry ${extra.join(", ")}.` };
  const providerId = value.providerId;
  if (typeof providerId !== "string" || !providerById(providerId as AiProviderId)) {
    return { error: "A route target names an unknown provider." };
  }
  const provider = providerById(providerId as AiProviderId)!;
  const task = taskForFeature(feature);
  if (!provider.capabilities.includes(task)) {
    return { error: `${provider.name} cannot serve ${feature}.` };
  }
  if (feature === "assistant" && !provider.capabilities.includes("tools")) {
    return { error: `${provider.name} cannot carry the assistant's tool calls.` };
  }
  const model = value.model;
  if (model !== null && (typeof model !== "string" || model.trim().length === 0 || model.trim().length > MAX_MODEL_LENGTH)) {
    return { error: "A model id must be null or a non-empty string of at most 200 characters." };
  }
  return { providerId: provider.id, model: typeof model === "string" ? model.trim() : null };
}

/**
 * Validate a whole routing document.
 *
 * Closed set: a document that carries an unknown key is refused rather than silently
 * dropped, because "the save said OK and the value did not change" is the failure mode a
 * settings panel cannot afford. Every feature must be present — a partial document would
 * otherwise erase routes the caller did not mention.
 */
export function validateAiRoutingSettings(value: unknown): AiRoutingValidation {
  if (!isRecord(value)) return { valid: false, error: "AI routing settings must be an object." };
  const allowed = new Set(["currency", "usdPerCurrencyUnit", "monthlyBudgetUsd", "routes"]);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length > 0) return { valid: false, error: `Unsupported AI routing setting: ${extra.join(", ")}.` };

  const currency = value.currency;
  if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
    return { valid: false, error: "Currency must be a three-letter code such as USD." };
  }
  if (typeof value.usdPerCurrencyUnit !== "string" || !DECIMAL_PATTERN.test(value.usdPerCurrencyUnit) || Number(value.usdPerCurrencyUnit) <= 0) {
    return { valid: false, error: "The currency rate must be a positive decimal (units of that currency per US dollar)." };
  }
  let monthlyBudgetUsd: string | null = null;
  if (value.monthlyBudgetUsd !== null && value.monthlyBudgetUsd !== undefined) {
    if (typeof value.monthlyBudgetUsd !== "string" || !DECIMAL_PATTERN.test(value.monthlyBudgetUsd)) {
      return { valid: false, error: "The monthly budget must be a decimal amount or null." };
    }
    monthlyBudgetUsd = value.monthlyBudgetUsd;
  }

  const routesValue = value.routes;
  if (!isRecord(routesValue)) return { valid: false, error: "AI routing settings need a route per feature." };
  const routeKeys = Object.keys(routesValue);
  if (routeKeys.some((key) => !(AI_FEATURES as readonly string[]).includes(key))) {
    return { valid: false, error: "One or more routes name an unknown feature." };
  }
  if (AI_FEATURES.some((feature) => !Array.isArray(routesValue[feature]))) {
    return { valid: false, error: "Every feature needs a route, even an empty one." };
  }

  const routes = {} as Record<AiFeature, AiTarget[]>;
  for (const feature of AI_FEATURES) {
    const raw = routesValue[feature] as unknown[];
    if (raw.length > MAX_TARGETS) return { valid: false, error: `A route can hold at most ${MAX_TARGETS} targets.` };
    const targets: AiTarget[] = [];
    for (const entry of raw) {
      const normalised = normaliseTarget(entry, feature);
      if ("error" in normalised) return { valid: false, error: normalised.error };
      targets.push(normalised);
    }
    const unique = new Set(targets.map((target) => `${target.providerId}:${target.model ?? ""}`));
    if (unique.size !== targets.length) return { valid: false, error: "A route cannot name the same target twice." };
    if (feature === "assistant" && targets.length === 0) {
      return { valid: false, error: "The assistant needs at least one tool-capable target." };
    }
    routes[feature] = targets;
  }

  return {
    valid: true,
    value: { currency, usdPerCurrencyUnit: value.usdPerCurrencyUnit, monthlyBudgetUsd, routes },
  };
}

const SINGLETON_ID = "global";

/** The stored settings, or the environment defaults when nothing is stored. */
export async function getAiRoutingSettings(env: NodeJS.ProcessEnv = process.env): Promise<AiRoutingSettings> {
  const fallback = defaultAiRoutingSettings(env);
  try {
    const { prisma } = await import("@/lib/db");
    const row = await prisma.aiProviderSettings.findUnique({ where: { id: SINGLETON_ID } });
    if (!row) return fallback;
    const parsed: unknown = JSON.parse(row.routesJson);
    const validation = validateAiRoutingSettings({
      currency: row.currency,
      usdPerCurrencyUnit: row.usdPerCurrencyUnit,
      monthlyBudgetUsd: row.monthlyBudgetUsd,
      routes: parsed,
    });
    return validation.valid ? validation.value : fallback;
  } catch {
    // Unreadable settings are the deployment's defaults, never a guess: the defaults are
    // the documented behaviour of an unconfigured install.
    return fallback;
  }
}

/** Save the whole document and audit the change, in one transaction. */
export async function saveAiRoutingSettings(
  value: unknown,
  actorUserId: string,
): Promise<AiRoutingValidation> {
  const validation = validateAiRoutingSettings(value);
  if (!validation.valid) return validation;

  const { prisma } = await import("@/lib/db");
  const saved = await prisma.$transaction(async (transaction) => {
    const before = await transaction.aiProviderSettings.findUnique({ where: { id: SINGLETON_ID } });
    const row = await transaction.aiProviderSettings.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        currency: validation.value.currency,
        usdPerCurrencyUnit: validation.value.usdPerCurrencyUnit,
        monthlyBudgetUsd: validation.value.monthlyBudgetUsd,
        routesJson: JSON.stringify(validation.value.routes),
        updatedByUserId: actorUserId,
      },
      update: {
        currency: validation.value.currency,
        usdPerCurrencyUnit: validation.value.usdPerCurrencyUnit,
        monthlyBudgetUsd: validation.value.monthlyBudgetUsd,
        routesJson: JSON.stringify(validation.value.routes),
        updatedByUserId: actorUserId,
      },
    });
    await auditCreate(transaction, {
      data: {
        actorUserId,
        action: "AI_ROUTING_UPDATED",
        objectType: "AiProviderSettings",
        objectId: SINGLETON_ID,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({
          before: before
            ? { currency: before.currency, usdPerCurrencyUnit: before.usdPerCurrencyUnit, monthlyBudgetUsd: before.monthlyBudgetUsd, routes: JSON.parse(before.routesJson) }
            : null,
          after: validation.value,
        }),
      },
    });
    return row;
  });

  void saved;
  return validation;
}

// ─────────────────────────────────────────────────────────────────────────────
// Planning and failure classification
// ─────────────────────────────────────────────────────────────────────────────

export type AiSkippedTarget = { providerId: AiProviderId; model: string | null; reason: string };

export type AiEligibleTarget = { provider: AiProvider; model: string | null; label: string };

export type AiRoutePlan = {
  feature: AiFeature;
  requirements: AiRequirement[];
  candidates: AiEligibleTarget[];
  skipped: AiSkippedTarget[];
  /** Key names that would make a capable provider usable, when none is. */
  missingKeys: string[];
};

function labelOf(providerId: AiProviderId, model: string | null): string {
  return model ? `${providerId}:${model}` : providerId;
}

/**
 * Turn the route into the list of providers that may actually be called.
 *
 * Skipping is a recorded decision: a provider without the required capability, without its
 * key, or behind a switched-off ChainGPT feature never reaches the wire — and the plan says
 * which of those it was.
 */
export async function planAiRoute(
  feature: AiFeature,
  settings: AiRoutingSettings,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AiRoutePlan> {
  const requirements = requirementsForFeature(feature);
  const skipped: AiSkippedTarget[] = [];
  const candidates: AiEligibleTarget[] = [];

  const chainGpt = settings.routes[feature].some((target) => target.providerId === "chaingpt")
    ? await getChainGPTFeatureSettings().catch(() => null)
    : null;

  for (const target of settings.routes[feature]) {
    const provider = providerById(target.providerId, env);
    if (!provider) {
      skipped.push({ ...target, reason: "the provider is not known to this build" });
      continue;
    }
    const missing = requirements.filter((requirement) => !provider.capabilities.includes(requirement));
    if (missing.length > 0) {
      skipped.push({ ...target, reason: `${provider.name} does not support ${missing.join(", ")}` });
      continue;
    }
    if (!providerConfigured(provider, env)) {
      skipped.push({ ...target, reason: `${provider.keyEnv} is not set` });
      continue;
    }
    if (provider.id === "chaingpt" && chainGpt !== null && !chainGpt.chatbotEnabled) {
      skipped.push({ ...target, reason: "ChainGPT is switched off in Access & Integrations" });
      continue;
    }
    if ((feature === "assistant" || feature === "strategy" || feature === "admin-probe") && !target.model) {
      skipped.push({ ...target, reason: "no model is configured for this target" });
      continue;
    }
    candidates.push({ provider, model: target.model, label: labelOf(provider.id, target.model) });
  }

  return {
    feature,
    requirements,
    candidates,
    skipped,
    missingKeys: candidates.length > 0 ? [] : missingProviderKeyNames(requirements, env),
  };
}

export class AiRouteUnavailableError extends Error {
  readonly code = "AI_ROUTE_UNAVAILABLE";
  constructor(
    message: string,
    readonly missingKeys: string[] = [],
    readonly skipped: AiSkippedTarget[] = [],
  ) {
    super(message);
    this.name = "AiRouteUnavailableError";
  }
}

export type AiFailure = {
  /** A stable code for the record: `network`, `timeout`, `rate-limit`, `server`, `auth`, `invalid`. */
  code: "network" | "timeout" | "rate-limit" | "server" | "auth" | "invalid" | "unavailable";
  retryable: boolean;
  status: number | null;
  message: string;
};

/**
 * Whether another provider is worth trying.
 *
 * Transport, capacity and credential failures are retryable. The first two are obvious; the
 * third is the reason this a multi-provider router exists — a rejected key belongs to *that*
 * provider, and the next target has its own. A request the provider rejected on its merits (a
 * model that does not exist, an unreadable body) is refused by every provider the same way,
 * so it stops here instead of spending a second call.
 */
export function classifyAiFailure(error: unknown, status: number | null = null): AiFailure {
  const message = error instanceof Error ? error.message : String(error);
  const numeric = status ?? (/status (\d{3})/.exec(message)?.[1] ? Number(/status (\d{3})/.exec(message)?.[1]) : null);
  if (numeric !== null) {
    if (numeric === 408 || numeric === 425 || numeric === 429) {
      return { code: numeric === 429 ? "rate-limit" : "timeout", retryable: true, status: numeric, message };
    }
    if (numeric >= 500) return { code: "server", retryable: true, status: numeric, message };
    if (numeric === 401 || numeric === 403) return { code: "auth", retryable: true, status: numeric, message };
    return { code: "invalid", retryable: false, status: numeric, message };
  }
  if (/timeout|timed out|aborted/i.test(message)) return { code: "timeout", retryable: true, status: null, message };
  if (/fetch failed|network|ECONNREFUSED|ENOTFOUND|socket/i.test(message)) {
    return { code: "network", retryable: true, status: null, message };
  }
  return { code: "unavailable", retryable: true, status: null, message };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider calls
// ─────────────────────────────────────────────────────────────────────────────

export type AiTextMessage = { role: "system" | "user" | "assistant"; content: string };

export type AiTextResult = {
  text: string;
  usage: AiUsage;
  toolCalls: { id: string; name: string; arguments: string }[];
};

const REQUEST_TIMEOUT_MS = 20_000;

function textOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const choices = record.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (typeof first === "object" && first !== null) {
      const message = (first as { message?: unknown }).message;
      if (typeof message === "object" && message !== null && typeof (message as { content?: unknown }).content === "string") {
        return (message as { content: string }).content;
      }
    }
  }
  const data = record.data;
  if (typeof data === "object" && data !== null) {
    for (const key of ["bot", "text", "answer"]) {
      const candidate = (data as Record<string, unknown>)[key];
      if (typeof candidate === "string") return candidate;
    }
  }
  for (const key of ["bot", "answer", "text"]) {
    const candidate = record[key];
    if (typeof candidate === "string") return candidate;
  }
  return null;
}

function usageOf(value: unknown): AiUsage {
  const usage = emptyUsage();
  usage.requests = 1;
  if (typeof value !== "object" || value === null) return usage;
  const record = (value as { usage?: unknown }).usage;
  if (typeof record !== "object" || record === null) return usage;
  const input = (record as { prompt_tokens?: unknown }).prompt_tokens;
  const output = (record as { completion_tokens?: unknown }).completion_tokens;
  usage.inputTokens = typeof input === "number" && Number.isFinite(input) ? input : 0;
  usage.outputTokens = typeof output === "number" && Number.isFinite(output) ? output : 0;
  return usage;
}

/** Where ChainGPT is asked. Only an https override is honoured outside development. */
export function chainGptBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CHAINGPT_API_BASE_URL?.trim();
  if (!configured) return "https://api.chaingpt.org";
  if (isDevelopmentMode(env)) return configured.replace(/\/$/, "");
  try {
    return new URL(configured).protocol === "https:" ? configured.replace(/\/$/, "") : "https://api.chaingpt.org";
  } catch {
    return "https://api.chaingpt.org";
  }
}

export function gatewayUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AI_GATEWAY_CHAT_URL?.trim();
  if (!configured) return AI_GATEWAY_CHAT_URL;
  if (isDevelopmentMode(env)) return configured;
  try {
    return new URL(configured).protocol === "https:" ? configured : AI_GATEWAY_CHAT_URL;
  } catch {
    return AI_GATEWAY_CHAT_URL;
  }
}

function authorizationFor(provider: AiProvider, env: NodeJS.ProcessEnv): string {
  const value = providerCredential(provider, env);
  if (!value) {
    throw new Error(`${provider.keyEnv ?? "The provider key"} is not set.`);
  }
  return value;
}

/** One plain-text completion through a specific provider, in the provider's own wire format. */
export async function callProviderText(input: {
  provider: AiProvider;
  model: string;
  messages: readonly AiTextMessage[];
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
}): Promise<AiTextResult> {
  const env = input.env ?? process.env;
  const authorization = authorizationFor(input.provider, env);
  const request = instrumentFetch({
    providerId: input.provider.id === "chaingpt" ? PROVIDER_IDS.chaingpt : PROVIDER_IDS.aiGateway,
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
  });

  if (input.provider.id === "chaingpt") {
    const response = await request(`${chainGptBaseUrl(env)}/chat/stream`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authorization}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        question: input.messages.map((message) => `${message.role}: ${message.content}`).join("\n"),
        chatHistory: "off",
        useCustomContext: false,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`The ChainGPT provider answered status ${response.status}.`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("The ChainGPT provider returned an unreadable response.");
    }
    const text = textOf(body);
    if (!text) throw new Error("The ChainGPT provider returned no answer text.");
    // ChainGPT bills credits per request and reports no token counts.
    return { text, usage: { inputTokens: 0, outputTokens: 0, requests: 1 }, toolCalls: [] };
  }

  const response = await request(gatewayUrl(env), {
    method: "POST",
    headers: { Authorization: `Bearer ${authorization}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: input.model, messages: input.messages, stream: false, max_tokens: 800 }),
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`The AI Gateway answered status ${response.status}.`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("The AI Gateway returned an unreadable response.");
  }
  const text = textOf(body);
  if (!text) throw new Error("The AI Gateway returned no answer text.");
  return { text, usage: usageOf(body), toolCalls: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Running a task through the route
// ─────────────────────────────────────────────────────────────────────────────

export type AiAttempt = {
  providerId: AiProviderId;
  model: string | null;
  label: string;
  outcome: AiRequestOutcome;
  errorCode: string | null;
  durationMs: number;
  costMicrosUsd: number | null;
};

export type AiTextRun = {
  text: string;
  providerId: AiProviderId;
  model: string | null;
  usage: AiUsage;
  costMicrosUsd: number | null;
  /** The target that failed immediately before this one answered, if any. */
  fallbackFrom: string | null;
  attempts: AiAttempt[];
};

function meterInput(input: {
  feature: AiFeature;
  userId: string | null;
  task: AiTask;
  providerId: AiProviderId;
  model: string | null;
  outcome: AiRequestOutcome;
  errorCode: string | null;
  usage: AiUsage;
  durationMs: number;
  costMicrosUsd: number | null;
  currency: string;
  fallbackFrom: string | null;
}) {
  const provider = providerById(input.providerId);
  const unitKind = provider ? providerUnitKind(provider) : "requests";
  return {
    userId: input.userId,
    feature: input.feature,
    task: input.task,
    providerId: input.providerId,
    model: input.model,
    outcome: input.outcome,
    errorCode: input.errorCode,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    units: unitKind === "tokens" ? input.usage.inputTokens + input.usage.outputTokens : input.usage.requests,
    unitKind,
    durationMs: input.durationMs,
    costMicrosUsd: input.costMicrosUsd,
    currency: input.currency,
    fallbackFrom: input.fallbackFrom,
  } satisfies Parameters<typeof recordAiRequest>[0];
}

/**
 * A plain-text task, in route order, with a record per attempt.
 *
 * The first target that answers wins. A retryable failure records itself and moves on; a
 * rejected request stops, because the next provider would reject it too.
 */
export async function runAiTextTask(input: {
  feature: AiFeature;
  userId: string | null;
  messages: readonly AiTextMessage[];
  settings?: AiRoutingSettings;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  store?: AiMeterStore;
}): Promise<AiTextRun> {
  const env = input.env ?? process.env;
  const settings = input.settings ?? (await getAiRoutingSettings(env));
  const plan = await planAiRoute(input.feature, settings, env);
  if (plan.candidates.length === 0) {
    const names = plan.missingKeys.length > 0 ? ` Set ${plan.missingKeys.join(" and ")}.` : "";
    throw new AiRouteUnavailableError(
      `No provider can serve ${input.feature} right now.${names}`,
      plan.missingKeys,
      plan.skipped,
    );
  }

  const attempts: AiAttempt[] = [];
  let fallbackFrom: string | null = null;
  for (const candidate of plan.candidates) {
    const startedAt = Date.now();
    try {
      const result = await callProviderText({
        provider: candidate.provider,
        model: candidate.model as string,
        messages: input.messages.map((message) => ({ ...message, content: redactTranscript(message.content) })),
        env,
        ...(input.fetcher ? { fetcher: input.fetcher } : {}),
      });
      const durationMs = Date.now() - startedAt;
      const costMicrosUsd = providerCostMicros(candidate.provider, result.usage);
      attempts.push({ providerId: candidate.provider.id, model: candidate.model, label: candidate.label, outcome: "SUCCESS", errorCode: null, durationMs, costMicrosUsd });
      await recordAiRequest(
        meterInput({
          feature: input.feature,
          userId: input.userId,
          task: "text",
          providerId: candidate.provider.id,
          model: candidate.model,
          outcome: "SUCCESS",
          errorCode: null,
          usage: result.usage,
          durationMs,
          costMicrosUsd,
          currency: settings.currency,
          fallbackFrom,
        }),
        input.store,
      );
      return { text: result.text, providerId: candidate.provider.id, model: candidate.model, usage: result.usage, costMicrosUsd, fallbackFrom, attempts };
    } catch (error) {
      const failure = classifyAiFailure(error);
      const durationMs = Date.now() - startedAt;
      attempts.push({ providerId: candidate.provider.id, model: candidate.model, label: candidate.label, outcome: "FAILED", errorCode: failure.code, durationMs, costMicrosUsd: null });
      await recordAiRequest(
        meterInput({
          feature: input.feature,
          userId: input.userId,
          task: "text",
          providerId: candidate.provider.id,
          model: candidate.model,
          outcome: "FAILED",
          errorCode: failure.code,
          usage: emptyUsage(),
          durationMs,
          costMicrosUsd: null,
          currency: settings.currency,
          fallbackFrom,
        }),
        input.store,
      );
      if (!failure.retryable) {
        throw new AiRouteUnavailableError(`${candidate.provider.name} refused the ${input.feature} request: ${failure.message}`, plan.missingKeys, plan.skipped);
      }
      fallbackFrom = candidate.label;
    }
  }

  throw new AiRouteUnavailableError(
    `Every provider in the ${input.feature} route failed. The last attempt was ${fallbackFrom ?? "none"}.`,
    plan.missingKeys,
    plan.skipped,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The assistant's transport, metered per provider call
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A transport for the assistant's tool loop that obeys the route.
 *
 * A stream that breaks after text has been shown is not retried: the reader has already
 * seen that text, and a second provider's answer would replace half a sentence. A failure
 * before the first delta is retryable, and the next tool-capable target is asked instead —
 * with the answer's record naming the target that failed.
 */
export function createRoutedAssistantTransport(input: {
  plan: AiRoutePlan;
  feature: AiFeature;
  userId: string | null;
  settings: AiRoutingSettings;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  store?: AiMeterStore;
  /** Called with the target that answered, so a caller can report the provider truthfully. */
  onAnswered?: (target: AiEligibleTarget) => void;
}): AssistantTransport {
  const env = input.env ?? process.env;

  async function attempt(
    candidate: AiEligibleTarget,
    conversation: readonly ConversationEntry[],
    tools: readonly unknown[],
    stream: boolean,
    onDelta?: (text: string) => void,
  ): Promise<AssistantRound> {
    const transport = createGatewayTransport({
      model: candidate.model as string,
      authorization: authorizationFor(candidate.provider, env),
      url: gatewayUrl(env),
      ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    });
    return stream
      ? transport.stream(conversation, tools, onDelta ?? (() => undefined))
      : transport.complete(conversation, tools);
  }

  async function run(
    conversation: readonly ConversationEntry[],
    tools: readonly unknown[],
    onDelta: ((text: string) => void) | null,
  ): Promise<AssistantRound> {
    let fallbackFrom: string | null = null;
    const candidates = input.plan.candidates;
    for (const candidate of candidates) {
      const startedAt = Date.now();
      let sawDelta = false;
      const wrapped = onDelta
        ? (text: string) => {
            sawDelta = true;
            onDelta(text);
          }
        : undefined;
      try {
        const round = await attempt(candidate, conversation, tools, onDelta !== null, wrapped);
        const durationMs = Date.now() - startedAt;
        // A completed round reports tokens; a streamed one reports them in its final
        // chunk. Either way the provider was asked once, which is the request unit.
        const usage: AiUsage = {
          inputTokens: round.usage?.inputTokens ?? 0,
          outputTokens: round.usage?.outputTokens ?? 0,
          requests: 1,
        };
        const costMicrosUsd = providerCostMicros(candidate.provider, usage);
        await recordAiRequest(
          meterInput({
            feature: input.feature,
            userId: input.userId,
            task: "text",
            providerId: candidate.provider.id,
            model: candidate.model,
            outcome: "SUCCESS",
            errorCode: null,
            usage,
            durationMs,
            costMicrosUsd,
            currency: input.settings.currency,
            fallbackFrom,
          }),
          input.store,
        );
        input.onAnswered?.(candidate);
        return round;
      } catch (error) {
        const failure = classifyAiFailure(error);
        const durationMs = Date.now() - startedAt;
        await recordAiRequest(
          meterInput({
            feature: input.feature,
            userId: input.userId,
            task: "text",
            providerId: candidate.provider.id,
            model: candidate.model,
            outcome: "FAILED",
            errorCode: failure.code,
            usage: emptyUsage(),
            durationMs,
            costMicrosUsd: null,
            currency: input.settings.currency,
            fallbackFrom,
          }),
          input.store,
        );
        if (!failure.retryable || sawDelta) {
          throw error instanceof AssistantProviderError
            ? error
            : new AssistantProviderError(failure.message, failure.retryable ? "unavailable" : "invalid");
        }
        fallbackFrom = candidate.label;
      }
    }
    throw new AssistantProviderError(
      `Every tool-capable provider in the assistant route failed. The last attempt was ${fallbackFrom ?? "none"}.`,
      "unavailable",
    );
  }

  return {
    complete: (conversation, tools) => run(conversation, tools, null),
    stream: (conversation, tools, onDelta) => run(conversation, tools, onDelta),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tavily, through the same route and meter
// ─────────────────────────────────────────────────────────────────────────────

export async function runResearchSearch(input: {
  feature: AiFeature;
  userId: string | null;
  query: string;
  topic: TavilyTopic;
  settings?: AiRoutingSettings;
  env?: NodeJS.ProcessEnv;
  store?: AiMeterStore;
}): Promise<TavilySearchResult[]> {
  const env = input.env ?? process.env;
  const settings = input.settings ?? (await getAiRoutingSettings(env));
  const plan = await planAiRoute("research", settings, env);
  const candidate = plan.candidates[0];
  if (!candidate) throw new AiRouteUnavailableError("No provider can serve research right now.", plan.missingKeys, plan.skipped);
  const startedAt = Date.now();
  try {
    const results = await searchTavily(input.query, input.topic);
    const durationMs = Date.now() - startedAt;
    const usage = { inputTokens: 0, outputTokens: 0, requests: 1 };
    await recordAiRequest(
      meterInput({
        feature: input.feature,
        userId: input.userId,
        task: "search",
        providerId: candidate.provider.id,
        model: null,
        outcome: "SUCCESS",
        errorCode: null,
        usage,
        durationMs,
        costMicrosUsd: providerCostMicros(candidate.provider, usage),
        currency: settings.currency,
        fallbackFrom: null,
      }),
      input.store,
    );
    return results;
  } catch (error) {
    const failure = classifyAiFailure(error);
    await recordAiRequest(
      meterInput({
        feature: input.feature,
        userId: input.userId,
        task: "search",
        providerId: candidate.provider.id,
        model: null,
        outcome: "FAILED",
        errorCode: failure.code,
        usage: emptyUsage(),
        durationMs: Date.now() - startedAt,
        costMicrosUsd: null,
        currency: settings.currency,
        fallbackFrom: null,
      }),
      input.store,
    );
    throw error;
  }
}

export async function runResearchExtract(input: {
  feature: AiFeature;
  userId: string | null;
  urls: string[];
  settings?: AiRoutingSettings;
  env?: NodeJS.ProcessEnv;
  store?: AiMeterStore;
}): Promise<{ results: { url: string; content: string }[]; failed: string[] }> {
  const env = input.env ?? process.env;
  const settings = input.settings ?? (await getAiRoutingSettings(env));
  const plan = await planAiRoute("research", settings, env);
  const candidate = plan.candidates.find((entry) => entry.provider.capabilities.includes("extract"));
  if (!candidate) throw new AiRouteUnavailableError("No provider can extract pages right now.", plan.missingKeys, plan.skipped);
  const startedAt = Date.now();
  try {
    const extracted = await extractTavily(input.urls);
    const durationMs = Date.now() - startedAt;
    const usage = { inputTokens: 0, outputTokens: 0, requests: Math.max(1, input.urls.length) };
    await recordAiRequest(
      meterInput({
        feature: input.feature,
        userId: input.userId,
        task: "extract",
        providerId: candidate.provider.id,
        model: null,
        outcome: "SUCCESS",
        errorCode: null,
        usage,
        durationMs,
        costMicrosUsd: providerCostMicros(candidate.provider, usage),
        currency: settings.currency,
        fallbackFrom: null,
      }),
      input.store,
    );
    return extracted;
  } catch (error) {
    const failure = classifyAiFailure(error);
    await recordAiRequest(
      meterInput({
        feature: input.feature,
        userId: input.userId,
        task: "extract",
        providerId: candidate.provider.id,
        model: null,
        outcome: "FAILED",
        errorCode: failure.code,
        usage: emptyUsage(),
        durationMs: Date.now() - startedAt,
        costMicrosUsd: null,
        currency: settings.currency,
        fallbackFrom: null,
      }),
      input.store,
    );
    throw error;
  }
}

/** The providers that may answer a feature, for the admin panel's read. */
export async function describeAiRoutes(settings: AiRoutingSettings, env: NodeJS.ProcessEnv = process.env) {
  const plans = await Promise.all(
    AI_FEATURES.map(async (feature) => {
      const plan = await planAiRoute(feature, settings, env);
      return {
        feature,
        requirements: plan.requirements,
        targets: plan.candidates.map((candidate) => ({ providerId: candidate.provider.id, model: candidate.model })),
        skipped: plan.skipped,
        missingKeys: plan.missingKeys,
      };
    }),
  );
  return plans;
}

export { aiProviders };
