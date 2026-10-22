/**
 * Phase 18 acceptance tests: aggregation, provenance, partial reads, metadata
 * caching and the unknown-token rule.
 *
 * The chain is a fake JSON-RPC endpoint, the cache is an object in this file, and
 * the networks are the real registry. That is deliberate: what is being tested is
 * the aggregation's behaviour when a provider is slow, dead, or returns a token
 * nobody listed — not the provider itself.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { getAddress } from "viem";
import type { EvmMainnet } from "@/lib/portfolio/evm-mainnets";
import { getEvmMainnet } from "@/lib/portfolio/evm-mainnets";
import { readPortfolio, mapBounded, withDeadline } from "@/lib/portfolio/aggregate";
import type { CachedTokenMetadata, TokenMetadataReader, TokenMetadataStore } from "@/lib/portfolio/tokens";

const wallet = getAddress("0x1234567890abcdef1234567890abcdef12345678");
const usdc = getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
const unknownToken = getAddress("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");

const eth = getEvmMainnet(1)!;
const base = getEvmMainnet(8453)!;

type FakeToken = {
  contractAddress: string;
  rawAmount: bigint;
  symbol: string;
  name: string;
  decimals: number;
};

function hex(value: bigint | number): string {
  return `0x${value.toString(16)}`;
}

function rpcFetcher(options: {
  chainForHost: (host: string) => number;
  native?: Record<number, bigint>;
  tokens?: Record<number, FakeToken[]>;
  failHosts?: string[];
  hangHosts?: string[];
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (options.failHosts?.includes(url.hostname)) throw new Error("provider is down");
    if (options.hangHosts?.includes(url.hostname)) return new Promise<Response>(() => {});

    const chainId = options.chainForHost(url.hostname);
    const body = JSON.parse(String(init?.body ?? "[]")) as {
      id: number;
      method: string;
      params: unknown[];
    }[];
    const tokens = options.tokens?.[chainId] ?? [];

    const results = body.map((call) => {
      let result: unknown = null;
      if (call.method === "eth_chainId") result = hex(chainId);
      else if (call.method === "eth_getBalance") result = hex(options.native?.[chainId] ?? BigInt(0));
      else if (call.method === "alchemy_getTokenBalances") {
        result = {
          tokenBalances: tokens.map((token) => ({
            contractAddress: token.contractAddress,
            tokenBalance: hex(token.rawAmount),
          })),
        };
      } else if (call.method === "alchemy_getTokenMetadata") {
        const requested = String(call.params[0]).toLowerCase();
        const token = tokens.find((candidate) => candidate.contractAddress.toLowerCase() === requested);
        result = token
          ? { symbol: token.symbol, name: token.name, decimals: hex(token.decimals) }
          : null;
      } else if (call.method === "eth_call") {
        result = hex(BigInt(0));
      }
      return { jsonrpc: "2.0", id: call.id, result };
    });

    return new Response(JSON.stringify(results), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

class MemoryStore implements TokenMetadataStore {
  rows = new Map<string, CachedTokenMetadata>();
  reads = 0;
  writes = 0;
  failReads = false;

  async read({ chainId, addresses }: { chainId: number; addresses: readonly string[] }) {
    this.reads += 1;
    if (this.failReads) throw new Error("database is down");
    return addresses
      .map((address) => this.rows.get(`${chainId}:${address}`))
      .filter((row): row is CachedTokenMetadata => Boolean(row));
  }

  async write(rows: readonly CachedTokenMetadata[]) {
    this.writes += 1;
    for (const row of rows) this.rows.set(`${row.chainId}:${row.contractAddress}`, row);
  }
}

const env = { ALCHEMY_API_KEY: "test-key" } as unknown as NodeJS.ProcessEnv;

function standardFetcher() {
  return rpcFetcher({
    chainForHost: (host) => (host.includes("base") ? base.chainId : eth.chainId),
    native: { [eth.chainId]: BigInt("1000000000000000000"), [base.chainId]: BigInt("500000000000000000") },
    tokens: {
      [eth.chainId]: [
        { contractAddress: usdc, rawAmount: BigInt(2_500_000), symbol: "USDC", name: "USD Coin", decimals: 6 },
        {
          contractAddress: unknownToken,
          rawAmount: BigInt("1000000000000000000"),
          symbol: "SCAM",
          name: "Visit scam.example.com to claim",
          decimals: 18,
        },
      ],
    },
  });
}

function networks(): EvmMainnet[] {
  return [eth, base];
}

test("aggregate totals equal the sum of the per-network rows", async () => {
  const result = await readPortfolio({
    walletAddress: wallet,
    networks: networks(),
    store: new MemoryStore(),
    fetcher: standardFetcher(),
    env,
    allowListByChain: new Map([[eth.chainId, new Set([usdc])]]),
  });

  assert.equal(result.networks.length, 2);
  assert.equal(result.summary.complete, true);
  assert.deepEqual(result.summary.missing, []);

  const ethRow = result.networks.find(({ chainId }) => chainId === eth.chainId)!;
  const baseRow = result.networks.find(({ chainId }) => chainId === base.chainId)!;
  assert.equal(ethRow.holdings.find(({ symbol }) => symbol === "ETH")!.formattedAmount, "1");
  assert.equal(baseRow.holdings.find(({ symbol }) => symbol === "ETH")!.formattedAmount, "0.5");

  // Per-network totals are the rows the aggregate is made of.
  assert.equal(ethRow.totals.byAsset.find(({ symbol }) => symbol === "ETH")!.amount, "1");
  assert.equal(baseRow.totals.byAsset.find(({ symbol }) => symbol === "ETH")!.amount, "0.5");
  assert.equal(result.summary.totals.byAsset.find(({ symbol }) => symbol === "ETH")!.amount, "1.5");
  assert.equal(result.summary.totals.byAsset.find(({ symbol }) => symbol === "USDC")!.amount, "2.5");

  // The aggregate is exactly the rows' sums; a test that only compares rendered
  // strings would miss a per-row rounding difference.
  const ethHoldings = ethRow.holdings.reduce((sum, holding) => sum + Number(holding.formattedAmount), 0);
  const baseHoldings = baseRow.holdings.reduce((sum, holding) => sum + Number(holding.formattedAmount), 0);
  assert.equal(result.summary.totals.holdings, ethRow.holdings.length + baseRow.holdings.length);
  assert.equal(ethHoldings + baseHoldings, 1 + 1 + 0.5 + 2.5);
});

test("every holding carries the network it was read on and the provider that answered", async () => {
  const result = await readPortfolio({
    walletAddress: wallet,
    networks: networks(),
    store: new MemoryStore(),
    fetcher: standardFetcher(),
    env,
  });

  for (const row of result.networks) {
    assert.equal(row.status, "available");
    assert.equal(row.providerId, "alchemy-rpc");
    for (const holding of row.holdings) {
      assert.equal(holding.network, row.network);
      assert.equal(holding.chainId, row.chainId);
      assert.equal(holding.providerId, "alchemy-rpc");
      assert.match(holding.readAt, /^\d{4}-\d{2}-\d{2}T/);
    }
  }
});

test("an unknown token is listed with its checksummed address and a marker, not dropped", async () => {
  const result = await readPortfolio({
    walletAddress: wallet,
    networks: [eth],
    store: new MemoryStore(),
    fetcher: standardFetcher(),
    env,
    allowListByChain: new Map([[eth.chainId, new Set([usdc])]]),
  });

  const holding = result.networks[0]!.holdings.find(({ contractAddress }) => contractAddress === unknownToken)!;
  assert.ok(holding, "the token must be present");
  assert.equal(holding.allowListed, false);
  assert.equal(holding.contractAddress, unknownToken);
  assert.ok(holding.markers.includes("not in allow-list"));
  assert.ok(holding.markers.includes("name or symbol contains a URL"));
  assert.equal(holding.suspectedSpam, true);
  assert.equal(holding.rawAmount, "1000000000000000000");
  assert.equal(holding.formattedAmount, "1");

  const allowed = result.networks[0]!.holdings.find(({ contractAddress }) => contractAddress === usdc)!;
  assert.equal(allowed.allowListed, true);
  assert.equal(allowed.suspectedSpam, false);
});

test("a dead network is named as missing and the rest still render", async () => {
  const result = await readPortfolio({
    walletAddress: wallet,
    networks: networks(),
    store: new MemoryStore(),
    fetcher: rpcFetcher({
      chainForHost: (host) => (host.includes("base") ? base.chainId : eth.chainId),
      native: { [eth.chainId]: BigInt("1000000000000000000") },
      failHosts: ["base-mainnet.g.alchemy.com"],
    }),
    env,
  });

  assert.equal(result.summary.complete, false);
  assert.equal(result.summary.answered, 1);
  assert.deepEqual(result.summary.missing.map(({ chainId }) => chainId), [base.chainId]);
  assert.match(result.summary.missing[0]!.reason, /Base/);

  const dead = result.networks.find(({ chainId }) => chainId === base.chainId)!;
  assert.equal(dead.status, "unavailable");
  assert.equal(dead.providerId, null);
  assert.ok(dead.reason && dead.reason.length > 0);
  assert.equal(result.networks.find(({ chainId }) => chainId === eth.chainId)!.status, "available");

  // The partial total is a floor, and the response says so instead of presenting
  // "1 ETH" as the whole portfolio.
  assert.equal(result.summary.totals.byAsset.find(({ symbol }) => symbol === "ETH")!.amount, "1");
});

test("a slow network times out without blocking the others", async () => {
  const result = await readPortfolio({
    walletAddress: wallet,
    networks: networks(),
    store: new MemoryStore(),
    fetcher: rpcFetcher({
      chainForHost: (host) => (host.includes("base") ? base.chainId : eth.chainId),
      native: { [eth.chainId]: BigInt("1000000000000000000") },
      hangHosts: ["base-mainnet.g.alchemy.com"],
    }),
    env,
    timeoutMs: 40,
  });

  const slow = result.networks.find(({ chainId }) => chainId === base.chainId)!;
  assert.equal(slow.status, "timeout");
  assert.match(slow.reason ?? "", /did not answer within/);
  assert.equal(result.networks.find(({ chainId }) => chainId === eth.chainId)!.status, "available");
  assert.equal(result.summary.answered, 1);
});

test("a repeat load within the freshness window does not re-fetch metadata", async () => {
  const store = new MemoryStore();
  let metadataCalls = 0;
  const fetcher = rpcFetcher({
    chainForHost: () => eth.chainId,
    native: { [eth.chainId]: BigInt("1000000000000000000") },
    tokens: {
      [eth.chainId]: [
        { contractAddress: usdc, rawAmount: BigInt(2_500_000), symbol: "USDC", name: "USD Coin", decimals: 6 },
      ],
    },
  });
  const reader: TokenMetadataReader = async ({ addresses }) => {
    metadataCalls += 1;
    return addresses.map((contractAddress) => ({
      contractAddress,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
    }));
  };

  const first = await readPortfolio({
    walletAddress: wallet,
    networks: [eth],
    store,
    metadataReader: reader,
    fetcher,
    env,
  });
  assert.equal(first.networks[0]!.metadata, "cache-miss");
  assert.equal(metadataCalls, 1);
  assert.ok(store.writes > 0);

  const second = await readPortfolio({
    walletAddress: wallet,
    networks: [eth],
    store,
    metadataReader: reader,
    fetcher,
    env,
  });
  assert.equal(second.networks[0]!.metadata, "cache-hit");
  assert.equal(metadataCalls, 1, "a fresh cache row means no provider call at all");
});

test("a cache that cannot be read still lists live chain holdings", async () => {
  const store = new MemoryStore();
  store.failReads = true;

  const result = await readPortfolio({
    walletAddress: wallet,
    networks: [eth],
    store,
    fetcher: standardFetcher(),
    env,
    allowListByChain: new Map([[eth.chainId, new Set([usdc])]]),
  });

  const row = result.networks[0]!;
  assert.equal(row.status, "available");
  assert.equal(row.metadata, "cache-unavailable");
  assert.equal(row.holdings.length, 3);
  assert.ok(row.holdings.some(({ symbol }) => symbol === "ETH"));
  assert.ok(row.holdings.some(({ symbol }) => symbol === "USDC"));
  assert.ok(row.holdings.some(({ contractAddress }) => contractAddress === unknownToken));
});

test("holdings with an unresolvable metadata answer stay listed by address", async () => {
  const result = await readPortfolio({
    walletAddress: wallet,
    networks: [eth],
    store: new MemoryStore(),
    metadataReader: async () => [],
    fetcher: rpcFetcher({
      chainForHost: () => eth.chainId,
      native: { [eth.chainId]: BigInt(0) },
      tokens: {
        [eth.chainId]: [{ contractAddress: unknownToken, rawAmount: BigInt(42), symbol: "X", name: "X", decimals: 18 }],
      },
    }),
    env,
  });

  const holding = result.networks[0]!.holdings.find(({ contractAddress }) => contractAddress === unknownToken)!;
  assert.ok(holding);
  assert.equal(holding.decimals, 0);
  assert.equal(holding.formattedAmount, "42");
  assert.ok(holding.markers.includes("decimals unavailable (shown in raw units)"));
  assert.equal(holding.allowListed, false);
  assert.ok(holding.markers.includes("not in allow-list"));
});

test("rows are emitted as each network settles", async () => {
  const seen: number[] = [];
  await readPortfolio({
    walletAddress: wallet,
    networks: networks(),
    store: new MemoryStore(),
    fetcher: standardFetcher(),
    env,
    onNetwork: (row) => seen.push(row.chainId),
  });
  assert.deepEqual(seen.sort(), [eth.chainId, base.chainId].sort());
});

test("bounded concurrency keeps the width and the order", async () => {
  let inFlight = 0;
  let peak = 0;
  const result = await mapBounded([1, 2, 3, 4, 5, 6], 2, async (value) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return value * 2;
  });
  assert.deepEqual(result, [2, 4, 6, 8, 10, 12]);
  assert.equal(peak, 2);
});

test("withDeadline aborts the signal when the deadline wins", async () => {
  let aborted = false;
  const outcome = await withDeadline((signal) => {
    signal.addEventListener("abort", () => { aborted = true; });
    return new Promise<number>(() => {});
  }, 20);
  assert.equal(outcome.timedOut, true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(aborted, true);
});
