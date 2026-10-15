import { resolveRpcEndpoint } from "./networks";

/**
 * Multi-network JSON-RPC proxy.
 *
 * Replaces the old single-network `ethereum-proxy.ts`. Behaviour now:
 *  - any configured network resolves through {@link resolveRpcEndpoint};
 *  - requests are forwarded as-is (no per-method allow-list);
 *  - the key stays server-side; it never appears in a response body.
 *
 * Kept as anti-abuse hygiene (not capability limits): same-origin check, request
 * size cap, and a per-IP rate limit.
 */

const MAX_BODY_BYTES = 32_768;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 120;
const rateBuckets = new Map<string, { startedAt: number; count: number }>();

type FetchLike = typeof fetch;

export type RpcProxyDeps = {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
};

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function sameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  const appBaseUrl = process.env.APP_BASE_URL;
  if (!origin || !appBaseUrl) return false;
  try {
    return new URL(origin).origin === new URL(appBaseUrl).origin;
  } catch {
    return false;
  }
}

function isJsonRpcPayload(value: unknown): value is {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return payload.jsonrpc === "2.0" &&
    (typeof payload.id === "string" || typeof payload.id === "number" || payload.id === null) &&
    typeof payload.method === "string" && payload.method.length > 0 &&
    (payload.params === undefined || Array.isArray(payload.params));
}

function consumeRateLimit(request: Request) {
  const ip = request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const current = rateBuckets.get(ip);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(ip, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= RATE_LIMIT) return false;
  current.count += 1;
  return true;
}

export async function handleNetworkRpcPost(
  request: Request,
  network: string,
  deps: RpcProxyDeps = {},
): Promise<Response> {
  const fetcher = deps.fetch ?? fetch;
  const env = deps.env ?? process.env;

  if (!sameOriginRequest(request)) return json({ error: "Request origin is not allowed." }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413);

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    return json({ error: "Invalid JSON-RPC request." }, 400);
  }
  if (!isJsonRpcPayload(payload)) return json({ error: "Unsupported JSON-RPC request." }, 400);

  const resolution = resolveRpcEndpoint(network, env);
  if (!resolution.ok) {
    return resolution.reason === "invalid-network"
      ? json({ error: "Unknown network." }, 404)
      : json({ error: "This network is not configured." }, 503);
  }
  if (!consumeRateLimit(request)) return json({ error: "RPC request limit exceeded." }, 429);

  try {
    const upstream = await fetcher(resolution.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!upstream.ok) return json({ error: "RPC provider is unavailable." }, 502);
    const result: unknown = await upstream.json();
    return json(result);
  } catch {
    return json({ error: "RPC provider is unavailable." }, 502);
  }
}
