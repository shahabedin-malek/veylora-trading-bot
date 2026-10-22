import assert from "node:assert/strict";
import test from "node:test";
import { handleAdminHealth } from "./route";

const AUTH_ENV = {
  chainIds: process.env.AUTH_EVM_CHAIN_IDS,
  appBaseUrl: process.env.APP_BASE_URL,
  sessionSecret: process.env.SESSION_SECRET,
};

function restoreAuthEnv() {
  for (const [name, value] of Object.entries({
    AUTH_EVM_CHAIN_IDS: AUTH_ENV.chainIds,
    APP_BASE_URL: AUTH_ENV.appBaseUrl,
    SESSION_SECRET: AUTH_ENV.sessionSecret,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test("without auth configuration the health endpoint names what is missing and never probes a dependency", async () => {
  delete process.env.AUTH_EVM_CHAIN_IDS;
  delete process.env.APP_BASE_URL;
  delete process.env.SESSION_SECRET;
  let probed = false;

  try {
    const response = await handleAdminHealth({
      probe: async () => {
        probed = true;
        return { reachable: true, detail: "probed" };
      },
    });
    assert.equal(response.status, 503);
    assert.match((await response.json() as { error: string }).error, /APP_BASE_URL|AUTH_EVM_CHAIN_IDS|SESSION_SECRET/);
    assert.equal(probed, false, "an unconfigured deployment should not touch a provider or a database");
  } finally {
    restoreAuthEnv();
  }
});

test("an unreachable database answers 503 naming DATABASE_URL instead of an empty snapshot", async () => {
  process.env.AUTH_EVM_CHAIN_IDS = "1";
  process.env.APP_BASE_URL = "https://veylora.example";
  process.env.SESSION_SECRET = "test-only-placeholder-secret-32-bytes-minimum";
  let snapshotRead = false;

  try {
    const response = await handleAdminHealth({
      probe: async () => ({ reachable: false, detail: "The database did not answer a probe query: connect ECONNREFUSED", variable: "DATABASE_URL" }),
      snapshot: async () => {
        snapshotRead = true;
        throw new Error("the snapshot must not be read while the database is down");
      },
    });
    const body = await response.json() as { error: string; variable?: string; reason?: { code: string } };
    assert.equal(response.status, 503);
    assert.equal(body.variable, "DATABASE_URL");
    assert.equal(body.reason?.code, "DATABASE_UNAVAILABLE");
    assert.ok(body.error.includes("DATABASE_URL") || body.error.includes("unreachable"));
    assert.equal(snapshotRead, false);
  } finally {
    restoreAuthEnv();
  }
});

test("a reachable database still refuses a caller who cannot be authorized", async () => {
  process.env.AUTH_EVM_CHAIN_IDS = "1";
  process.env.APP_BASE_URL = "https://veylora.example";
  process.env.SESSION_SECRET = "test-only-placeholder-secret-32-bytes-minimum";
  let snapshotRead = false;

  try {
    const response = await handleAdminHealth({
      probe: async () => ({ reachable: true, detail: "The database answered a probe query." }),
      snapshot: async () => {
        snapshotRead = true;
        throw new Error("the snapshot must not be read for a caller who is not authorized");
      },
    });
    const body = await response.json() as { error?: string; providers?: unknown };
    assert.ok(response.status === 401 || response.status === 503, `unexpected status ${response.status}`);
    assert.equal(body.providers, undefined, "no provider data may leave an unauthorized answer");
    assert.equal(snapshotRead, false);
  } finally {
    restoreAuthEnv();
  }
});
