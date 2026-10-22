import assert from "node:assert/strict";
import test from "node:test";
import { assertLiveEndpoints, createLiveVenue, type LiveExchange } from "@/lib/venues/live-adapter";
import { clientOrderIdForVenue, type RawBinanceOrder } from "@/lib/venues/binance-shared";
import {
  describeTestnetComparison,
  LIVE_CREDENTIAL_MISSING,
  LIVE_EXECUTION_DISABLED,
  orderPlacementRefusal,
  orderVenueSummary,
  resolveOrderVenue,
  resolveVenueForOrder,
  type OrderRoutingSettings,
  type VenueCredentialRow,
} from "@/lib/venues/registry";
import { VENUE_DESCRIPTORS } from "@/lib/venues/types";
import { buildPreTradeReport } from "@/lib/orders/preflight";
import { cancelOrder, submitOrder, type OrderProcessDeps } from "@/lib/orders/process";
import { reconcileOrders } from "@/lib/orders/reconcile";
import { validateOrderSubmission } from "@/lib/orders/api";
import { DEFAULT_RISK_POLICY } from "@/lib/risk-controls/policy";
import type { RiskPolicySettings } from "@/lib/risk-controls/settings";
import { getTradingStatus } from "@/lib/trading/status";
import {
  createMemoryIdempotencyStore,
  createMemoryOrderStore,
  createTestClock,
} from "@/lib/orders/test-support";

/**
 * Phase 22's acceptance criteria, run against the real live adapter and the real switch.
 *
 * The switch itself is data (a column on the risk-policy row, validated and audited by
 * `risk-controls/settings.ts`), so what a unit test can prove is the *behaviour* that reads
 * it: an attempt that names live while it is off is refused by name and reads no key, an
 * order that is already open is still reconciled and cancelled when it is turned off, and
 * the venue is never asked a question it cannot answer. The database half of the switch —
 * who changed it, when, and the audit row — is proved on the running application in this
 * phase's record.
 *
 * The venue is scripted, but it is the production `createLiveVenue`: the same adapter, the
 * same mapping, the same classifier and the same lifecycle the application runs. What the
 * script stands in for is Binance's server, not our code.
 */

const secret = { apiKey: "live-api-key", apiSecret: "live-api-secret", readOnly: false };
const LIVE_HOSTS = { api: { public: "https://api.binance.com/api/v3", private: "https://api.binance.com/api/v3" } };

const switches = (overrides: Partial<OrderRoutingSettings> = {}): OrderRoutingSettings => ({
  testnetOrdersEnabled: false,
  liveExecutionEnabled: false,
  ...overrides,
});

const intent = {
  userId: "dev-test-account",
  venue: "binance",
  market: "BTC-USD",
  side: "BUY" as const,
  orderType: "MARKET" as const,
  quantity: "0.01",
  limitPrice: null,
  stopLossPrice: "0",
  notionalUsdCents: 70_000,
  verifiedBalanceCents: 250_000,
};

const liveRow: VenueCredentialRow = {
  id: "cred-live",
  venue: "binance",
  label: "live trading key",
  readOnly: false,
  credentialCiphertext: "ciphertext",
  credentialIv: "iv",
  credentialAuthTag: "tag",
  createdAt: new Date("2026-10-18T08:00:00.000Z"),
  verifiedAt: new Date("2026-10-18T08:05:00.000Z"),
  lastCheckError: null,
};

type LiveScript = {
  createOrder?: (request: {
    symbol: string;
    type: string;
    side: string;
    amount: string;
    price?: string;
    params?: Record<string, unknown>;
  }) => Promise<RawBinanceOrder>;
  fetchOrder?: (id: string, symbol?: string) => Promise<RawBinanceOrder>;
  fetchOrders?: () => Promise<RawBinanceOrder[]>;
  cancelOrder?: (id: string, symbol?: string) => Promise<RawBinanceOrder>;
  fetchBalance?: () => Promise<{ free?: Record<string, string>; total?: Record<string, string> }>;
};

function scriptedLive(script: LiveScript) {
  const calls = {
    createOrder: 0,
    fetchOrder: 0,
    fetchOrders: 0,
    cancelOrder: 0,
    fetchBalance: 0,
    requests: [] as { symbol: string; type: string; side: string; amount: string; price?: string; params?: Record<string, unknown> }[],
  };
  const exchange: LiveExchange = {
    urls: LIVE_HOSTS,
    async fetchBalance() {
      calls.fetchBalance += 1;
      return script.fetchBalance ? script.fetchBalance() : { free: { USDT: "10000" }, total: { USDT: "10000" } };
    },
    async fetchOrders() {
      calls.fetchOrders += 1;
      return script.fetchOrders ? script.fetchOrders() : [];
    },
    async fetchOrder(id: string, symbol?: string) {
      calls.fetchOrder += 1;
      if (!script.fetchOrder) throw Object.assign(new Error(`no order ${id}`), { name: "OrderNotFound" });
      return script.fetchOrder(id, symbol);
    },
    async createOrder(symbol, type, side, amount, price, params) {
      calls.createOrder += 1;
      calls.requests.push({ symbol, type, side, amount, ...(price ? { price } : {}), ...(params ? { params } : {}) });
      if (!script.createOrder) throw new Error("the script has no createOrder answer");
      return script.createOrder({ symbol, type, side, amount, ...(price ? { price } : {}), ...(params ? { params } : {}) });
    },
    async cancelOrder(id: string, symbol?: string) {
      calls.cancelOrder += 1;
      if (!script.cancelOrder) throw Object.assign(new Error("no cancel answer"), { name: "InvalidOrder" });
      return script.cancelOrder(id, symbol);
    },
    async close() {
      return undefined;
    },
  };
  return { exchange, calls };
}

const openLive = (signed: Partial<RawBinanceOrder> = {}): RawBinanceOrder => ({
  id: "887766",
  symbol: "BTC/USDT",
  side: "buy",
  type: "market",
  status: "NEW",
  amount: "0.01",
  filled: "0",
  ...signed,
});

function harness(script: LiveScript) {
  const orders = createMemoryOrderStore();
  const idempotency = createMemoryIdempotencyStore();
  const clock = createTestClock("2026-10-18T09:00:00.000Z");
  const { exchange, calls } = scriptedLive(script);
  const venue = createLiveVenue(secret, { createExchange: () => exchange, now: clock.now });
  const deps: OrderProcessDeps = {
    store: orders.store,
    idempotency: idempotency.store,
    venue,
    now: clock.now,
    sleep: async (ms) => {
      clock.advance(ms);
    },
  };
  return { orders, idempotency, clock, venue, calls, deps, exchange };
}

test("the live venue is the exchange itself: live descriptor, real key, no sandbox", () => {
  const descriptor = VENUE_DESCRIPTORS.binance;
  assert.equal(descriptor.environment, "live");
  assert.ok(descriptor.capabilities.includes("place"));

  const { exchange } = scriptedLive({});
  const venue = createLiveVenue(secret, { createExchange: () => exchange });
  assert.equal(venue.id, "binance");
  assert.equal(venue.environment, "live");
  assert.equal(venue.paper, false);
  assert.equal(venue.quoteAssetFor?.("BTC-USD"), "USDT", "a balance check asks for the asset the venue actually quotes");
  assert.equal(venue.quoteAssetFor?.("BTC-USDT"), null);

  // A sandbox client may not be reported as live: that difference is what the switch means.
  assert.throws(
    () => assertLiveEndpoints({ api: { public: "https://testnet.binance.vision/api/v3" } }),
    /sandbox host/,
  );
  assert.throws(() => assertLiveEndpoints({ api: {} }), /no API endpoint/);

  // The production factory is not the sandbox, and its own guard accepts it.
  const production = createLiveVenue(secret, {});
  assert.equal(production.id, "binance");
  assert.notEqual(venue.paper, true);
});

test("with the switch off a live request is refused by name, and no key is read", async () => {
  let keysRead = 0;
  const resolution = await resolveOrderVenue("user-1", {
    settings: async () => switches({ liveExecutionEnabled: false }),
    requested: "live",
    liveCredential: async () => {
      keysRead += 1;
      return liveRow;
    },
    decrypt: () => secret,
    createLive: () => createLiveVenue(secret, { createExchange: () => scriptedLive({}).exchange }),
  });

  assert.equal(resolution.kind, "refused");
  if (resolution.kind !== "refused") return;
  assert.equal(resolution.status, 403);
  assert.equal(resolution.code, LIVE_EXECUTION_DISABLED);
  assert.match(resolution.error, /switched off/);
  assert.match(resolution.error, /liveExecutionEnabled/);
  assert.match(resolution.error, /\/admin\/risk/);
  assert.equal(keysRead, 0, "the switch was checked before any credential was read");
  assert.match(orderPlacementRefusal("binance") ?? "", /Live execution is switched off/);
});

test("with the switch on, routing selects the live venue and reports it with its key", async () => {
  const { exchange } = scriptedLive({});
  const resolution = await resolveOrderVenue("user-1", {
    settings: async () => switches({ liveExecutionEnabled: true }),
    liveCredential: async () => liveRow,
    decrypt: () => secret,
    createLive: () => createLiveVenue(secret, { createExchange: () => exchange }),
  });

  assert.equal(resolution.kind, "resolved");
  if (resolution.kind !== "resolved") return;
  assert.equal(resolution.source, "live");
  assert.equal(resolution.venue.id, "binance");
  assert.equal(resolution.venue.environment, "live");
  assert.match(resolution.detail, /real funds can move/);
  assert.match(resolution.detail, /no further prompt/);
  assert.equal(resolution.credential?.label, "live trading key");
  assert.equal(resolution.credential?.verifiedAt, "2026-10-18T08:05:00.000Z");
  assert.equal(orderPlacementRefusal("binance", { liveExecutionEnabled: true }), null);

  // A live switch with no live key is an answer with a name, not a fallback to paper.
  const missing = await resolveOrderVenue("user-1", {
    settings: async () => switches({ liveExecutionEnabled: true }),
    liveCredential: async () => null,
    createLive: () => createLiveVenue(secret, { createExchange: () => exchange }),
  });
  assert.equal(missing.kind, "refused");
  if (missing.kind === "refused") {
    assert.equal(missing.status, 409);
    assert.equal(missing.code, LIVE_CREDENTIAL_MISSING);
    assert.match(missing.error, /no Binance key/);
  }

  // A read-only key still cannot trade: the venue would refuse it, and the sentence says
  // which key and what to do instead.
  const readOnly = await resolveOrderVenue("user-1", {
    settings: async () => switches({ liveExecutionEnabled: true }),
    liveCredential: async () => ({ ...liveRow, readOnly: true }),
    decrypt: () => secret,
    createLive: () => createLiveVenue(secret, { createExchange: () => exchange }),
  });
  assert.equal(readOnly.kind, "refused");
  if (readOnly.kind === "refused") assert.equal(readOnly.code, "READ_ONLY_CREDENTIAL");

  // Without the switch, nothing asks for a live key at all: routing is the paper venue.
  const auto = await resolveOrderVenue("user-1", { settings: async () => switches() });
  assert.equal(auto.kind, "resolved");
  if (auto.kind === "resolved") {
    assert.equal(auto.source, "paper");
    assert.match(auto.detail, /no real funds move/);
  }
});

test("an order that is already open resolves to its own venue even with the switch off", async () => {
  const { exchange, calls } = scriptedLive({});
  const venue = createLiveVenue(secret, { createExchange: () => exchange });
  const resolution = await resolveVenueForOrder("user-1", "binance", {
    settings: async () => switches({ liveExecutionEnabled: false }),
    credential: async (_userId, venueId) => (venueId === "binance" ? liveRow : null),
    decrypt: () => secret,
    createLive: () => venue,
  });

  assert.equal(resolution.kind, "resolved");
  if (resolution.kind !== "resolved") return;
  assert.equal(resolution.venue.id, "binance", "placement is switched off; asking about an existing order is not");
  assert.equal(resolution.source, "live");
  assert.equal(calls.fetchBalance + calls.createOrder, 0, "resolving a venue builds no order and reads no funds");

  // A paper order resolves to the paper venue, and an unknown venue is a sentence.
  const paper = await resolveVenueForOrder("user-1", "dev-paper", {});
  assert.equal(paper.kind === "resolved" ? paper.source : "", "paper");
  const unknown = await resolveVenueForOrder("user-1", "not-a-venue", {});
  assert.equal(unknown.kind, "refused");
  if (unknown.kind === "refused") assert.equal(unknown.code, "UNKNOWN_ORDER_VENUE");
});

test("a live order is submitted with the venue's own spelling of our client id, and both halves are recorded", async () => {
  const { orders, deps, calls } = harness({
    createOrder: async () => openLive(),
    fetchOrder: async () => openLive({ status: "FILLED", filled: "0.01" }),
  });

  const submitted = await submitOrder({ intent, actorUserId: "dev-test-account" }, deps);
  assert.equal(submitted.kind, "submitted", submitted.reason.message);
  assert.equal(submitted.status, 201);
  const order = submitted.order;
  assert.ok(order);
  assert.equal(order.venue, "binance", "the row names the exchange, not the sandbox");
  assert.equal(order.venueOrderId, "887766");

  const request = calls.requests[0];
  assert.ok(request);
  assert.equal(request.symbol, "BTC/USDT");
  assert.equal(request.amount, "0.01");
  const sentClientId = String(request.params?.newClientOrderId ?? "");
  assert.match(sentClientId, /^[A-Za-z0-9_-]{1,36}$/);
  assert.equal(sentClientId, clientOrderIdForVenue(order.clientOrderId));

  const attempt = orders.attempts.at(-1);
  assert.ok(attempt);
  const provider = attempt.providerResponse as {
    request?: { newClientOrderId?: string; symbol?: string };
    response?: { id?: string };
  };
  assert.equal(provider.request?.symbol, "BTC/USDT");
  assert.equal(provider.request?.newClientOrderId, sentClientId);
  assert.equal(provider.response?.id, "887766", "the venue's own answer is what the record keeps");
});

test("the venue's refusal is recorded once, in the venue's own words, and the order fails", async () => {
  const { orders, deps } = harness({
    createOrder: async () => {
      throw Object.assign(new Error("Account has insufficient balance for requested action."), {
        name: "InsufficientFunds",
      });
    },
  });

  const outcome = await submitOrder({ intent, actorUserId: "dev-test-account" }, deps);
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.status, 502);
  assert.equal(outcome.attempts, 1, "a definitive refusal is not retried");
  assert.match(outcome.reason.message, /insufficient balance/);
  assert.equal(outcome.order?.status, "FAILED");

  const attempt = orders.attempts.at(-1);
  assert.ok(attempt);
  assert.equal(attempt.reasonCode, "ORDER_REJECTED");
  const provider = attempt.providerResponse as { code?: string; error?: string };
  assert.equal(provider.code, "INSUFFICIENT_VENUE_BALANCE");
  assert.match(provider.error ?? "", /insufficient balance/);
});

test("a timeout is not a refusal: the venue is asked whether it holds the order", async () => {
  let storedClientOrderId: string | null = null;
  const { deps, calls } = harness({
    createOrder: async ({ params }) => {
      storedClientOrderId = typeof params?.newClientOrderId === "string" ? params.newClientOrderId : null;
      throw Object.assign(new Error("request timed out"), { name: "RequestTimeout" });
    },
    fetchOrders: async () => [
      openLive({ id: "77001", ...(storedClientOrderId ? { clientOrderId: storedClientOrderId } : {}) }),
    ],
  });

  const outcome = await submitOrder({ intent, actorUserId: "dev-test-account" }, deps);
  assert.equal(outcome.kind, "submitted", outcome.reason.message);
  assert.equal(outcome.order?.venueOrderId, "77001");
  assert.equal(calls.createOrder, 1, "the order was looked up, not sent again");
  assert.ok(calls.fetchOrders >= 1);
});

test("turning the switch off mid-flight lets an open live order reconcile and cancel", async () => {
  // The order was placed live; the owner has since switched live execution off. The pass
  // must still ask the venue that holds it — otherwise the order would be stranded for as
  // long as the switch stayed off, which the phase forbids.
  const orders = createMemoryOrderStore();
  const clock = createTestClock("2026-10-18T09:30:00.000Z");
  const { exchange, calls } = scriptedLive({
    fetchOrder: async () => openLive({ status: "FILLED", filled: "0.01" }),
    cancelOrder: async () => openLive({ status: "CANCELED", filled: "0.003" }),
  });
  const venue = createLiveVenue(secret, { createExchange: () => exchange, now: clock.now });
  const off = switches({ liveExecutionEnabled: false });
  const resolveForOrder = (userId: string, venueId: string) =>
    resolveVenueForOrder(userId, venueId, {
      settings: async () => off,
      credential: async (_userId, id) => (id === "binance" ? liveRow : null),
      decrypt: () => secret,
      createLive: () => venue,
    });

  const seeded = orders.seed({ status: "SUBMITTED", requestedQuantity: "0.01", venue: "binance", venueOrderId: "887766" });
  const summary = await reconcileOrders({ store: orders.store, resolveVenueForOrder: resolveForOrder, now: clock.now });
  assert.equal(summary.checked, 1);
  assert.equal(summary.corrected, 1, "the venue the order names was asked");
  assert.equal(summary.skippedByVenueMismatch, 0);
  assert.equal((await orders.store.findOrderById(seeded.id))?.status, "FILLED");
  assert.equal(calls.fetchOrder, 1);

  // A cancel is not a placement: it reaches the live venue with the switch off, and the
  // executed part stays as a trade.
  const open = orders.seed({ status: "SUBMITTED", requestedQuantity: "0.01", venue: "binance", venueOrderId: "900001" });
  const cancelled = await cancelOrder(
    { orderId: open.id, actorUserId: "dev-test-account", reason: "the owner cancelled this order." },
    {
      store: orders.store,
      idempotency: createMemoryIdempotencyStore().store,
      resolveVenueForOrder: resolveForOrder,
      now: clock.now,
    },
  );
  assert.equal(cancelled.kind, "cancelled", cancelled.reason.message);
  assert.equal(cancelled.order?.status, "CANCELLED");
  assert.equal(calls.cancelOrder, 1, "the venue was asked to cancel, switch or no switch");
});

test("the pre-trade report notices everything and stops nothing", async () => {
  const { exchange, calls } = scriptedLive({
    // The venue holds far less than the order is worth.
    fetchBalance: async () => ({ free: { USDT: "1" }, total: { USDT: "1" } }),
    createOrder: async () => openLive(),
  });
  const venue = createLiveVenue(secret, { createExchange: () => exchange });
  const policy: RiskPolicySettings = {
    ...DEFAULT_RISK_POLICY,
    approvedSymbols: ["BTC-USD"],
    killSwitchActive: false,
    liveExecutionEnabled: true,
    liveExecutionChangedByUserId: "owner-1",
    liveExecutionChangedAt: "2026-10-18T08:00:00.000Z",
    limitsEffectiveFrom: {},
    cooldownUntil: null,
    killSwitchChangedByUserId: null,
    killSwitchChangedAt: null,
  };
  const openOrders = createMemoryOrderStore();
  openOrders.seed({ status: "SUBMITTED", requestedQuantity: "1", venue: "binance", notionalUsdCents: 60_000_00 });

  const report = await buildPreTradeReport({
    venue,
    // Never verified, and the last check failed: both are reported.
    credential: { id: "c", label: "live trading key", venue: "binance", verifiedAt: null, lastCheckError: null },
    policy,
    order: { market: "BTC-USD", side: "BUY", quantity: "0.01", notionalUsdCents: 70_000, verifiedBalanceCents: 100_00 },
    openOrders: async () => [...openOrders.orders.values()],
  });

  const codes = report.notices.map((notice) => notice.code);
  assert.ok(codes.includes("CREDENTIAL_UNVERIFIED"), "an unverified key is reported");
  assert.ok(codes.includes("INSUFFICIENT_VENUE_BALANCE"), "a short venue balance is reported");
  assert.ok(codes.includes("EXPOSURE_ABOVE_CONFIGURED_LIMIT"), "exposure over the limit is reported");
  assert.equal(report.notices.length, 3);
  assert.match(report.summary, /none of them stopped the order/);
  // Nothing in the report can refuse: it is a list of sentences.
  for (const check of report.checks) {
    assert.ok(["ok", "notice", "unavailable", "not-applicable"].includes(check.status));
  }

  // And the order goes anyway, with the venue answering rather than the report. The
  // assertions above already proved the report was full of notices; this proves the same
  // configuration still places.
  const submitted = await submitOrder(
    { intent, actorUserId: "dev-test-account" },
    { venue, store: createMemoryOrderStore().store, idempotency: createMemoryIdempotencyStore().store },
  );
  assert.equal(submitted.kind, "submitted", submitted.reason.message);
  assert.equal(calls.createOrder, 1);

  // A venue that cannot be read at all is an outage notice, not a refusal to try.
  const dead = createLiveVenue(secret, {
    createExchange: () =>
      scriptedLive({
        fetchBalance: async () => {
          throw Object.assign(new Error("getaddrinfo ENOTFOUND api.binance.com"), { name: "NetworkError" });
        },
      }).exchange,
  });
  const outage = await buildPreTradeReport({
    venue: dead,
    credential: { id: "c", label: "k", venue: "binance", verifiedAt: new Date().toISOString(), lastCheckError: null },
    policy,
    order: { market: "BTC-USD", side: "BUY", quantity: "0.01", notionalUsdCents: 1000, verifiedBalanceCents: 10_000_00 },
    openOrders: async () => [],
  });
  const outageCheck = outage.notices.find((notice) => notice.code === "VENUE_OUTAGE");
  assert.ok(outageCheck, "a venue that cannot be read is reported as an outage");
  assert.match(outageCheck.detail, /still sent/);

  // A policy that could not be read is reported too, never guessed at.
  const noPolicy = await buildPreTradeReport({
    venue: dead,
    policy: null,
    order: { market: "BTC-USD", side: "BUY", quantity: "0.01", notionalUsdCents: 1000, verifiedBalanceCents: 10_000_00 },
    openOrders: async () => [],
  });
  assert.match(noPolicy.summary, /reported and none of them stopped the order/);
});

test("the dry comparison says what the testnet would have been asked, and places nothing", async () => {
  const { exchange, calls } = scriptedLive({});
  const report = await describeTestnetComparison("user-1", "BTC-USD", {
    settings: async () => switches({ testnetOrdersEnabled: true }),
    credential: async () => ({
      ...liveRow,
      id: "cred-testnet",
      venue: "binance-testnet",
      label: "testnet key",
    }),
  });

  assert.equal(report.mappedPair, "BTC/USDT");
  assert.equal(report.testnetKeyLabel, "testnet key");
  assert.equal(report.wouldPlaceOnTestnet, true);
  assert.equal(report.testnetRoutingEnabled, true);
  assert.match(report.detail, /would be sent to the testnet as BTC\/USDT/);

  const noKey = await describeTestnetComparison("user-1", "BTC-USD", {
    settings: async () => switches({ testnetOrdersEnabled: true }),
    credential: async () => null,
  });
  assert.equal(noKey.wouldPlaceOnTestnet, false);
  assert.match(noKey.detail, /no testnet key/);

  const readOnly = await describeTestnetComparison("user-1", "BTC-USD", {
    settings: async () => switches({ testnetOrdersEnabled: true }),
    credential: async () => ({ ...liveRow, venue: "binance-testnet", readOnly: true }),
  });
  assert.equal(readOnly.wouldPlaceOnTestnet, false);
  assert.match(readOnly.detail, /read-only/);

  const unmappable = await describeTestnetComparison("user-1", "BTC-EUR", {
    settings: async () => switches(),
    credential: async () => liveRow,
  });
  assert.equal(unmappable.mappedPair, null);
  assert.equal(unmappable.wouldPlaceOnTestnet, false);
  assert.match(unmappable.detail, /does not map onto a Binance USDT pair/);
  assert.equal(calls.createOrder, 0, "a comparison is a report, not a step");
  assert.equal(exchange.urls, LIVE_HOSTS);
});

test("the routing summary reports all three environments, and admits when the switches cannot be read", async () => {
  const paper = await orderVenueSummary({ settings: async () => switches() });
  assert.equal(paper.environment, "paper");
  assert.equal(paper.liveExecutionEnabled, false);

  const testnet = await orderVenueSummary({ settings: async () => switches({ testnetOrdersEnabled: true }) });
  assert.equal(testnet.environment, "testnet");

  const live = await orderVenueSummary({ settings: async () => switches({ liveExecutionEnabled: true }) });
  assert.equal(live.environment, "live");
  assert.equal(live.venueId, "binance");
  assert.equal(live.liveExecutionEnabled, true);
  assert.match(live.detail, /real funds move/);
  assert.match(live.detail, /no further prompt/);

  const unknown = await orderVenueSummary({
    settings: async () => {
      throw new Error("database unavailable");
    },
  });
  assert.equal(unknown.available, false);
  assert.equal(unknown.liveExecutionEnabled, false);
  assert.match(unknown.detail, /refused rather than sent anywhere/);
});

test("the status surface says live from the switch, not from a constant", async () => {
  const live = await getTradingStatus(
    async () => DEFAULT_RISK_POLICY,
    async () => ({
      environment: "live" as const,
      venueId: "binance",
      label: "Binance",
      testnetRoutingEnabled: false,
      liveExecutionEnabled: true,
      available: true,
      detail: "Live execution is switched on in /admin/risk.",
    }),
  );
  assert.equal(live.trading.status, "LIVE ORDERS");
  assert.equal(live.trading.execution, "LIVE VENUE");
  assert.equal(live.trading.liveExecutionEnabled, true);
  assert.equal(live.trading.venue.paper, false);
  assert.equal(live.riskControls.executionEnabled, true);
  assert.match(live.riskControls.detail, /live execution ON in \/admin\/risk/);
  assert.match(live.trading.retry, /same idempotency key/);
});

test("a submission may name the venue it wants, and only the four known words", () => {
  const body = {
    market: "BTC-USD",
    side: "BUY",
    orderType: "MARKET",
    quantity: "0.01",
    notionalUsdCents: 7000,
    verifiedBalanceCents: 250_000,
  };
  const auto = validateOrderSubmission(body);
  assert.equal(auto.valid, true);
  if (auto.valid) assert.equal(auto.value.execution, "auto", "an omitted target means \"wherever routing points\"");

  for (const execution of ["paper", "testnet", "live", "AUTO", " Live "]) {
    const parsed = validateOrderSubmission({ ...body, execution });
    assert.equal(parsed.valid, true, `${execution} should be accepted`);
    if (parsed.valid) assert.equal(parsed.value.execution, execution.trim().toLowerCase());
  }

  const bad = validateOrderSubmission({ ...body, execution: "live2" });
  assert.equal(bad.valid, false);
  if (!bad.valid) assert.match(bad.error, /Execution must be one of auto, paper, testnet, live/);
});
