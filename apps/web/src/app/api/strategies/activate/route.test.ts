import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "./route";

/**
 * The activation route carries the read control and the start. What a deployment with no
 * usable auth configuration can answer is the configuration gap itself — for both verbs,
 * rather than half-executing a start.
 */
test("the activation route keeps the read and the start unavailable without auth configuration", async () => {
  const previous = {
    chainIds: process.env.AUTH_EVM_CHAIN_IDS,
    appBaseUrl: process.env.APP_BASE_URL,
    sessionSecret: process.env.SESSION_SECRET,
  };
  delete process.env.AUTH_EVM_CHAIN_IDS;
  delete process.env.APP_BASE_URL;
  delete process.env.SESSION_SECRET;

  const localOrigin = ["http:", "", "localhost"].join("/");

  try {
    const getResponse = await GET();
    const postResponse = await POST(new Request(new URL("/api/strategies/activate", localOrigin), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: localOrigin },
      body: "{}",
    }) as never);
    assert.equal(getResponse.status, 503);
    assert.match((await getResponse.json() as { error: string }).error, /APP_BASE_URL|AUTH_EVM_CHAIN_IDS|SESSION_SECRET/);
    assert.equal(postResponse.status, 503);
  } finally {
    if (previous.chainIds === undefined) delete process.env.AUTH_EVM_CHAIN_IDS;
    else process.env.AUTH_EVM_CHAIN_IDS = previous.chainIds;
    if (previous.appBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous.appBaseUrl;
    if (previous.sessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.sessionSecret;
  }
});
