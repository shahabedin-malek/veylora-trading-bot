import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "./route";

test("WunderTrading reads require an authenticated user", async () => {
  const previous = {
    chainIds: process.env.AUTH_EVM_CHAIN_IDS,
    appBaseUrl: process.env.APP_BASE_URL,
    sessionSecret: process.env.SESSION_SECRET,
  };
  delete process.env.AUTH_EVM_CHAIN_IDS;
  delete process.env.APP_BASE_URL;
  delete process.env.SESSION_SECRET;

  try {
    const request = new Request("http://localhost/api/trading/wundertrading?view=profiles&credentialId=credential") as never;
    assert.equal((await GET(request)).status, 401);
  } finally {
    if (previous.chainIds === undefined) delete process.env.AUTH_EVM_CHAIN_IDS;
    else process.env.AUTH_EVM_CHAIN_IDS = previous.chainIds;
    if (previous.appBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous.appBaseUrl;
    if (previous.sessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.sessionSecret;
  }
});