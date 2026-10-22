/**
 * A local chain stand-in for the deposit watcher and the withdrawal simulation.
 *
 * The watcher is a server-side reader: a browser route cannot intercept it, so a
 * real (loopback) JSON-RPC endpoint is the only way to exercise the actual
 * detection, confirmation and crediting path. This server answers the handful of
 * methods that path uses and nothing else. A plain-HTTP control surface lets a
 * spec place one transfer on it, so every transfer in the suite is explicit
 * rather than something a background process invented.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { E2E_CHAIN_ID, E2E_TOKEN, E2E_WRONG_TOKEN } from "./config";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BLOCK_HASH = `0x${"b".repeat(64)}`;
const BLOCK_NUMBER = 1_000;

type MockLog = {
  address: string;
  topics: string[];
  data: string;
  /** JSON-RPC quantities are hex strings, not numbers. */
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
  removed: boolean;
};

type State = {
  blockNumber: number;
  transactions: number;
  logs: MockLog[];
};

export type MockChain = {
  rpcUrl: string;
  controlUrl: string;
  close(): Promise<void>;
};

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw) as unknown;
}

function padTopic(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function blockTag(value: unknown, latest: number): number | null {
  if (typeof value !== "string") return null;
  if (value === "latest" || value === "pending") return latest;
  if (/^0x[0-9a-f]+$/i.test(value)) return Number.parseInt(value.slice(2), 16);
  return null;
}

function resultFor(state: State, method: string, params: unknown[]): unknown {
  switch (method) {
    case "eth_blockNumber":
      return `0x${state.blockNumber.toString(16)}`;
    case "eth_chainId":
      return `0x${E2E_CHAIN_ID.toString(16)}`;
    case "net_version":
      return String(E2E_CHAIN_ID);
    case "eth_getLogs": {
      const filter = (typeof params[0] === "object" && params[0] !== null ? params[0] : {}) as Record<string, unknown>;
      const topics = Array.isArray(filter.topics) ? filter.topics : [];
      const recipientTopics = Array.isArray(topics[2])
        ? new Set(topics[2].map((topic) => String(topic).toLowerCase()))
        : null;
      const address = typeof filter.address === "string" ? filter.address.toLowerCase() : null;
      return state.logs.filter((log) => {
        if (address && log.address.toLowerCase() !== address) return false;
        if (recipientTopics && !recipientTopics.has(log.topics[2]!.toLowerCase())) return false;
        return true;
      });
    }
    case "eth_getBlockByNumber": {
      const number = blockTag(params[0], state.blockNumber) ?? state.blockNumber;
      return {
        number: `0x${number.toString(16)}`,
        hash: BLOCK_HASH,
        parentHash: `0x${"a".repeat(64)}`,
        transactions: [],
      };
    }
    case "eth_getTransactionReceipt": {
      const hash = String(params[0] ?? "").toLowerCase();
      const logs = state.logs.filter((log) => log.transactionHash.toLowerCase() === hash);
      if (logs.length === 0) return null;
      return {
        transactionHash: logs[0]!.transactionHash,
        blockNumber: logs[0]!.blockNumber,
        blockHash: logs[0]!.blockHash,
        status: "0x1",
        logs,
      };
    }
    case "eth_call":
      // Every token on this mock reports six decimals; the enabled token is never
      // asked, and an unknown one is only asked so its units can be shown.
      return word(BigInt(6));
    case "eth_getBalance":
      return word(BigInt(0));
    default:
      throw new Error(`Mock chain does not implement ${method}.`);
  }
}

export async function startMockChain(input: { certPath: string; keyPath: string; rpcPort: number; controlPort: number }): Promise<MockChain> {
  const state: State = { blockNumber: BLOCK_NUMBER, transactions: 0, logs: [] };

  const rpcServer = createHttpsServer(
    { cert: readFileSync(input.certPath), key: readFileSync(input.keyPath) },
    async (request, response) => {
      if (request.method !== "POST" || !request.url?.startsWith("/rpc")) {
        json(response, 404, { error: "Use POST /rpc." });
        return;
      }
      let body: unknown;
      try {
        body = await readBody(request);
      } catch {
        json(response, 400, { error: "Invalid JSON." });
        return;
      }
      const batch = Array.isArray(body) ? body : [body];
      try {
        const answers = batch.map((entry) => {
          const call = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
          const method = typeof call.method === "string" ? call.method : "";
          const params = Array.isArray(call.params) ? call.params : [];
          return { jsonrpc: "2.0", id: call.id ?? null, result: resultFor(state, method, params) };
        });
        json(response, 200, Array.isArray(body) ? answers : answers[0]);
      } catch (error) {
        json(response, 200, {
          jsonrpc: "2.0",
          id: Array.isArray(body) ? null : ((body as { id?: unknown }).id ?? null),
          error: { code: -32601, message: error instanceof Error ? error.message : "Unsupported method." },
        });
      }
    },
  );

  const controlServer = createHttpServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { ok: true, blockNumber: state.blockNumber, logs: state.logs.length });
      return;
    }
    if (request.method !== "POST") {
      json(response, 404, { error: "Unknown control path." });
      return;
    }
    let body: unknown;
    try {
      body = await readBody(request);
    } catch {
      json(response, 400, { error: "Invalid JSON." });
      return;
    }
    const payload = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

    if (request.url === "/reset") {
      // Clear the pending transfers but keep the height moving: the watcher's
      // cursor is persisted per network, and a chain that rewound below it would
      // make every later transfer look like it happened in the past.
      state.logs = [];
      json(response, 200, { ok: true, blockNumber: state.blockNumber });
      return;
    }

    if (request.url === "/deposit") {
      const to = typeof payload.to === "string" ? payload.to : "";
      const token = typeof payload.token === "string" ? payload.token : E2E_TOKEN.address;
      const amount = typeof payload.amount === "string" ? payload.amount : "100000000";
      if (!/^0x[0-9a-fA-F]{40}$/.test(to) || !/^0x[0-9a-fA-F]{40}$/.test(token)) {
        json(response, 400, { error: "A recipient and a token address are required." });
        return;
      }
      if (!/^\d+$/.test(amount)) {
        json(response, 400, { error: "Amount must be an integer in the token's minor units." });
        return;
      }
      // Each transfer mines a block: the watcher advances a per-network cursor,
      // and a log written into an already-scanned block would be invisible.
      state.blockNumber += 1;
      // A counter, not the log count: `/reset` clears the logs between specs but
      // the database keeps the earlier hashes, and the watcher keys a transfer
      // by (network, transaction hash, log index).
      state.transactions += 1;
      const transactionHash = `0x${String(state.transactions).padStart(64, "0")}`;
      const log: MockLog = {
        address: token,
        topics: [TRANSFER_TOPIC, padTopic("0x9999999999999999999999999999999999999999"), padTopic(to)],
        data: word(BigInt(amount)),
        blockNumber: `0x${state.blockNumber.toString(16)}`,
        blockHash: BLOCK_HASH,
        transactionHash,
        transactionIndex: "0x0",
        logIndex: "0x0",
        removed: false,
      };
      state.logs.push(log);
      json(response, 200, {
        ok: true,
        transactionHash,
        token: token === E2E_TOKEN.address ? E2E_TOKEN.symbol : E2E_WRONG_TOKEN.symbol,
        to,
        amount,
      });
      return;
    }

    json(response, 404, { error: "Unknown control path." });
  });

  await Promise.all([
    new Promise<void>((resolve, reject) => {
      rpcServer.once("error", reject);
      rpcServer.listen(input.rpcPort, "127.0.0.1", () => resolve());
    }),
    new Promise<void>((resolve, reject) => {
      controlServer.once("error", reject);
      controlServer.listen(input.controlPort, "127.0.0.1", () => resolve());
    }),
  ]);

  return {
    rpcUrl: `https://127.0.0.1:${input.rpcPort}/rpc`,
    controlUrl: `http://127.0.0.1:${input.controlPort}`,
    async close() {
      await Promise.all([
        new Promise<void>((resolve) => rpcServer.close(() => resolve())),
        new Promise<void>((resolve) => controlServer.close(() => resolve())),
      ]);
    },
  };
}
