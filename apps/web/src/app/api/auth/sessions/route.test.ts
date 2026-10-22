import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "./route";

/**
 * The session list, asked by a deployment that cannot authenticate anyone and by
 * a request from somewhere else.
 *
 * The list shows device labels and IP addresses — observations about where an
 * account was used — so the two refusals it can give without a session are worth
 * pinning: the configuration gap names the missing variable, and a cross-origin
 * mutation is refused before it reaches the store.
 */

const AUTH_ENV_NAMES = ["AUTH_EVM_CHAIN_IDS", "APP_BASE_URL", "SESSION_SECRET"] as const;

test("the session API names the missing configuration instead of asking for a sign-in", async () => {
  const previous = AUTH_ENV_NAMES.map((name) => [name, process.env[name]] as const);
  for (const name of AUTH_ENV_NAMES) delete process.env[name];
  try {
    const read = await GET();
    assert.equal(read.status, 503);
    assert.match((await read.json() as { error: string }).error, /AUTH_EVM_CHAIN_IDS|APP_BASE_URL|SESSION_SECRET/);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("a cross-origin revocation is refused, so another site cannot end your sessions", async () => {
  const previous = {
    chainIds: process.env.AUTH_EVM_CHAIN_IDS,
    baseUrl: process.env.APP_BASE_URL,
    secret: process.env.SESSION_SECRET,
  };
  process.env.AUTH_EVM_CHAIN_IDS = "1";
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.SESSION_SECRET = "a-test-only-session-secret-long-enough-to-sign";

  try {
    const response = await POST(new Request(new URL("/api/auth/sessions", "http://localhost:3000"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
      body: JSON.stringify({ action: "revoke-others" }),
    }) as never);
    assert.equal(response.status, 403);
    assert.match((await response.json() as { error: string }).error, /origin is not allowed/);
  } finally {
    if (previous.chainIds === undefined) delete process.env.AUTH_EVM_CHAIN_IDS;
    else process.env.AUTH_EVM_CHAIN_IDS = previous.chainIds;
    if (previous.baseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous.baseUrl;
    if (previous.secret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.secret;
  }
});
