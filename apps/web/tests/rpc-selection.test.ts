import assert from "node:assert/strict";
import test from "node:test";
import type { NetworkRegistryEntry } from "@/lib/rpc/networks";
import { entryForChain, reconcileNetworkSelection, selectionProblem, switchNotice } from "@/lib/rpc/selection";

function entry(overrides: Partial<NetworkRegistryEntry> & { slug: string; chainId: number | null }): NetworkRegistryEntry {
  return {
    variable: `ALCHEMY_${overrides.slug.toUpperCase().replace(/-/g, "_")}_RPC_URL`,
    name: overrides.slug,
    kind: overrides.chainId === null ? "non-evm" : "evm",
    testnet: false,
    nativeSymbol: "ETH",
    explorerUrl: null,
    tokenAllowlist: overrides.chainId === null ? "not-applicable" : "not-listed",
    availability: "available",
    source: "rpc-url",
    problem: "none",
    reason: null,
    ...overrides,
  };
}

const ENTRIES: NetworkRegistryEntry[] = [
  entry({ slug: "ethereum-mainnet", chainId: 1, tokenAllowlist: "listed" }),
  entry({ slug: "base-mainnet", chainId: 8453, tokenAllowlist: "listed" }),
  entry({ slug: "solana-mainnet", chainId: null }),
  entry({
    slug: "arb-mainnet",
    chainId: 42161,
    availability: "unavailable",
    problem: "missing",
    reason: "ALCHEMY_ARB_MAINNET_RPC_URL is not set, so arb-mainnet is unavailable.",
  }),
];

test("the wallet's chain wins on load and says why the stored choice was not kept", () => {
  const selection = reconcileNetworkSelection({
    entries: ENTRIES,
    storedSlug: "ethereum-mainnet",
    walletChainId: 8453,
  });
  assert.equal(selection.slug, "base-mainnet");
  assert.equal(selection.entry?.chainId, 8453);
  assert.match(selection.notice ?? "", /selection follows the wallet to base-mainnet/);
});

test("a stored choice is kept when the wallet is on an unknown chain", () => {
  const selection = reconcileNetworkSelection({
    entries: ENTRIES,
    storedSlug: "base-mainnet",
    walletChainId: 999_999,
  });
  assert.equal(selection.slug, "base-mainnet");
  assert.match(selection.notice ?? "", /wallet reports chain 999999, but base-mainnet is chain 8453/);
});

test("with no stored choice and no wallet, the default mainnet is selected", () => {
  const selection = reconcileNetworkSelection({ entries: ENTRIES, storedSlug: null, walletChainId: null });
  assert.equal(selection.slug, "ethereum-mainnet");
  assert.equal(selection.notice, null);
});

test("an empty registry explains itself instead of selecting nothing silently", () => {
  const selection = reconcileNetworkSelection({ entries: [], storedSlug: "base-mainnet", walletChainId: 8453 });
  assert.equal(selection.entry, null);
  assert.match(selection.notice ?? "", /No Alchemy network variable is configured/);
});

test("chain lookup ignores a null chain id", () => {
  assert.equal(entryForChain(ENTRIES, null), null);
  assert.equal(entryForChain(ENTRIES, 42161)?.slug, "arb-mainnet");
  assert.equal(entryForChain(ENTRIES, 5), null);
});

test("switchability refuses unavailable and non-EVM networks with a specific reason", () => {
  const unavailable = selectionProblem(ENTRIES[3]!);
  assert.match(unavailable ?? "", /ALCHEMY_ARB_MAINNET_RPC_URL is not set/);

  const solana = selectionProblem(ENTRIES[2]!);
  assert.match(solana ?? "", /no EVM chain id/);
  assert.match(solana ?? "", /RPC endpoint is still reachable/);

  assert.equal(selectionProblem(ENTRIES[1]!), null);
  assert.match(selectionProblem(null) ?? "", /No network is selected/);
});

test("a switch that did not move the wallet is reported, not assumed", () => {
  assert.equal(switchNotice({ requestedChainId: 8453, reachedChainId: 8453, name: "Base" }), null);
  const mismatch = switchNotice({ requestedChainId: 8453, reachedChainId: 1, name: "Base" });
  assert.match(mismatch ?? "", /wallet reports chain 1/);
  assert.match(mismatch ?? "", /switch to Base/);
  assert.match(mismatch ?? "", /retry/);
});
