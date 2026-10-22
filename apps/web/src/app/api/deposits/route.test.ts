import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "./route";
import { GET as GET_ADDRESS } from "./[address]/route";

/**
 * What the deposit routes do when the deployment cannot authenticate anybody.
 *
 * A missing auth configuration is a *configuration gap*, not a signed-out visitor:
 * the answer is a 503 that names the variable the deployment needs, because a 401
 * would send the owner looking for a session problem that does not exist. The
 * deposit routes answer in the same shape as every other guarded read here, and
 * this test is what keeps that true — including for the per-address route, whose
 * address is a lookup key and never an authorization.
 */

const AUTH_NAMES = ["AUTH_EVM_CHAIN_IDS", "APP_BASE_URL", "SESSION_SECRET"] as const;

function withoutAuthConfig<T>(run: () => Promise<T>): Promise<T> {
  const previous = AUTH_NAMES.map((name) => [name, process.env[name]] as const);
  for (const name of AUTH_NAMES) delete process.env[name];
  return run().finally(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function request(path: string, method: string): Request {
  const origin = "http://localhost";
  return new Request(new URL(path, origin), {
    method,
    headers: { "Content-Type": "application/json", Origin: origin },
    ...(method === "POST" ? { body: "{}" } : {}),
  }) as never;
}

test("the deposit read fails closed when authentication is not configured", async () => {
  const response = await withoutAuthConfig(() => GET());
  assert.equal(response.status, 503);
  assert.match(
    ((await response.json()) as { error: string }).error,
    /APP_BASE_URL|AUTH_EVM_CHAIN_IDS|SESSION_SECRET/,
  );
});

test("asking for a deposit check fails closed when authentication is not configured", async () => {
  const response = await withoutAuthConfig(() => POST(request("/api/deposits", "POST") as never));
  assert.equal(response.status, 503);
  assert.match(
    ((await response.json()) as { error: string }).error,
    /APP_BASE_URL|AUTH_EVM_CHAIN_IDS|SESSION_SECRET/,
  );
});

test("the per-address read fails closed when authentication is not configured", async () => {
  const response = await withoutAuthConfig(() =>
    GET_ADDRESS(request("/api/deposits/0x1111111111111111111111111111111111111111", "GET") as never, {
      params: Promise.resolve({ address: "0x1111111111111111111111111111111111111111" }),
    }),
  );
  assert.equal(response.status, 503);
  assert.match(
    ((await response.json()) as { error: string }).error,
    /APP_BASE_URL|AUTH_EVM_CHAIN_IDS|SESSION_SECRET/,
  );
});
