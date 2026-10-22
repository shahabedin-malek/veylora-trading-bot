import assert from "node:assert/strict";
import test from "node:test";
import { listRpcNetworkSlugs, resolveRpcEndpoint } from "@/lib/rpc/networks";

test("resolves a per-network endpoint from the environment", () => {
  const env = {
    NODE_ENV: "test",
    ALCHEMY_BASE_MAINNET_RPC_URL: "https://base-mainnet.g.alchemy.com/v2/test-key",
  } as NodeJS.ProcessEnv;
  const result = resolveRpcEndpoint("base-mainnet", env);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.endpoint, "https://base-mainnet.g.alchemy.com/v2/test-key");
});

test("resolves network aliases to their canonical slug", () => {
  const env = {
    NODE_ENV: "test",
    ALCHEMY_ETHEREUM_MAINNET_RPC_URL: "https://eth-mainnet.g.alchemy.com/v2/test-key",
  } as NodeJS.ProcessEnv;
  const result = resolveRpcEndpoint("ethereum", env);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.slug, "ethereum-mainnet");
});

test("falls back to the shared account-wide key plus a known hostname", () => {
  const env = { NODE_ENV: "test", ALCHEMY_API_KEY: "shared-test-key" } as NodeJS.ProcessEnv;
  const result = resolveRpcEndpoint("base", env);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.endpoint, "https://base-mainnet.g.alchemy.com/v2/shared-test-key");
});

test("an empty shared key does not shadow the legacy Ethereum key", () => {
  const env = {
    NODE_ENV: "test",
    ALCHEMY_API_KEY: "   ",
    ALCHEMY_ETHEREUM_MAINNET_API_KEY: "legacy-test-key",
  } as NodeJS.ProcessEnv;
  const result = resolveRpcEndpoint("base", env);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.endpoint, "https://base-mainnet.g.alchemy.com/v2/legacy-test-key");
});

test("blank keys are reported as unconfigured rather than used", () => {
  const env = { NODE_ENV: "test", ALCHEMY_API_KEY: "", ALCHEMY_ETHEREUM_MAINNET_API_KEY: "  " } as NodeJS.ProcessEnv;
  const result = resolveRpcEndpoint("base", env);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "unconfigured");
});

test("rejects an invalid network name and an unconfigured network", () => {
  const invalid = resolveRpcEndpoint("not a network", {} as NodeJS.ProcessEnv);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.reason, "invalid-network");

  const missing = resolveRpcEndpoint("dogecoin-mainnet", {} as NodeJS.ProcessEnv);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, "unconfigured");
});

test("discovers every configured network and never exposes endpoints", () => {
  const env = {
    NODE_ENV: "test",
    ALCHEMY_BASE_MAINNET_RPC_URL: "https://base-mainnet.g.alchemy.com/v2/secret-a",
    ALCHEMY_ARB_MAINNET_RPC_URL: "https://arb-mainnet.g.alchemy.com/v2/secret-b",
    UNRELATED: "https://example.com",
  } as NodeJS.ProcessEnv;
  const slugs = listRpcNetworkSlugs(env);
  assert.deepEqual(slugs, ["arb-mainnet", "base-mainnet"]);
  assert.equal(JSON.stringify(slugs).includes("secret"), false);
});
