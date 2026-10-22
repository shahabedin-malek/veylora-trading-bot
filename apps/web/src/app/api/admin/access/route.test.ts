import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "./route";

test("access management API denies reads and writes when authentication is disabled", async () => {
  const previous = {
    chainIds: process.env.AUTH_EVM_CHAIN_IDS,
    appBaseUrl: process.env.APP_BASE_URL,
    sessionSecret: process.env.SESSION_SECRET,
  };
  delete process.env.AUTH_EVM_CHAIN_IDS;
  delete process.env.APP_BASE_URL;
  delete process.env.SESSION_SECRET;

  try {
    const readResponse = await GET();
    const origin = ["http:", "", "localhost"].join("/");
    const writeResponse = await POST(new Request(new URL("/api/admin/access", origin), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ action: "create-team", name: "Unauthorized" }),
    }) as never);
    // A deployment with no usable auth configuration is a configuration gap, not a
    // signed-out visitor: the read answers 503 and names the value it needs.
    assert.equal(readResponse.status, 503);
    assert.match((await readResponse.json() as { error: string }).error, /APP_BASE_URL|AUTH_EVM_CHAIN_IDS|SESSION_SECRET/);
    assert.equal(writeResponse.status, 503);
  } finally {
    if (previous.chainIds === undefined) delete process.env.AUTH_EVM_CHAIN_IDS;
    else process.env.AUTH_EVM_CHAIN_IDS = previous.chainIds;
    if (previous.appBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous.appBaseUrl;
    if (previous.sessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.sessionSecret;
  }
});

test("access management refuses another origin before it looks at the change", async () => {
  const previous = {
    chainIds: process.env.AUTH_EVM_CHAIN_IDS,
    appBaseUrl: process.env.APP_BASE_URL,
    sessionSecret: process.env.SESSION_SECRET,
  };
  process.env.AUTH_EVM_CHAIN_IDS = "1";
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";

  try {
    const response = await POST(new Request(new URL("/api/admin/access", "http://localhost:3000"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://somewhere-else.example" },
      body: JSON.stringify({ action: "create-team", name: "Cross site", reason: "a cross-site attempt" }),
    }) as never);
    // A configured deployment answers a foreign origin with 403 and never reaches
    // the authorization check, the reason rule or the database.
    assert.equal(response.status, 403);
    assert.match((await response.json() as { error: string }).error, /origin/i);
  } finally {
    if (previous.chainIds === undefined) delete process.env.AUTH_EVM_CHAIN_IDS;
    else process.env.AUTH_EVM_CHAIN_IDS = previous.chainIds;
    if (previous.appBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous.appBaseUrl;
    if (previous.sessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.sessionSecret;
  }
});