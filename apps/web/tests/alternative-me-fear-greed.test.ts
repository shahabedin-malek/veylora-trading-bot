import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALTERNATIVE_ME_FEAR_GREED_URL,
  getBitcoinFearGreedIndex,
  parseBitcoinFearGreedResponse,
  resetFearGreedCacheForTests,
} from "@/lib/market-data/alternative-me-fear-greed";

const response = {
  name: "Fear and Greed Index",
  data: [{ value: "62", value_classification: "Greed", timestamp: "1791907200", time_until_update: "21600" }],
  metadata: { error: null },
};

test("Alternative.me parser validates the current Bitcoin sentiment fields", () => {
  assert.deepEqual(parseBitcoinFearGreedResponse(response), {
    value: 62,
    classification: "Greed",
    observedAt: "2026-10-13T16:00:00.000Z",
    nextUpdateSeconds: 21_600,
  });
  assert.throws(() => parseBitcoinFearGreedResponse({ data: [{ value: "101", value_classification: "Greed", timestamp: "1" }] }));
  assert.throws(() => parseBitcoinFearGreedResponse({ data: [{ value: "62", value_classification: "unknown", timestamp: "1" }] }));
});

test("Alternative.me reader uses the fixed HTTPS endpoint and caches five minutes", async () => {
  const previousFetch = globalThis.fetch;
  let observedUrl = "";
  let calls = 0;
  globalThis.fetch = async (input) => {
    observedUrl = String(input);
    calls += 1;
    return Response.json(response);
  };
  resetFearGreedCacheForTests();
  try {
    const first = await getBitcoinFearGreedIndex(1_000);
    const second = await getBitcoinFearGreedIndex(2_000);
    assert.equal(observedUrl, ALTERNATIVE_ME_FEAR_GREED_URL);
    assert.equal(calls, 1);
    assert.deepEqual(second, first);
  } finally {
    globalThis.fetch = previousFetch;
    resetFearGreedCacheForTests();
  }
});