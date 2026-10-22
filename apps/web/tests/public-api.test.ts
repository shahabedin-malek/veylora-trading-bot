import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authenticateApiKeyValue,
  scopeRefusal,
  type ApiKeyAuthStore,
  type ApiKeyLookupRow,
} from "@/lib/api/auth";
import {
  generateApiKey,
  hashApiKey,
  normalizeScopes,
  publicApiKeyView,
  type ApiScope,
} from "@/lib/api/keys";
import {
  API_RATE_LIMIT_HEADER,
  API_RATE_RESET_HEADER,
  consumeApiRateLimit,
  type ApiRateLimitStore,
} from "@/lib/api/limits";
import { serveApiRequest } from "@/lib/api/handler";
import { approvalView } from "@/lib/api/service";
import { documentedRoutes } from "@/lib/api/docs";
import { API_ROUTES, type ApiRouteSpec } from "@/lib/api/routes";
import { API_TOOLS, invokeApiTool, toolsForScopes } from "@/lib/api/tools";
import {
  agentAccountScopeRefusal,
  agentScopeAuditDetail,
  validateAgentOrder,
} from "@/lib/api/trading";
import { ApiProblem } from "@/lib/api/problem";

/**
 * Phase 32's provable claims.
 *
 * The handler is exercised with in-memory stores, so "a read key cannot write", "a revoked
 * key is refused immediately" and "the third request in a two-per-minute window is a 429"
 * are asserted against the real dispatcher rather than a restatement of its rules. The
 * agent-account rule, the expiry derivation and the docs/tool parity are pure functions.
 */

const NOW = new Date("2026-10-19T18:00:30.000Z");
const READ_SECRET = "vyl_read-only-test-key-000000000000000000000000";
const TRADE_SECRET = "vyl_trade-agent-test-key-00000000000000000000";

function row(input: {
  id?: string;
  scopes: ApiScope[];
  secret?: string;
  rateLimitPerMinute?: number;
  revokedAt?: Date | null;
  agentAccountId?: string | null;
  status?: string;
}): ApiKeyLookupRow {
  return {
    id: input.id ?? "key_1",
    userId: "owner_1",
    label: "test key",
    prefix: (input.secret ?? READ_SECRET).slice(0, 12),
    scopesJson: JSON.stringify(input.scopes),
    agentAccountId: input.agentAccountId ?? null,
    rateLimitPerMinute: input.rateLimitPerMinute ?? 60,
    expiresAt: null,
    revokedAt: input.revokedAt ?? null,
    user: { status: input.status ?? "ACTIVE" },
    agentAccount: input.agentAccountId
      ? { id: input.agentAccountId, name: "Research agent", status: "ACTIVE", ledgerUserId: "agent_ledger_1" }
      : null,
  };
}

function authStore(rows: ApiKeyLookupRow[]): ApiKeyAuthStore {
  return {
    async findByHash(hash) {
      return rows.find((candidate) => hashApiKey(secretFor(candidate)) === hash) ?? null;
    },
    async touch() {},
  };
}

function secretFor(candidate: ApiKeyLookupRow): string {
  return candidate.id === "key_trade" ? TRADE_SECRET : READ_SECRET;
}

function memoryRateStore(): ApiRateLimitStore & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    async increment({ keyId, windowStart }) {
      const id = `${keyId}:${windowStart.toISOString()}`;
      const next = (counts.get(id) ?? 0) + 1;
      counts.set(id, next);
      return next;
    },
  };
}

function route(method: "GET" | "POST", path: string, scope: ApiScope): ApiRouteSpec {
  return {
    method,
    path,
    summary: `${method} ${path}`,
    description: "Test route.",
    scope,
    query: [],
    body: method === "POST" ? [{ name: "value", type: "string", required: true, description: "A value." }] : null,
    response: {},
    async handler() {
      return { ok: true };
    },
  };
}

const TEST_ROUTES = [route("GET", "/ping", "read"), route("POST", "/ping", "trade")];

function request(method: "GET" | "POST", secret: string | null, body?: unknown): Request {
  const headers = new Headers();
  if (secret) headers.set("Authorization", `Bearer ${secret}`);
  if (method === "POST") headers.set("Content-Type", "application/json");
  return new Request("http://localhost/api/v1/ping", {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify(body ?? { value: "x" }) } : {}),
  });
}

async function call(input: {
  method: "GET" | "POST";
  secret?: string | null;
  rows?: ApiKeyLookupRow[];
  routes?: ApiRouteSpec[];
  rateLimit?: ApiRateLimitStore;
  body?: unknown;
  audit?: (event: { action: string }) => Promise<void>;
}) {
  return serveApiRequest({
    request: request(input.method, input.secret === undefined ? READ_SECRET : input.secret, input.body),
    method: input.method,
    path: "/ping",
    deps: {
      routes: input.routes ?? TEST_ROUTES,
      authStore: authStore(input.rows ?? [row({ scopes: ["read"] })]),
      rateLimitStore: input.rateLimit ?? memoryRateStore(),
      now: () => NOW,
      audit: input.audit ?? (async () => {}),
    },
  });
}

// ── keys, scopes and the one-time value ──────────────────────────────────────

test("a generated key is shown once: the public view carries a prefix, never the key or its hash", () => {
  const generated = generateApiKey();
  assert.match(generated.plaintext, /^vyl_[A-Za-z0-9_-]{40,}$/);
  assert.equal(generated.hash, hashApiKey(generated.plaintext));
  assert.equal(generated.prefix.length, 12);

  const view = publicApiKeyView({
    id: "key_1",
    label: "reader",
    prefix: generated.prefix,
    scopes: ["read"],
    agentAccountId: null,
    rateLimitPerMinute: 60,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: NOW,
  });
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes(generated.plaintext), false);
  assert.equal(serialized.includes(generated.hash), false);
  assert.equal(view.prefix, generated.prefix);
});

test("scopes refuse unknown names and never let trade or agent float free of an account", () => {
  assert.deepEqual(normalizeScopes(["read", "read"], null), { valid: true, scopes: ["read"] });
  assert.equal(normalizeScopes([], null).valid, false);
  assert.equal(normalizeScopes(["read", "admin"], null).valid, false);
  assert.equal(normalizeScopes(["trade"], null).valid, false);
  assert.equal(normalizeScopes(["agent"], null).valid, false);
  assert.equal(normalizeScopes(["trade"], "agent_1").valid, true);
});

test("a read-only key reads, is refused a write with the required scope, and the refusal is audited", async () => {
  const audited: string[] = [];
  const read = await call({ method: "GET", audit: async (event) => { audited.push(event.action); } });
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { ok: true });

  const write = await call({ method: "POST", audit: async (event) => { audited.push(event.action); } });
  assert.equal(write.status, 403);
  const payload = (await write.json()) as { code: string; requiredScope: string };
  assert.equal(payload.code, "SCOPE_REQUIRED");
  assert.equal(payload.requiredScope, "trade");
  assert.deepEqual(audited, ["API_SCOPE_REFUSED"]);
});

test("a revoked key answers a specific 401 on the very next request", async () => {
  const revoked = await call({ method: "GET", rows: [row({ scopes: ["read"], revokedAt: NOW, id: "key_revoked" })] });
  assert.equal(revoked.status, 401);
  const payload = (await revoked.json()) as { code: string; error: string };
  assert.equal(payload.code, "API_KEY_REVOKED");
  assert.match(payload.error, /revoked at/);

  const missing = await call({ method: "GET", secret: null });
  assert.equal(missing.status, 401);
  assert.equal(((await missing.json()) as { code: string }).code, "API_KEY_MISSING");

  const unknown = await call({ method: "GET", secret: "vyl_not-a-key-that-exists-000000000000000000" });
  assert.equal(unknown.status, 401);
  assert.equal(((await unknown.json()) as { code: string }).code, "API_KEY_INVALID");
});

test("an agent key's scopes are valid only with its own agent account", async () => {
  const outcome = await authenticateApiKeyValue(
    TRADE_SECRET,
    authStore([
      row({
        id: "key_trade",
        secret: TRADE_SECRET,
        scopes: ["read", "trade", "agent"],
        agentAccountId: "agent_1",
      }),
    ]),
    NOW,
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.principal.agentAccountId, "agent_1");
  assert.equal(outcome.ok ? scopeRefusal(outcome.principal, "trade") : null, null);

  const broken = await authenticateApiKeyValue(
    TRADE_SECRET,
    authStore([row({ id: "key_trade", secret: TRADE_SECRET, scopes: ["trade"], agentAccountId: null })]),
    NOW,
  );
  assert.equal(broken.ok, false);
  assert.equal(broken.ok === false && broken.failure.code, "API_KEY_INVALID");
});

// ── rate limits ─────────────────────────────────────────────────────────────

test("the third request in a two-per-minute window is a 429 carrying the limit and the reset", async () => {
  const store = memoryRateStore();
  const limitRow = row({ id: "key_limited", scopes: ["read"], rateLimitPerMinute: 2 });

  const first = await call({ method: "GET", rows: [limitRow], rateLimit: store });
  const second = await call({ method: "GET", rows: [limitRow], rateLimit: store });
  const third = await call({ method: "GET", rows: [limitRow], rateLimit: store });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(third.status, 429);
  assert.equal(third.headers.get(API_RATE_LIMIT_HEADER), "2");
  assert.equal(third.headers.get(API_RATE_RESET_HEADER), "2026-10-19T18:01:00.000Z");

  const payload = (await third.json()) as { code: string; limit: number; remaining: number; resetAt: string };
  assert.equal(payload.code, "RATE_LIMITED");
  assert.equal(payload.limit, 2);
  assert.equal(payload.remaining, 0);
  assert.equal(payload.resetAt, "2026-10-19T18:01:00.000Z");

  const direct = await consumeApiRateLimit({ store, keyId: "other", limit: 1, now: NOW });
  assert.equal(direct.allowed, true);
  assert.equal(direct.remaining, 0);
  assert.equal(direct.resetAt, "2026-10-19T18:01:00.000Z");
});

// ── the agent's one account ─────────────────────────────────────────────────

test("a trade request naming another agent account is refused and its audit payload names both accounts", () => {
  const refusal = agentAccountScopeRefusal("agent_mine", "agent_theirs");
  assert.ok(refusal instanceof ApiProblem);
  assert.equal(refusal.status, 403);
  assert.equal(refusal.code, "AGENT_ACCOUNT_SCOPE");
  assert.match(refusal.message, /agent_mine.*agent_theirs/);

  const detail = agentScopeAuditDetail({
    keyPrefix: "vyl_abcdefgh",
    keyAgentAccountId: "agent_mine",
    requestedAgentAccountId: "agent_theirs",
    market: "BTC-USD",
    notionalUsdCents: 2_500,
  });
  assert.equal(detail.requestedAgentAccountId, "agent_theirs");
  assert.equal(detail.keyAgentAccountId, "agent_mine");
  assert.equal(detail.reason, "The API key may trade only inside its dedicated agent account.");

  assert.equal(agentAccountScopeRefusal("agent_mine", "agent_mine"), null);
  assert.equal(agentAccountScopeRefusal("agent_mine", null), null);
});

test("an agent order body needs a market, side, quantity and a limit price only for a limit order", () => {
  const market = validateAgentOrder({ market: "btc-usd", side: "BUY", orderType: "MARKET", quantity: "0.001" });
  assert.equal(market.market, "BTC-USD");
  assert.equal(market.limitPrice, null);

  assert.throws(
    () => validateAgentOrder({ market: "BTC-USD", side: "BUY", orderType: "LIMIT", quantity: "0.001" }),
    (error: unknown) => error instanceof ApiProblem && error.code === "ORDER_INVALID",
  );
  assert.throws(
    () => validateAgentOrder({ market: "NOT-A-MARKET", side: "BUY", orderType: "MARKET", quantity: "0.001" }),
    (error: unknown) => error instanceof ApiProblem && error.code === "ORDER_INVALID",
  );
});

test("an approval past its expiry is reported as EXPIRED with the expiry preserved", () => {
  const base = {
    id: "approval_1",
    status: "PENDING",
    market: "BTC-USD",
    side: "BUY",
    quantity: "0.001",
    notionalUsdCents: 500_000,
    createdAt: new Date("2026-10-19T17:50:00.000Z"),
    decidedAt: null,
    orderId: null,
    agentAccountId: "agent_1",
    decisionNote: null,
    agentAccount: { name: "Research agent" },
    apiKey: { prefix: "vyl_abcdefgh" },
  };
  const live = approvalView({ ...base, expiresAt: new Date("2026-10-19T18:10:00.000Z") }, NOW);
  assert.equal(live.effectiveStatus, "PENDING");
  assert.equal(live.expired, false);

  const expired = approvalView({ ...base, expiresAt: new Date("2026-10-19T17:59:00.000Z") }, NOW);
  assert.equal(expired.effectiveStatus, "EXPIRED");
  assert.equal(expired.expired, true);
  assert.equal(expired.expiresAt, "2026-10-19T17:59:00.000Z");
});

// ── docs and MCP parity ─────────────────────────────────────────────────────

test("the docs are generated from the routes, every route is documented and every example is a placeholder", () => {
  const docs = documentedRoutes();
  assert.equal(docs.length, API_ROUTES.length);
  for (const spec of API_ROUTES) {
    const doc = docs.find((candidate) => candidate.method === spec.method && candidate.path === spec.path);
    assert.ok(doc, `${spec.method} ${spec.path} is not documented`);
    assert.equal(doc.scope, spec.scope);
    assert.equal(doc.fullPath, `/api/v1${spec.path}`);
    assert.match(doc.curl, /vyl_replace_me/);
    assert.equal(/vyl_[A-Za-z0-9_-]{20,}/.test(doc.curl), false);
  }
  const identities = new Set(API_ROUTES.map((spec) => `${spec.method} ${spec.path}`));
  assert.equal(identities.size, API_ROUTES.length);
});

test("every MCP tool names one route, carries its scope, and refuses a call outside the key's scopes", async () => {
  assert.equal(API_TOOLS.length, API_ROUTES.length);
  assert.deepEqual(
    API_TOOLS.map((tool) => `${tool.route.method} ${tool.route.path}`).sort(),
    API_ROUTES.map((route) => `${route.method} ${route.path}`).sort(),
  );
  for (const tool of API_TOOLS) assert.equal(tool.scope, tool.route.scope);

  const readOnly = toolsForScopes(["read"]).map((tool) => tool.name);
  assert.ok(readOnly.includes("get_account"));
  assert.equal(readOnly.includes("place_agent_order"), false);

  await assert.rejects(
    invokeApiTool({
      name: "place_agent_order",
      args: { market: "BTC-USD", side: "BUY", orderType: "MARKET", quantity: "0.001" },
      principal: {
        keyId: "key_read",
        ownerUserId: "owner_1",
        keyLabel: "reader",
        keyPrefix: "vyl_readonly",
        scopes: ["read"],
        agentAccountId: null,
        agentAccountName: null,
        agentAccountStatus: null,
        agentLedgerUserId: null,
        rateLimitPerMinute: 60,
      },
      now: NOW,
    }),
    (error: unknown) => error instanceof ApiProblem && error.code === "SCOPE_REQUIRED",
  );
});
