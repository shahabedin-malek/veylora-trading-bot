import assert from "node:assert/strict";
import test from "node:test";
import { DELETE, GET, POST } from "./route";

test("market alert list fails closed when authentication is not configured", async () => {
  const previous = {
    chainIds: process.env.AUTH_EVM_CHAIN_IDS,
    appBaseUrl: process.env.APP_BASE_URL,
    sessionSecret: process.env.SESSION_SECRET,
  };
  delete process.env.AUTH_EVM_CHAIN_IDS;
  delete process.env.APP_BASE_URL;
  delete process.env.SESSION_SECRET;
  try {
    const response = await GET();
    assert.equal(response.status, 401);
  } finally {
    if (previous.chainIds === undefined) delete process.env.AUTH_EVM_CHAIN_IDS;
    else process.env.AUTH_EVM_CHAIN_IDS = previous.chainIds;
    if (previous.appBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous.appBaseUrl;
    if (previous.sessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.sessionSecret;
  }
});

test("market alert changes fail closed when authentication is not configured", async () => {
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
    const request = (method: string, body: unknown) => new Request(new URL("/api/market-alerts", origin), {
      method,
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    }) as never;
    const create = await POST(request("POST", { symbol: "BTC-USD", condition: "PRICE_ABOVE", threshold: "1" }));
    const remove = await DELETE(request("DELETE", { alertId: "alert-id" }));
    assert.equal(create.status, 503);
    assert.equal(remove.status, 503);
  } finally {
    if (previous.chainIds === undefined) delete process.env.AUTH_EVM_CHAIN_IDS;
    else process.env.AUTH_EVM_CHAIN_IDS = previous.chainIds;
    if (previous.appBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous.appBaseUrl;
    if (previous.sessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.sessionSecret;
  }
});