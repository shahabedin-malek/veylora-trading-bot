/**
 * The injected wallet port: the four EIP-1193 calls sign-in actually makes, and
 * nothing else.
 *
 * Sign-in used to go through `wagmi`'s React hooks, which meant the wallet was
 * only reachable from a rendered component and the flow could not be exercised
 * without a browser and a real extension. Every wallet call now goes through
 * this file against a provider object the caller supplies, so the same code
 * runs against MetaMask, Rabby, Coinbase Wallet or a test double.
 *
 * Nothing here trusts what the provider says about itself: the chain is read
 * back after a switch request rather than taken from the request, and the
 * address is normalised before it is used. The server re-derives all of it
 * anyway (`src/lib/auth/siwe.ts` recovers the signer from the signature and
 * checks the chain inside the SIWE message), so a lying provider cannot choose
 * its own identity.
 */

export type Eip1193RequestArguments = { method: string; params?: readonly unknown[] | Record<string, unknown> };

/**
 * The subset of EIP-1193 this application uses, plus the flags wallets use to
 * announce themselves (all optional, all self-reported — see
 * `wallet-providers.ts` for how they are read).
 */
export type Eip1193Provider = {
  request: (args: Eip1193RequestArguments) => Promise<unknown>;
  providers?: readonly unknown[];
  isMetaMask?: boolean;
  isRabby?: boolean;
  isCoinbaseWallet?: boolean;
  isBraveWallet?: boolean;
  isTrust?: boolean;
  isFrame?: boolean;
  isOkxWallet?: boolean;
  isTokenPocket?: boolean;
  isZerion?: boolean;
  isStatus?: boolean;
  on?: (event: string, listener: (...args: never[]) => void) => void;
  removeListener?: (event: string, listener: (...args: never[]) => void) => void;
  [flag: string]: unknown;
};

/** The EIP-1193 / EIP-1474 codes the flow branches on. */
export const EIP1193_ERROR_CODES = {
  USER_REJECTED: 4001,
  UNAUTHORIZED: 4100,
  UNSUPPORTED_METHOD: 4200,
  DISCONNECTED: 4900,
  CHAIN_DISCONNECTED: 4901,
  UNRECOGNIZED_CHAIN: 4902,
} as const;

export function isEip1193Provider(value: unknown): value is Eip1193Provider {
  return typeof value === "object" && value !== null && typeof (value as { request?: unknown }).request === "function";
}

export function toHexChainId(chainId: number): `0x${string}` {
  return `0x${chainId.toString(16)}`;
}

// `BigInt` is not in the TS target here, so the accepted shapes are the two a
// provider actually sends: a number, or the hex string `eth_chainId` returns.
/** `0x1`, `0x01`, `"1"` and `1` all mean chain 1. Returns null for anything else. */
export function parseChainId(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  const parsed = /^0x[0-9a-f]+$/i.test(text) ? Number.parseInt(text.slice(2), 16) : Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Ask the wallet for its accounts. This is the one call that shows the
 * wallet's own connect prompt, so it is also the call a user most often
 * cancels — the caller classifies that as a cancelled prompt, not a failure.
 */
export async function requestWalletAccounts(provider: Eip1193Provider): Promise<string> {
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
    throw new Error("The wallet did not return an account.");
  }
  return accounts[0];
}

/** The chain the wallet is actually on, read from the wallet rather than a cache. */
export async function readWalletChainId(provider: Eip1193Provider): Promise<number> {
  const chainId = parseChainId(await provider.request({ method: "eth_chainId" }));
  if (chainId === null) throw new Error("The wallet did not report a network.");
  return chainId;
}

/**
 * `personal_sign`, whose de-facto parameter order is `[message, address]`.
 *
 * `params` is sent as an array, which is what every injected wallet accepts;
 * viem's `signMessage` sends `[message, address]` too.
 */
export async function signWalletMessage(
  provider: Eip1193Provider,
  input: { message: string; address: string },
): Promise<string> {
  const signature = await provider.request({
    method: "personal_sign",
    params: [input.message, input.address],
  });
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error("The wallet did not return a signature.");
  }
  return signature;
}

/**
 * Ask the wallet to move to `chainId` **and read back where it ended up**.
 *
 * The read-back is the point. `wallet_switchEthereumChain` resolving means the
 * request was accepted, not that the wallet is on the chain: some wallets
 * resolve before their state settles, and a queued account change can land
 * after it. This function therefore returns the chain the wallet reports
 * *afterwards*, and the caller compares it against what it asked for instead of
 * assuming the switch worked.
 *
 * Throws the provider's own error (classification happens in `wallet-errors.ts`).
 */
export async function switchWalletChain(
  provider: Eip1193Provider,
  chainId: number,
): Promise<{ requestedChainId: number; reachedChainId: number }> {
  await provider.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: toHexChainId(chainId) }],
  });
  return { requestedChainId: chainId, reachedChainId: await readWalletChainId(provider) };
}

/**
 * The numeric `code` a thrown provider error carries, when it carries one.
 *
 * Wallets disagree about how faithfully they reproduce EIP-1193: MetaMask and
 * Rabby throw `{ code: 4001 }`, Coinbase Wallet has thrown a plain `Error`
 * whose message says "User denied", and viem's wrappers add their own named
 * error classes on top. All of that is handled in `wallet-errors.ts`.
 */
export function providerErrorCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "number") return code;
  if (typeof code === "string" && /^-?\d+$/.test(code)) return Number(code);
  return null;
}
