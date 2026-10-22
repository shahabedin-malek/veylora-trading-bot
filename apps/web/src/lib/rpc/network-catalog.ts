/**
 * Public network metadata for chains that are not in the portfolio mainnet
 * allow-list: testnets, additional mainnets, and the non-EVM families Alchemy
 * serves.
 *
 * This file is *metadata*, never discovery: the registry in `./networks.ts`
 * only ever lists a network because an `ALCHEMY_<NETWORK>_*` variable exists in
 * the environment. A configured network with no entry here is still listed and
 * still proxied — it just reports that its chain id is unknown.
 *
 * Keep values here factual. An explorer URL is optional because a wrong link is
 * worse than no link; a chain id, however, is what lets the wallet be switched
 * and the registry's answer verified, so an uncertain chain id is omitted
 * rather than guessed.
 */

export type NetworkCatalogMetadata = {
  chainId: number;
  name: string;
  nativeSymbol: string;
  explorerUrl: string | null;
};

export const NETWORK_CATALOG: Readonly<Record<string, NetworkCatalogMetadata>> = {
  // ── Ethereum testnets ───────────────────────────────────────────────────────
  "ethereum-sepolia": { chainId: 11155111, name: "Ethereum Sepolia", nativeSymbol: "ETH", explorerUrl: "https://sepolia.etherscan.io" },
  "ethereum-hoodi": { chainId: 560048, name: "Ethereum Hoodi", nativeSymbol: "ETH", explorerUrl: null },

  // ── L2 testnets ─────────────────────────────────────────────────────────────
  "base-sepolia": { chainId: 84532, name: "Base Sepolia", nativeSymbol: "ETH", explorerUrl: "https://sepolia.basescan.org" },
  "arb-sepolia": { chainId: 421614, name: "Arbitrum Sepolia", nativeSymbol: "ETH", explorerUrl: "https://sepolia.arbiscan.io" },
  "opt-sepolia": { chainId: 11155420, name: "OP Sepolia", nativeSymbol: "ETH", explorerUrl: "https://sepolia-optimism.etherscan.io" },
  "zksync-sepolia": { chainId: 300, name: "ZKsync Sepolia", nativeSymbol: "ETH", explorerUrl: "https://sepolia.explorer.zksync.io" },
  "linea-sepolia": { chainId: 59141, name: "Linea Sepolia", nativeSymbol: "ETH", explorerUrl: "https://sepolia.lineascan.build" },
  "scroll-sepolia": { chainId: 534351, name: "Scroll Sepolia", nativeSymbol: "ETH", explorerUrl: "https://sepolia.scrollscan.com" },
  "mode-sepolia": { chainId: 919, name: "Mode Sepolia", nativeSymbol: "ETH", explorerUrl: "https://sepolia.explorer.mode.network" },
  "ink-sepolia": { chainId: 763373, name: "Ink Sepolia", nativeSymbol: "ETH", explorerUrl: "https://explorer-sepolia.inkonchain.com" },
  "unichain-sepolia": { chainId: 1301, name: "Unichain Sepolia", nativeSymbol: "ETH", explorerUrl: "https://sepolia.uniscan.xyz" },
  "soneium-minato": { chainId: 1946, name: "Soneium Minato", nativeSymbol: "ETH", explorerUrl: "https://explorer-testnet.soneium.org" },
  "abstract-testnet": { chainId: 11124, name: "Abstract Testnet", nativeSymbol: "ETH", explorerUrl: "https://explorer.testnet.abs.xyz" },
  "blast-sepolia": { chainId: 168587773, name: "Blast Sepolia", nativeSymbol: "ETH", explorerUrl: "https://testnet.blastscan.io" },
  "zora-sepolia": { chainId: 999999999, name: "Zora Sepolia", nativeSymbol: "ETH", explorerUrl: "https://sepolia.explorer.zora.energy" },
  "worldchain-sepolia": { chainId: 4801, name: "World Chain Sepolia", nativeSymbol: "ETH", explorerUrl: null },
  "berachain-bepolia": { chainId: 80069, name: "Berachain Bepolia", nativeSymbol: "BERA", explorerUrl: "https://bepolia.berascan.com" },
  "apechain-curtis": { chainId: 33111, name: "ApeChain Curtis", nativeSymbol: "APE", explorerUrl: "https://curtis.apescan.io" },
  "ronin-saigon": { chainId: 202601, name: "Ronin Saigon", nativeSymbol: "RON", explorerUrl: "https://saigon-explorer.roninchain.com" },
  "bob-sepolia": { chainId: 808813, name: "BOB Sepolia", nativeSymbol: "ETH", explorerUrl: null },
  "boba-sepolia": { chainId: 28882, name: "Boba Sepolia", nativeSymbol: "ETH", explorerUrl: null },
  "mantle-sepolia": { chainId: 5001, name: "Mantle Sepolia", nativeSymbol: "MNT", explorerUrl: "https://explorer.sepolia.mantle.xyz" },
  "citrea-testnet": { chainId: 5115, name: "Citrea Testnet", nativeSymbol: "cBTC", explorerUrl: "https://explorer.testnet.citrea.xyz" },
  "megaeth-testnet": { chainId: 6342, name: "MegaETH Testnet", nativeSymbol: "ETH", explorerUrl: null },
  "monad-testnet": { chainId: 10143, name: "Monad Testnet", nativeSymbol: "MON", explorerUrl: "https://testnet.monadscan.com" },
  "kaia-testnet": { chainId: 1001, name: "Kaia Kairos", nativeSymbol: "KAIA", explorerUrl: null },
  "lens-sepolia": { chainId: 37111, name: "Lens Testnet", nativeSymbol: "GRASS", explorerUrl: "https://explorer.testnet.lens.xyz" },
  "plasma-testnet": { chainId: 9746, name: "Plasma Testnet", nativeSymbol: "XPL", explorerUrl: null },
  "sei-testnet": { chainId: 1328, name: "Sei Testnet", nativeSymbol: "SEI", explorerUrl: null },
  "sonic-testnet": { chainId: 14601, name: "Sonic Testnet", nativeSymbol: "S", explorerUrl: "https://testnet.sonicscan.org" },
  "superseed-sepolia": { chainId: 53302, name: "Superseed Sepolia", nativeSymbol: "ETH", explorerUrl: "https://sepolia-explorer.superseed.xyz" },
  "xlayer-testnet": { chainId: 195, name: "X Layer Testnet", nativeSymbol: "OKB", explorerUrl: "https://www.okx.com/explorer/xlayer-test" },
  "zetachain-testnet": { chainId: 7001, name: "ZetaChain Testnet", nativeSymbol: "ZETA", explorerUrl: "https://testnet.zetascan.com" },
  "giwa-sepolia": { chainId: 91342, name: "GIWA Sepolia", nativeSymbol: "ETH", explorerUrl: null },

  // ── other EVM mainnets the account configures ───────────────────────────────
  "mantle-mainnet": { chainId: 5000, name: "Mantle", nativeSymbol: "MNT", explorerUrl: "https://explorer.mantle.xyz" },
  "moonbeam-mainnet": { chainId: 1284, name: "Moonbeam", nativeSymbol: "GLMR", explorerUrl: "https://moonbeam.moonscan.io" },
  "rootstock-mainnet": { chainId: 30, name: "Rootstock", nativeSymbol: "RBTC", explorerUrl: "https://explorer.rootstock.io" },
  "rootstock-testnet": { chainId: 31, name: "Rootstock Testnet", nativeSymbol: "tRBTC", explorerUrl: "https://explorer.testnet.rootstock.io" },
  "boba-mainnet": { chainId: 288, name: "Boba Network", nativeSymbol: "ETH", explorerUrl: "https://bobascan.com" },
  "bob-mainnet": { chainId: 60808, name: "BOB", nativeSymbol: "ETH", explorerUrl: "https://explorer.gobob.xyz" },
  "citrea-mainnet": { chainId: 4114, name: "Citrea", nativeSymbol: "cBTC", explorerUrl: "https://explorer.citrea.xyz" },
  "hyperliquid-mainnet": { chainId: 999, name: "HyperEVM", nativeSymbol: "HYPE", explorerUrl: "https://hyperevmscan.io" },
  "hyperliquid-testnet": { chainId: 998, name: "HyperEVM Testnet", nativeSymbol: "HYPE", explorerUrl: null },
  "kaia-mainnet": { chainId: 8217, name: "Kaia", nativeSymbol: "KAIA", explorerUrl: "https://kaiascan.io" },
  "lens-mainnet": { chainId: 232, name: "Lens Chain", nativeSymbol: "GRASS", explorerUrl: "https://explorer.lens.xyz" },
  "megaeth-mainnet": { chainId: 4326, name: "MegaETH", nativeSymbol: "ETH", explorerUrl: "https://megaexplorer.xyz" },
  "monad-mainnet": { chainId: 143, name: "Monad", nativeSymbol: "MON", explorerUrl: "https://monadscan.com" },
  "opbnb-mainnet": { chainId: 204, name: "opBNB", nativeSymbol: "BNB", explorerUrl: "https://opbnb.bscscan.com" },
  "opbnb-testnet": { chainId: 5611, name: "opBNB Testnet", nativeSymbol: "tBNB", explorerUrl: "https://opbnb-testnet.bscscan.com" },
  "plasma-mainnet": { chainId: 9745, name: "Plasma", nativeSymbol: "XPL", explorerUrl: null },
  "shape-mainnet": { chainId: 360, name: "Shape", nativeSymbol: "ETH", explorerUrl: "https://shapescan.xyz" },
  "superseed-mainnet": { chainId: 5330, name: "Superseed", nativeSymbol: "ETH", explorerUrl: "https://explorer.superseed.xyz" },
  "xlayer-mainnet": { chainId: 196, name: "X Layer", nativeSymbol: "OKB", explorerUrl: "https://www.okx.com/explorer/xlayer" },
  "zetachain-mainnet": { chainId: 7000, name: "ZetaChain", nativeSymbol: "ZETA", explorerUrl: "https://zetascan.io" },
  "arc-testnet": { chainId: 5042002, name: "Arc Testnet", nativeSymbol: "USDC", explorerUrl: null },
  "gnosis-chiado": { chainId: 10200, name: "Gnosis Chiado", nativeSymbol: "XDAI", explorerUrl: "https://gnosis-chiado.blockscout.com" },
  "avax-fuji": { chainId: 43113, name: "Avalanche Fuji", nativeSymbol: "AVAX", explorerUrl: "https://testnet.snowtrace.io" },
  "bnb-testnet": { chainId: 97, name: "BNB Testnet", nativeSymbol: "tBNB", explorerUrl: "https://testnet.bscscan.com" },
  "celo-sepolia": { chainId: 44787, name: "Celo Sepolia", nativeSymbol: "CELO", explorerUrl: "https://celo-sepolia.celoscan.io" },
  "cronos-testnet": { chainId: 338, name: "Cronos Testnet", nativeSymbol: "TCRO", explorerUrl: "https://testnet.cronoscan.com" },
  "polygon-amoy": { chainId: 80002, name: "Polygon Amoy", nativeSymbol: "POL", explorerUrl: "https://amoy.polygonscan.com" },
};

/**
 * Alchemy serves these families over their own native JSON-RPC, not Ethereum
 * JSON-RPC: the proxy still forwards to them, but no wallet chain switch or EVM
 * balance read is claimed for them.
 */
export const NON_EVM_NETWORK_PREFIXES: readonly string[] = [
  "solana",
  "bitcoin",
  "bitcoincash",
  "dogecoin",
  "litecoin",
  "aptos",
  "starknet",
  "stellar",
  "flow",
  "tron",
  "celestia",
];

export function isKnownNonEvmNetwork(slug: string): boolean {
  return NON_EVM_NETWORK_PREFIXES.some((prefix) => slug === prefix || slug.startsWith(`${prefix}-`));
}
