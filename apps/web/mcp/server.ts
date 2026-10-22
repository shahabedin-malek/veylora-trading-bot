#!/usr/bin/env node
/**
 * Veylora's MCP server (phase 32).
 *
 * A stdio JSON-RPC server with no SDK dependency: the protocol surface this build needs is
 * `initialize`, `tools/list` and `tools/call`, and the tools themselves are the public API's
 * own route handlers. Nothing is opened on the network, nothing is printed except JSON-RPC
 * frames, and the key is read from `VEYLORA_API_KEY` for each call so a revocation takes
 * effect without restarting the client.
 *
 * The server never logs the key. A refusal is returned as a tool result with `isError` and
 * the same code REST would answer with.
 */
import { createInterface } from "node:readline";
import { authenticateApiKeyValue, createPrismaApiKeyAuthStore, scopeRefusal } from "../src/lib/api/auth";
import { consumeApiRateLimit, createPrismaApiRateLimitStore } from "../src/lib/api/limits";
import { ApiProblem } from "../src/lib/api/problem";
import { invokeApiTool, toolsForScopes } from "../src/lib/api/tools";

const SERVER_NAME = "veylora";
const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2025-06-18";
const KEY_ENV = "VEYLORA_API_KEY";

/**
 * stdout carries JSON-RPC frames and nothing else. The service layer logs one JSON line per
 * provider call through `process.stdout.write`, and on a stdio transport that line is a
 * protocol error the client may answer by dropping the session. The frame writer is captured
 * before the first request is read, then every other stdout write is aimed at stderr, where a
 * client's log pane expects it and where it cannot be mistaken for a response.
 */
const writeFrame = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

function send(payload: unknown): void {
  writeFrame(`${JSON.stringify(payload)}\n`);
}

function result(id: JsonRpcId, value: unknown): void {
  send({ jsonrpc: "2.0", id, result: value });
}

function rpcError(id: JsonRpcId, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolErrorText(error: unknown): { code: string; message: string } {
  if (error instanceof ApiProblem) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: "TOOL_FAILED", message: error.message };
  return { code: "TOOL_FAILED", message: "The tool call failed." };
}

async function readPrincipal() {
  const key = process.env[KEY_ENV]?.trim();
  if (!key) {
    return {
      ok: false as const,
      message: `${KEY_ENV} is not set. Put an API key from /admin/access in the MCP client's environment.`,
    };
  }
  const outcome = await authenticateApiKeyValue(key, createPrismaApiKeyAuthStore());
  if (!outcome.ok) return { ok: false as const, message: `${outcome.failure.code}: ${outcome.failure.message}` };
  return { ok: true as const, principal: outcome.principal };
}

async function handleToolsList(id: JsonRpcId): Promise<void> {
  const auth = await readPrincipal();
  if (!auth.ok) {
    rpcError(id, -32001, auth.message);
    return;
  }
  const tools = toolsForScopes(auth.principal.scopes).map((tool) => ({
    name: tool.name,
    description: `${tool.description} (scope: ${tool.scope})`,
    inputSchema: tool.inputSchema,
  }));
  result(id, { tools });
}

async function handleToolsCall(id: JsonRpcId, params: unknown): Promise<void> {
  if (typeof params !== "object" || params === null) {
    rpcError(id, -32602, "tools/call needs a name and arguments.");
    return;
  }
  const { name, arguments: args } = params as { name?: unknown; arguments?: unknown };
  if (typeof name !== "string" || !name) {
    rpcError(id, -32602, "tools/call needs a tool name.");
    return;
  }

  const auth = await readPrincipal();
  if (!auth.ok) {
    result(id, { content: [{ type: "text", text: auth.message }], isError: true });
    return;
  }

  const tool = toolsForScopes(auth.principal.scopes).find((candidate) => candidate.name === name);
  if (!tool) {
    result(id, {
      content: [
        {
          type: "text",
          text: `No tool named ${name} is available to this key. Call tools/list to see its scopes.`,
        },
      ],
      isError: true,
    });
    return;
  }
  const denial = scopeRefusal(auth.principal, tool.scope);
  if (denial) {
    result(id, { content: [{ type: "text", text: `${denial.code}: ${denial.message}` }], isError: true });
    return;
  }

  try {
    const rate = await consumeApiRateLimit({
      store: createPrismaApiRateLimitStore(),
      keyId: auth.principal.keyId,
      limit: auth.principal.rateLimitPerMinute,
    });
    if (!rate.allowed) {
      result(id, {
        content: [
          {
            type: "text",
            text: `RATE_LIMITED: ${rate.limit} requests per minute for this key. Try again after ${rate.resetAt}.`,
          },
        ],
        isError: true,
      });
      return;
    }
    const data = await invokeApiTool({ name, args, principal: auth.principal });
    result(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false });
  } catch (error) {
    const failure = toolErrorText(error);
    result(id, {
      content: [{ type: "text", text: `${failure.code}: ${failure.message}` }],
      isError: true,
    });
  }
}

export async function handleRequest(request: JsonRpcRequest): Promise<void> {
  const id = request.id ?? null;
  const method = request.method;

  if (request.jsonrpc !== "2.0" || typeof method !== "string") {
    rpcError(id, -32600, "Invalid JSON-RPC 2.0 request.");
    return;
  }

  if (method === "initialize") {
    result(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") {
    result(id, {});
    return;
  }
  if (method === "tools/list") {
    await handleToolsList(id);
    return;
  }
  if (method === "tools/call") {
    await handleToolsCall(id, request.params);
    return;
  }
  rpcError(id, -32601, `Method not found: ${method}`);
}

function main(): void {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      rpcError(null, -32700, "Invalid JSON.");
      return;
    }
    void handleRequest(parsed).catch((error: unknown) => {
      const failure = toolErrorText(error);
      rpcError(parsed.id ?? null, -32603, `${failure.code}: ${failure.message}`);
    });
  });
}

main();
