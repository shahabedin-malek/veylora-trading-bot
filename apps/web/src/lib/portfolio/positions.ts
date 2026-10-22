/**
 * Holdings and totals, as values rather than renderings.
 *
 * Every figure here is a reading: it carries the network it came from, the
 * provider that answered, and the moment of the answer. Nothing is priced —
 * phase 19 owns market pricing — so a "total" is exact amounts of each asset
 * plus the count of holdings, not a currency figure this phase cannot honestly
 * produce. A partial read is expressed as `missing`, never as a smaller total
 * presented as complete.
 *
 * Arithmetic is exact: raw amounts are decimal strings in base units, formatting
 * goes through viem's `formatUnits`, and sums go through `decimal.js`. No float
 * touches an amount.
 */
import Decimal from "decimal.js";
import { formatUnits } from "viem";
import type { EvmMainnet } from "@/lib/portfolio/evm-mainnets";
import { normalizeChecksummedAddress } from "@/lib/portfolio/ethereum-token-allowlist";
import { assessToken, type ResolvedTokenMetadata } from "@/lib/portfolio/tokens";

export const PORTFOLIO_PROVIDER_ID = "alchemy-rpc";

export type PortfolioHolding = {
  network: string;
  networkName: string;
  chainId: number;
  assetType: "native" | "token";
  /** Checksummed contract address, null for the native asset. */
  contractAddress: string | null;
  symbol: string;
  name: string | null;
  decimals: number;
  /** Base units, as the chain returned them. */
  rawAmount: string;
  /** Exact decimal rendering of `rawAmount`. */
  formattedAmount: string;
  allowListed: boolean;
  suspectedSpam: boolean;
  markers: string[];
  /** Where the holding was read. */
  providerId: string;
  readAt: string;
  explorerUrl: string | null;
};

export type AssetTotal = {
  symbol: string;
  decimals: number;
  amount: string;
};

export type NetworkPortfolio = {
  network: string;
  networkName: string;
  chainId: number;
  status: "available" | "unavailable" | "timeout";
  reason: string | null;
  holdings: PortfolioHolding[];
  totals: {
    holdings: number;
    byAsset: AssetTotal[];
  };
  providerId: string | null;
  readAt: string;
  /** Tokens discovered beyond the display cap; reported, never dropped silently. */
  truncated: number;
  metadata: "cache-hit" | "cache-miss" | "cache-unavailable" | null;
  warnings: string[];
};

export type PortfolioSummary = {
  readAt: string;
  networks: number;
  answered: number;
  complete: boolean;
  missing: { network: string; networkName: string; chainId: number; reason: string }[];
  totals: {
    holdings: number;
    byAsset: AssetTotal[];
  };
};

export type RawTokenHolding = {
  contractAddress: string;
  rawAmount: string;
  metadata: ResolvedTokenMetadata;
};

function positiveRaw(value: string): boolean {
  return /^\d+$/.test(value) && BigInt(value) > BigInt(0);
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function assetKey(symbol: string, decimals: number): string {
  return `${symbol.toUpperCase()}::${decimals}`;
}

export function totalsFor(holdings: readonly PortfolioHolding[]): NetworkPortfolio["totals"] {
  const byAsset = new Map<string, AssetTotal>();
  for (const holding of holdings) {
    const key = assetKey(holding.symbol, holding.decimals);
    const existing = byAsset.get(key);
    if (existing) {
      existing.amount = new Decimal(existing.amount).plus(holding.formattedAmount).toString();
    } else {
      byAsset.set(key, {
        symbol: holding.symbol,
        decimals: holding.decimals,
        amount: holding.formattedAmount,
      });
    }
  }
  return {
    holdings: holdings.length,
    byAsset: [...byAsset.values()].sort((left, right) => left.symbol.localeCompare(right.symbol) || left.decimals - right.decimals),
  };
}

/**
 * The aggregate of the rows that answered, plus the rows that did not.
 *
 * `complete` is a fact about coverage, not about totals: a missing network means
 * the aggregate is a floor and the summary says so.
 */
export function summarizePortfolio(networks: readonly NetworkPortfolio[], readAt: string): PortfolioSummary {
  const answered = networks.filter(({ status }) => status === "available");
  const merged = new Map<string, AssetTotal>();
  for (const row of answered) {
    for (const asset of row.totals.byAsset) {
      const key = assetKey(asset.symbol, asset.decimals);
      const existing = merged.get(key);
      if (existing) existing.amount = new Decimal(existing.amount).plus(asset.amount).toString();
      else merged.set(key, { ...asset });
    }
  }
  const missing = networks
    .filter(({ status }) => status !== "available")
    .map((row) => ({
      network: row.network,
      networkName: row.networkName,
      chainId: row.chainId,
      reason: row.reason ?? `${row.networkName} did not answer.`,
    }));

  return {
    readAt,
    networks: networks.length,
    answered: answered.length,
    complete: networks.length > 0 && missing.length === 0,
    missing,
    totals: {
      holdings: answered.reduce((sum, row) => sum + row.holdings.length, 0),
      byAsset: [...merged.values()].sort(
        (left, right) => left.symbol.localeCompare(right.symbol) || left.decimals - right.decimals,
      ),
    },
  };
}

/**
 * One holding, or null when there is nothing to show.
 *
 * A zero balance is not a holding. A token with no resolved decimals is still a
 * holding: it is shown in raw units with a marker, because an address we can see
 * is more useful than a token that disappeared.
 */
export function buildHolding(input: {
  network: EvmMainnet;
  readAt: string;
  native?: { rawAmount: string; symbol: string; decimals: number };
  token?: Omit<RawTokenHolding, "metadata"> & { metadata: ResolvedTokenMetadata };
  allowListed?: boolean;
}): PortfolioHolding | null {
  const base = {
    network: input.network.alchemyNetwork,
    networkName: input.network.name,
    chainId: input.network.chainId,
    providerId: PORTFOLIO_PROVIDER_ID,
    readAt: input.readAt,
    explorerUrl: input.network.explorerUrl,
  };

  if (input.native) {
    if (!positiveRaw(input.native.rawAmount)) return null;
    const decimals = input.native.decimals;
    if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) return null;
    return {
      ...base,
      assetType: "native",
      contractAddress: null,
      symbol: input.native.symbol,
      name: null,
      decimals,
      rawAmount: input.native.rawAmount,
      formattedAmount: formatUnits(BigInt(input.native.rawAmount), decimals),
      allowListed: true,
      suspectedSpam: false,
      markers: [],
    };
  }

  const token = input.token;
  if (!token) return null;
  const contractAddress = normalizeChecksummedAddress(token.contractAddress);
  if (!contractAddress) return null;
  if (!positiveRaw(token.rawAmount)) return null;

  const metadata = token.metadata;
  const decimals = metadata.decimals ?? 0;
  const assessment = assessToken({
    symbol: metadata.symbol,
    name: metadata.name,
    allowListed: input.allowListed === true,
    decimals: metadata.decimals,
  });
  const markers = [...assessment.markers];
  if (metadata.decimals === null) markers.push("decimals unavailable (shown in raw units)");
  if (metadata.stale) markers.push("metadata stale");

  const symbol = metadata.symbol ?? shortAddress(contractAddress);
  return {
    ...base,
    assetType: "token",
    contractAddress,
    symbol,
    name: metadata.name,
    decimals,
    rawAmount: token.rawAmount,
    formattedAmount: metadata.decimals === null
      ? token.rawAmount
      : formatUnits(BigInt(token.rawAmount), decimals),
    allowListed: assessment.allowListed,
    suspectedSpam: assessment.suspectedSpam,
    markers,
  };
}

/** Assemble one network's row from the chain's answer and its metadata. */
export function buildNetworkPortfolio(input: {
  network: EvmMainnet;
  status: NetworkPortfolio["status"];
  reason: string | null;
  readAt: string;
  native: { rawAmount: string; symbol: string; decimals: number } | null;
  tokens: readonly RawTokenHolding[];
  allowList: ReadonlySet<string>;
  truncated?: number;
  metadata?: NetworkPortfolio["metadata"];
  warnings?: string[];
}): NetworkPortfolio {
  const holdings: PortfolioHolding[] = [];
  if (input.status === "available") {
    const native = input.native
      ? buildHolding({ network: input.network, readAt: input.readAt, native: input.native })
      : null;
    if (native) holdings.push(native);

    for (const token of input.tokens) {
      const checksummed = normalizeChecksummedAddress(token.contractAddress);
      if (!checksummed) continue;
      const holding = buildHolding({
        network: input.network,
        readAt: input.readAt,
        token,
        allowListed: input.allowList.has(checksummed),
      });
      if (holding) holdings.push(holding);
    }
  }

  const available = input.status === "available";
  return {
    network: input.network.alchemyNetwork,
    networkName: input.network.name,
    chainId: input.network.chainId,
    status: input.status,
    reason: input.reason,
    holdings,
    totals: totalsFor(holdings),
    providerId: available ? PORTFOLIO_PROVIDER_ID : null,
    readAt: input.readAt,
    truncated: input.truncated ?? 0,
    metadata: input.metadata ?? null,
    warnings: input.warnings ?? [],
  };
}
