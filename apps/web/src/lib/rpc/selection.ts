/**
 * Selection rules for the network switcher, kept apart from the component so
 * they can be exercised without a browser or a wallet.
 *
 * Two facts are reconciled: what the user last selected, and what the wallet
 * actually reports. The wallet wins on load because it is the only side that
 * cannot be stale — a stored selection is a preference, the wallet's chain is
 * where the next signature would happen.
 */
import type { NetworkRegistryEntry } from "./networks";

export type NetworkSelection = {
  slug: string | null;
  entry: NetworkRegistryEntry | null;
  /** Why the selection is not what a stored preference asked for, if it is not. */
  notice: string | null;
};

function preferredEntry(entries: readonly NetworkRegistryEntry[]): NetworkRegistryEntry | null {
  return entries.find(({ slug, kind, availability }) => slug === "ethereum-mainnet" && kind === "evm" && availability === "available")
    ?? entries.find(({ kind, availability }) => kind === "evm" && availability === "available")
    ?? entries[0]
    ?? null;
}

export function entryForChain(entries: readonly NetworkRegistryEntry[], chainId: number | null): NetworkRegistryEntry | null {
  if (chainId === null) return null;
  return entries.find((entry) => entry.chainId === chainId) ?? null;
}

/**
 * Choose the network the switcher shows.
 *
 * `storedSlug` is the last explicit choice. If the wallet is on a chain the
 * registry knows, that chain is selected and the notice says why the stored
 * choice was not kept — the user asked to reconcile, not to be lied to about
 * where their wallet is.
 */
export function reconcileNetworkSelection(input: {
  entries: readonly NetworkRegistryEntry[];
  storedSlug: string | null;
  walletChainId: number | null;
}): NetworkSelection {
  const { entries, storedSlug, walletChainId } = input;
  if (entries.length === 0) {
    return {
      slug: null,
      entry: null,
      notice: "No Alchemy network variable is configured, so there is no network to switch to.",
    };
  }

  const walletEntry = entryForChain(entries, walletChainId);
  if (walletEntry) {
    const stored = entries.find(({ slug }) => slug === storedSlug) ?? null;
    return {
      slug: walletEntry.slug,
      entry: walletEntry,
      notice: stored && stored.slug !== walletEntry.slug
        ? `The wallet reports chain ${walletChainId}, so the selection follows the wallet to ${walletEntry.name}.`
        : null,
    };
  }

  const stored = entries.find(({ slug }) => slug === storedSlug) ?? null;
  const entry = stored ?? preferredEntry(entries);
  return {
    slug: entry?.slug ?? null,
    entry,
    notice: entry && walletChainId !== null && entry.chainId !== null && entry.chainId !== walletChainId
      ? `The wallet reports chain ${walletChainId}, but ${entry.name} is chain ${entry.chainId}. Switch the wallet to use it.`
      : null,
  };
}

/** Why a network cannot be handed to the wallet, or null when it can. */
export function selectionProblem(entry: NetworkRegistryEntry | null): string | null {
  if (!entry) return "No network is selected.";
  if (entry.availability === "unavailable") {
    return entry.reason ?? `${entry.variable} is not usable, so ${entry.name} cannot be selected.`;
  }
  if (entry.kind !== "evm" || entry.chainId === null) {
    return `${entry.name} has no EVM chain id in the registry, so the wallet cannot be switched to it. Its RPC endpoint is still reachable.`;
  }
  return null;
}

/** What to say after asking the wallet to move, comparing where it ended up. */
export function switchNotice(input: {
  requestedChainId: number;
  reachedChainId: number;
  name: string;
}): string | null {
  if (input.requestedChainId === input.reachedChainId) return null;
  return `The wallet reports chain ${input.reachedChainId} after the request to switch to ${input.name} (chain ${input.requestedChainId}); it did not change. Open the wallet, switch to ${input.name}, then retry.`;
}
