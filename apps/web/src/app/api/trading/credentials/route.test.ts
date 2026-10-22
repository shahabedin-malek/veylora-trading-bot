import assert from "node:assert/strict";
import test from "node:test";
import { DELETE, GET, POST } from "./route";
import { POST as verifyBalance } from "./[credentialId]/verify/route";

test("trading credential API fails closed when authentication is not configured", async () => {
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
    const origin = "http://localhost";
    const request = (method: string, body: unknown) => new Request(new URL("/api/trading/credentials", origin), {
      method,
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    }) as never;
    const createResponse = await POST(request("POST", {
      venue: "binance",
      apiKey: "test-key",
      apiSecret: "test-secret",
    }));
    const revokeResponse = await DELETE(request("DELETE", { credentialId: "credential-id" }));
    const verifyResponse = await verifyBalance(new Request(new URL("/api/trading/credentials/credential-id/verify", origin), {
      method: "POST",
      headers: { Origin: origin },
    }) as never, { params: Promise.resolve({ credentialId: "credential-id" }) });

    // No usable auth configuration is a configuration gap, not a signed-out
    // visitor: the read answers 503 and names the value it needs.
    assert.equal(readResponse.status, 503);
    assert.match(((await readResponse.json()) as { error: string }).error, /APP_BASE_URL|AUTH_EVM_CHAIN_IDS|SESSION_SECRET/);
    assert.equal(createResponse.status, 503);
    assert.equal(revokeResponse.status, 503);
    assert.equal(verifyResponse.status, 503);
  } finally {
    if (previous.chainIds === undefined) delete process.env.AUTH_EVM_CHAIN_IDS;
    else process.env.AUTH_EVM_CHAIN_IDS = previous.chainIds;
    if (previous.appBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous.appBaseUrl;
    if (previous.sessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.sessionSecret;
  }
});