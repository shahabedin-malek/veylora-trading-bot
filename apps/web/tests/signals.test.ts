import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deliverPendingWebhooks,
  publishWebhookEvent,
  webhookBackoffSeconds,
  webhookSignature,
  WEBHOOK_MAX_ATTEMPTS,
  type WebhookDeliveryRow,
  type WebhookStore,
} from "@/lib/webhooks/dispatch";
import { mapSignal, signalRiskInput, type SignalBounds } from "@/lib/signals/map";
import {
  generateSignalToken,
  hashSignalToken,
  maskSignalToken,
  normalizeReplayWindowSeconds,
  openSecret,
  parseSignalTimestamp,
  sealSecret,
  signalSignature,
  verifySignal,
} from "@/lib/signals/verify";

/**
 * Phase 31's provable claims.
 *
 * The signature, the replay window and the mapping bounds are pure, so they are tested as
 * functions. The webhook retry rule is tested against a `WebhookStore` in memory, which is the
 * same seam the order path uses for its store: what has to hold is "attempt N+1 happens after
 * the backoff and the endpoint turns unhealthy after three failures", not "Prisma was called".
 */

const KEY = Buffer.alloc(32, 0x31).toString("hex");
const NOW = new Date("2026-10-19T10:00:00.000Z");

function withKey<T>(run: () => T): T {
  const previous = process.env.TRADING_CREDENTIAL_ENCRYPTION_KEY;
  process.env.TRADING_CREDENTIAL_ENCRYPTION_KEY = KEY;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.TRADING_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.TRADING_CREDENTIAL_ENCRYPTION_KEY = previous;
  }
}

// ---------------------------------------------------------------------------------------
// Signatures and replay protection
// ---------------------------------------------------------------------------------------

test("a correctly signed signal is accepted and a tampered body is refused", () => {
  const secret = "ss_test-signing-secret";
  const body = JSON.stringify({ signalId: "tv-1", action: "enter", market: "BTC-USD", sizeUsd: "25" });
  const timestamp = NOW.toISOString();

  const accepted = verifySignal({
    rawBody: body,
    signature: `sha256=${signalSignature(secret, timestamp, body)}`,
    timestamp,
    secret,
    replayWindowSeconds: 300,
    now: NOW,
  });
  assert.equal(accepted.ok, true);

  const tampered = verifySignal({
    rawBody: body.replace("25", "2500"),
    signature: `sha256=${signalSignature(secret, timestamp, body)}`,
    timestamp,
    secret,
    replayWindowSeconds: 300,
    now: NOW,
  });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.ok === false && tampered.code, "SIGNATURE_INVALID");

  const wrongSecret = verifySignal({
    rawBody: body,
    signature: signalSignature("ss_someone-else", timestamp, body),
    timestamp,
    secret,
    replayWindowSeconds: 300,
    now: NOW,
  });
  assert.equal(wrongSecret.ok, false);
});

test("a signature outside the owner's replay window is refused as stale, and the window is configurable", () => {
  const secret = "ss_window";
  const body = "{}";
  const timestamp = new Date(NOW.getTime() - 301_000).toISOString();
  const signature = signalSignature(secret, timestamp, body);

  const stale = verifySignal({ rawBody: body, signature, timestamp, secret, replayWindowSeconds: 300, now: NOW });
  assert.equal(stale.ok, false);
  assert.equal(stale.ok === false && stale.code, "TIMESTAMP_OUT_OF_WINDOW");
  assert.match(stale.ok === false ? stale.message : "", /301s.*300s/);

  const widened = verifySignal({ rawBody: body, signature, timestamp, secret, replayWindowSeconds: 600, now: NOW });
  assert.equal(widened.ok, true, "the same request is accepted once the owner widens the window");

  const future = verifySignal({
    rawBody: body,
    signature: signalSignature(secret, new Date(NOW.getTime() + 400_000).toISOString(), body),
    timestamp: new Date(NOW.getTime() + 400_000).toISOString(),
    secret,
    replayWindowSeconds: 300,
    now: NOW,
  });
  assert.equal(future.ok, false, "a timestamp in the future is bounded by the same window");
});

test("missing and unreadable signature material is refused with a named reason", () => {
  const base = { rawBody: "{}", secret: "ss_missing", replayWindowSeconds: 300, now: NOW };
  assert.equal((verifySignal({ ...base, signature: null, timestamp: NOW.toISOString() }) as { code?: string }).code, "SIGNATURE_MISSING");
  assert.equal((verifySignal({ ...base, signature: "sha256=00", timestamp: NOW.toISOString() }) as { code?: string }).code, "SIGNATURE_INVALID");
  assert.equal((verifySignal({ ...base, signature: "a".repeat(64), timestamp: null }) as { code?: string }).code, "TIMESTAMP_MISSING");
  assert.equal((verifySignal({ ...base, signature: "a".repeat(64), timestamp: "yesterday-ish" }) as { code?: string }).code, "TIMESTAMP_INVALID");
});

test("timestamps are readable as ISO, epoch seconds and epoch milliseconds", () => {
  assert.equal(parseSignalTimestamp("2026-10-19T10:00:00.000Z")?.toISOString(), "2026-10-19T10:00:00.000Z");
  assert.equal(parseSignalTimestamp("1792404000")?.getTime(), 1_792_404_000_000);
  assert.equal(parseSignalTimestamp("1792404000000")?.getTime(), 1_792_404_000_000);
  assert.equal(parseSignalTimestamp("nope"), null);
});

test("the replay window is clamped to what this build honours", () => {
  assert.equal(normalizeReplayWindowSeconds(1), 30);
  assert.equal(normalizeReplayWindowSeconds(90), 90);
  assert.equal(normalizeReplayWindowSeconds(99_999), 3_600);
  assert.equal(normalizeReplayWindowSeconds("120"), 120);
  assert.equal(normalizeReplayWindowSeconds("not a number"), 300);
});

// ---------------------------------------------------------------------------------------
// Sealing, tokens and masking
// ---------------------------------------------------------------------------------------

test("signal and webhook secrets are sealed, purpose-bound and never recoverable from the record", () => {
  withKey(() => {
    const secret = "ss_never-returned";
    const sealed = sealSecret("signal", secret);
    assert.equal(sealed.ciphertext.includes(secret), false);
    assert.notEqual(sealed.ciphertext, secret);
    assert.equal(openSecret("signal", sealed), secret);

    assert.throws(() => openSecret("webhook", sealed), "a signal secret cannot be opened as a webhook secret");

    const bytes = Buffer.from(sealed.ciphertext, "base64url");
    bytes[0] ^= 0x01;
    assert.throws(() => openSecret("signal", { ...sealed, ciphertext: bytes.toString("base64url") }));
  });
});

test("a generated token is stored only as a hash and shown only as a mask", () => {
  const first = generateSignalToken();
  const second = generateSignalToken();
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.secret, second.secret);
  assert.equal(first.tokenHash, hashSignalToken(first.token));
  assert.equal(first.tokenHash.includes(first.token), false);
  assert.match(first.tokenPrefix, /^sig_.+…/);
  assert.equal(first.tokenPrefix.includes(first.token), false);

  const masked = maskSignalToken(first.token);
  assert.equal(masked, first.tokenPrefix);
  assert.equal(masked.length < first.token.length, true);
  assert.equal(masked.includes(first.secret), false);
});

// ---------------------------------------------------------------------------------------
// Mapping with named bounds
// ---------------------------------------------------------------------------------------

function bounds(overrides: Partial<SignalBounds> = {}): SignalBounds {
  return {
    strategy: { id: "builtin", label: "RSI Reversion", market: "BTC-USD", budgetUsd: "1000", stopLossPercent: "2" },
    strategyRunning: true,
    position: null,
    strategyOpenNotionalUsd: "0",
    price: "60000",
    policy: { approvedSymbols: ["BTC-USD"], maxOrderNotionalUsd: "0", maxStrategyNotionalUsd: "0", killSwitchActive: false },
    ...overrides,
  };
}

test("an enter signal becomes a BUY with a stop and a size drawn from the strategy budget", () => {
  const mapping = mapSignal({ action: "enter", market: "BTC-USD" }, bounds());
  assert.equal(mapping.ok, true);
  if (!mapping.ok) return;
  assert.equal(mapping.intent.side, "BUY");
  assert.equal(mapping.intent.notionalUsdCents, 100_000);
  assert.equal(mapping.intent.quantity, "0.01666666");
  assert.equal(mapping.intent.stopLossPrice, "58800.00");
  assert.equal(mapping.intent.reduceOnly, false);
});

test("a signal cannot exceed the per-order cap, and the refusal names the bound and both values", () => {
  const mapping = mapSignal(
    { action: "enter", market: "BTC-USD", sizeUsd: "100" },
    bounds({ policy: { approvedSymbols: ["BTC-USD"], maxOrderNotionalUsd: "50", maxStrategyNotionalUsd: "0", killSwitchActive: false } }),
  );
  assert.equal(mapping.ok, false);
  if (mapping.ok) return;
  assert.equal(mapping.code, "MAX_ORDER_NOTIONAL");
  assert.equal(mapping.bound, "policy.maxOrderNotionalUsd");
  assert.match(mapping.message, /100\.00.*50\.00/);
});

test("the strategy budget and the strategy position cap are separate named bounds", () => {
  const overBudget = mapSignal({ action: "enter", market: "BTC-USD", sizeUsd: "2000" }, bounds());
  assert.equal(overBudget.ok === false && overBudget.code, "STRATEGY_BUDGET");

  const overCap = mapSignal(
    { action: "enter", market: "BTC-USD", sizeUsd: "100" },
    bounds({
      strategyOpenNotionalUsd: "100",
      policy: { approvedSymbols: ["BTC-USD"], maxOrderNotionalUsd: "0", maxStrategyNotionalUsd: "150", killSwitchActive: false },
    }),
  );
  assert.equal(overCap.ok === false && overCap.code, "STRATEGY_POSITION_CAP");
  assert.equal(overCap.ok === false && overCap.bound, "policy.maxStrategyNotionalUsd");
});

test("pair and state bounds are refused before any size is considered", () => {
  const cases: Array<[Parameters<typeof mapSignal>[0], SignalBounds, string]> = [
    [{ action: "enter", market: "ZZZ-USD" }, bounds(), "MARKET_NOT_SUPPORTED"],
    [
      { action: "enter", market: "BTC-USD" },
      bounds({ policy: { approvedSymbols: ["ETH-USD"], maxOrderNotionalUsd: "0", maxStrategyNotionalUsd: "0", killSwitchActive: false } }),
      "MARKET_NOT_APPROVED",
    ],
    [
      { action: "enter", market: "BTC-USD" },
      bounds({ strategy: { id: "builtin", label: "ETH strategy", market: "ETH-USD", budgetUsd: "1000", stopLossPercent: "2" } }),
      "STRATEGY_MARKET_MISMATCH",
    ],
    [{ action: "enter", market: "BTC-USD" }, bounds({ strategyRunning: false }), "STRATEGY_NOT_RUNNING"],
    [
      { action: "enter", market: "BTC-USD" },
      bounds({ policy: { approvedSymbols: ["BTC-USD"], maxOrderNotionalUsd: "0", maxStrategyNotionalUsd: "0", killSwitchActive: true } }),
      "KILL_SWITCH_ENGAGED",
    ],
    [{ action: "flip", market: "BTC-USD" }, bounds(), "ACTION_UNSUPPORTED"],
    [{ action: "enter", market: "BTC-USD" }, bounds({ price: "0" }), "PRICE_UNAVAILABLE"],
  ];
  for (const [request, configured, code] of cases) {
    const mapping = mapSignal(request, configured);
    assert.equal(mapping.ok, false, `expected ${code}`);
    assert.equal(mapping.ok === false && mapping.code, code);
    assert.ok(mapping.ok === false && mapping.bound.length > 0);
  }
});

test("an exit closes the stored position and refuses to exceed it", () => {
  const withPosition = bounds({ position: { quantity: "0.01", notionalUsd: "600" } });
  const full = mapSignal({ action: "exit", market: "BTC-USD" }, withPosition);
  assert.equal(full.ok, true);
  if (full.ok) {
    assert.equal(full.intent.side, "SELL");
    assert.equal(full.intent.reduceOnly, true);
    assert.equal(full.intent.quantity, "0.01");
    assert.equal(full.intent.notionalUsdCents, 60_000);
  }

  const partial = mapSignal({ action: "exit", market: "BTC-USD", sizeUsd: "100" }, withPosition);
  assert.equal(partial.ok === true && partial.intent.quantity, "0.00166666");

  const tooLarge = mapSignal({ action: "exit", market: "BTC-USD", sizeUsd: "900" }, withPosition);
  assert.equal(tooLarge.ok === false && tooLarge.code, "EXIT_EXCEEDS_POSITION");
  assert.equal(tooLarge.ok === false && tooLarge.bound, "position.notionalUsd");

  const nothing = mapSignal({ action: "exit", market: "BTC-USD" }, bounds());
  assert.equal(nothing.ok === false && nothing.code, "NO_OPEN_POSITION");
});

test("an adjust is signed: positive adds, negative reduces", () => {
  const add = mapSignal({ action: "adjust", market: "BTC-USD", sizeUsd: "120" }, bounds());
  assert.equal(add.ok === true && add.intent.side, "BUY");

  const reduce = mapSignal({ action: "adjust", market: "BTC-USD", sizeUsd: "-100" }, bounds({ position: { quantity: "0.01", notionalUsd: "600" } }));
  assert.equal(reduce.ok === true && reduce.intent.side, "SELL");
  assert.equal(reduce.ok === true && reduce.intent.reduceOnly, true);

  const zero = mapSignal({ action: "adjust", market: "BTC-USD", sizeUsd: "0" }, bounds());
  assert.equal(zero.ok === false && zero.code, "SIGNAL_SIZE_INVALID");
  const junk = mapSignal({ action: "enter", market: "BTC-USD", sizeUsd: "a lot" }, bounds());
  assert.equal(junk.ok === false && junk.code, "SIGNAL_SIZE_INVALID");
});

test("a strategy without a stop cannot be entered, and the refusal names the missing setting", () => {
  const mapping = mapSignal(
    { action: "enter", market: "BTC-USD" },
    bounds({ strategy: { id: "builtin", label: "No stop", market: "BTC-USD", budgetUsd: "1000", stopLossPercent: "0" } }),
  );
  assert.equal(mapping.ok === false && mapping.code, "STOP_LOSS_MISSING");
  assert.equal(mapping.ok === false && mapping.bound, "strategy.stopLossPercent");
});

test("the risk input carries the strategy, the stop and the owner's facts", () => {
  const configured = bounds();
  const mapping = mapSignal({ action: "enter", market: "BTC-USD", sizeUsd: "100" }, configured);
  assert.equal(mapping.ok, true);
  if (!mapping.ok) return;
  const input = signalRiskInput({
    mapping: mapping.intent,
    bounds: { ...configured, strategy: configured.strategy! },
    facts: {
      routing: "paper",
      venueId: "dev-paper",
      tradesToday: 2,
      openPositions: 0,
      tradesInInterval: 1,
      cooldownRemainingMinutes: 0,
      killSwitchActive: false,
      strategyKillSwitchActive: false,
    },
  });
  assert.equal(input.executionMode, "PAPER");
  assert.equal(input.strategyKey, "builtin");
  assert.equal(input.hasValidStopLoss, true);
  assert.equal(input.requestedNotionalUsd, "100.00");
  assert.equal(input.serverComputedMaxLossUsd, "2.00");
  assert.equal(input.tradesToday, 2);
});

// ---------------------------------------------------------------------------------------
// Outbound delivery: signature, retry, bounded attempts and health
// ---------------------------------------------------------------------------------------

type MemoryRow = WebhookDeliveryRow & {
  status: "PENDING" | "DELIVERED" | "FAILED";
  responseStatus: number | null;
  error: string | null;
  durationMs: number | null;
  attemptedAt: Date | null;
  nextAttemptAt: Date | null;
};

class MemoryWebhookStore implements WebhookStore {
  rows: MemoryRow[] = [];
  endpoint: { id: string; url: string; active: boolean; revoked: boolean; secret: string | null; health: string; failures: number };

  constructor(secret: string | null = "whsec_test") {
    this.endpoint = {
      id: "sub-1",
      url: "http://localhost:4555/hook",
      active: true,
      revoked: false,
      secret,
      health: "HEALTHY",
      failures: 0,
    };
  }

  async subscriptionsForEvent() {
    return this.endpoint.active && !this.endpoint.revoked ? [{ id: this.endpoint.id }] : [];
  }
  async subscription() {
    return {
      url: this.endpoint.url,
      active: this.endpoint.active,
      revoked: this.endpoint.revoked,
      secret: this.endpoint.secret,
    };
  }
  async createDelivery(input: {
    subscriptionId: string;
    userId: string;
    eventType: string;
    deliveryKey: string;
    attempt: number;
    payload: string;
  }) {
    const row: MemoryRow = {
      id: `row-${this.rows.length + 1}`,
      ...input,
      status: "PENDING",
      responseStatus: null,
      error: null,
      durationMs: null,
      attemptedAt: null,
      nextAttemptAt: null,
    };
    this.rows.push(row);
    return row;
  }
  async updateDelivery(id: string, update: Parameters<WebhookStore["updateDelivery"]>[1]) {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) return;
    Object.assign(row, update);
  }
  async clearSchedule(deliveryKey: string) {
    for (const row of this.rows) if (row.deliveryKey === deliveryKey) row.nextAttemptAt = null;
  }
  async recordSuccess() {
    this.endpoint.failures = 0;
    this.endpoint.health = "HEALTHY";
  }
  async recordFailure() {
    this.endpoint.failures += 1;
    return this.endpoint.failures;
  }
  async markUnhealthy() {
    this.endpoint.health = "UNHEALTHY";
  }
  async dueRetries(now: Date, limit: number) {
    return this.rows
      .filter(
        (row) =>
          row.status === "FAILED" &&
          row.attempt < WEBHOOK_MAX_ATTEMPTS &&
          row.nextAttemptAt !== null &&
          row.nextAttemptAt.getTime() <= now.getTime() &&
          this.endpoint.active &&
          !this.endpoint.revoked,
      )
      .slice(0, limit);
  }
}

test("a delivery is signed so the receiver can verify it, and the payload carries no secret", async () => {
  const store = new MemoryWebhookStore("whsec_verify-me");
  let captured: { url: string; body: string; headers: Record<string, string> } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    captured = {
      url: String(url),
      body: String(init.body),
      headers: init.headers as Record<string, string>,
    };
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  const result = await publishWebhookEvent({
    userId: "user-1",
    eventType: "trade.placed",
    payload: { orderId: "order-1", market: "BTC-USD" },
    now: NOW,
    fetchImpl,
    store,
  });

  assert.deepEqual({ queued: result.queued, delivered: result.delivered, failed: result.failed }, { queued: 1, delivered: 1, failed: 0 });
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].status, "DELIVERED");
  assert.equal(store.rows[0].responseStatus, 204);
  assert.equal(captured !== null, true);
  const sent = captured as unknown as { body: string; headers: Record<string, string> };
  const timestamp = sent.headers["X-Veylora-Timestamp"];
  const header = sent.headers["X-Veylora-Signature"];
  assert.equal(header, `sha256=${webhookSignature("whsec_verify-me", timestamp, sent.body)}`);
  assert.equal(sent.headers["X-Veylora-Event"], "trade.placed");
  assert.equal(sent.body.includes("whsec_verify-me"), false);
  assert.equal(header.includes("whsec_verify-me"), false);
  assert.match(sent.body, /"orderId":"order-1"/);
});

test("a failing receiver is retried on a bounded backoff and each attempt is recorded", async () => {
  const store = new MemoryWebhookStore();
  const failing = (async () => new Response("down", { status: 500 })) as unknown as typeof fetch;

  const first = await publishWebhookEvent({
    userId: "user-1",
    eventType: "strategy.decision",
    payload: { code: "ENTRY_CONDITION_MET" },
    now: NOW,
    fetchImpl: failing,
    store,
  });
  assert.equal(first.failed, 1);
  assert.equal(store.rows[0].status, "FAILED");
  assert.equal(store.rows[0].responseStatus, 500);
  assert.equal(store.rows[0].error, "The receiver answered HTTP 500.");
  assert.equal(store.rows[0].nextAttemptAt?.toISOString(), new Date(NOW.getTime() + 30_000).toISOString());
  assert.equal(store.endpoint.failures, 1);
  assert.equal(webhookBackoffSeconds(1), 30);
  assert.equal(webhookBackoffSeconds(3), 600);
  assert.equal(webhookBackoffSeconds(9), 600, "the backoff is bounded at its last step");

  // Too early: nothing is due.
  const early = await deliverPendingWebhooks({ now: new Date(NOW.getTime() + 10_000), fetchImpl: failing, store });
  assert.equal(early.attempted, 0);

  const second = await deliverPendingWebhooks({ now: new Date(NOW.getTime() + 31_000), fetchImpl: failing, store });
  assert.equal(second.attempted, 1);
  assert.equal(second.failed, 1);
  assert.equal(store.rows.length, 2);
  assert.equal(store.rows[1].attempt, 2);
  assert.equal(store.endpoint.failures, 2);
  assert.equal(store.endpoint.health, "HEALTHY", "two failures are not yet unhealthy");

  const third = await deliverPendingWebhooks({ now: new Date(NOW.getTime() + 200_000), fetchImpl: failing, store });
  assert.equal(third.attempted, 1);
  assert.equal(store.endpoint.failures, 3);
  assert.equal(store.endpoint.health, "UNHEALTHY", "a persistently failing endpoint is visible as unhealthy");

  const fourth = await deliverPendingWebhooks({ now: new Date(NOW.getTime() + 1_000_000), fetchImpl: failing, store });
  assert.equal(fourth.attempted, 1);
  assert.equal(store.rows.at(-1)?.attempt, 4);
  assert.equal(store.rows.at(-1)?.nextAttemptAt, null, "attempt four is final: bounded, not infinite");

  const exhausted = await deliverPendingWebhooks({ now: new Date(NOW.getTime() + 2_000_000), fetchImpl: failing, store });
  assert.equal(exhausted.attempted, 0);
  assert.deepEqual(store.rows.map((row) => row.attempt), [1, 2, 3, 4], "every attempt is a row, none overwritten");
  assert.equal(store.rows.every((row) => row.status === "FAILED"), true);
});

test("a receiver that comes back is delivered on the next attempt and the endpoint recovers", async () => {
  const store = new MemoryWebhookStore();
  const failing = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
  const healthy = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

  await publishWebhookEvent({ userId: "u", eventType: "webhook.test", payload: {}, now: NOW, fetchImpl: failing, store });
  assert.equal(store.endpoint.health, "HEALTHY");

  const retry = await deliverPendingWebhooks({ now: new Date(NOW.getTime() + 31_000), fetchImpl: healthy, store });
  assert.equal(retry.delivered, 1);
  assert.equal(store.endpoint.health, "HEALTHY");
  assert.equal(store.endpoint.failures, 0);
  assert.equal(store.rows[1].status, "DELIVERED");
  assert.equal(store.rows[0].status, "FAILED", "the first failure is still visible");
});

test("an endpoint whose secret cannot be opened fails once and is never retried", async () => {
  const store = new MemoryWebhookStore(null);
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;

  const result = await publishWebhookEvent({ userId: "u", eventType: "webhook.test", payload: {}, now: NOW, fetchImpl, store });
  assert.equal(result.failed, 1);
  assert.equal(calls, 0, "no unsigned request leaves the server");
  assert.equal(store.rows[0].nextAttemptAt, null);
  const later = await deliverPendingWebhooks({ now: new Date(NOW.getTime() + 86_400_000), fetchImpl, store });
  assert.equal(later.attempted, 0);
});
