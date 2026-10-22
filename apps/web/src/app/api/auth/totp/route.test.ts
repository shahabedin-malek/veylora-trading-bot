import assert from "node:assert/strict";
import test from "node:test";
import { DELETE, GET, POST } from "./route";

/**
 * The authenticator routes, asked by a deployment that cannot authenticate
 * anyone and by nobody at all.
 *
 * Both answers matter more than they look. A deployment with no usable
 * authentication configuration is a configuration gap, so it names the variable
 * that is missing (503) rather than asking the visitor to sign in to a sign-in
 * that can never complete. And a request with no session is refused (401) — but
 * only once the deployment *can* authenticate, which is the case these tests
 * cannot reach without a running server; that path is covered by the click-path.
 */

const AUTH_ENV_NAMES = ["AUTH_EVM_CHAIN_IDS", "APP_BASE_URL", "SESSION_SECRET"] as const;

async function withoutAuthConfiguration(run: () => Promise<unknown>) {
  const previous = AUTH_ENV_NAMES.map((name) => [name, process.env[name]] as const);
  for (const name of AUTH_ENV_NAMES) delete process.env[name];
  try {
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("the authenticator API names the missing configuration instead of asking for a sign-in", async () => {
  await withoutAuthConfiguration(async () => {
    const read = await GET();
    assert.equal(read.status, 503);
    assert.match((await read.json() as { error: string }).error, /AUTH_EVM_CHAIN_IDS|APP_BASE_URL|SESSION_SECRET/);

    const origin = ["http:", "", "localhost"].join("/");
    const enrol = await POST(new Request(new URL("/api/auth/totp", origin), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({}),
    }) as never);
    assert.equal(enrol.status, 503);

    const disable = await DELETE(new Request(new URL("/api/auth/totp", origin), {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ code: "123456" }),
    }) as never);
    assert.equal(disable.status, 503);
  });
});

test("a cross-origin enrolment is refused before anything is issued", async () => {
  const previous = {
    chainIds: process.env.AUTH_EVM_CHAIN_IDS,
    baseUrl: process.env.APP_BASE_URL,
    secret: process.env.SESSION_SECRET,
  };
  process.env.AUTH_EVM_CHAIN_IDS = "1";
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.SESSION_SECRET = "a-test-only-session-secret-long-enough-to-sign";

  try {
    const response = await POST(new Request(new URL("/api/auth/totp", "http://localhost:3000"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
      body: JSON.stringify({}),
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
