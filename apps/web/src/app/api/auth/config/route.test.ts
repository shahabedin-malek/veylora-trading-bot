import assert from "node:assert/strict";
import test from "node:test";
import { getAllowedEvmMainnetChainIds } from "@/lib/auth/config";

test("auth configuration allows no chain unless explicitly set", () => {
  assert.equal(getAllowedEvmMainnetChainIds("").size, 0);
  assert.equal(getAllowedEvmMainnetChainIds(undefined).size, 0);
});

test("auth configuration accepts any configured EVM chain", () => {
  assert.equal(getAllowedEvmMainnetChainIds("11155111").has(11155111), true);
  assert.equal(getAllowedEvmMainnetChainIds("8453").has(8453), true);
  assert.deepEqual([...getAllowedEvmMainnetChainIds("1")], [1]);
});
