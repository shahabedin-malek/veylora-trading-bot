import { isEip1193Provider, type Eip1193Provider } from "@/lib/auth/eip1193";

/**
 * Which injected wallets are actually here.
 *
 * The page used to offer one generic "connect" button that opened a modal
 * listing whatever the connector layer believed existed. With no extension
 * installed that button led nowhere usable and the page never said why. This
 * module answers the question from the page itself: which EIP-1193 providers are
 * present, which wallet each one is, and which of the mainstream wallets are
 * missing — the missing ones being reported with a way to get them rather than
 * rendered as a button that cannot work.
 *
 * Detection is self-reported by the wallets (their `isMetaMask`/`isRabby`/
 * `isCoinbaseWallet` flags) and is therefore *presentation only*: it decides
 * which name to show and which "install it" line to hide. It is never an input
 * to an authorisation decision — the server recovers the signer from the
 * signature and checks the chain inside the SIWE message.
 */

export type InjectedWalletKind =
  | "metamask"
  | "rabby"
  | "coinbase"
  | "brave"
  | "trust"
  | "okx"
  | "tokenpocket"
  | "frame"
  | "eip1193";

type WalletBrand = {
  kind: InjectedWalletKind;
  name: string;
  installUrl: string;
  /** Flag names to test on a provider, most specific first. */
  flags: readonly string[];
  /** Reported as missing when absent, because sign-in should name a way forward. */
  mainstream: boolean;
};

/**
 * Order matters: Rabby sets `isMetaMask` as well as `isRabby`, and older
 * Coinbase Wallet and Brave builds set `isMetaMask` too. A provider is named by
 * its most specific flag, so testing these in order is what makes the label on
 * screen the wallet the user actually installed.
 */
const WALLET_BRANDS: readonly WalletBrand[] = [
  { kind: "rabby", name: "Rabby", installUrl: "https://rabby.io/", flags: ["isRabby"], mainstream: true },
  { kind: "coinbase", name: "Coinbase Wallet", installUrl: "https://www.coinbase.com/wallet/downloads", flags: ["isCoinbaseWallet", "isCoinbaseBrowser"], mainstream: true },
  { kind: "brave", name: "Brave Wallet", installUrl: "https://brave.com/wallet/", flags: ["isBraveWallet"], mainstream: false },
  { kind: "trust", name: "Trust Wallet", installUrl: "https://trustwallet.com/browser-extension", flags: ["isTrust", "isTrustWallet"], mainstream: false },
  { kind: "okx", name: "OKX Wallet", installUrl: "https://www.okx.com/web3", flags: ["isOkxWallet", "isOKExWallet"], mainstream: false },
  { kind: "tokenpocket", name: "TokenPocket", installUrl: "https://www.tokenpocket.pro/en/download/extension", flags: ["isTokenPocket"], mainstream: false },
  { kind: "frame", name: "Frame", installUrl: "https://frame.sh/", flags: ["isFrame"], mainstream: false },
  { kind: "metamask", name: "MetaMask", installUrl: "https://metamask.io/download/", flags: ["isMetaMask"], mainstream: true },
];

const GENERIC_WALLET: WalletBrand = {
  kind: "eip1193",
  name: "Browser wallet",
  installUrl: "",
  flags: [],
  mainstream: false,
};

export type DetectedInjectedWallet = {
  kind: InjectedWalletKind;
  name: string;
  provider: Eip1193Provider;
  /** The self-reported flags that matched, for the "detected" line on screen. */
  flags: readonly string[];
};

export type MissingInjectedWallet = {
  kind: InjectedWalletKind;
  name: string;
  installUrl: string;
};

export type WalletDiscovery = {
  detected: readonly DetectedInjectedWallet[];
  missing: readonly MissingInjectedWallet[];
};

/** What a page renders before it has looked, and on the server. */
export const EMPTY_INJECTED_WALLETS: WalletDiscovery = { detected: [], missing: [] };

function brandFor(provider: Eip1193Provider): WalletBrand {
  const matched = WALLET_BRANDS.find((brand) => brand.flags.some((flag) => provider[flag] === true));
  return matched ?? GENERIC_WALLET;
}

/**
 * Every EIP-1193 provider reachable from the page's global scope.
 *
 * Read the way wallets actually inject. When `window.ethereum.providers` is a
 * non-empty array it is authoritative — that array is what EIP-5749-capable
 * wallets publish so that several can coexist, and the top-level object is then
 * only a legacy alias onto one of its entries. Adding that alias as well would
 * list the same wallet twice, so it is used alone when there is no array.
 * Coinbase Wallet's separate `window.coinbaseWalletExtension` and Rabby's
 * `window.rabby.ethereum` are read too, and a provider reachable by two paths is
 * one wallet rather than two, so candidates are de-duplicated by identity.
 */
function providerCandidates(scope: unknown): Eip1193Provider[] {
  if (typeof scope !== "object" || scope === null) return [];
  const record = scope as Record<string, unknown>;
  const ethereum = record.ethereum;
  const listed = isEip1193Provider(ethereum) && Array.isArray(ethereum.providers) ? ethereum.providers : [];

  const candidates = [
    ...(listed.length > 0 ? listed : [ethereum]),
    record.coinbaseWalletExtension,
    typeof record.rabby === "object" && record.rabby !== null ? (record.rabby as Record<string, unknown>).ethereum : undefined,
  ];

  const providers: Eip1193Provider[] = [];
  for (const candidate of candidates) {
    if (!isEip1193Provider(candidate) || providers.includes(candidate)) continue;
    providers.push(candidate);
  }
  return providers;
}

/**
 * What is installed right now.
 *
 * A wallet that is not installed is reported in `missing` only if it is
 * mainstream, so the page can say "MetaMask was not detected — install it" for
 * the three wallets sign-in is documented to support, without listing every
 * wallet in the catalogue as an absence.
 */
export function discoverInjectedWallets(scope: unknown): WalletDiscovery {
  const detected: DetectedInjectedWallet[] = [];
  for (const provider of providerCandidates(scope)) {
    const brand = brandFor(provider);
    detected.push({
      kind: brand.kind,
      name: brand.name,
      provider,
      flags: brand.flags.filter((flag) => provider[flag] === true),
    });
  }

  const present = new Set(detected.map((wallet) => wallet.kind));
  const missing = WALLET_BRANDS
    .filter((brand) => brand.mainstream && !present.has(brand.kind))
    .map((brand) => ({ kind: brand.kind, name: brand.name, installUrl: brand.installUrl }));

  return { detected, missing };
}

// The page reads the wallet list as an external store (`useSyncExternalStore`),
// so the same snapshot object has to come back until the injected providers
// actually change — a fresh object each read would re-render forever. Providers
// are stable objects for the life of the page, so comparing identity in order
// is enough to tell "unchanged" from "a wallet was added or removed".
let snapshotCache: { providers: readonly Eip1193Provider[]; discovery: WalletDiscovery } | null = null;

/** The wallet list, identical until the injected providers change. */
export function injectedWalletsSnapshot(scope: unknown): WalletDiscovery {
  const providers = providerCandidates(scope);
  if (
    snapshotCache &&
    snapshotCache.providers.length === providers.length &&
    snapshotCache.providers.every((provider, index) => provider === providers[index])
  ) {
    return snapshotCache.discovery;
  }
  const discovery = discoverInjectedWallets(scope);
  snapshotCache = { providers, discovery };
  return discovery;
}

/**
 * Watch for the page's wallets changing.
 *
 * Two events matter: `ethereum#initialized`, which a wallet dispatches when it
 * injects *after* the page loaded (the case a plain read on mount would miss),
 * and a return to the tab, after which an extension may have been enabled or
 * removed while the page sat in the background. Both are rare; neither is
 * required for a wallet that was there from the start.
 */
export function subscribeToInjectedWallets(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const ethereum = (window as { ethereum?: { on?: (event: string, listener: () => void) => void; removeListener?: (event: string, listener: () => void) => void } }).ethereum;
  const onVisibilityChange = () => onChange();

  ethereum?.on?.("ethereum#initialized", onChange);
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    ethereum?.removeListener?.("ethereum#initialized", onChange);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

/**
 * Re-resolve one wallet at the moment it is used.
 *
 * A wallet can be removed, updated or disabled between the page rendering and
 * the user pressing the button — and its provider object can be replaced by a
 * fresh injection. Holding the discovery result from render time would then
 * either sign nothing at all or sign against a stale provider, so the flow
 * re-runs detection and reports a missing provider as its own outcome.
 */
export function findInjectedWallet(scope: unknown, kind: InjectedWalletKind): Eip1193Provider | null {
  const { detected } = discoverInjectedWallets(scope);
  return detected.find((wallet) => wallet.kind === kind)?.provider ?? null;
}

/** The label a wallet's connect control shows. */
export function walletConnectLabel(wallet: DetectedInjectedWallet, connected: boolean): string {
  return connected ? `Sign in with ${wallet.name}` : `Connect ${wallet.name}`;
}
