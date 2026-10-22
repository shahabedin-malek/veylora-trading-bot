import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNetworkRegistry,
  canonicalNetworkSlug,
  getNetworkRegistry,
  invalidateNetworkRegistry,
  listRpcNetworkSlugs,
  resolveRpcEndpoint,
  validateNetworkRegistry,
} from "@/lib/rpc/networks";

const SECRET = "registry-test-secret-key";

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...values } as NodeJS.ProcessEnv;
}

test("discovers networks from both documented patterns with no code change", () => {
  const registry = buildNetworkRegistry(env({
    ALCHEMY_BASE_MAINNET_RPC_URL: `https://base-mainnet.g.alchemy.com/v2/${SECRET}`,
    ALCHEMY_KAIA_MAINNET_API_KEY: SECRET,
  }));

  assert.deepEqual(registry.entries.map(({ slug }) => slug), ["base-mainnet", "kaia-mainnet"]);
  const base = registry.entries[0]!;
  assert.equal(base.availability, "available");
  assert.equal(base.source, "rpc-url");
  assert.equal(base.chainId, 8453);
  assert.equal(base.tokenAllowlist, "listed");

  // The key-only network is discovered and says precisely why it cannot resolve:
  // no host is known for it, so the per-network URL is what the operator must set.
  const kaia = registry.entries[1]!;
  assert.equal(kaia.availability, "unavailable");
  assert.equal(kaia.problem, "no-host");
  assert.match(kaia.reason ?? "", /ALCHEMY_KAIA_MAINNET_API_KEY/);
  assert.match(kaia.reason ?? "", /ALCHEMY_KAIA_MAINNET_RPC_URL/);
});

test("an alias canonicalises to the same key health and the registry use", () => {
  assert.equal(canonicalNetworkSlug("eth-mainnet"), "ethereum-mainnet");
  assert.equal(canonicalNetworkSlug("base"), "base-mainnet");
  assert.equal(canonicalNetworkSlug("not a network"), null);
});

test("a per-network API key resolves through a known host and stays out of the registry", () => {
  const registry = buildNetworkRegistry(env({ ALCHEMY_BASE_MAINNET_API_KEY: SECRET }));
  assert.equal(registry.entries[0]!.availability, "available");
  assert.equal(registry.entries[0]!.source, "api-key");

  const resolution = resolveRpcEndpoint("base-mainnet", env({ ALCHEMY_BASE_MAINNET_API_KEY: SECRET }));
  assert.equal(resolution.ok, true);
  if (resolution.ok) assert.equal(resolution.endpoint, `https://base-mainnet.g.alchemy.com/v2/${SECRET}`);

  assert.equal(JSON.stringify(registry).includes(SECRET), false);
});

test("a malformed or insecure endpoint marks only that network unavailable", () => {
  const registry = buildNetworkRegistry(env({
    ALCHEMY_BASE_MAINNET_RPC_URL: "http://base-mainnet.g.alchemy.com/v2/not-https",
    ALCHEMY_ARB_MAINNET_RPC_URL: "https://arb-mainnet.g.alchemy.com/v2/ok",
  }));
  const base = registry.entries.find(({ slug }) => slug === "base-mainnet")!;
  const arb = registry.entries.find(({ slug }) => slug === "arb-mainnet")!;

  assert.equal(base.availability, "unavailable");
  assert.equal(base.problem, "insecure");
  assert.match(base.reason ?? "", /ALCHEMY_BASE_MAINNET_RPC_URL/);
  assert.equal(JSON.stringify(base).includes("not-https"), false);

  assert.equal(arb.availability, "available");
  assert.equal(registry.totals.available, 1);
  assert.equal(registry.totals.unavailable, 1);
});

test("a placeholder value is unavailable and names the variable, not the value", () => {
  const registry = buildNetworkRegistry(env({
    ALCHEMY_BASE_MAINNET_RPC_URL: "replace-me",
    ALCHEMY_OPT_MAINNET_RPC_URL: "https://opt-mainnet.g.alchemy.com/v2/ok",
  }));
  const base = registry.entries.find(({ slug }) => slug === "base-mainnet")!;
  assert.equal(base.availability, "unavailable");
  assert.equal(base.problem, "placeholder");
  assert.match(base.reason ?? "", /ALCHEMY_BASE_MAINNET_RPC_URL/);
  assert.equal(registry.entries.find(({ slug }) => slug === "opt-mainnet")!.availability, "available");
});

test("metadata is optional: an unknown configured network is listed, not hidden", () => {
  const registry = buildNetworkRegistry(env({
    ALCHEMY_MYSTERY_MAINNET_RPC_URL: "https://mystery.example/v2/ok",
  }));
  const entry = registry.entries[0]!;
  assert.equal(entry.slug, "mystery-mainnet");
  assert.equal(entry.availability, "available");
  assert.equal(entry.chainId, null);
  assert.equal(entry.kind, "unknown");
  assert.equal(entry.tokenAllowlist, "not-applicable");
  assert.equal(entry.name, "Mystery Mainnet");
  assert.equal(entry.explorerUrl, null);
});

test("non-EVM families are identified and never offered a wallet chain", () => {
  const registry = buildNetworkRegistry(env({
    ALCHEMY_SOLANA_MAINNET_RPC_URL: "https://solana-mainnet.g.alchemy.com/v2/ok",
    ALCHEMY_BITCOIN_MAINNET_RPC_URL: "https://bitcoin-mainnet.g.alchemy.com/v2/ok",
  }));
  assert.deepEqual(registry.entries.map(({ kind }) => kind), ["non-evm", "non-evm"]);
  assert.deepEqual(registry.entries.map(({ tokenAllowlist }) => tokenAllowlist), ["not-applicable", "not-applicable"]);
});

test("beacon endpoints are recognised as not JSON-RPC and never become networks", () => {
  const registry = buildNetworkRegistry(env({
    ALCHEMY_ETHEREUM_MAINNET_BEACON_RPC_URL: "https://ethereum-mainnet-beacon.example/v2/ok",
    ALCHEMY_ETHEREUM_MAINNET_RPC_URL: "https://eth-mainnet.g.alchemy.com/v2/ok",
  }));
  assert.deepEqual(registry.entries.map(({ slug }) => slug), ["ethereum-mainnet"]);
  assert.deepEqual(registry.ignoredVariables, ["ALCHEMY_ETHEREUM_MAINNET_BEACON_RPC_URL"]);
  assert.deepEqual(listRpcNetworkSlugs(env({
    ALCHEMY_ETHEREUM_MAINNET_BEACON_RPC_URL: "https://x.example",
  })), []);
});

test("the registry is cached per process and invalidated explicitly", () => {
  const variable = "ALCHEMY_CACHE_TEST_MAINNET_RPC_URL";
  const previous = process.env[variable];
  try {
    process.env[variable] = "https://cache-test.example/v2/ok";
    invalidateNetworkRegistry();
    assert.equal(getNetworkRegistry().entries[0]!.availability, "available");

    process.env[variable] = "not a url";
    // Cached: a change is not visible until the TTL passes or a caller invalidates.
    assert.equal(getNetworkRegistry().entries[0]!.availability, "available");

    invalidateNetworkRegistry();
    const fresh = getNetworkRegistry();
    assert.equal(fresh.entries[0]!.availability, "unavailable");
    assert.equal(fresh.entries[0]!.problem, "malformed");
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    invalidateNetworkRegistry();
  }
});

test("startup validation collects reasons without ever containing a value", () => {
  const { registry, problems } = validateNetworkRegistry(env({
    ALCHEMY_BASE_MAINNET_RPC_URL: `https://base-mainnet.g.alchemy.com/v2/${SECRET}`,
    ALCHEMY_ARB_MAINNET_RPC_URL: "broken",
    ALCHEMY_ETHEREUM_MAINNET_BEACON_RPC_URL: "https://beacon.example",
  }));
  assert.equal(registry.totals.available, 1);
  assert.equal(problems.length, 2);
  assert.equal(problems.some((problem) => problem.includes("arb-mainnet")), true);
  assert.equal(problems.some((problem) => problem.includes("beacon")), true);
  assert.equal(problems.join(" ").includes(SECRET), false);
});
