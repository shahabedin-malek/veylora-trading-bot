import assert from "node:assert/strict";
import test from "node:test";
import { GET, PUT } from "./route";

test("withdrawal admin settings stay unavailable while authentication is disabled", async () => {
  const previous = {
    chainIds: process.env.AUTH_EVM_CHAIN_IDS,
    appBaseUrl: process.env.APP_BASE_URL,
    sessionSecret: process.env.SESSION_SECRET,
  };
  delete process.env.AUTH_EVM_CHAIN_IDS;
  delete process.env.APP_BASE_URL;
  delete process.env.SESSION_SECRET;

  try {
    const getResponse = await GET();
    const localOrigin = ["http:", "", "localhost"].join("/");
    const putResponse = await PUT(new Request(new URL("/api/admin/withdrawals", localOrigin), {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: localOrigin },
      body: JSON.stringify({ newAddressWindowMinutes: 0 }),
    }) as never);
    // A deployment with no usable auth configuration is a configuration gap, not a
    // signed-out visitor: the read answers 503 and names the value it needs.
    assert.equal(getResponse.status, 503);
    assert.match((await getResponse.json() as { error: string }).error, /APP_BASE_URL|AUTH_EVM_CHAIN_IDS|SESSION_SECRET/);
    assert.equal(putResponse.status, 503);
  } finally {
    if (previous.chainIds === undefined) delete process.env.AUTH_EVM_CHAIN_IDS;
    else process.env.AUTH_EVM_CHAIN_IDS = previous.chainIds;
    if (previous.appBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous.appBaseUrl;
    if (previous.sessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.sessionSecret;
  }
});
