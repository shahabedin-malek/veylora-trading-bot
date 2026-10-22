/**
 * Token metadata: cache-first resolution and the markers that make a token
 * inspectable instead of suspiciously absent.
 *
 * Metadata (symbol, name, decimals) is public chain fact, so it is cached in a
 * shared table for a freshness window. Two rules keep the cache from becoming a
 * dependency:
 *
 *  - a store that cannot be read is a **miss**, and a store that cannot be
 *    written is a warning — the provider's answer is still used;
 *  - a token whose metadata cannot be resolved is still returned, with its
 *    checksummed address and a marker, rather than omitted.
 *
 * Nothing here reads a balance or a secret. The only network call is the
 * caller-supplied reader.
 */
import { normalizeChecksummedAddress } from "@/lib/portfolio/ethereum-token-allowlist";

/** How long a cached row is treated as current. */
export const TOKEN_METADATA_FRESHNESS_MS = 24 * 60 * 60 * 1_000;

export type CachedTokenMetadata = {
  chainId: number;
  contractAddress: string;
  symbol: string | null;
  name: string | null;
  decimals: number;
  fetchedAt: Date;
  source: string;
};

export type ProviderTokenMetadata = {
  contractAddress: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
};

export type ResolvedTokenMetadata = {
  chainId: number;
  /** Checksummed, always present: this is what an unknown token is shown by. */
  contractAddress: string;
  symbol: string | null;
  name: string | null;
  /** Null when the provider did not answer and no cached row exists. */
  decimals: number | null;
  fetchedAt: string | null;
  source: "cache" | "provider" | "placeholder";
  /** True when a cached row was used past its freshness window because a refresh failed. */
  stale: boolean;
};

export type TokenMetadataStore = {
  read(input: { chainId: number; addresses: readonly string[] }): Promise<CachedTokenMetadata[]>;
  write(rows: readonly CachedTokenMetadata[]): Promise<void>;
};

export type TokenMetadataReader = (input: {
  chainId: number;
  addresses: readonly string[];
  signal?: AbortSignal;
}) => Promise<ProviderTokenMetadata[]>;

export type TokenMetadataResolution = {
  tokens: ResolvedTokenMetadata[];
  /** `hit` only when every requested address was served from a fresh row. */
  cache: "hit" | "miss" | "unavailable";
  warnings: string[];
};

function validDecimals(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 36 ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Resolve metadata for every address, cache first.
 *
 * `refresh` bypasses freshness (not the cache itself): the provider is asked for
 * every address and the answer is written back. A repeat call within the window
 * makes no reader call at all.
 */
export async function resolveTokenMetadata(input: {
  chainId: number;
  addresses: readonly string[];
  store: TokenMetadataStore;
  reader: TokenMetadataReader;
  now?: Date;
  freshnessMs?: number;
  refresh?: boolean;
  signal?: AbortSignal;
}): Promise<TokenMetadataResolution> {
  const now = input.now ?? new Date();
  const freshnessMs = input.freshnessMs ?? TOKEN_METADATA_FRESHNESS_MS;
  const warnings: string[] = [];

  const addresses: string[] = [];
  for (const candidate of input.addresses) {
    const checksummed = normalizeChecksummedAddress(candidate);
    if (!checksummed) {
      warnings.push(`A contract address (${String(candidate).slice(0, 42)}) was not a valid EVM address and was skipped.`);
      continue;
    }
    if (!addresses.includes(checksummed)) addresses.push(checksummed);
  }

  const wanted = new Set(addresses);
  let cachedRows: CachedTokenMetadata[] = [];
  let storeAvailable = true;
  try {
    cachedRows = (await input.store.read({ chainId: input.chainId, addresses })).filter(
      (row) => wanted.has(row.contractAddress) && row.chainId === input.chainId,
    );
  } catch {
    storeAvailable = false;
    warnings.push("The token metadata cache could not be read, so metadata was resolved from the chain provider.");
  }

  const fresh = new Map<string, CachedTokenMetadata>();
  const stale = new Map<string, CachedTokenMetadata>();
  for (const row of cachedRows) {
    const age = now.getTime() - row.fetchedAt.getTime();
    if (!input.refresh && age >= 0 && age < freshnessMs) fresh.set(row.contractAddress, row);
    else stale.set(row.contractAddress, row);
  }

  const needsProvider = input.refresh
    ? addresses
    : addresses.filter((address) => !fresh.has(address));

  const resolved = new Map<string, ResolvedTokenMetadata>();
  for (const address of addresses) {
    const hit = fresh.get(address);
    if (hit) {
      resolved.set(address, {
        chainId: input.chainId,
        contractAddress: address,
        symbol: hit.symbol,
        name: hit.name,
        decimals: hit.decimals,
        fetchedAt: hit.fetchedAt.toISOString(),
        source: "cache",
        stale: false,
      });
    }
  }

  if (needsProvider.length > 0) {
    let answered: ProviderTokenMetadata[] = [];
    try {
      answered = await input.reader({ chainId: input.chainId, addresses: needsProvider, ...(input.signal ? { signal: input.signal } : {}) });
    } catch {
      warnings.push(
        `Token metadata could not be refreshed for ${needsProvider.length} contract(s); ` +
          "cached or address-only entries are shown instead.",
      );
    }

    const writes: CachedTokenMetadata[] = [];
    for (const answer of answered) {
      const address = normalizeChecksummedAddress(answer.contractAddress);
      if (!address || !needsProvider.includes(address)) continue;
      const decimals = validDecimals(answer.decimals);
      if (decimals === null) {
        // No usable decimals: an address-only entry, still listed.
        resolved.set(address, {
          chainId: input.chainId,
          contractAddress: address,
          symbol: textOrNull(answer.symbol),
          name: textOrNull(answer.name),
          decimals: null,
          fetchedAt: now.toISOString(),
          source: "provider",
          stale: false,
        });
        continue;
      }
      resolved.set(address, {
        chainId: input.chainId,
        contractAddress: address,
        symbol: textOrNull(answer.symbol),
        name: textOrNull(answer.name),
        decimals,
        fetchedAt: now.toISOString(),
        source: "provider",
        stale: false,
      });
      writes.push({
        chainId: input.chainId,
        contractAddress: address,
        symbol: textOrNull(answer.symbol),
        name: textOrNull(answer.name),
        decimals,
        fetchedAt: now,
        source: "alchemy_getTokenMetadata",
      });
    }

    if (writes.length > 0 && storeAvailable) {
      try {
        await input.store.write(writes);
      } catch {
        warnings.push("Token metadata could not be cached; the provider's answer is still shown.");
      }
    }
  }

  // Anything still unresolved falls back to a stale row, then to the address.
  for (const address of addresses) {
    if (resolved.has(address)) continue;
    const previous = stale.get(address);
    if (previous) {
      resolved.set(address, {
        chainId: input.chainId,
        contractAddress: address,
        symbol: previous.symbol,
        name: previous.name,
        decimals: previous.decimals,
        fetchedAt: previous.fetchedAt.toISOString(),
        source: "cache",
        stale: true,
      });
      continue;
    }
    resolved.set(address, {
      chainId: input.chainId,
      contractAddress: address,
      symbol: null,
      name: null,
      decimals: null,
      fetchedAt: null,
      source: "placeholder",
      stale: false,
    });
  }

  const allFresh = addresses.length > 0 && addresses.every((address) => resolved.get(address)?.source === "cache");
  return {
    tokens: addresses.map((address) => resolved.get(address)!),
    cache: !storeAvailable ? "unavailable" : allFresh ? "hit" : "miss",
    warnings,
  };
}

export type TokenAssessment = {
  allowListed: boolean;
  suspectedSpam: boolean;
  markers: string[];
};

const URL_MARKER = /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|io|xyz|net|org|app|finance|site|top|vip)\b)/i;
const CLAIM_MARKER = /\b(?:claim|airdrop|reward|bonus|voucher|visit|giveaway|prize|winner|free)\b/i;
const SYMBOL_TEXT = /[a-z0-9]/i;

/**
 * The markers a holding carries. None of them removes the token: they are how a
 * token is inspected, including one that looks like spam.
 *
 * The allow-list is the owner's own statement of which contracts they care
 * about. Heuristics are deliberately conservative and textual (a URL in the
 * name, a claim phrase, an absurd symbol length) — a marker is a prompt to look,
 * not a verdict.
 */
export function assessToken(input: {
  symbol: string | null;
  name: string | null;
  allowListed: boolean;
  decimals: number | null;
}): TokenAssessment {
  const markers: string[] = [];
  const symbol = input.symbol?.trim() ?? "";
  const name = input.name?.trim() ?? "";
  const text = `${symbol} ${name}`.trim();

  if (!input.allowListed) markers.push("not in allow-list");
  if (!symbol) markers.push("symbol unavailable");
  if (input.decimals === null) markers.push("decimals unavailable");
  if (text && URL_MARKER.test(text)) markers.push("name or symbol contains a URL");
  if (text && CLAIM_MARKER.test(text)) markers.push("name or symbol contains a claim phrase");
  if (symbol.length > 20) markers.push("symbol is unusually long");
  if (name.length > 64) markers.push("name is unusually long");
  if (symbol && !SYMBOL_TEXT.test(symbol)) markers.push("symbol has no letters or digits");

  return {
    allowListed: input.allowListed,
    suspectedSpam: markers.some((marker) =>
      marker !== "not in allow-list" && marker !== "symbol unavailable" && marker !== "decimals unavailable",
    ),
    markers,
  };
}
