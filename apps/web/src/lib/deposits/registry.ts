/**
 * The networks a deposit can arrive on, and the token expected on each.
 *
 * This is the *default* registry: it is what the deployment knows before the
 * owner configures anything, and it is deliberately small. Every entry names the
 * chain the address lives on, the Alchemy network slug the chain reads go
 * through (the same slugs `src/lib/rpc/networks.ts` resolves), a sensible default
 * confirmation count, and the USDT contract this project treats as the deposit
 * token there.
 *
 * Two things this file refuses to do, because both would mislead an owner about
 * their own money:
 *
 *  - **It does not call every USDT "Tether-issued USDT".** Only Ethereum mainnet
 *    carries the contract Tether issues and redeems. On Base the token is
 *    BaseScan's *Bridged Tether USD*, on BNB Smart Chain it is Binance-Peg
 *    BSC-USD (and it has **18** decimals, not 6), and on Arbitrum One and
 *    Polygon PoS the USDT listed under these addresses is the bridged **USDT0**
 *    representation. Each entry therefore states what the token actually is in
 *    `note`, and the UI shows that note next to the address. The addresses and
 *    decimals come from the explorer/Tether documentation pages listed in
 *    `proof/phase-12-deposits-and-crediting.md`.
 *
 *  - **It does not invent a testnet token.** No official Tether deployment
 *    exists on Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia or Polygon Amoy,
 *    so those entries ship with `token: null` and the deployment names the
 *    variable the owner must set (`DEPOSIT_TOKEN_ADDRESS_<SLUG>`) rather than
 *    pointing at a contract that merely calls itself USDT.
 *
 * The confirmation counts are *defaults for this project's own policy*, not
 * claims about how many confirmations any venue considers final: they are the
 * starting point the owner overrides per network with
 * `DEPOSIT_CONFIRMATIONS_<SLUG>`. The deposit minimum is a dust guard for the
 * same reason — a transfer below it is recorded and never credited.
 */

export type DepositTokenDefault = {
  /** The ticker an owner recognises. */
  symbol: string;
  /** What the token actually is on this chain, in the owner's words. */
  displayName: string;
  address: string;
  decimals: number;
  /** The issuer/bridge qualification, when the ticker alone would overstate it. */
  note?: string;
};

export type DepositNetworkDefault = {
  /** The slug used everywhere: settings, addresses, deposits, the API. */
  slug: string;
  chainId: number;
  /** The Alchemy network slug this chain's reads resolve through. */
  alchemyNetwork: string;
  /** The chain's own name. */
  displayName: string;
  /** The chain's native coin, for the "the native coin arrived, not USDT" case. */
  nativeSymbol: string;
  /** The default confirmation count, before the owner's own number applies. */
  defaultConfirmations: number;
  /** The token expected on this chain, or null when none is known. */
  token: DepositTokenDefault | null;
  /** Testnet entries are marked so the UI can say so. */
  testnet: boolean;
};

export const DEPOSIT_NETWORKS: readonly DepositNetworkDefault[] = [
  {
    slug: "ethereum-mainnet",
    chainId: 1,
    alchemyNetwork: "ethereum-mainnet",
    displayName: "Ethereum Mainnet",
    nativeSymbol: "ETH",
    defaultConfirmations: 12,
    testnet: false,
    token: {
      symbol: "USDT",
      displayName: "Tether USD",
      address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      decimals: 6,
    },
  },
  {
    slug: "base-mainnet",
    chainId: 8453,
    alchemyNetwork: "base-mainnet",
    displayName: "Base",
    nativeSymbol: "ETH",
    defaultConfirmations: 15,
    testnet: false,
    token: {
      symbol: "USDT",
      displayName: "Bridged Tether USD on Base",
      address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      decimals: 6,
      note: "Bridged, not issued or redeemed by Tether.",
    },
  },
  {
    slug: "arb-mainnet",
    chainId: 42161,
    alchemyNetwork: "arb-mainnet",
    displayName: "Arbitrum One",
    nativeSymbol: "ETH",
    defaultConfirmations: 15,
    testnet: false,
    token: {
      symbol: "USDT0",
      displayName: "USDT0 on Arbitrum One",
      address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      decimals: 6,
      note: "The bridged USDT0 representation; Arbitrum's explorer lists this contract as USD₮0.",
    },
  },
  {
    slug: "opt-mainnet",
    chainId: 10,
    alchemyNetwork: "opt-mainnet",
    displayName: "OP Mainnet",
    nativeSymbol: "ETH",
    defaultConfirmations: 15,
    testnet: false,
    token: {
      symbol: "USDT",
      displayName: "Tether USD on OP Mainnet",
      address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
      decimals: 6,
      note: "A bridged representation on Optimism, not a Tether-issued contract.",
    },
  },
  {
    slug: "polygon-mainnet",
    chainId: 137,
    alchemyNetwork: "polygon-mainnet",
    displayName: "Polygon PoS",
    nativeSymbol: "POL",
    defaultConfirmations: 128,
    testnet: false,
    token: {
      symbol: "USDT0",
      displayName: "USDT0 on Polygon PoS",
      address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
      decimals: 6,
      note: "Polygon upgraded this USDT to native USDT0; the old bridge contract is disabled.",
    },
  },
  {
    slug: "bnb-mainnet",
    chainId: 56,
    alchemyNetwork: "bnb-mainnet",
    displayName: "BNB Smart Chain",
    nativeSymbol: "BNB",
    defaultConfirmations: 15,
    testnet: false,
    token: {
      symbol: "USDT",
      displayName: "Binance-Peg BSC-USD",
      address: "0x55d398326f99059fF775485246999027B3197955",
      decimals: 18,
      note: "Binance-Peg, not Tether-issued, and 18 decimals rather than USDT's usual 6.",
    },
  },
  {
    slug: "ethereum-sepolia",
    chainId: 11155111,
    alchemyNetwork: "ethereum-sepolia",
    displayName: "Ethereum Sepolia",
    nativeSymbol: "ETH",
    defaultConfirmations: 3,
    testnet: true,
    token: null,
  },
  {
    slug: "base-sepolia",
    chainId: 84532,
    alchemyNetwork: "base-sepolia",
    displayName: "Base Sepolia",
    nativeSymbol: "ETH",
    defaultConfirmations: 3,
    testnet: true,
    token: null,
  },
  {
    slug: "arb-sepolia",
    chainId: 421614,
    alchemyNetwork: "arb-sepolia",
    displayName: "Arbitrum Sepolia",
    nativeSymbol: "ETH",
    defaultConfirmations: 3,
    testnet: true,
    token: null,
  },
  {
    slug: "polygon-amoy",
    chainId: 80002,
    alchemyNetwork: "polygon-amoy",
    displayName: "Polygon Amoy",
    nativeSymbol: "POL",
    defaultConfirmations: 3,
    testnet: true,
    token: null,
  },
];

/** The slug pattern the registry, the environment and the database all agree on. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isDepositNetworkSlug(value: string): boolean {
  return SLUG_PATTERN.test(value) && value.length <= 64;
}

/** Look a network up by slug. Aliases are deliberately not accepted here. */
export function getDepositNetwork(slug: string): DepositNetworkDefault | null {
  return DEPOSIT_NETWORKS.find((network) => network.slug === slug) ?? null;
}

export function depositNetworkDisplayName(slug: string): string {
  return getDepositNetwork(slug)?.displayName ?? slug;
}

/**
 * Networks that are usable without the owner configuring a token: the mainnets
 * whose deposit token this project already knows. Testnets are absent because
 * nobody can say from this file which contract an owner's test token lives at.
 */
export const DEFAULT_ENABLED_DEPOSIT_NETWORKS: readonly string[] = DEPOSIT_NETWORKS
  .filter((network) => !network.testnet && network.token !== null)
  .map((network) => network.slug);

/**
 * Where an owner can look at the address and the transfer for themselves.
 *
 * This matters more for deposits than anywhere else in the project: the one
 * question a person with money in flight asks is "is it really there?", and the
 * only answer they should have to accept from us is a link to the chain. The
 * panel therefore links every recorded hash, and the link is built here rather
 * than pasted into a component so a network added to the registry above only has
 * to name its explorer once.
 *
 * A slug with no explorer listed returns null, and the panel shows the hash as
 * text — an absent explorer is not a reason to hide the hash.
 */
export const DEPOSIT_EXPLORERS: Record<string, { base: string; name: string }> = {
  "ethereum-mainnet": { base: "https://etherscan.io", name: "Etherscan" },
  "base-mainnet": { base: "https://basescan.org", name: "BaseScan" },
  "arb-mainnet": { base: "https://arbiscan.io", name: "Arbiscan" },
  "opt-mainnet": { base: "https://optimistic.etherscan.io", name: "OP Etherscan" },
  "polygon-mainnet": { base: "https://polygonscan.com", name: "PolygonScan" },
  "bnb-mainnet": { base: "https://bscscan.com", name: "BscScan" },
  "ethereum-sepolia": { base: "https://sepolia.etherscan.io", name: "Sepolia Etherscan" },
  "base-sepolia": { base: "https://sepolia.basescan.org", name: "Base Sepolia Scan" },
  "arb-sepolia": { base: "https://sepolia.arbiscan.io", name: "Arbiscan Sepolia" },
  "polygon-amoy": { base: "https://amoy.polygonscan.com", name: "PolygonScan Amoy" },
};

export function depositExplorer(slug: string): { base: string; name: string } | null {
  return DEPOSIT_EXPLORERS[slug] ?? null;
}

/** The explorer page for one recorded transfer, or null when the slug has no explorer. */
export function depositTransactionUrl(slug: string, txHash: string): string | null {
  const explorer = depositExplorer(slug);
  return explorer ? `${explorer.base}/tx/${txHash}` : null;
}

/** The explorer page for one address, or null when the slug has no explorer. */
export function depositAddressUrl(slug: string, address: string): string | null {
  const explorer = depositExplorer(slug);
  return explorer ? `${explorer.base}/address/${address}` : null;
}
