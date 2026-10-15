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
    assert.equal(readResponse.status, 401);
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