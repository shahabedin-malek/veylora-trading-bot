import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST, PUT } from "./route";

/**
 * What this route can answer without a database, which is the two things that must never
 * depend on one: a deployment with no usable auth configuration, and a definition that
 * cannot run. The second is answered *before* authorization on purpose — the owner gets the
 * problem, not a login error that hides it.
 */

const ORIGIN = "http://localhost:3000";

async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = {
    chainIds: process.env.AUTH_EVM_CHAIN_IDS,
    appBaseUrl: process.env.APP_BASE_URL,
    sessionSecret: process.env.SESSION_SECRET,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    if (previous.chainIds === undefined) delete process.env.AUTH_EVM_CHAIN_IDS;
    else process.env.AUTH_EVM_CHAIN_IDS = previous.chainIds;
    if (previous.appBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous.appBaseUrl;
    if (previous.sessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.sessionSecret;
  }
}

function post(body: unknown): never {
  return new Request(`${ORIGIN}/api/strategies`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify(body),
  }) as never;
}

function put(body: unknown): never {
  return new Request(`${ORIGIN}/api/strategies`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify(body),
  }) as never;
}

test("the strategy list and edits stay unavailable while authentication is unconfigured", async () => {
  await withEnv(
    { AUTH_EVM_CHAIN_IDS: undefined, APP_BASE_URL: undefined, SESSION_SECRET: undefined },
    async () => {
      const response = await GET();
      assert.equal(response.status, 503);
      assert.match(((await response.json()) as { error: string }).error, /APP_BASE_URL|AUTH_EVM_CHAIN_IDS|SESSION_SECRET/);

      const manual = await POST(post({ mode: "manual", text: "STRATEGY \"x\"" }));
      assert.equal(manual.status, 503);

      const edit = await PUT(put({ id: "definition-1", text: "STRATEGY \"x\"" }));
      assert.equal(edit.status, 503);
    },
  );
});

test("a definition that cannot run is refused with the named problem before authorization", async () => {
  await withEnv(
    { AUTH_EVM_CHAIN_IDS: "1", APP_BASE_URL: ORIGIN, SESSION_SECRET: "test-session-secret-value-long-enough" },
    async () => {
      const response = await POST(post({
        mode: "manual",
        text: [
          'STRATEGY "Bad"',
          "MARKET BTC-USD",
          "TIMEFRAME 1d",
          "ENTRY RSI(14) CROSS_BELOW 70",
          "EXIT RSI(14) CROSS_ABOVE 30",
          "SIZE 0% OF CAPITAL",
          "STOP NONE",
          "DAILY_HALT 2%",
          "LEVERAGE 1x",
        ].join("\n"),
      }));
      assert.equal(response.status, 422);
      const payload = (await response.json()) as { issues?: string[] };
      assert.ok(payload.issues?.some((issue) => /size must be a percentage/.test(issue)), JSON.stringify(payload));
      assert.ok(payload.issues?.some((issue) => /entry threshold \(70\)/.test(issue)), JSON.stringify(payload));
    },
  );
});
