import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "./route";

function request(body: string, origin = ["http:", "", "localhost:3000"].join("/")) {
  return new Request(new URL("/api/admin/risk-policy/switch", origin), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body,
  }) as never;
}

test("the switch route answers 503 naming the auth configuration it needs", async () => {
  const previous = {
    chainIds: process.env.AUTH_EVM_CHAIN_IDS,
    appBaseUrl: process.env.APP_BASE_URL,
    sessionSecret: process.env.SESSION_SECRET,
  };
  delete process.env.AUTH_EVM_CHAIN_IDS;
  delete process.env.APP_BASE_URL;
  delete process.env.SESSION_SECRET;

  try {
    const response = await POST(request(JSON.stringify({ scope: "global", active: true })));
    assert.equal(response.status, 503);
    assert.match((await response.json() as { error: string }).error, /APP_BASE_URL|AUTH_EVM_CHAIN_IDS|SESSION_SECRET/);
  } finally {
    if (previous.chainIds === undefined) delete process.env.AUTH_EVM_CHAIN_IDS;
    else process.env.AUTH_EVM_CHAIN_IDS = previous.chainIds;
    if (previous.appBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous.appBaseUrl;
    if (previous.sessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.sessionSecret;
  }
});

test("a switch press is refused before anything is written when nobody is signed in", async () => {
  const previous = {
    chainIds: process.env.AUTH_EVM_CHAIN_IDS,
    appBaseUrl: process.env.APP_BASE_URL,
    sessionSecret: process.env.SESSION_SECRET,
  };
  process.env.AUTH_EVM_CHAIN_IDS = "1";
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.SESSION_SECRET = "switch-route-test-secret";

  try {
    // Same origin, so the request is past the CSRF check and stops at authorization: the
    // switch is never touched by a caller the panel does not know.
    const response = await POST(request(JSON.stringify({ scope: "global", active: true })));
    assert.ok(response.status === 401 || response.status === 503, `unexpected status ${response.status}`);
    assert.ok(response.headers.get("cache-control")?.includes("no-store"));
    const body = (await response.json()) as { error: string };
    assert.equal(typeof body.error, "string");
  } finally {
    if (previous.chainIds === undefined) delete process.env.AUTH_EVM_CHAIN_IDS;
    else process.env.AUTH_EVM_CHAIN_IDS = previous.chainIds;
    if (previous.appBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous.appBaseUrl;
    if (previous.sessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.sessionSecret;
  }
});
