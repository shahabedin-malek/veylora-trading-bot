import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_EVM_MAINNET_CHAIN_ID,
  EVM_MAINNETS,
  getEnabledEvmMainnetChainIds,
  getEvmMainnet,
  MAX_ADDITIONAL_EVM_MAINNETS,
} from "@/lib/portfolio/evm-mainnets";

test("mainnet registry has unique chain IDs and provider slugs with no test networks", () => {
  assert.equal(new Set(EVM_MAINNETS.map(({ chainId }) => chainId)).size, EVM_MAINNETS.length);
  assert.equal(new Set(EVM_MAINNETS.map(({ alchemyNetwork }) => alchemyNetwork)).size, EVM_MAINNETS.length);
  assert.ok(EVM_MAINNETS.every(({ alchemyNetwork }) => !/test|sepolia|devnet|hoodi|amoy/i.test(alchemyNetwork)));
  assert.equal(getEvmMainnet(DEFAULT_EVM_MAINNET_CHAIN_ID)?.name, "Ethereum Mainnet");
});

test("only the default plus explicitly selected supported mainnets are enabled", () => {
  assert.deepEqual(getEnabledEvmMainnetChainIds([]), [DEFAULT_EVM_MAINNET_CHAIN_ID]);
  assert.deepEqual(getEnabledEvmMainnetChainIds([8453]), [DEFAULT_EVM_MAINNET_CHAIN_ID, 8453]);
  assert.equal(getEnabledEvmMainnetChainIds([DEFAULT_EVM_MAINNET_CHAIN_ID]), null);
  assert.equal(getEnabledEvmMainnetChainIds([11155111]), null);
  assert.equal(getEnabledEvmMainnetChainIds([8453, 8453]), null);
  assert.equal(getEnabledEvmMainnetChainIds(Array.from({ length: MAX_ADDITIONAL_EVM_MAINNETS + 1 }, (_, index) => EVM_MAINNETS[index + 1].chainId)), null);
});