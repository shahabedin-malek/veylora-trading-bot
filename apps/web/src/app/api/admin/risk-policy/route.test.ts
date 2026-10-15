import assert from "node:assert/strict";
import test from "node:test";
import { GET, PUT } from "./route";

test("risk policy API keeps reads and writes unavailable without auth configuration", async () => {
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
    const putResponse = await PUT(new Request(new URL("/api/admin/risk-policy", localOrigin), {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: localOrigin },
      body: "{}",
    }) as never);
    assert.equal(getResponse.status, 401);
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