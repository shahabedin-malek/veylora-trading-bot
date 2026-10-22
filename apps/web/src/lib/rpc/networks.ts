/**
 * Multi-network Alchemy RPC registry.
 *
 * Networks are discovered from the environment at runtime: every variable named
 * `ALCHEMY_<NETWORK>_RPC_URL` or `ALCHEMY_<NETWORK>_API_KEY` counts as one
 * configured network. There is no hand-maintained network list, so all
 * configured networks work automatically — today that is the full account-wide
 * key's network set (150+).
 *
 * The registry is the single source the switcher, the admin panel and the proxy
 * read. It carries only public metadata (chain id, display name, native asset,
 * explorer, availability with a reason) and never an endpoint or a key: the
 * key-bearing URL stays behind {@link resolveRpcEndpoint}, which is server-only.
 *
 * Server-only. Never import this from a client component.
 */
import { EVM_MAINNETS } from "@/lib/portfolio/evm-mainnets";
import { NETWORK_CATALOG, isKnownNonEvmNetwork, type NetworkCatalogMetadata } from "./network-catalog";

const RPC_URL_ENV_PATTERN = /^ALCHEMY_([A-Z0-9]+(?:_[A-Z0-9]+)*)_RPC_URL$/;
const API_KEY_ENV_PATTERN = /^ALCHEMY_([A-Z0-9]+(?:_[A-Z0-9]+)*)_API_KEY$/;
const BEACON_VARIABLE_SUFFIX = "_BEACON_RPC_URL";
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 64;

/** How long a process keeps a registry it built from `process.env`. */
export const NETWORK_REGISTRY_TTL_MS = 30_000;

/** Friendly aliases → canonical network slug. */
export const RPC_NETWORK_ALIASES: Readonly<Record<string, string>> = {
  ethereum: "ethereum-mainnet",
  eth: "ethereum-mainnet",
  "eth-mainnet": "ethereum-mainnet",
  mainnet: "ethereum-mainnet",
  base: "base-mainnet",
  arbitrum: "arb-mainnet",
  arb: "arb-mainnet",
  optimism: "opt-mainnet",
  op: "opt-mainnet",
  polygon: "polygon-mainnet",
  matic: "polygon-mainnet",
  bnb: "bnb-mainnet",
  avax: "avax-mainnet",
  avalanche: "avax-mainnet",
  solana: "solana-mainnet",
  sol: "solana-mainnet",
  zksync: "zksync-mainnet",
  scroll: "scroll-mainnet",
  line: "linea-mainnet",
  linea: "linea-mainnet",
  blast: "blast-mainnet",
  mantle: "mantle-mainnet",
  celo: "celo-mainnet",
  gnosis: "gnosis-mainnet",
  zora: "zora-mainnet",
};

/**
 * Fallback hostnames used only when a network has no usable
 * `ALCHEMY_<NET>_RPC_URL` variable but a key (per-network or shared) is set.
 * The per-network variable is always preferred.
 */
const RPC_NETWORK_HOSTS: Readonly<Record<string, string>> = {
  "ethereum-mainnet": "eth-mainnet.g.alchemy.com",
  "ethereum-sepolia": "eth-sepolia.g.alchemy.com",
  "base-mainnet": "base-mainnet.g.alchemy.com",
  "base-sepolia": "base-sepolia.g.alchemy.com",
  "arb-mainnet": "arb-mainnet.g.alchemy.com",
  "arb-sepolia": "arb-sepolia.g.alchemy.com",
  "opt-mainnet": "opt-mainnet.g.alchemy.com",
  "opt-sepolia": "opt-sepolia.g.alchemy.com",
  "polygon-mainnet": "polygon-mainnet.g.alchemy.com",
  "polygon-amoy": "polygon-amoy.g.alchemy.com",
  "bnb-mainnet": "bnb-mainnet.g.alchemy.com",
  "avax-mainnet": "avax-mainnet.g.alchemy.com",
  "zksync-mainnet": "zksync-mainnet.g.alchemy.com",
  "solana-mainnet": "solana-mainnet.g.alchemy.com",
  "gnosis-mainnet": "gnosis-mainnet.g.alchemy.com",
  "metis-mainnet": "metis-mainnet.g.alchemy.com",
  "unichain-mainnet": "unichain-mainnet.g.alchemy.com",
  "sonic-mainnet": "sonic-mainnet.g.alchemy.com",
  "worldchain-mainnet": "worldchain-mainnet.g.alchemy.com",
  "soneium-mainnet": "soneium-mainnet.g.alchemy.com",
  "ronin-mainnet": "ronin-mainnet.g.alchemy.com",
  "abstract-mainnet": "abstract-mainnet.g.alchemy.com",
  "mode-mainnet": "mode-mainnet.g.alchemy.com",
  "celo-mainnet": "celo-mainnet.g.alchemy.com",
  "ink-mainnet": "ink-mainnet.g.alchemy.com",
  "scroll-mainnet": "scroll-mainnet.g.alchemy.com",
  "linea-mainnet": "linea-mainnet.g.alchemy.com",
  "blast-mainnet": "blast-mainnet.g.alchemy.com",
  "zora-mainnet": "zora-mainnet.g.alchemy.com",
  "berachain-mainnet": "berachain-mainnet.g.alchemy.com",
  "apechain-mainnet": "apechain-mainnet.g.alchemy.com",
  "sei-mainnet": "sei-mainnet.g.alchemy.com",
  "cronos-mainnet": "cronos-mainnet.g.alchemy.com",
  "story-mainnet": "story-mainnet.g.alchemy.com",
  "frax-mainnet": "frax-mainnet.g.alchemy.com",
};

export type NetworkKind = "evm" | "non-evm" | "unknown";
export type NetworkAvailability = "available" | "unavailable";
export type NetworkConfigurationSource = "rpc-url" | "api-key" | "shared-key" | "none";
export type NetworkProblemCode = "none" | "missing" | "empty" | "placeholder" | "malformed" | "insecure" | "no-host";

/** One configured network, with no endpoint and no key in it. */
export type NetworkRegistryEntry = {
  slug: string;
  /** The variable the operator must edit, e.g. `ALCHEMY_BASE_MAINNET_RPC_URL`. */
  variable: string;
  name: string;
  chainId: number | null;
  kind: NetworkKind;
  testnet: boolean;
  nativeSymbol: string | null;
  explorerUrl: string | null;
  /** Whether this chain is part of the portfolio token allow-list. */
  tokenAllowlist: "listed" | "not-listed" | "not-applicable";
  availability: NetworkAvailability;
  source: NetworkConfigurationSource;
  problem: NetworkProblemCode;
  reason: string | null;
};

export type NetworkRegistry = {
  readAt: string;
  entries: NetworkRegistryEntry[];
  totals: {
    discovered: number;
    available: number;
    unavailable: number;
    evm: number;
    listedForPortfolio: number;
  };
  /** Variables that matched a pattern but are not JSON-RPC endpoints. */
  ignoredVariables: string[];
};

function hasRealValue(value: string | undefined): value is string {
  const trimmed = value?.trim();
  return Boolean(trimmed && !/^(?:replace|change.?me|example|your.?)/i.test(trimmed));
}

function normalizeSlug(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.length > MAX_SLUG_LENGTH) return null;
  const slug = RPC_NETWORK_ALIASES[trimmed] ?? trimmed;
  return SLUG_PATTERN.test(slug) ? slug : null;
}

/**
 * The canonical slug for a network name or alias, or null when it is not a slug.
 *
 * Health and registry keys are canonical, so a caller holding an alias such as
 * `eth-mainnet` records against the same network the proxy records against.
 */
export function canonicalNetworkSlug(network: string): string | null {
  return normalizeSlug(network);
}

function envKeyForSlug(slug: string): string {
  return `ALCHEMY_${slug.toUpperCase().replace(/-/g, "_")}_RPC_URL`;
}

function apiKeyEnvKeyForSlug(slug: string): string {
  return `ALCHEMY_${slug.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

function slugFromEnvKey(key: string, pattern: RegExp): string | null {
  const match = pattern.exec(key);
  return match ? match[1]!.toLowerCase().replace(/_/g, "-") : null;
}

function titleCase(slug: string): string {
  return slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isTestnetSlug(slug: string): boolean {
  return /(?:^|-)(testnet|sepolia|devnet|hoodi|amoy|fuji|curtis|bokuto|minato|saigon|chiado|mocha|aeneid|moderato|septestnet|bepolia|cassiopeia|atlantic|signet|ropsten|testnet4|giwa)(?:-|$)/.test(slug);
}

function metadataForSlug(slug: string): NetworkCatalogMetadata | null {
  const mainnet = EVM_MAINNETS.find((network) => normalizeSlug(network.alchemyNetwork) === slug);
  if (mainnet) {
    return {
      chainId: mainnet.chainId,
      name: mainnet.name,
      nativeSymbol: mainnet.nativeSymbol,
      explorerUrl: mainnet.explorerUrl,
    };
  }
  return NETWORK_CATALOG[slug] ?? null;
}

/**
 * The variable name that would configure `network` directly, for honest 503 copy
 * ("ALCHEMY_ETHEREUM_MAINNET_RPC_URL is not configured"). Returns null when the
 * value is not a network slug at all.
 */
export function rpcConfigurationVariableName(network: string): string | null {
  const slug = normalizeSlug(network);
  return slug ? envKeyForSlug(slug) : null;
}

/** The per-network API-key variable name, for the same honest copy. */
export function rpcApiKeyVariableName(network: string): string | null {
  const slug = normalizeSlug(network);
  return slug ? apiKeyEnvKeyForSlug(slug) : null;
}

/** Every configured network slug, sorted. Never returns endpoint values. */
export function listRpcNetworkSlugs(env: NodeJS.ProcessEnv = process.env): string[] {
  const slugs = new Set<string>();
  for (const key of Object.keys(env)) {
    if (key.endsWith(BEACON_VARIABLE_SUFFIX)) continue;
    const slug = slugFromEnvKey(key, RPC_URL_ENV_PATTERN) ?? slugFromEnvKey(key, API_KEY_ENV_PATTERN);
    if (slug) slugs.add(slug);
  }
  return [...slugs].sort();
}

function isUsableEndpoint(value: string | undefined): value is string {
  if (!hasRealValue(value)) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/** Why a set RPC URL cannot be used, said without repeating its value. */
type EndpointProblem = "empty" | "placeholder" | "malformed" | "insecure";

function endpointProblem(value: string): EndpointProblem | "none" {
  const trimmed = value.trim();
  if (!trimmed) return "empty";
  if (!hasRealValue(trimmed)) return "placeholder";
  try {
    const url = new URL(trimmed);
    if (!url.hostname) return "malformed";
    if (url.protocol !== "https:") return "insecure";
    return "none";
  } catch {
    return "malformed";
  }
}

const PROBLEM_TEXT: Readonly<Record<"missing" | "empty" | "placeholder" | "malformed" | "insecure", string>> = {
  missing: "is not set",
  empty: "is set but empty",
  placeholder: "is set to a placeholder value",
  malformed: "is not a usable URL",
  insecure: "must be an https URL",
};

export type RpcNetworkResolution =
  | { ok: true; slug: string; endpoint: string }
  | { ok: false; reason: "invalid-network" | "unconfigured" };

/**
 * Resolve a network slug (or alias) to its key-bearing RPC endpoint. The
 * endpoint is returned only to server-side callers and is never logged.
 *
 * Precedence: a per-network `_RPC_URL`, then a per-network `_API_KEY` combined
 * with a known Alchemy host, then the shared `ALCHEMY_API_KEY` fallback.
 */
export function resolveRpcEndpoint(
  network: string,
  env: NodeJS.ProcessEnv = process.env,
): RpcNetworkResolution {
  const slug = normalizeSlug(network);
  if (!slug) return { ok: false, reason: "invalid-network" };

  const direct = env[envKeyForSlug(slug)];
  if (isUsableEndpoint(direct)) return { ok: true, slug, endpoint: direct.trim() };

  const host = RPC_NETWORK_HOSTS[slug];
  const networkKey = env[apiKeyEnvKeyForSlug(slug)];
  if (host && hasRealValue(networkKey)) {
    return { ok: true, slug, endpoint: `https://${host}/v2/${encodeURIComponent(networkKey.trim())}` };
  }

  // `ALCHEMY_ETHEREUM_MAINNET_API_KEY` is accepted as a legacy shared-key fallback.
  // The first *usable* value wins: an exported-but-empty `ALCHEMY_API_KEY` is common in
  // shells and CI, and `??` would let it shadow a real legacy key, reporting every
  // network as unconfigured.
  const sharedKey = firstUsableValue(env.ALCHEMY_API_KEY, env.ALCHEMY_ETHEREUM_MAINNET_API_KEY);
  if (host && sharedKey !== null) {
    return { ok: true, slug, endpoint: `https://${host}/v2/${encodeURIComponent(sharedKey.trim())}` };
  }
  return { ok: false, reason: "unconfigured" };
}

/** The first value that is not blank and not a placeholder, or null. */
function firstUsableValue(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    if (hasRealValue(value)) return value!.trim();
  }
  return null;
}

function assessNetwork(slug: string, env: NodeJS.ProcessEnv): Pick<NetworkRegistryEntry, "availability" | "source" | "problem" | "reason"> {
  const variable = envKeyForSlug(slug);
  const raw = env[variable];

  const resolution = resolveRpcEndpoint(slug, env);
  if (resolution.ok) {
    const direct = isUsableEndpoint(raw);
    const perNetworkKey = hasRealValue(env[apiKeyEnvKeyForSlug(slug)]);
    return {
      availability: "available",
      source: direct ? "rpc-url" : perNetworkKey ? "api-key" : "shared-key",
      problem: "none",
      reason: null,
    };
  }

  if (raw !== undefined) {
    const problem = endpointProblem(raw);
    if (problem !== "none") {
      return {
        availability: "unavailable",
        source: "none",
        problem,
        reason: `${variable} ${PROBLEM_TEXT[problem]}, so ${slug} is unavailable.`,
      };
    }
  }

  const keyVariable = apiKeyEnvKeyForSlug(slug);
  if (hasRealValue(env[keyVariable]) && !RPC_NETWORK_HOSTS[slug]) {
    return {
      availability: "unavailable",
      source: "none",
      problem: "no-host",
      reason: `${keyVariable} is set, but no RPC host is known for ${slug}; set ${variable} instead.`,
    };
  }

  return {
    availability: "unavailable",
    source: "none",
    problem: "missing",
    reason: `${variable} is not set, so ${slug} is unavailable.`,
  };
}

function buildEntry(slug: string, env: NodeJS.ProcessEnv): NetworkRegistryEntry {
  const metadata = metadataForSlug(slug);
  const kind: NetworkKind = metadata ? "evm" : isKnownNonEvmNetwork(slug) ? "non-evm" : "unknown";
  const listed = metadata
    ? EVM_MAINNETS.some((network) => network.chainId === metadata.chainId)
    : false;
  const assessment = assessNetwork(slug, env);

  return {
    slug,
    variable: envKeyForSlug(slug),
    name: metadata?.name ?? titleCase(slug),
    chainId: metadata?.chainId ?? null,
    kind,
    testnet: isTestnetSlug(slug),
    nativeSymbol: metadata?.nativeSymbol ?? null,
    explorerUrl: metadata?.explorerUrl ?? null,
    tokenAllowlist: kind !== "evm" ? "not-applicable" : listed ? "listed" : "not-listed",
    ...assessment,
  };
}

/**
 * Build a registry from an environment, without touching the cache.
 *
 * Exported for the startup validation and for tests that must not share state:
 * a caller passing its own `env` always gets a fresh answer.
 */
export function buildNetworkRegistry(env: NodeJS.ProcessEnv = process.env, now = new Date()): NetworkRegistry {
  const ignoredVariables: string[] = [];
  for (const key of Object.keys(env)) {
    if (key.endsWith(BEACON_VARIABLE_SUFFIX)) ignoredVariables.push(key);
  }

  const entries = listRpcNetworkSlugs(env).map((slug) => buildEntry(slug, env));
  return {
    readAt: now.toISOString(),
    entries,
    totals: {
      discovered: entries.length,
      available: entries.filter(({ availability }) => availability === "available").length,
      unavailable: entries.filter(({ availability }) => availability === "unavailable").length,
      evm: entries.filter(({ kind }) => kind === "evm").length,
      listedForPortfolio: entries.filter(({ tokenAllowlist }) => tokenAllowlist === "listed").length,
    },
    ignoredVariables: ignoredVariables.sort(),
  };
}

type CachedRegistry = { registry: NetworkRegistry; expiresAt: number };
let cachedRegistry: CachedRegistry | null = null;

/**
 * The process's registry, cached briefly.
 *
 * Only the default `process.env` is cached: a caller that passes its own
 * environment is asking a question about *that* environment, so it always gets
 * a fresh answer. The TTL is what makes a changed variable visible without a
 * redeploy where the process rereads its environment; {@link invalidateNetworkRegistry}
 * is the explicit path for a caller that has just changed one.
 */
export function getNetworkRegistry(
  env: NodeJS.ProcessEnv = process.env,
  options: { now?: number; fresh?: boolean } = {},
): NetworkRegistry {
  const now = options.now ?? Date.now();
  const cacheable = env === process.env && options.fresh !== true;
  if (cacheable && cachedRegistry && now < cachedRegistry.expiresAt) return cachedRegistry.registry;

  const registry = buildNetworkRegistry(env, new Date(now));
  if (cacheable) cachedRegistry = { registry, expiresAt: now + NETWORK_REGISTRY_TTL_MS };
  return registry;
}

/** Drop the cached registry so the next read rediscovers the environment. */
export function invalidateNetworkRegistry(): void {
  cachedRegistry = null;
}

export type NetworkRegistryValidation = {
  registry: NetworkRegistry;
  /** Unavailable networks and ignored variables, said without any value. */
  problems: string[];
};

/**
 * Validate the registry once at startup.
 *
 * One bad network never invalidates the others: every problem is collected as a
 * sentence naming the variable, and the process keeps serving the networks that
 * did resolve.
 */
export function validateNetworkRegistry(env: NodeJS.ProcessEnv = process.env): NetworkRegistryValidation {
  const registry = buildNetworkRegistry(env);
  const problems = [
    ...registry.entries
      .filter(({ availability }) => availability === "unavailable")
      .map((entry) => `${entry.slug}: ${entry.reason ?? "unavailable"}`),
    ...registry.ignoredVariables.map((variable) => `${variable} ignored: beacon endpoints are not JSON-RPC`),
  ];
  return { registry, problems };
}
