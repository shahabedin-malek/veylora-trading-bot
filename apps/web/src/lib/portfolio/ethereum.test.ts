import assert from "node:assert/strict";
import test from "node:test";
import { readEthereumMainnetPortfolio, readEvmMainnetPortfolio } from "@/lib/portfolio/ethereum";
import { isChecksummedAddress, normalizeChecksummedAddress } from "@/lib/portfolio/ethereum-token-allowlist";

const walletAddress = "0x52908400098527886E0F7030069857D2E4169EE7";
const tokenAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

test("token address validation canonicalizes valid input and only stores checksum form", () => {
  assert.equal(normalizeChecksummedAddress(tokenAddress.toLowerCase()), tokenAddress);
  assert.equal(isChecksummedAddress(tokenAddress), true);
  assert.equal(isChecksummedAddress(tokenAddress.toLowerCase()), false);
  assert.equal(normalizeChecksummedAddress("0x1234"), null);
  assert.equal(isChecksummedAddress("0xA0b86991c6218b36c1d19d4a2e9Eb0cE3606eB48"), false);
});

test("portfolio stays disconnected without the new key and performs no provider request", async () => {
  const previous = process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY;
  delete process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY;
  let fetchCalled = false;
  try {
    const result = await readEthereumMainnetPortfolio(walletAddress, [], async () => {
      fetchCalled = true;
      return Response.json([]);
    }, {} as NodeJS.ProcessEnv);
    assert.deepEqual(result, { status: "not-connected" });
    assert.equal(fetchCalled, false);
  } finally {
    if (previous === undefined) delete process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY;
    else process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY = previous;
  }
});

test("portfolio batches only native balance and calls to the allow-listed ERC-20", async () => {
  const previous = process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY;
  process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY = "test-only-placeholder";
  const requestMethods: string[] = [];
  const queriedTokenAddresses: string[] = [];
  let batchCount = 0;

  try {
    const result = await readEthereumMainnetPortfolio(walletAddress, [tokenAddress], async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Array<{ id: number; method: string; params: unknown[] }>;
      batchCount += 1;
      requestMethods.push(...body.map(({ method }) => method));
      for (const call of body.filter(({ method }) => method === "eth_getCode" || method === "eth_call")) {
        const target = (call.params[0] as { to: string }).to;
        queriedTokenAddresses.push(call.method === "eth_getCode" ? call.params[0] as string : target);
      }
      return Response.json(body.map(({ id, method, params }) => ({
        jsonrpc: "2.0",
        id,
        result: method === "eth_chainId"
          ? "0x1"
          : method === "eth_getBalance"
            ? "0xde0b6b3a7640000"
            : method === "eth_getCode"
              ? "0x6000"
            : (params[0] as { data: string }).data.startsWith("0x313ce567")
              ? "0x12"
              : "0x2a",
      })));
    });

    assert.deepEqual(result, {
      status: "available",
      nativeBalance: "1",
      tokens: [{ contractAddress: tokenAddress, status: "available", balance: "0.000000000000000042" }],
    });
    assert.deepEqual(requestMethods, ["eth_chainId", "eth_getBalance", "eth_getCode", "eth_call", "eth_call"]);
    assert.deepEqual(queriedTokenAddresses, [tokenAddress, tokenAddress, tokenAddress]);
    assert.equal(batchCount, 2);
    assert.equal(requestMethods.some((method) => /send|sign/i.test(method)), false);
  } finally {
    if (previous === undefined) delete process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY;
    else process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY = previous;
  }
});

test("portfolio does not call an allow-listed address as ERC-20 without deployed code", async () => {
  const previous = process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY;
  process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY = "test-only-placeholder";
  const methods: string[] = [];
  try {
    const result = await readEthereumMainnetPortfolio(walletAddress, [tokenAddress], async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Array<{ id: number; method: string }>;
      methods.push(...body.map(({ method }) => method));
      return Response.json(body.map(({ id, method }) => ({
        jsonrpc: "2.0",
        id,
        result: method === "eth_chainId" ? "0x1" : method === "eth_getBalance" ? "0x0" : "0x",
      })));
    });
    assert.deepEqual(result, {
      status: "available",
      nativeBalance: "0",
      tokens: [{ contractAddress: tokenAddress, status: "unavailable", balance: null }],
    });
    assert.deepEqual(methods, ["eth_chainId", "eth_getBalance", "eth_getCode"]);
  } finally {
    if (previous === undefined) delete process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY;
    else process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY = previous;
  }
});

test("portfolio refuses a bad stored token address before contacting the provider", async () => {
  const previous = process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY;
  process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY = "test-only-placeholder";
  let fetchCalled = false;
  try {
    const result = await readEthereumMainnetPortfolio(walletAddress, [tokenAddress.toLowerCase()], async () => {
      fetchCalled = true;
      return Response.json([]);
    });
    assert.deepEqual(result, { status: "unavailable" });
    assert.equal(fetchCalled, false);
  } finally {
    if (previous === undefined) delete process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY;
    else process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY = previous;
  }
});

test("an explicitly selected Base mainnet reads only its fixed Alchemy host and verifies chain ID", async () => {
  const previous = process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY;
  process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY = "test-only-placeholder";
  let requestedUrl = "";
  let methods: string[] = [];
  try {
    const result = await readEvmMainnetPortfolio(8453, walletAddress, [], async (input, init) => {
      requestedUrl = String(input);
      const calls = JSON.parse(String(init?.body)) as Array<{ id: number; method: string }>;
      methods = calls.map(({ method }) => method);
      return Response.json(calls.map(({ id, method }) => ({
        jsonrpc: "2.0",
        id,
        result: method === "eth_chainId" ? "0x2105" : "0x2",
      })));
    });

    assert.equal(new URL(requestedUrl).origin, "https://base-mainnet.g.alchemy.com");
    assert.deepEqual(methods, ["eth_chainId", "eth_getBalance"]);
    assert.deepEqual(result, {
      status: "available",
      chainId: 8453,
      networkName: "Base",
      nativeSymbol: "ETH",
      nativeBalance: "0.000000000000000002",
      tokens: [],
    });
  } finally {
    if (previous === undefined) delete process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY;
    else process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY = previous;
  }
});

test("a provider chain mismatch and unsupported chain never produce a balance", async () => {
  const previous = process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY;
  process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY = "test-only-placeholder";
  let fetchCalled = false;
  try {
    const wrongChain = await readEvmMainnetPortfolio(8453, walletAddress, [], async (_input, init) => {
      fetchCalled = true;
      const calls = JSON.parse(String(init?.body)) as Array<{ id: number; method: string }>;
      return Response.json(calls.map(({ id, method }) => ({
        jsonrpc: "2.0",
        id,
        result: method === "eth_chainId" ? "0x1" : "0xde0b6b3a7640000",
      })));
    });
    assert.deepEqual(wrongChain, { status: "unavailable" });

    fetchCalled = false;
    const unsupported = await readEvmMainnetPortfolio(11155111, walletAddress, [], async () => {
      fetchCalled = true;
      return Response.json([]);
    });
    assert.deepEqual(unsupported, { status: "unavailable" });
    assert.equal(fetchCalled, false);
  } finally {
    if (previous === undefined) delete process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY;
    else process.env.ALCHEMY_ETHEREUM_MAINNET_API_KEY = previous;
  }
});