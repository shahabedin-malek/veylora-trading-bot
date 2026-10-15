import assert from "node:assert/strict";
import test from "node:test";
import { handleNetworkRpcPost } from "@/lib/rpc/rpc-proxy";

const origin = "https://veylora.example";

function request(body: unknown, requestOrigin = origin) {
  return new Request(`${origin}/api/rpc/base-mainnet`, {
    method: "POST",
    headers: { Origin: requestOrigin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function withAppBaseUrl<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = origin;
  return run().finally(() => {
    if (previous === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous;
  });
}

test("multi-network proxy rejects cross-origin requests", async () => {
  await withAppBaseUrl(async () => {
    const response = await handleNetworkRpcPost(
      request({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, "https://attacker.example"),
      "base-mainnet",
    );
    assert.equal(response.status, 403);
  });
});

test("multi-network proxy reports unknown and unconfigured networks", async () => {
  await withAppBaseUrl(async () => {
    const unknown = await handleNetworkRpcPost(
      request({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      "not a network",
      { env: {} as NodeJS.ProcessEnv },
    );
    assert.equal(unknown.status, 404);

    const unconfigured = await handleNetworkRpcPost(
      request({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      "base-mainnet",
      { env: {} as NodeJS.ProcessEnv },
    );
    assert.equal(unconfigured.status, 503);
  });
});

test("multi-network proxy forwards any JSON-RPC method to the resolved network", async () => {
  await withAppBaseUrl(async () => {
    const env = {
      NODE_ENV: "test",
      ALCHEMY_BASE_MAINNET_RPC_URL: "https://base-mainnet.g.alchemy.com/v2/test-key",
    } as NodeJS.ProcessEnv;
    const forwarded: { url: string; method: string }[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { method: string };
      forwarded.push({ url: String(input), method: payload.method });
      return Response.json({ jsonrpc: "2.0", id: 7, result: "0x1" });
    }) as typeof fetch;

    for (const method of ["eth_chainId", "eth_getBalance", "eth_call", "eth_sendRawTransaction"]) {
      const response = await handleNetworkRpcPost(
        request({ jsonrpc: "2.0", id: 7, method, params: [] }),
        "base-mainnet",
        { fetch: fakeFetch, env },
      );
      assert.equal(response.status, 200, `${method} must be forwarded`);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(await response.json(), { jsonrpc: "2.0", id: 7, result: "0x1" });
    }

    assert.equal(forwarded.length, 4);
    assert.equal(forwarded.every((entry) => entry.url.startsWith("https://base-mainnet.g.alchemy.com/v2/")), true);
    assert.deepEqual(forwarded.map((entry) => entry.method), ["eth_chainId", "eth_getBalance", "eth_call", "eth_sendRawTransaction"]);
  });
});

test("multi-network proxy never echoes the key in an error response", async () => {
  await withAppBaseUrl(async () => {
    const env = {
      NODE_ENV: "test",
      ALCHEMY_BASE_MAINNET_RPC_URL: "https://base-mainnet.g.alchemy.com/v2/super-secret-key",
    } as NodeJS.ProcessEnv;
    const failingFetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const response = await handleNetworkRpcPost(
      request({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      "base-mainnet",
      { fetch: failingFetch, env },
    );
    assert.equal(response.status, 502);
    assert.equal(JSON.stringify(await response.json()).includes("super-secret-key"), false);
  });
});
