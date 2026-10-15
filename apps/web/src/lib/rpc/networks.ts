/**
 * Multi-network Alchemy RPC resolver.
 *
 * Networks are discovered from the environment at runtime: every variable named
 * `ALCHEMY_<NETWORK>_RPC_URL` counts as one enabled network. There is no
 * hand-maintained network list, so all configured networks work automatically —
 * today that is the full account-wide key's network set (150+).
 *
 * Server-only. Never import this from a client component: resolving a network
 * reads the key-bearing endpoint URL, which must never reach the browser.
 */

const NETWORK_ENV_PATTERN = /^ALCHEMY_([A-Z0-9]+(?:_[A-Z0-9]+)*)_RPC_URL$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 64;

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
 * Fallback hostnames used only when a network has no `ALCHEMY_<NET>_RPC_URL`
 * variable but the shared `ALCHEMY_API_KEY` is set. The per-network variable is
 * always preferred.
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

function envKeyForSlug(slug: string): string {
  return `ALCHEMY_${slug.toUpperCase().replace(/-/g, "_")}_RPC_URL`;
}

function slugFromEnvKey(key: string): string | null {
  const match = NETWORK_ENV_PATTERN.exec(key);
  return match ? match[1]!.toLowerCase().replace(/_/g, "-") : null;
}

/** Every configured network slug, sorted. Never returns endpoint values. */
export function listRpcNetworkSlugs(env: NodeJS.ProcessEnv = process.env): string[] {
  const slugs = new Set<string>();
  for (const key of Object.keys(env)) {
    const slug = slugFromEnvKey(key);
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

export type RpcNetworkResolution =
  | { ok: true; slug: string; endpoint: string }
  | { ok: false; reason: "invalid-network" | "unconfigured" };

/**
 * Resolve a network slug (or alias) to its key-bearing RPC endpoint. The
 * endpoint is returned only to server-side callers and is never logged.
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
  // `ALCHEMY_ETHEREUM_MAINNET_API_KEY` is accepted as a legacy shared-key fallback.
  const sharedKey = env.ALCHEMY_API_KEY ?? env.ALCHEMY_ETHEREUM_MAINNET_API_KEY;
  if (host && hasRealValue(sharedKey)) {
    return { ok: true, slug, endpoint: `https://${host}/v2/${encodeURIComponent(sharedKey.trim())}` };
  }
  return { ok: false, reason: "unconfigured" };
}
