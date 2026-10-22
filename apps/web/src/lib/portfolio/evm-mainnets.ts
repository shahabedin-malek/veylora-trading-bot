export type EvmMainnet = {
  chainId: number;
  name: string;
  alchemyNetwork: string;
  nativeSymbol: string;
  explorerUrl: string;
};

/**
 * The EVM mainnets the portfolio page is allowed to read, in the order the
 * network allow-list shows them. This is the *portfolio* allow-list, not the RPC
 * registry: phase 17 discovers every configured network from the environment,
 * and `tokenAllowlist` in the registry is "listed" only for these.
 */
export const EVM_MAINNETS: readonly EvmMainnet[] = [
  { chainId: 1, name: "Ethereum Mainnet", alchemyNetwork: "eth-mainnet", nativeSymbol: "ETH", explorerUrl: "https://etherscan.io" },
  { chainId: 10, name: "OP Mainnet", alchemyNetwork: "opt-mainnet", nativeSymbol: "ETH", explorerUrl: "https://optimistic.etherscan.io" },
  { chainId: 56, name: "BNB Smart Chain", alchemyNetwork: "bnb-mainnet", nativeSymbol: "BNB", explorerUrl: "https://bscscan.com" },
  { chainId: 100, name: "Gnosis", alchemyNetwork: "gnosis-mainnet", nativeSymbol: "XDAI", explorerUrl: "https://gnosisscan.io" },
  { chainId: 137, name: "Polygon PoS", alchemyNetwork: "polygon-mainnet", nativeSymbol: "POL", explorerUrl: "https://polygonscan.com" },
  { chainId: 324, name: "ZKsync Era", alchemyNetwork: "zksync-mainnet", nativeSymbol: "ETH", explorerUrl: "https://explorer.zksync.io" },
  { chainId: 1088, name: "Metis", alchemyNetwork: "metis-mainnet", nativeSymbol: "METIS", explorerUrl: "https://andromeda-explorer.metis.io" },
  { chainId: 130, name: "Unichain", alchemyNetwork: "unichain-mainnet", nativeSymbol: "ETH", explorerUrl: "https://uniscan.xyz" },
  { chainId: 146, name: "Sonic", alchemyNetwork: "sonic-mainnet", nativeSymbol: "S", explorerUrl: "https://sonicscan.org" },
  { chainId: 480, name: "World Chain", alchemyNetwork: "worldchain-mainnet", nativeSymbol: "ETH", explorerUrl: "https://worldscan.org" },
  { chainId: 8453, name: "Base", alchemyNetwork: "base-mainnet", nativeSymbol: "ETH", explorerUrl: "https://basescan.org" },
  { chainId: 1868, name: "Soneium", alchemyNetwork: "soneium-mainnet", nativeSymbol: "ETH", explorerUrl: "https://soneium.blockscout.com" },
  { chainId: 2020, name: "Ronin", alchemyNetwork: "ronin-mainnet", nativeSymbol: "RON", explorerUrl: "https://explorer.roninchain.com" },
  { chainId: 2741, name: "Abstract", alchemyNetwork: "abstract-mainnet", nativeSymbol: "ETH", explorerUrl: "https://explorer.abs.xyz" },
  { chainId: 34443, name: "Mode", alchemyNetwork: "mode-mainnet", nativeSymbol: "ETH", explorerUrl: "https://explorer.mode.network" },
  { chainId: 42220, name: "Celo", alchemyNetwork: "celo-mainnet", nativeSymbol: "CELO", explorerUrl: "https://celoscan.io" },
  { chainId: 57073, name: "Ink", alchemyNetwork: "ink-mainnet", nativeSymbol: "ETH", explorerUrl: "https://explorer.inkonchain.com" },
  { chainId: 534352, name: "Scroll", alchemyNetwork: "scroll-mainnet", nativeSymbol: "ETH", explorerUrl: "https://scrollscan.com" },
  { chainId: 42161, name: "Arbitrum One", alchemyNetwork: "arb-mainnet", nativeSymbol: "ETH", explorerUrl: "https://arbiscan.io" },
  { chainId: 43114, name: "Avalanche C-Chain", alchemyNetwork: "avax-mainnet", nativeSymbol: "AVAX", explorerUrl: "https://snowtrace.io" },
  { chainId: 59144, name: "Linea", alchemyNetwork: "linea-mainnet", nativeSymbol: "ETH", explorerUrl: "https://lineascan.build" },
  { chainId: 81457, name: "Blast", alchemyNetwork: "blast-mainnet", nativeSymbol: "ETH", explorerUrl: "https://blastscan.io" },
  { chainId: 7777777, name: "Zora", alchemyNetwork: "zora-mainnet", nativeSymbol: "ETH", explorerUrl: "https://explorer.zora.energy" },
  { chainId: 80094, name: "Berachain", alchemyNetwork: "berachain-mainnet", nativeSymbol: "BERA", explorerUrl: "https://berascan.com" },
  { chainId: 33139, name: "ApeChain", alchemyNetwork: "apechain-mainnet", nativeSymbol: "APE", explorerUrl: "https://apescan.io" },
  { chainId: 1329, name: "Sei EVM", alchemyNetwork: "sei-mainnet", nativeSymbol: "SEI", explorerUrl: "https://seitrace.com" },
  { chainId: 25, name: "Cronos EVM", alchemyNetwork: "cronos-mainnet", nativeSymbol: "CRO", explorerUrl: "https://cronoscan.com" },
  { chainId: 1514, name: "Story", alchemyNetwork: "story-mainnet", nativeSymbol: "IP", explorerUrl: "https://explorer.story.foundation" },
  { chainId: 252, name: "Fraxtal", alchemyNetwork: "frax-mainnet", nativeSymbol: "FRAX", explorerUrl: "https://fraxscan.com" },
];

export const DEFAULT_EVM_MAINNET_CHAIN_ID = 1;
export const MAX_ADDITIONAL_EVM_MAINNETS = 8;

const networkByChainId = new Map(EVM_MAINNETS.map((network) => [network.chainId, network]));

export function getEvmMainnet(chainId: number): EvmMainnet | null {
  return networkByChainId.get(chainId) ?? null;
}

export function getAdditionalEvmMainnets(): readonly EvmMainnet[] {
  return EVM_MAINNETS
    .filter(({ chainId }) => chainId !== DEFAULT_EVM_MAINNET_CHAIN_ID)
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export function getEnabledEvmMainnetChainIds(additionalChainIds: readonly number[]): number[] | null {
  const knownChainIds = new Set(EVM_MAINNETS.map(({ chainId }) => chainId));
  if (additionalChainIds.length > MAX_ADDITIONAL_EVM_MAINNETS) return null;
  if (new Set(additionalChainIds).size !== additionalChainIds.length) return null;
  if (additionalChainIds.some((chainId) => chainId === DEFAULT_EVM_MAINNET_CHAIN_ID || !knownChainIds.has(chainId))) return null;
  return [DEFAULT_EVM_MAINNET_CHAIN_ID, ...additionalChainIds];
}
