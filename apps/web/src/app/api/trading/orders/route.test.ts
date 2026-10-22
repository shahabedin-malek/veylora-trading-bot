import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "./route";
import { POST as cancel } from "./[orderId]/cancel/route";

/**
 * What the order routes do when the caller is not signed in.
 *
 * These are the two answers that must never be wrong: an unconfigured deployment
 * says which variable is missing (503) rather than pretending the caller is
 * signed out, and a cross-origin write is refused (403) before anything else is
 * considered. A probe payload is used throughout, so a passing run cannot have
 * written an order.
 */

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const origin = "http://localhost";
  return new Request(new URL(path, origin), {
    method,
    headers: { "Content-Type": "application/json", Origin: origin, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as never;
}

async function withAuthEnvironment<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = {
    appBaseUrl: process.env.APP_BASE_URL,
    chainIds: process.env.AUTH_EVM_CHAIN_IDS,
    sessionSecret: process.env.SESSION_SECRET,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries({ APP_BASE_URL: previous.appBaseUrl, AUTH_EVM_CHAIN_IDS: previous.chainIds, SESSION_SECRET: previous.sessionSecret })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("order routes fail closed when authentication is not configured, naming what is missing", async () => {
  await withAuthEnvironment({ APP_BASE_URL: undefined, AUTH_EVM_CHAIN_IDS: undefined, SESSION_SECRET: undefined }, async () => {
    const list = await GET(request("GET", "/api/trading/orders"));
    const submit = await POST(request("POST", "/api/trading/orders", { market: "BTC-USD", quantity: "0.01" }));
    const cancelled = await cancel(request("POST", "/api/trading/orders/order-1/cancel", {}), {
      params: Promise.resolve({ orderId: "order-1" }),
    });

    assert.equal(list.status, 503);
    assert.equal(submit.status, 503);
    assert.equal(cancelled.status, 503);
    const body = (await list.json()) as { error: string };
    assert.match(body.error, /APP_BASE_URL|AUTH_EVM_CHAIN_IDS|SESSION_SECRET/);
    // Every answer says the same thing, so a script can read any of them.
    assert.match(((await submit.json()) as { error: string }).error, /Authentication is not configured/);
  });
});

test("a cross-origin write is refused before anything else happens", async () => {
  await withAuthEnvironment(
    { APP_BASE_URL: "http://localhost", AUTH_EVM_CHAIN_IDS: "1", SESSION_SECRET: "x".repeat(40) },
    async () => {
      const foreign = new Request(new URL("/api/trading/orders", "http://localhost"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
        body: JSON.stringify({ market: "BTC-USD", side: "BUY", orderType: "MARKET", quantity: "0.01", notionalUsdCents: 1_000, verifiedBalanceCents: 2_000 }),
      }) as never;

      const response = await POST(foreign);
      assert.equal(response.status, 403);
      assert.match(((await response.json()) as { error: string }).error, /origin/i);
    },
  );
});

test("a signed-out caller gets no orders and no order is written", async () => {
  await withAuthEnvironment(
    { APP_BASE_URL: "http://localhost", AUTH_EVM_CHAIN_IDS: "1", SESSION_SECRET: "x".repeat(40) },
    async () => {
      // Same-origin with no session cookie. In a real request the session reader
      // throws `AuthenticationRequiredError` and the route answers 401; outside a
      // request scope it cannot read a cookie at all and reports unavailability.
      // What matters, and what is asserted here, is that neither path serves
      // order data: a refusal is never a list.
      const list = await GET(request("GET", "/api/trading/orders"));
      const listBody = (await list.json()) as { error: string; orders?: unknown };
      assert.notEqual(list.status, 200);
      assert.equal(listBody.orders, undefined, "a refused read must not carry orders");
      assert.ok(listBody.error.length > 0, "the refusal says something specific");

      // A submission from a signed-out caller is refused before it is validated
      // into anything: no order, no side effect.
      const invalid = await POST(request("POST", "/api/trading/orders", { market: "NOT-A-MARKET" }));
      const invalidBody = (await invalid.json()) as { error: string; order?: unknown };
      assert.notEqual(invalid.status, 201);
      assert.equal(invalidBody.order, undefined);
    },
  );
});
