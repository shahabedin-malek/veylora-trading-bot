import assert from "node:assert/strict";
import test from "node:test";
import {
  NETWORK_SKIP_COOLDOWN_MS,
  NETWORK_SKIP_THRESHOLD,
  networkHealthSnapshot,
  networkSkipDecision,
  recordNetworkFailure,
  recordNetworkSuccess,
  resetNetworkHealth,
} from "@/lib/rpc/health";

test("one or two failures do not skip a network", () => {
  resetNetworkHealth();
  const now = Date.now();
  recordNetworkFailure("base-mainnet", "UPSTREAM_500", now);
  recordNetworkFailure("base-mainnet", "UPSTREAM_500", now + 10);
  assert.equal(networkSkipDecision("base-mainnet", now + 20).skip, false);
});

test("the threshold skips with a stated wait, then the cooldown retries it", () => {
  resetNetworkHealth();
  const now = Date.now();
  for (let index = 0; index < NETWORK_SKIP_THRESHOLD; index += 1) {
    recordNetworkFailure("arb-mainnet", "TIMEOUT", now + index);
  }
  const skipped = networkSkipDecision("arb-mainnet", now + 100);
  assert.equal(skipped.skip, true);
  assert.ok(skipped.retryAfterMs > 0);
  assert.match(skipped.reason ?? "", /skipped after 3 consecutive failures/);
  assert.match(skipped.reason ?? "", /TIMEOUT/);

  // Exactly at the end of the cooldown it is tried again rather than skipped forever.
  assert.equal(networkSkipDecision("arb-mainnet", now + 2 + NETWORK_SKIP_COOLDOWN_MS).skip, false);
});

test("a success clears both the failure count and the skip", () => {
  resetNetworkHealth();
  const now = Date.now();
  for (let index = 0; index < NETWORK_SKIP_THRESHOLD; index += 1) {
    recordNetworkFailure("opt-mainnet", "TIMEOUT", now + index);
  }
  assert.equal(networkSkipDecision("opt-mainnet", now + 10).skip, true);
  recordNetworkSuccess("opt-mainnet", 87, now + 20);

  assert.equal(networkSkipDecision("opt-mainnet", now + 30).skip, false);
  const record = networkHealthSnapshot().find(({ slug }) => slug === "opt-mainnet")!;
  assert.equal(record.consecutiveFailures, 0);
  assert.equal(record.lastLatencyMs, 87);
  assert.equal(record.lastProblem, null);
  assert.equal(record.requests, NETWORK_SKIP_THRESHOLD + 1);
});

test("the snapshot reports ISO times and is sorted", () => {
  resetNetworkHealth();
  recordNetworkSuccess("zora-mainnet", 12, 1_700_000_000_000);
  recordNetworkFailure("base-mainnet", "UPSTREAM_502", 1_700_000_001_000);

  const snapshot = networkHealthSnapshot();
  assert.deepEqual(snapshot.map(({ slug }) => slug), ["base-mainnet", "zora-mainnet"]);
  assert.equal(snapshot[0]!.lastFailureAt, new Date(1_700_000_001_000).toISOString());
  assert.equal(snapshot[0]!.lastSuccessAt, null);
  assert.equal(snapshot[1]!.lastSuccessAt, new Date(1_700_000_000_000).toISOString());
});

test("an unrecorded network is never skipped and reset forgets everything", () => {
  resetNetworkHealth();
  assert.equal(networkSkipDecision("never-called").skip, false);
  recordNetworkFailure("never-called", "TIMEOUT");
  assert.equal(networkHealthSnapshot().length, 1);
  resetNetworkHealth();
  assert.deepEqual(networkHealthSnapshot(), []);
});
