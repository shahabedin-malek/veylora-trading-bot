import { instrumentFetch, PROVIDER_IDS } from "@/lib/observability/provider-call";
import { resolveRpcEndpoint } from "@/lib/rpc/networks";

/**
 * The chain reads deposit detection needs, and nothing else.
 *
 * Three reads, chosen because between them they see every way value can arrive
 * at an address:
 *
 *  - `blockNumber` — how far the chain is, which is what confirmations are
 *    counted from.
 *  - `getLogs` with the ERC-20 `Transfer` topic and the recipient topic filter
 *    set to our addresses. Filtering on the *recipient* rather than on the token
 *    contract is deliberate: it finds a transfer of a token this deployment has
 *    never heard of, and it finds one that arrived through an internal call
 *    (where our address never appears in the transaction's calldata). A filter on
 *    the token contract alone would silently miss both.
 *  - `getBlock(…, true)` for the blocks in the window — the only way to see a
 *    *native* coin arrival, which by definition writes no log.
 *
 * The endpoint carries the Alchemy key in its path, so every call goes through
 * `instrumentFetch`, which records the redacted URL: the key never reaches a log
 * line, a response body or the database.
 */

const REQUEST_TIMEOUT_MS = 15_000;
/** One JSON-RPC batch per read; larger batches are refused by some providers. */
const MAX_BATCH_SIZE = 50;

export type ChainLog = {
  address: string;
  logIndex: number;
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  topics: string[];
  data: string;
  removed: boolean;
};

export type ChainReceipt = {
  transactionHash: string;
  status: "success" | "reverted" | "unknown";
  blockNumber: number;
  blockHash: string;
  logs: ChainLog[];
};

export type ChainTransaction = {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  input: string;
};

export type ChainBlock = {
  number: number;
  hash: string;
  transactions: ChainTransaction[];
};

export type ChainLogFilter = {
  fromBlock: number;
  toBlock: number;
  /** The token contract, or null for "any contract" (the unfiltered pass). */
  address: string | null;
  /** Addresses to match in `topics[2]` (the recipient), or null for no filter. */
  toAddresses: string[] | null;
};

export type ChainReader = {
  blockNumber(): Promise<number>;
  getLogs(filter: ChainLogFilter): Promise<ChainLog[]>;
  getBlock(number: number): Promise<ChainBlock | null>;
  getTransactionReceipt(hash: string): Promise<ChainReceipt | null>;
  /**
   * `eth_call` for one view function. Used only to read a *non* deposit token's
   * `decimals()` so an arrival in the wrong token can be shown in its own units
   * rather than as an unreadable integer. Null when the call did not answer with
   * a 32-byte word.
   */
  call(to: string, data: string): Promise<string | null>;
};

/** `keccak256("decimals()")[0..4]` — how many decimals a token reports. */
export const DECIMALS_SELECTOR = "0x313ce567";

export class ChainReadError extends Error {
  constructor(message: string, readonly kind: "unreachable" | "invalid-response") {
    super(message);
    this.name = "ChainReadError";
  }
}

type Dependencies = {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
};

function padTopic(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

function isHexQuantity(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value);
}

function hexToNumber(value: string): number {
  return Number(BigInt(value));
}

type RpcPayload = { jsonrpc: "2.0"; id: number; method: string; params: unknown[] };

/**
 * One batch of JSON-RPC calls. Anything that is not a well-formed answer for a
 * call we made is *invalid*, not empty: a deposit must never be missed because a
 * provider answered in a shape this code did not recognise, so an unreadable
 * response raises instead of quietly returning fewer logs.
 */
async function batch(
  endpoint: string,
  calls: readonly { method: string; params: unknown[] }[],
  fetcher: typeof fetch,
): Promise<Map<number, unknown>> {
  const request = instrumentFetch({ providerId: PROVIDER_IDS.alchemyRpc, fetcher });
  const results = new Map<number, unknown>();
  for (let offset = 0; offset < calls.length; offset += MAX_BATCH_SIZE) {
    const slice = calls.slice(offset, offset + MAX_BATCH_SIZE);
    const payload: RpcPayload[] = slice.map((call, index) => ({
      jsonrpc: "2.0",
      id: offset + index + 1,
      method: call.method,
      params: call.params,
    }));
    let response: Response;
    try {
      response = await request(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ChainReadError(
        `The ${endpoint.includes("alchemy.com") ? "Alchemy" : "configured"} RPC endpoint did not answer: ${error instanceof Error ? error.message : "unknown error"}.`,
        "unreachable",
      );
    }
    if (!response.ok) throw new ChainReadError(`The RPC endpoint answered ${response.status}.`, "unreachable");

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ChainReadError("The RPC endpoint answered with a body that is not JSON.", "invalid-response");
    }
    if (!Array.isArray(body)) throw new ChainReadError("The RPC endpoint answered without a batch array.", "invalid-response");
    for (const item of body) {
      if (typeof item !== "object" || item === null || !("id" in item) || !Number.isSafeInteger((item as { id: unknown }).id)) {
        throw new ChainReadError("The RPC endpoint answered with an item this build cannot read.", "invalid-response");
      }
      const record = item as { id: number; result?: unknown; error?: unknown };
      if ("error" in record && record.error) {
        // A per-call error is the provider's answer about that call (a range too
        // wide, a block not found); it is not an empty result.
        throw new ChainReadError(`The RPC endpoint refused one of this batch's calls: ${JSON.stringify(record.error).slice(0, 200)}.`, "invalid-response");
      }
      results.set(record.id, record.result);
    }
  }
  return results;
}

function readLogs(value: unknown): ChainLog[] {
  if (!Array.isArray(value)) return [];
  const logs: ChainLog[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.address !== "string" ||
      !isHexQuantity(record.logIndex) ||
      typeof record.transactionHash !== "string" ||
      !isHexQuantity(record.blockNumber) ||
      typeof record.blockHash !== "string" ||
      !Array.isArray(record.topics) ||
      typeof record.data !== "string"
    ) {
      continue;
    }
    logs.push({
      address: record.address,
      logIndex: hexToNumber(record.logIndex),
      transactionHash: record.transactionHash,
      blockNumber: hexToNumber(record.blockNumber),
      blockHash: record.blockHash,
      topics: record.topics.filter((topic): topic is string => typeof topic === "string"),
      data: record.data,
      removed: record.removed === true,
    });
  }
  return logs;
}

function readBlock(value: unknown): ChainBlock | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!isHexQuantity(record.number) || typeof record.hash !== "string" || !Array.isArray(record.transactions)) return null;
  const transactions: ChainTransaction[] = [];
  for (const item of record.transactions) {
    if (typeof item !== "object" || item === null) continue;
    const transaction = item as Record<string, unknown>;
    if (
      typeof transaction.hash !== "string" ||
      typeof transaction.from !== "string" ||
      (transaction.to !== null && typeof transaction.to !== "string") ||
      !isHexQuantity(transaction.value) ||
      typeof transaction.input !== "string"
    ) {
      continue;
    }
    transactions.push({
      hash: transaction.hash,
      from: transaction.from,
      to: transaction.to,
      value: transaction.value,
      input: transaction.input,
    });
  }
  return { number: hexToNumber(record.number), hash: record.hash, transactions };
}

function readReceipt(value: unknown): ChainReceipt | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.transactionHash !== "string" || !isHexQuantity(record.blockNumber) || typeof record.blockHash !== "string") return null;
  const status = record.status === "0x1" ? "success" : record.status === "0x0" ? "reverted" : "unknown";
  return {
    transactionHash: record.transactionHash,
    status,
    blockNumber: hexToNumber(record.blockNumber),
    blockHash: record.blockHash,
    logs: readLogs(record.logs),
  };
}

/**
 * Build a reader for one network. Returns the refusal reason instead of a reader
 * when the network has no usable endpoint, so the caller can name the missing
 * variable rather than reporting a failed read.
 */
export function createChainReader(
  alchemyNetwork: string,
  deps: Dependencies = {},
): { ok: true; reader: ChainReader } | { ok: false; reason: "unconfigured" | "invalid-network" } {
  const env = deps.env ?? process.env;
  const resolution = resolveRpcEndpoint(alchemyNetwork, env);
  if (!resolution.ok) return { ok: false, reason: resolution.reason };
  const endpoint = resolution.endpoint;
  const fetcher = deps.fetch ?? fetch;

  return {
    ok: true,
    reader: {
      async blockNumber() {
        const results = await batch(endpoint, [{ method: "eth_blockNumber", params: [] }], fetcher);
        const value = results.get(1);
        if (!isHexQuantity(value)) throw new ChainReadError("eth_blockNumber did not answer with a block height.", "invalid-response");
        return hexToNumber(value);
      },

      async getLogs(filter) {
        const params: Record<string, unknown> = {
          fromBlock: `0x${filter.fromBlock.toString(16)}`,
          toBlock: `0x${filter.toBlock.toString(16)}`,
          topics: [
            TRANSFER_TOPIC,
            null,
            filter.toAddresses && filter.toAddresses.length > 0 ? filter.toAddresses.map(padTopic) : null,
          ],
        };
        if (filter.address) params.address = filter.address;
        const results = await batch(endpoint, [{ method: "eth_getLogs", params: [params] }], fetcher);
        return readLogs(results.get(1));
      },

      async getBlock(number) {
        const results = await batch(endpoint, [{ method: "eth_getBlockByNumber", params: [`0x${number.toString(16)}`, true] }], fetcher);
        return readBlock(results.get(1));
      },

      async getTransactionReceipt(hash) {
        const results = await batch(endpoint, [{ method: "eth_getTransactionReceipt", params: [hash] }], fetcher);
        return readReceipt(results.get(1));
      },

      async call(to, data) {
        const results = await batch(endpoint, [{ method: "eth_call", params: [{ to, data }, "latest"] }], fetcher);
        const value = results.get(1);
        return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? value : null;
      },
    },
  };
}

/**
 * `keccak256("Transfer(address,address,uint256)")` — the ERC-20 transfer topic.
 * Written literally rather than computed so it is greppable and cannot change
 * shape if a hashing helper is refactored.
 */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export type DecodedTransfer = {
  tokenAddress: string;
  from: string;
  to: string;
  rawAmount: string;
};

/** Decode one ERC-20 `Transfer` log, or null when it is not one we can read. */
export function decodeTransferLog(log: ChainLog): DecodedTransfer | null {
  if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return null;
  const from = log.topics[1];
  const to = log.topics[2];
  if (!from || !to || !/^0x[0-9a-fA-F]{64}$/.test(from) || !/^0x[0-9a-fA-F]{64}$/.test(to)) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(log.data)) return null;
  try {
    return {
      tokenAddress: log.address,
      from: `0x${from.slice(26)}`,
      to: `0x${to.slice(26)}`,
      rawAmount: BigInt(log.data).toString(),
    };
  } catch {
    return null;
  }
}
