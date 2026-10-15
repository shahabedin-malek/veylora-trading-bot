import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "./route";

test("credential balance verification refuses when auth configuration is unavailable", async () => {
  const previous = {
    chainIds: process.env.AUTH_EVM_CHAIN_IDS,
    appBaseUrl: process.env.APP_BASE_URL,
    sessionSecret: process.env.SESSION_SECRET,
  };
  delete process.env.AUTH_EVM_CHAIN_IDS;
  delete process.env.APP_BASE_URL;
  delete process.env.SESSION_SECRET;

  try {
    const origin = "http://localhost";
    const response = await POST(new Request(new URL("/api/trading/credentials/credential-id/verify", origin), {
      method: "POST",
      headers: { Origin: origin },
    }) as never, { params: Promise.resolve({ credentialId: "credential-id" }) });
    assert.equal(response.status, 503);
  } finally {
    if (previous.chainIds === undefined) delete process.env.AUTH_EVM_CHAIN_IDS;
    else process.env.AUTH_EVM_CHAIN_IDS = previous.chainIds;
    if (previous.appBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous.appBaseUrl;
    if (previous.sessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.sessionSecret;
  }
});