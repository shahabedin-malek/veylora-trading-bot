import { getEvmMainnet } from "@/lib/portfolio/evm-mainnets";

/**
 * Human label for a configured auth chain id. Reuses the app's single
 * chain-id → name map (`lib/portfolio/evm-mainnets.ts`) and falls back to the raw
 * id for networks it has no name for, so sign-in copy can only ever name chains
 * that `AUTH_EVM_CHAIN_IDS` actually configures.
 */
export function evmChainLabel(chainId: number): string {
  return getEvmMainnet(chainId)?.name ?? `Chain ${chainId}`;
}

function byLabel(left: string, right: string): number {
  // Plain code-unit comparison: identical on the server and in the browser, unlike
  // `localeCompare`, whose result depends on the runtime's locale data.
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * "Ethereum Mainnet" · "Base and Ethereum Mainnet" · "Base, Ethereum Mainnet and
 * Polygon PoS" · "Base, Ethereum Mainnet and 4 more".
 *
 * Alphabetical, so the sentence reads the same however `AUTH_EVM_CHAIN_IDS` was
 * written and never leaks the env's ordering into user-facing copy.
 */
export function formatEvmChainList(chainIds: readonly number[]): string {
  const labels = chainIds.map(evmChainLabel).toSorted(byLabel);
  if (labels.length === 0) return "none";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  if (labels.length === 3) return `${labels[0]}, ${labels[1]} and ${labels[2]}`;
  return `${labels[0]}, ${labels[1]} and ${labels.length - 2} more`;
}

/**
 * The one sentence every sign-in surface uses, derived from the configured set
 * rather than from an assumed allow-list.
 */
export function describeAcceptedChains(chainIds: readonly number[]): string {
  return chainIds.length === 0
    ? "No EVM chain is configured for sign-in."
    : `Sign-in accepts ${formatEvmChainList(chainIds)}.`;
}
