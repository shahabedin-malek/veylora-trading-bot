import assert from "node:assert/strict";
import test from "node:test";
import { DELETE, GET } from "./route";

/**
 * The per-activation route is where a stop lives, so it must refuse identically to the rest
 * of the app when the deployment has no usable auth configuration — and it must do so before
 * any ownership lookup, so a probe cannot learn whether an id exists.
 */
test("the per-activation route keeps the read and the stop unavailable without auth configuration", async () => {
  const previous = {
    chainIds: process.env.AUTH_EVM_CHAIN_IDS,
    appBaseUrl: process.env.APP_BASE_URL,
    sessionSecret: process.env.SESSION_SECRET,
  };
  delete process.env.AUTH_EVM_CHAIN_IDS;
  delete process.env.APP_BASE_URL;
  delete process.env.SESSION_SECRET;

  const localOrigin = ["http:", "", "localhost"].join("/");
  const params = Promise.resolve({ id: "route-sweep-probe" });

  try {
    const getResponse = await GET(
      new Request(new URL("/api/strategies/route-sweep-probe", localOrigin)) as never,
      { params },
    );
    const deleteResponse = await DELETE(
      new Request(new URL("/api/strategies/route-sweep-probe", localOrigin), {
        method: "DELETE",
        headers: { Origin: localOrigin },
      }) as never,
      { params },
    );

    assert.equal(getResponse.status, 503);
    assert.equal(deleteResponse.status, 503);
  } finally {
    if (previous.chainIds === undefined) delete process.env.AUTH_EVM_CHAIN_IDS;
    else process.env.AUTH_EVM_CHAIN_IDS = previous.chainIds;
    if (previous.appBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous.appBaseUrl;
    if (previous.sessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.sessionSecret;
  }
});
