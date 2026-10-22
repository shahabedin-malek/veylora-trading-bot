import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticationGapMessage,
  authenticationGapResponse,
  checkPageAccess,
  getAccessRefusal,
  getAuthenticationGap,
} from "../src/lib/auth/access-gate";
import { AuthenticationRequiredError, AuthorizationRequiredError } from "../src/lib/auth/session-store";

const AUTH_NAMES = ["APP_BASE_URL", "AUTH_EVM_CHAIN_IDS", "SESSION_SECRET"];

function withoutAuthConfiguration<T>(run: () => Promise<T> | T): Promise<T> | T {
  const previous = {
    appBaseUrl: process.env.APP_BASE_URL,
    chainIds: process.env.AUTH_EVM_CHAIN_IDS,
    sessionSecret: process.env.SESSION_SECRET,
  };
  delete process.env.APP_BASE_URL;
  delete process.env.AUTH_EVM_CHAIN_IDS;
  delete process.env.SESSION_SECRET;
  const restore = () => {
    if (previous.appBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous.appBaseUrl;
    if (previous.chainIds === undefined) delete process.env.AUTH_EVM_CHAIN_IDS;
    else process.env.AUTH_EVM_CHAIN_IDS = previous.chainIds;
    if (previous.sessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.sessionSecret;
  };
  try {
    const result = run();
    return result instanceof Promise ? result.finally(restore) : (restore(), result);
  } catch (error) {
    restore();
    throw error;
  }
}

test("an unconfigured deployment answers 503 naming a variable, not 401", async () => {
  await withoutAuthConfiguration(async () => {
    const response = authenticationGapResponse();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");

    const body = (await response.json()) as { error: string };
    assert.equal(body.error, authenticationGapMessage());
    assert.ok(AUTH_NAMES.some((name) => body.error.includes(name)), body.error);
  });
});

test("an authentication failure is a 503 naming the gap when sign-in is unconfigured", async () => {
  await withoutAuthConfiguration(() => {
    assert.ok(AUTH_NAMES.some((name) => getAuthenticationGap()?.includes(name)), getAuthenticationGap() ?? "null");

    const refusal = getAccessRefusal(new AuthenticationRequiredError());
    assert.equal(refusal?.status, 503);
    assert.ok(AUTH_NAMES.some((name) => refusal?.error.includes(name)), refusal?.error);
  });
});

test("the same failure is a 401 once sign-in is configured", async () => {
  const previous = {
    appBaseUrl: process.env.APP_BASE_URL,
    chainIds: process.env.AUTH_EVM_CHAIN_IDS,
    sessionSecret: process.env.SESSION_SECRET,
  };
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.AUTH_EVM_CHAIN_IDS = "1";
  process.env.SESSION_SECRET = "s".repeat(40);
  try {
    assert.equal(getAuthenticationGap(), null);
    assert.deepEqual(getAccessRefusal(new AuthenticationRequiredError()), { status: 401, error: "Authentication required." });
  } finally {
    if (previous.appBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous.appBaseUrl;
    if (previous.chainIds === undefined) delete process.env.AUTH_EVM_CHAIN_IDS;
    else process.env.AUTH_EVM_CHAIN_IDS = previous.chainIds;
    if (previous.sessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.sessionSecret;
  }
});

test("an authorization failure keeps its own message and status", () => {
  const refusal = getAccessRefusal(new AuthorizationRequiredError("This site function is not assigned to your account."));
  assert.deepEqual(refusal, { status: 403, error: "This site function is not assigned to your account." });
  assert.equal(getAccessRefusal(new Error("something else")), null);
});

test("a page reports the configuration gap instead of redirecting", async () => {
  await withoutAuthConfiguration(async () => {
    const access = await checkPageAccess({ kind: "admin" });
    assert.equal(access.status, "unconfigured");
    if (access.status !== "unconfigured") return;
    assert.ok(AUTH_NAMES.some((name) => access.reason.includes(name)), access.reason);
  });
});
