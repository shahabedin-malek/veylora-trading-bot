import {
  encodeFunctionData,
  formatEther,
  formatUnits,
  type Address,
} from "viem";
import { isChecksummedAddress } from "@/lib/portfolio/ethereum-token-allowlist";
import { getEvmMainnet } from "@/lib/portfolio/evm-mainnets";
import { resolveRpcEndpoint } from "@/lib/rpc/networks";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_TOKENS_PER_READ = 50;

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

type RpcMethod = "eth_chainId" | "eth_getBalance" | "eth_getCode" | "eth_call";
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

async function requestBatch(
  endpoint: string,
  calls: readonly RpcCall[],
  fetcher: typeof fetch,
): Promise<Map<number, unknown>> {
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(calls.map(({ method, params }, index) => ({
      jsonrpc: "2.0",
      id: index + 1,
      method,
      params,
    }))),
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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