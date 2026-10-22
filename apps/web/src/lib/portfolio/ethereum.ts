import {
  encodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  type Address,
} from "viem";
import { instrumentFetch, PROVIDER_IDS } from "@/lib/observability/provider-call";
import { isChecksummedAddress } from "@/lib/portfolio/ethereum-token-allowlist";
import { getEvmMainnet } from "@/lib/portfolio/evm-mainnets";
import type { ProviderTokenMetadata } from "@/lib/portfolio/tokens";
import { resolveRpcEndpoint } from "@/lib/rpc/networks";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_TOKENS_PER_READ = 50;
/** Discovered contracts beyond this are reported as truncated, never silently dropped. */
export const MAX_DISCOVERED_TOKENS = 200;
export const EVM_NATIVE_DECIMALS = 18;

const balanceOfAbi = [{
  type: "function",
  name: "balanceOf",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "balance", type: "uint256" }],
}] as const;

const decimalsAbi = [{
  type: "function",
  name: "decimals",
  stateMutability: "view",
  inputs: [],
  outputs: [{ name: "decimals", type: "uint8" }],
}] as const;

type RpcMethod =
  | "eth_chainId"
  | "eth_getBalance"
  | "eth_getCode"
  | "eth_call"
  | "alchemy_getTokenBalances"
  | "alchemy_getTokenMetadata";
type RpcCall = { method: RpcMethod; params: unknown[] };
type TokenBalance = {
  contractAddress: string;
  status: "available" | "unavailable";
  balance: string | null;
};

export type EthereumPortfolioResult =
  | { status: "not-connected" }
  | { status: "unavailable" }
  | { status: "available"; nativeBalance: string; tokens: TokenBalance[] };

export type EvmPortfolioResult =
  | { status: "not-connected" }
  | { status: "unavailable" }
  | { status: "available"; chainId: number; networkName: string; nativeSymbol: string; nativeBalance: string; tokens: TokenBalance[] };

export function isAlchemyEvmMainnetConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveRpcEndpoint("ethereum-mainnet", env).ok;
}

function isHexResult(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value);
}

function tokenCall(contractAddress: Address, walletAddress: Address, method: "balanceOf" | "decimals") {
  const data = method === "balanceOf"
    ? encodeFunctionData({ abi: balanceOfAbi, functionName: "balanceOf", args: [walletAddress] })
    : encodeFunctionData({ abi: decimalsAbi, functionName: "decimals" });
  return { to: contractAddress, data };
}

/**
 * A request signal that ends at `ms` or when the caller's signal aborts,
 * whichever comes first. Disposed in a `finally`, so a relayed listener never
 * outlives the request that registered it.
 */
function boundedSignal(ms: number, signal?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("EVM request timed out.")), ms);
  const relay = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) relay();
    else signal.addEventListener("abort", relay, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", relay);
    },
  };
}

async function requestBatch(
  endpoint: string,
  calls: readonly RpcCall[],
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<Map<number, unknown>> {
  // The endpoint carries the Alchemy key in its path; the record stores the
  // redacted URL, never the endpoint.
  const request = instrumentFetch({ providerId: PROVIDER_IDS.alchemyRpc, fetcher });
  const bounded = boundedSignal(REQUEST_TIMEOUT_MS, signal);
  try {
    const response = await request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(calls.map(({ method, params }, index) => ({
        jsonrpc: "2.0",
        id: index + 1,
        method,
        params,
      }))),
      cache: "no-store",
      signal: bounded.signal,
    });
    if (!response.ok) throw new Error("EVM provider is unavailable.");

    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error("EVM response is invalid.");
    const results = new Map<number, unknown>();
    for (const item of payload) {
      if (typeof item !== "object" || item === null || !("id" in item) || !Number.isSafeInteger(item.id)) continue;
      if ("error" in item) results.set(item.id as number, null);
      else if ("result" in item) results.set(item.id as number, item.result);
    }
    return results;
  } finally {
    bounded.dispose();
  }
}

function hexAmount(value: unknown): string | null {
  return isHexResult(value) ? BigInt(value).toString() : null;
}

export async function readEvmMainnetPortfolio(
  chainId: number,
  walletAddress: string,
  contractAddresses: readonly string[],
  fetcher: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EvmPortfolioResult> {
  const network = getEvmMainnet(chainId);
  if (!network) return { status: "unavailable" };

  const resolution = resolveRpcEndpoint(network.alchemyNetwork, env);
  if (!resolution.ok) return { status: resolution.reason === "unconfigured" ? "not-connected" : "unavailable" };

  if (
    !isChecksummedAddress(walletAddress) ||
    contractAddresses.length > MAX_TOKENS_PER_READ ||
    contractAddresses.some((address) => !isChecksummedAddress(address))
  ) {
    return { status: "unavailable" };
  }

  const wallet = walletAddress as Address;
  const contracts = contractAddresses as readonly Address[];
  const calls: RpcCall[] = [
    { method: "eth_chainId", params: [] },
    { method: "eth_getBalance", params: [wallet, "latest"] },
    ...contracts.map((contractAddress) => ({
      method: "eth_getCode" as const,
      params: [contractAddress, "latest"],
    })),
  ];

  let results: Map<number, unknown>;
  try {
    results = await requestBatch(resolution.endpoint, calls, fetcher);
  } catch {
    return { status: "unavailable" };
  }

  const chainIdHex = results.get(1);
  const nativeHex = results.get(2);
  if (!isHexResult(chainIdHex) || BigInt(chainIdHex) !== BigInt(network.chainId) || !isHexResult(nativeHex)) {
    return { status: "unavailable" };
  }

  const tokenStatuses = new Map<Address, TokenBalance>();
  const deployedContracts = contracts.filter((contractAddress, index) => {
    const code = results.get(3 + index);
    if (isHexResult(code) && code !== "0x") return true;
    tokenStatuses.set(contractAddress, { contractAddress, status: "unavailable", balance: null });
    return false;
  });

  if (deployedContracts.length > 0) {
    const tokenCalls: RpcCall[] = deployedContracts.flatMap((contractAddress) => [
      { method: "eth_call", params: [tokenCall(contractAddress, wallet, "decimals"), "latest"] },
      { method: "eth_call", params: [tokenCall(contractAddress, wallet, "balanceOf"), "latest"] },
    ]);
    try {
      results = await requestBatch(resolution.endpoint, tokenCalls, fetcher);
    } catch {
      for (const contractAddress of deployedContracts) {
        tokenStatuses.set(contractAddress, { contractAddress, status: "unavailable", balance: null });
      }
      return {
        status: "available",
        chainId: network.chainId,
        networkName: network.name,
        nativeSymbol: network.nativeSymbol,
        nativeBalance: formatEther(BigInt(nativeHex)),
        tokens: contracts.map((address) => tokenStatuses.get(address) ?? { contractAddress: address, status: "unavailable", balance: null }),
      };
    }
  }

  for (const [index, contractAddress] of deployedContracts.entries()) {
    const decimalsHex = results.get(1 + index * 2);
    const balanceHex = results.get(2 + index * 2);
    if (!isHexResult(decimalsHex) || !isHexResult(balanceHex)) {
      tokenStatuses.set(contractAddress, { contractAddress, status: "unavailable", balance: null });
      continue;
    }

    try {
      const decimals = Number(BigInt(decimalsHex));
      const rawBalance = BigInt(balanceHex);
      if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) {
        tokenStatuses.set(contractAddress, { contractAddress, status: "unavailable", balance: null });
        continue;
      }
      tokenStatuses.set(contractAddress, {
        contractAddress,
        status: "available",
        balance: formatUnits(rawBalance, decimals),
      });
    } catch {
      tokenStatuses.set(contractAddress, { contractAddress, status: "unavailable", balance: null });
    }
  }

  try {
    return {
      status: "available",
      chainId: network.chainId,
      networkName: network.name,
      nativeSymbol: network.nativeSymbol,
      nativeBalance: formatEther(BigInt(nativeHex)),
      tokens: contracts.map((address) => tokenStatuses.get(address) ?? { contractAddress: address, status: "unavailable", balance: null }),
    };
  } catch {
    return { status: "unavailable" };
  }
}

export type EvmRawTokenBalance = {
  contractAddress: Address;
  rawAmount: string;
  /** `discovered` came from the provider's token list, `allow-listed` from balanceOf. */
  source: "discovered" | "allow-listed";
};

export type EvmRawBalances =
  | { status: "not-connected" }
  | { status: "unavailable"; reason: string }
  | {
      status: "available";
      chainId: number;
      networkName: string;
      nativeSymbol: string;
      nativeDecimals: number;
      nativeRaw: string;
      tokens: EvmRawTokenBalance[];
      truncated: number;
      warnings: string[];
    };

/**
 * Every token balance the provider knows about, plus any allow-listed contract
 * it did not mention.
 *
 * Discovery is what makes "unknown token" possible: `alchemy_getTokenBalances`
 * reports contracts the owner never listed, so a token is shown because it is in
 * the wallet, not because a list contains it. The allow-list is merged in after,
 * so a contract the owner named is still read when discovery fails.
 *
 * Returns raw base units only: formatting, metadata and markers are the caller's
 * job, and this function never touches the metadata cache.
 */
export async function readEvmRawBalances(
  chainId: number,
  walletAddress: string,
  allowListedContracts: readonly string[],
  fetcher: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<EvmRawBalances> {
  const network = getEvmMainnet(chainId);
  if (!network) return { status: "unavailable", reason: "This network is not in the portfolio allow-list." };

  const resolution = resolveRpcEndpoint(network.alchemyNetwork, env);
  if (!resolution.ok) {
    return resolution.reason === "unconfigured"
      ? { status: "not-connected" }
      : { status: "unavailable", reason: `${network.name} has no usable RPC endpoint.` };
  }

  if (!isChecksummedAddress(walletAddress) || allowListedContracts.some((address) => !isChecksummedAddress(address))) {
    return { status: "unavailable", reason: "The wallet or an allow-listed contract is not a checksummed address." };
  }

  const wallet = walletAddress as Address;
  const allowListed = allowListedContracts as readonly Address[];
  const warnings: string[] = [];

  const calls: RpcCall[] = [
    { method: "eth_chainId", params: [] },
    { method: "eth_getBalance", params: [wallet, "latest"] },
    { method: "alchemy_getTokenBalances", params: [wallet, "erc20"] },
    ...allowListed.map((contractAddress) => ({ method: "eth_call" as const, params: [tokenCall(contractAddress, wallet, "balanceOf"), "latest"] })),
  ];

  let results: Map<number, unknown>;
  try {
    results = await requestBatch(resolution.endpoint, calls, fetcher, signal);
  } catch {
    return { status: "unavailable", reason: `${network.name} did not answer.` };
  }

  const chainIdHex = results.get(1);
  const nativeHex = results.get(2);
  if (!isHexResult(chainIdHex) || BigInt(chainIdHex) !== BigInt(network.chainId) || !isHexResult(nativeHex)) {
    return { status: "unavailable", reason: `${network.name} answered for a different chain or without a balance.` };
  }

  const discovered = new Map<Address, string>();
  const discovery = results.get(3);
  if (typeof discovery === "object" && discovery !== null && "tokenBalances" in discovery && Array.isArray(discovery.tokenBalances)) {
    for (const entry of discovery.tokenBalances) {
      if (typeof entry !== "object" || entry === null) continue;
      const contract = "contractAddress" in entry && typeof entry.contractAddress === "string"
        ? normalizeContract(entry.contractAddress)
        : null;
      if (!contract) continue;
      const amount = "tokenBalance" in entry ? hexAmount(entry.tokenBalance) : null;
      if (!amount || BigInt(amount) === BigInt(0)) continue;
      discovered.set(contract, amount);
    }
  } else {
    warnings.push("Token discovery did not answer; only allow-listed contracts were read.");
  }

  const tokens: EvmRawTokenBalance[] = [];
  for (const [contractAddress, rawAmount] of discovered) {
    tokens.push({ contractAddress, rawAmount, source: "discovered" });
  }

  // Allow-listed contracts the provider did not report are read directly, so a
  // listed token with a balance is never missing because discovery skipped it.
  for (const [index, contractAddress] of allowListed.entries()) {
    if (discovered.has(contractAddress)) continue;
    const amount = hexAmount(results.get(4 + index));
    if (!amount || BigInt(amount) === BigInt(0)) continue;
    tokens.push({ contractAddress, rawAmount: amount, source: "allow-listed" });
  }

  tokens.sort((left, right) => {
    const leftValue = BigInt(left.rawAmount);
    const rightValue = BigInt(right.rawAmount);
    return leftValue === rightValue ? 0 : leftValue > rightValue ? -1 : 1;
  });
  const truncated = Math.max(0, tokens.length - MAX_DISCOVERED_TOKENS);

  return {
    status: "available",
    chainId: network.chainId,
    networkName: network.name,
    nativeSymbol: network.nativeSymbol,
    nativeDecimals: EVM_NATIVE_DECIMALS,
    nativeRaw: BigInt(nativeHex).toString(),
    tokens: tokens.slice(0, MAX_DISCOVERED_TOKENS),
    truncated,
    warnings,
  };
}

function normalizeContract(value: string): Address | null {
  try {
    return getAddress(value) as Address;
  } catch {
    return null;
  }
}

/**
 * `alchemy_getTokenMetadata` for a batch of contracts.
 *
 * A contract that answers with no decimals is returned with `decimals: null`; the
 * caller keeps it as an address-only entry rather than dropping it. A provider
 * that cannot be reached is an empty answer, and the cache resolves the rest.
 */
export async function readAlchemyTokenMetadata(
  chainId: number,
  addresses: readonly string[],
  fetcher: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<ProviderTokenMetadata[]> {
  const network = getEvmMainnet(chainId);
  if (!network || addresses.length === 0) return [];
  const resolution = resolveRpcEndpoint(network.alchemyNetwork, env);
  if (!resolution.ok) return [];

  const contracts = addresses.map(normalizeContract).filter((address): address is Address => address !== null);
  if (contracts.length === 0) return [];

  const calls: RpcCall[] = contracts.map((contractAddress) => ({
    method: "alchemy_getTokenMetadata",
    params: [contractAddress],
  }));

  let results: Map<number, unknown>;
  try {
    results = await requestBatch(resolution.endpoint, calls, fetcher, signal);
  } catch {
    return [];
  }

  const answers: ProviderTokenMetadata[] = [];
  for (const [index, contractAddress] of contracts.entries()) {
    const value = results.get(index + 1);
    if (typeof value !== "object" || value === null) {
      answers.push({ contractAddress, symbol: null, name: null, decimals: null });
      continue;
    }
    const rawDecimals = "decimals" in value ? value.decimals : null;
    const decimals = typeof rawDecimals === "number"
      ? rawDecimals
      : typeof rawDecimals === "string" && /^0x[0-9a-fA-F]+$/.test(rawDecimals)
        ? Number(BigInt(rawDecimals))
        : typeof rawDecimals === "string" && /^\d+$/.test(rawDecimals)
          ? Number(rawDecimals)
          : null;
    answers.push({
      contractAddress,
      symbol: "symbol" in value && typeof value.symbol === "string" ? value.symbol : null,
      name: "name" in value && typeof value.name === "string" ? value.name : null,
      decimals: decimals !== null && Number.isSafeInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : null,
    });
  }
  return answers;
}

export async function readEthereumMainnetPortfolio(
  walletAddress: string,
  contractAddresses: readonly string[],
  fetcher: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EthereumPortfolioResult> {
  const result = await readEvmMainnetPortfolio(1, walletAddress, contractAddresses, fetcher, env);
  return result.status === "available"
    ? { status: "available", nativeBalance: result.nativeBalance, tokens: result.tokens }
    : result;
}