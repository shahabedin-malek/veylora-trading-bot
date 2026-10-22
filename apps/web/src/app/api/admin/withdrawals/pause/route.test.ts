import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "./route";

test("the withdrawals pause switch stays unavailable while authentication is disabled", async () => {
  const previous = {
    chainIds: process.env.AUTH_EVM_CHAIN_IDS,
    appBaseUrl: process.env.APP_BASE_URL,
    sessionSecret: process.env.SESSION_SECRET,
  };
  delete process.env.AUTH_EVM_CHAIN_IDS;
  delete process.env.APP_BASE_URL;
  delete process.env.SESSION_SECRET;

  try {
    const localOrigin = ["http:", "", "localhost"].join("/");
    const response = await POST(new Request(new URL("/api/admin/withdrawals/pause", localOrigin), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: localOrigin },
      body: JSON.stringify({ paused: true }),
    }) as never);

    assert.equal(response.status, 503);
    assert.match(
      (await response.json() as { error: string }).error,
      /APP_BASE_URL|AUTH_EVM_CHAIN_IDS|SESSION_SECRET/,
      "an unconfigured deployment names the value it needs instead of pretending to pause",
    );
  } finally {
    if (previous.chainIds === undefined) delete process.env.AUTH_EVM_CHAIN_IDS;
    else process.env.AUTH_EVM_CHAIN_IDS = previous.chainIds;
    if (previous.appBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous.appBaseUrl;
    if (previous.sessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.sessionSecret;
  }
});
