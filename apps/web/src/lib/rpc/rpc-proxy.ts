import type { Logger } from "@/lib/observability/logger";
import { instrumentFetch, PROVIDER_IDS, reasonForProviderResponse, reasonForThrownCall } from "@/lib/observability/provider-call";
import { describeReason } from "@/lib/observability/reason";
import { resolveRequestContext } from "@/lib/observability/request-context";
import { networkSkipDecision, recordNetworkFailure, recordNetworkSuccess } from "./health";
import { resolveRpcEndpoint, rpcConfigurationVariableName } from "./networks";

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

/**
 * The same-origin check, refusing with the reason it refused.
 *
 * A missing `APP_BASE_URL` is a configuration gap, not a bad caller, so it answers
 * 503 naming the variable instead of a bare 403 that hides the cause.
 */
function sameOriginRefusal(request: Request): { status: number; error: string } | null {
  const origin = request.headers.get("origin");
  const appBaseUrl = process.env.APP_BASE_URL;
  if (!origin) return { status: 403, error: "A same-origin request is required." };
  if (!appBaseUrl) return { status: 503, error: "APP_BASE_URL is not configured, so request origin cannot be verified." };
  try {
    if (new URL(origin).origin !== new URL(appBaseUrl).origin) {
      return { status: 403, error: "Request origin is not allowed." };
    }
  } catch {
    return { status: 503, error: "APP_BASE_URL is not a usable origin, so request origin cannot be verified." };
  }
  return null;
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
  // Recorded like every other outbound call: the endpoint is key-bearing, so the
  // record stores the redacted URL and never the endpoint itself.
  const fetcher = instrumentFetch({ providerId: PROVIDER_IDS.alchemyRpc, fetcher: deps.fetch ?? fetch });
  const env = deps.env ?? process.env;

  const originRefusal = sameOriginRefusal(request);
  if (originRefusal) return json({ error: originRefusal.error }, originRefusal.status);
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
    if (resolution.reason === "invalid-network") return json({ error: "Unknown network." }, 404);
    // Name the value that would enable it. The shared key is the fallback, the
    // per-network variable is preferred, and both are safe to name.
    const variable = rpcConfigurationVariableName(network);
    return json({
      error: variable
        ? `${variable} is not configured, and no shared ALCHEMY_API_KEY covers this network.`
        : "No Alchemy RPC endpoint is configured for this network.",
    }, 503);
  }
  if (!consumeRateLimit(request)) return json({ error: "RPC request limit exceeded." }, 429);

  // A network this process has watched fail repeatedly is skipped for a bounded
  // cooldown, with the wait stated. The caller can retry rather than hang.
  const skip = networkSkipDecision(resolution.slug);
  if (skip.skip) {
    return json({ error: skip.reason, retryable: true, retryAfterMs: skip.retryAfterMs }, 503);
  }

  const startedAt = Date.now();
  try {
    const upstream = await fetcher(resolution.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!upstream.ok) {
      const failure = reasonForProviderResponse(PROVIDER_IDS.alchemyRpc, upstream.status);
      recordNetworkFailure(resolution.slug, failure.code);
      (await currentLogger())?.error("rpc proxy: upstream refused the call", {
        network: resolution.slug,
        statusCode: upstream.status,
        reason: describeReason(failure),
        reasonCode: failure.code,
      });
      return json({ error: `${resolution.slug} answered ${upstream.status}. Try again.`, retryable: true }, 502);
    }
    const result: unknown = await upstream.json();
    recordNetworkSuccess(resolution.slug, Date.now() - startedAt);
    return json(result);
  } catch (error) {
    const failure = reasonForThrownCall(PROVIDER_IDS.alchemyRpc, error);
    recordNetworkFailure(resolution.slug, failure.code);
    (await currentLogger())?.error("rpc proxy: upstream call failed", {
      network: resolution.slug,
      reason: describeReason(failure),
      reasonCode: failure.code,
      error,
    });
    return json({ error: `${resolution.slug} did not answer before the request ended. Try again.`, retryable: true }, 502);
  }
}

/**
 * The logger this request logs through: the pinned context when a caller set
 * one, otherwise the one the middleware's headers describe. Null outside a
 * request (a script, a build), which is why every call site guards it.
 */
async function currentLogger(): Promise<Logger | null> {
  const context = await resolveRequestContext();
  return context?.logger ?? null;
}
