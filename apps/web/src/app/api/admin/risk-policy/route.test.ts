import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RISK_POLICY } from "@/lib/risk-controls/policy";
import { validateRiskPolicyUpdate } from "@/lib/risk-controls/settings";
import { GET, PUT } from "./route";

/** Run one assertion with the auth variables set, then put the environment back. */
async function withAuthConfigured(run: () => Promise<void>) {
  const previous = {
    chainIds: process.env.AUTH_EVM_CHAIN_IDS,
    appBaseUrl: process.env.APP_BASE_URL,
    sessionSecret: process.env.SESSION_SECRET,
  };
  process.env.AUTH_EVM_CHAIN_IDS = "1";
  process.env.APP_BASE_URL = "http://localhost:3000";
  // The session secret must be at least 32 bytes or the config is treated as absent.
  process.env.SESSION_SECRET = "risk-policy-route-test-secret-0123456789";
  try {
    await run();
  } finally {
    if (previous.chainIds === undefined) delete process.env.AUTH_EVM_CHAIN_IDS;
    else process.env.AUTH_EVM_CHAIN_IDS = previous.chainIds;
    if (previous.appBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous.appBaseUrl;
    if (previous.sessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.sessionSecret;
  }
}

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
test("a save from another origin is refused before the session is looked at", async () => {
  await withAuthConfigured(async () => {
    const response = await PUT(new Request("http://localhost:3000/api/admin/risk-policy", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ ...DEFAULT_RISK_POLICY, killSwitchActive: false, liveExecutionEnabled: false }),
    }) as never);
    assert.equal(response.status, 403);
    assert.match((await response.json() as { error: string }).error, /origin/i);
  });
});

test("a save without a session never reaches validation or storage", async () => {
  await withAuthConfigured(async () => {
    // The phase-25 caps travel in the same body; none of them is read before the caller is
    // known, so an unauthenticated press cannot change a limit or a switch.
    const response = await PUT(new Request("http://localhost:3000/api/admin/risk-policy", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ ...DEFAULT_RISK_POLICY, killSwitchActive: true, liveExecutionEnabled: false, maxOrderNotionalUsd: "1" }),
    }) as never);
    assert.ok(response.status === 401 || response.status === 503, `unexpected status ${response.status}`);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(typeof (await response.json() as { error: string }).error, "string");
  });
});

test("what the read answers can be saved back, read-only metadata and all", () => {
  // The defect this phase's walk found: the GET body carries facts the server derives
  // (`limitsEffectiveFrom`, the switches' audit fields), so a save that rejected them made
  // every panel edit fail. They are accepted and ignored, never written from the request.
  const read = {
    ...DEFAULT_RISK_POLICY,
    approvedSymbols: ["BTC-USD"],
    killSwitchActive: false,
    liveExecutionEnabled: true,
    liveExecutionChangedByUserId: "owner-1",
    liveExecutionChangedAt: "2026-10-18T08:00:00.000Z",
    limitsEffectiveFrom: { maxOrderNotionalUsd: "2026-10-18T09:00:00.000Z" },
    cooldownUntil: null,
    killSwitchChangedByUserId: null,
    killSwitchChangedAt: null,
  };
  const validation = validateRiskPolicyUpdate(read);
  assert.equal(validation.valid, true);
  if (!validation.valid) return;
  assert.equal(validation.value.liveExecutionEnabled, true);
  for (const readOnly of ["limitsEffectiveFrom", "cooldownUntil", "killSwitchChangedAt", "liveExecutionChangedByUserId"]) {
    assert.equal(readOnly in validation.value, false, `${readOnly} must not be written from a request`);
  }
});
