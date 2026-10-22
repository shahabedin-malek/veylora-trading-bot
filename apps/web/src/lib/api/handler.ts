import { Buffer } from "node:buffer";
import { prisma } from "@/lib/db";
import { ApiProblem, ApiResult, isRecord } from "@/lib/api/problem";
import {
  authenticateApiRequest,
  createPrismaApiKeyAuthStore,
  scopeRefusal,
  type ApiAuthFailure,
  type ApiKeyAuthStore,
} from "@/lib/api/auth";
import {
  consumeApiRateLimit,
  createPrismaApiRateLimitStore,
  rateLimitHeaders,
  type ApiRateLimitResult,
  type ApiRateLimitStore,
} from "@/lib/api/limits";
import { API_ROUTES, findApiRoute, type ApiRouteSpec } from "@/lib/api/routes";
import { auditCreate } from "@/lib/audit/record";

/**
 * One request, from bearer to body.
 *
 * The order is deliberate: authenticate, find the route, count the request, check the
 * scope, then parse the body. A read-only key that calls a write route is refused before a
 * byte of its body is interpreted, and a request that cannot be authenticated never creates
 * a rate-window row for a key it does not own.
 *
 * The rate counters are headers on every answer, not only on the 429, so a client can slow
 * down before it is refused. Exceeding the allowance is a 429 whose body carries the same
 * limit and reset as the headers.
 */

const MAX_BODY_BYTES = 64 * 1024;

export type ApiHandlerDeps = {
  authStore?: ApiKeyAuthStore;
  rateLimitStore?: ApiRateLimitStore;
  routes?: readonly ApiRouteSpec[];
  now?: () => Date;
  audit?: (input: {
    actorUserId: string | null;
    action: string;
    objectType: string;
    objectId: string | null;
    detail: Record<string, unknown>;
  }) => Promise<void>;
};

function baseHeaders(): Record<string, string> {
  return { "Cache-Control": "no-store" };
}

function json(
  data: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return Response.json(data, { status, headers: { ...baseHeaders(), ...headers } });
}

function failureResponse(failure: ApiAuthFailure): Response {
  return json(
    { error: failure.message, code: failure.code, ...(failure.requiredScope ? { requiredScope: failure.requiredScope } : {}) },
    failure.status,
    failure.status === 401 ? { "WWW-Authenticate": 'Bearer realm="veylora"' } : {},
  );
}

function pathFrom(input: string | readonly string[]): string {
  const raw = typeof input === "string" ? input : input.join("/");
  const trimmed = raw.replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}` : "/";
}

async function readBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiProblem(415, "CONTENT_TYPE_REQUIRED", "Send the body as application/json.");
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    throw new ApiProblem(400, "BODY_UNREADABLE", "The request body could not be read.");
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    throw new ApiProblem(413, "BODY_TOO_LARGE", `The request body is larger than ${MAX_BODY_BYTES} bytes.`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiProblem(400, "BODY_INVALID_JSON", "The request body is not valid JSON.");
  }
}

async function recordScopeRefusal(
  deps: ApiHandlerDeps,
  input: { actorUserId: string | null; keyPrefix: string; method: string; path: string; requiredScope: string },
) {
  const write = deps.audit ?? defaultAudit;
  try {
    await write({
      actorUserId: input.actorUserId,
      action: "API_SCOPE_REFUSED",
      objectType: "ApiKey",
      objectId: null,
      detail: {
        keyPrefix: input.keyPrefix,
        method: input.method,
        path: input.path,
        requiredScope: input.requiredScope,
      },
    });
  } catch {
    // A refusal is still a refusal when the audit table cannot be written. The response is
    // the authority; the missing row is visible as an audit gap rather than a trade.
  }
}

async function defaultAudit(input: {
  actorUserId: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  detail: Record<string, unknown>;
}) {
  await auditCreate(prisma, {
    data: {
      actorUserId: input.actorUserId,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      outcome: "SUCCESS",
      redactedJson: JSON.stringify(input.detail),
    },
  });
}

function rateHeaders(result: ApiRateLimitResult | null): Record<string, string> {
  return result ? rateLimitHeaders(result) : {};
}

export async function serveApiRequest(input: {
  request: Request;
  method: "GET" | "POST";
  path: string | readonly string[];
  deps?: ApiHandlerDeps;
}): Promise<Response> {
  const deps = input.deps ?? {};
  const now = deps.now?.() ?? new Date();
  const path = pathFrom(input.path);

  const outcome = await authenticateApiRequest(
    input.request,
    deps.authStore ?? createPrismaApiKeyAuthStore(),
    now,
  );
  if (!outcome.ok) return failureResponse(outcome.failure);
  const principal = outcome.principal;

  const route = findApiRoute(input.method, path, deps.routes ?? API_ROUTES);
  if (!route) {
    return json(
      { error: `No ${input.method} ${path} route exists in v1.`, code: "ROUTE_NOT_FOUND", docs: "/docs/api" },
      404,
    );
  }

  let rate: ApiRateLimitResult;
  try {
    rate = await consumeApiRateLimit({
      store: deps.rateLimitStore ?? createPrismaApiRateLimitStore(),
      keyId: principal.keyId,
      limit: principal.rateLimitPerMinute,
      now,
    });
  } catch {
    return json(
      {
        error: "The rate limiter could not count this request, so it was not served. No work was done.",
        code: "RATE_LIMIT_UNAVAILABLE",
      },
      503,
    );
  }
  const headers = rateHeaders(rate);
  if (!rate.allowed) {
    return json(
      {
        error: `Rate limit exceeded: ${rate.limit} requests per minute for this key. Try again after ${rate.resetAt}.`,
        code: "RATE_LIMITED",
        limit: rate.limit,
        remaining: 0,
        resetAt: rate.resetAt,
      },
      429,
      { ...headers, "Retry-After": String(Math.max(1, Math.ceil((new Date(rate.resetAt).getTime() - now.getTime()) / 1000))) },
    );
  }

  const denial = scopeRefusal(principal, route.scope);
  if (denial) {
    await recordScopeRefusal(deps, {
      actorUserId: principal.ownerUserId,
      keyPrefix: principal.keyPrefix,
      method: input.method,
      path,
      requiredScope: route.scope,
    });
    return json(
      { error: denial.message, code: denial.code, requiredScope: denial.requiredScope, keyScopes: principal.scopes },
      403,
      headers,
    );
  }

  let body: unknown = null;
  if (input.method === "POST") {
    try {
      body = await readBody(input.request);
      if (!isRecord(body)) throw new ApiProblem(400, "BODY_INVALID", "The request body must be a JSON object.");
    } catch (error) {
      if (error instanceof ApiProblem) {
        return json({ error: error.message, code: error.code }, error.status, headers);
      }
      return json({ error: "The request body could not be read.", code: "BODY_UNREADABLE" }, 400, headers);
    }
  }

  try {
    const data = await route.handler({
      principal,
      query: new URL(input.request.url).searchParams,
      body,
      request: input.request,
      now,
    });
    if (data instanceof ApiResult) return json(data.body, data.status, headers);
    return json(data, 200, headers);
  } catch (error) {
    if (error instanceof ApiProblem) {
      return json(
        {
          error: error.message,
          code: error.code,
          ...(error.detail ? { detail: error.detail } : {}),
        },
        error.status,
        headers,
      );
    }
    return json(
      {
        error: "The API could not complete this request. Nothing was changed after the failure was detected.",
        code: "API_UNAVAILABLE",
      },
      503,
      headers,
    );
  } finally {
    if (deps.authStore === undefined) {
      try {
        await (deps.authStore ?? createPrismaApiKeyAuthStore()).touch(principal.keyId, now);
      } catch {
        // Last-used is an observation, not part of the answer.
      }
    } else {
      try {
        await deps.authStore.touch(principal.keyId, now);
      } catch {
        // Same.
      }
    }
  }
}

export { pathFrom as normalizeApiPath };
