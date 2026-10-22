import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTestnetEndpoints,
  BINANCE_TESTNET_HOSTS,
  classifyVenueError,
  createBinanceSpotTestnetExchange,
  createTestnetVenue,
  exchangeApiHosts,
  testnetClientOrderId,
  testnetOrderState,
  testnetSymbolFor,
  type RawTestnetOrder,
  type TestnetExchange,
} from "@/lib/venues/testnet-adapter";
import {
  createVenue,
  orderPlacementRefusal,
  orderVenueSummary,
  pickTestnetCredential,
  resolveOrderVenue,
  TESTNET_CREDENTIAL_MISSING,
  type TestnetCredentialRow,
} from "@/lib/venues/registry";
import {
  TESTNET_VENUE_IDS,
  VENUE_CAPABILITIES,
  VENUE_DESCRIPTORS,
  VenueRefusal,
} from "@/lib/venues/types";
import { cancelOrder, submitOrder, type OrderProcessDeps } from "@/lib/orders/process";
import { reconcileOrders } from "@/lib/orders/reconcile";
import type { OrderIntent } from "@/lib/orders/idempotency";
import {
  createMemoryIdempotencyStore,
  createMemoryOrderStore,
  createTestClock,
  makeOrder,
} from "@/lib/orders/test-support";

/**
 * Phase 21's acceptance criteria, run against the real testnet adapter.
 *
 * The venue is scripted and the transport is a plain object, but every assertion below
 * goes through `createTestnetVenue` and the phase-06 ports — the same adapter, the same
 * error classification, the same state machine and the same reconciliation the
 * application runs. What the script stands in for is Binance's server, not our code:
 * each scenario sets the answers the venue would give, and the test then reads the
 * order row, the attempt record and the transition chain that the production path wrote.
 */

const secret = { apiKey: "testnet-api-key", apiSecret: "testnet-api-secret", readOnly: false };
const TESTNET_HOSTS = { api: { public: "https://testnet.binance.vision/api/v3" } };

const intent: OrderIntent = {
  userId: "dev-test-account",
  venue: "binance-testnet",
  market: "BTC-USD",
  side: "BUY",
  orderType: "MARKET",
  quantity: "0.01",
  limitPrice: null,
  stopLossPrice: "0",
  notionalUsdCents: 700_00,
  verifiedBalanceCents: 250_000,
};

type Script = {
  createOrder?: (request: {
    symbol: string;
    type: string;
    side: string;
    amount: string;
    price?: string;
    params?: Record<string, unknown>;
  }) => Promise<RawTestnetOrder>;
  fetchOrder?: (id: string, symbol?: string) => Promise<RawTestnetOrder>;
  fetchOrders?: () => Promise<RawTestnetOrder[]>;
  cancelOrder?: (id: string, symbol?: string) => Promise<RawTestnetOrder>;
};

type Calls = {
  createOrder: number;
  fetchOrder: number;
  fetchOrders: number;
  cancelOrder: number;
  createOrderRequests: { symbol: string; type: string; side: string; amount: string; price?: string; params?: Record<string, unknown> }[];
};

function scriptedTransport(script: Script): { exchange: TestnetExchange; calls: Calls } {
  const calls: Calls = { createOrder: 0, fetchOrder: 0, fetchOrders: 0, cancelOrder: 0, createOrderRequests: [] };
  const exchange: TestnetExchange = {
    urls: TESTNET_HOSTS,
    async fetchBalance() {
      return { free: { BTC: "0.5", USDT: "10000" }, total: { BTC: "0.5", USDT: "10000" } };
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
      calls.createOrderRequests.push({ symbol, type, side, amount, ...(price ? { price } : {}), ...(params ? { params } : {}) });
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

function harness(script: Script) {
  const orders = createMemoryOrderStore();
  const idempotency = createMemoryIdempotencyStore();
  const clock = createTestClock();
  const { exchange, calls } = scriptedTransport(script);
  const venue = createTestnetVenue(secret, { createExchange: () => exchange, now: clock.now });
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

const open = (signed: Partial<RawTestnetOrder> = {}): RawTestnetOrder => ({
  id: "91234",
  symbol: "BTC/USDT",
  side: "buy",
  type: "market",
  status: "NEW",
  amount: "0.01",
  filled: "0",
  ...signed,
});

test("the testnet is a venue: same descriptor vocabulary, one adapter, and only a testnet may place", () => {
  const descriptor = VENUE_DESCRIPTORS["binance-testnet"];
  assert.equal(descriptor.environment, "testnet");
  assert.ok(descriptor.capabilities.includes("place"));

  // Binance live publishes `place` (phase 22); the other live rows do not, so no caller can
  // route an order to a venue whose placement path has not been proved.
  for (const id of ["coinbase-advanced", "kraken", "wundertrading"] as const) {
    assert.equal(VENUE_DESCRIPTORS[id].environment, "live");
    assert.ok(!VENUE_DESCRIPTORS[id].capabilities.includes("place"), `${id} must not publish a placement capability`);
    assert.match(orderPlacementRefusal(id) ?? "", /does not publish order placement/);
  }
  assert.ok(VENUE_DESCRIPTORS.binance.capabilities.includes("place"));
  // The switch is the whole gate: off it is refused by name, on it is allowed with no
  // further question.
  assert.match(orderPlacementRefusal("binance") ?? "", /Live execution is switched off/);
  assert.match(orderPlacementRefusal("binance") ?? "", /liveExecutionEnabled/);
  assert.match(orderPlacementRefusal("binance") ?? "", /\/admin\/risk/);
  assert.equal(orderPlacementRefusal("binance", { liveExecutionEnabled: true }), null);
  assert.equal(orderPlacementRefusal("binance-testnet"), null);
  assert.equal(orderPlacementRefusal("binance-testnet", { liveExecutionEnabled: true }), null);
  assert.equal(orderPlacementRefusal("dev-paper"), null);
  assert.equal(orderPlacementRefusal("dev-paper", { liveExecutionEnabled: true }), null);
  // Every capability name is in the closed vocabulary: a descriptor cannot invent one.
  for (const capability of descriptor.capabilities) {
    assert.ok((VENUE_CAPABILITIES as readonly string[]).includes(capability));
  }
  for (const id of TESTNET_VENUE_IDS) {
    assert.equal(VENUE_DESCRIPTORS[id].environment, "testnet");
  }

  const { exchange } = scriptedTransport({});
  const venue = createTestnetVenue(secret, { createExchange: () => exchange });
  assert.equal(venue.environment, "testnet");
  assert.equal(venue.paper, false);
  assert.equal(venue.sandboxed, true);

  // The live adapters are the phase-20 read interface only: no order port on them.
  const live = createVenue("binance", secret);
  assert.equal("submit" in live, false);
  assert.equal("lookup" in live, false);
});

test("the client is refused unless every API host is a testnet host", () => {
  const production = { api: { public: "https://api.binance.com/api/v3", private: "https://api.binance.com/api/v3" } };
  assert.deepEqual(exchangeApiHosts(production), ["api.binance.com"]);
  assert.throws(
    () => assertTestnetEndpoints(production),
    (error: unknown) =>
      error instanceof VenueRefusal && /api\.binance\.com/.test(error.message) && /live exchange endpoint/.test(error.message),
  );
  assert.throws(() => assertTestnetEndpoints({ api: {} }), /no API endpoint/);
  assert.doesNotThrow(() => assertTestnetEndpoints(TESTNET_HOSTS));

  // The production factory is the sandbox, and its own guard accepts it.
  const exchange = createBinanceSpotTestnetExchange(secret);
  const hosts = exchangeApiHosts({ api: (exchange as unknown as { urls: { api: unknown } }).urls["api"] });
  assert.ok(hosts.length > 0);
  for (const host of hosts) {
    assert.ok((BINANCE_TESTNET_HOSTS as readonly string[]).includes(host), `${host} is not a testnet host`);
    assert.ok(!host.includes("binance.com"), "no production host may appear in a testnet client");
  }
});

test("a market is mapped onto the testnet pair once, and an unmappable one is refused by name", async () => {
  assert.equal(testnetSymbolFor("BTC-USD"), "BTC/USDT");
  assert.equal(testnetSymbolFor("eth-usd"), "ETH/USDT");
  assert.equal(testnetSymbolFor("BTC-USDT"), null);
  assert.equal(testnetSymbolFor("BTC"), null);
  assert.equal(testnetSymbolFor("BTC-USD-PERP"), null);

  const { calls, deps } = harness({ createOrder: async () => open() });
  const outcome = await submitOrder({ intent: { ...intent, market: "BTC-USD" }, actorUserId: "dev-test-account" }, deps);
  assert.equal(outcome.kind, "submitted");
  assert.equal(calls.createOrderRequests[0]?.symbol, "BTC/USDT");
  assert.equal(calls.createOrderRequests[0]?.amount, "0.01", "the quantity is sent as a decimal string, not a float");
  // The venue gets its own spelling of our client id: 1–36 of A-Za-z0-9-_, while the local
  // id (which the order path derives from the idempotency key) is recorded beside it.
  const sentClientId = String(calls.createOrderRequests[0]?.params?.newClientOrderId ?? "");
  assert.match(sentClientId, /^[A-Za-z0-9_-]{1,36}$/);
  assert.equal(testnetClientOrderId("ord_" + "a.b:c".repeat(12)).length, 36);
  assert.match(testnetClientOrderId("ord_" + "a.b:c".repeat(12)), /^[A-Za-z0-9_-]{1,36}$/);
  assert.equal(testnetClientOrderId(""), "veylora-order");

  // A market that cannot be mapped never reaches the transport: the adapter refuses it and
  // the refusal names the mapping, which is the difference between "venue said no" and
  // "this build could not ask".
  const venue = deps.venue;
  assert.ok(venue);
  const unmappable = await venue.submit({
    order: makeOrder({ status: "SUBMITTED", requestedQuantity: "0.01", market: "BTC-USDT", venue: "binance-testnet" }),
    idempotencyKey: "key-x",
    attempt: 1,
  });
  assert.equal(unmappable.kind, "rejected");
  assert.equal(unmappable.kind === "rejected" ? unmappable.code : "", "INVALID_PAIR");
  assert.equal(calls.createOrder, 1, "the unmappable market was refused without a venue call");
});

test("an accepted order records the request, the venue response and the venue id, and reconciliation fills it", async () => {
  const { orders, deps, clock, calls } = harness({
    createOrder: async () => open(),
    fetchOrder: async () => open({ status: "FILLED", filled: "0.01" }),
  });

  const submitted = await submitOrder({ intent, actorUserId: "dev-test-account" }, deps);
  assert.equal(submitted.kind, "submitted");
  assert.equal(submitted.status, 201);
  const order = submitted.order;
  assert.ok(order);
  assert.equal(order.venue, "binance-testnet", "the row names the venue that holds it");
  assert.equal(order.venueOrderId, "91234");
  assert.equal(order.status, "SUBMITTED");

  const attempt = orders.attempts.at(-1);
  assert.ok(attempt);
  assert.equal(attempt.outcome, "accepted");
  assert.match(attempt.reason, /binance-testnet accepted the order/);
  const provider = attempt.providerResponse as {
    request?: { symbol?: string; clientOrderId?: string; newClientOrderId?: string };
    response?: { id?: string };
  };
  assert.equal(provider.request?.symbol, "BTC/USDT", "the request is recorded with the attempt");
  assert.equal(provider.request?.clientOrderId, order.clientOrderId, "the local client id is recorded");
  assert.equal(provider.request?.newClientOrderId, testnetClientOrderId(order.clientOrderId), "the venue's spelling of it was sent");
  assert.equal(provider.response?.id, "91234", "the venue's own answer is recorded with the attempt");

  clock.advance(1_000);
  const summary = await reconcileOrders({ store: orders.store, venue: deps.venue!, now: clock.now });
  assert.equal(summary.corrected, 1);
  const filled = await orders.store.findOrderById(order.id);
  assert.equal(filled?.status, "FILLED");
  assert.equal(filled?.filledQuantity, "0.01");
  assert.equal(calls.fetchOrder, 1, "reconciliation asked the venue for its record");
});

test("a partial fill is an execution, and a cancel keeps it", async () => {
  const { orders, deps, clock, calls } = harness({
    createOrder: async () => open(),
    fetchOrder: async () => open({ status: "PARTIALLY_FILLED", filled: "0.005" }),
    cancelOrder: async () => open({ status: "CANCELED", filled: "0.005" }),
  });

  const submitted = await submitOrder({ intent, actorUserId: "dev-test-account" }, deps);
  assert.equal(submitted.kind, "submitted");
  const orderId = submitted.order!.id;

  clock.advance(2_000);
  const partial = await reconcileOrders({ store: orders.store, venue: deps.venue!, now: clock.now });
  assert.equal(partial.corrected, 1);
  const partiallyFilled = await orders.store.findOrderById(orderId);
  assert.equal(partiallyFilled?.status, "PARTIALLY_FILLED");
  assert.equal(partiallyFilled?.filledQuantity, "0.005");
  assert.equal(partiallyFilled?.remainingQuantity, "0.005");

  clock.advance(1_000);
  const cancelled = await cancelOrder({ orderId, actorUserId: "dev-test-account", reason: "the owner cancelled this order." }, deps);
  assert.equal(cancelled.kind, "cancelled", cancelled.reason.message);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.order?.status, "CANCELLED");
  // The executed half is a trade, not a quantity a cancel discards.
  assert.equal(cancelled.order?.filledQuantity, "0.005");
  // `remainingQuantity` is the quantity that never executed: it is reported as what was
  // left open when the cancel arrived, and the fill above is what stays as a trade.
  assert.equal(cancelled.order?.remainingQuantity, "0.005");
  assert.match(cancelled.reason.message, /0\.005 of 0\.01 already executed/);

  const filledTransition = orders.transitions.find((entry) => entry.event === "PARTIAL_FILL");
  assert.ok(filledTransition, "the partial fill was applied as an execution");
  assert.equal(filledTransition?.filledQuantity, "0.005");
  const cancelTransition = orders.transitions.find((entry) => entry.event === "CANCEL");
  assert.equal(cancelTransition?.filledQuantity, "0.005", "the cancel transition carries the executed quantity forward");
  assert.equal(calls.cancelOrder, 1);

  // A second reconciliation over a terminal order changes nothing.
  const before = orders.transitions.length;
  clock.advance(10_000);
  await reconcileOrders({ store: orders.store, venue: deps.venue!, now: clock.now });
  assert.equal(orders.transitions.length, before);
  assert.equal((await orders.store.findOrderById(orderId))?.status, "CANCELLED");
});

for (const scenario of [
  {
    name: "an invalid pair",
    error: Object.assign(new Error("Invalid symbol."), { name: "BadSymbol" }),
    code: "INVALID_PAIR",
    message: /Invalid symbol/,
  },
  {
    name: "an insufficient venue balance",
    error: Object.assign(new Error("Account has insufficient balance for requested action."), { name: "InsufficientFunds" }),
    code: "INSUFFICIENT_VENUE_BALANCE",
    message: /insufficient balance/,
  },
  {
    name: "a rejected order",
    error: Object.assign(new Error("Filter failure: LOT_SIZE"), { name: "InvalidOrder" }),
    code: "ORDER_REJECTED",
    message: /LOT_SIZE/,
  },
  {
    // The live run of this phase produced exactly this: Binance answered -1100 with a
    // BadRequest, which used to be classified as "no definitive answer" and retried three
    // times. A refusal is definitive and is recorded once.
    name: "a bad request",
    error: Object.assign(new Error('binance {"code":-1100,"msg":"Illegal characters found in parameter\'newClientOrderId\'."}'), {
      name: "BadRequest",
    }),
    code: "ORDER_REJECTED",
    message: /Illegal characters/,
  },
] as const) {
  test(`${scenario.name} is recorded with the venue's own reason`, async () => {
    const { orders, deps } = harness({
      createOrder: async () => {
        throw scenario.error;
      },
    });

    const outcome = await submitOrder({ intent, actorUserId: "dev-test-account" }, deps);
    assert.equal(outcome.kind, "failed");
    assert.equal(outcome.status, 502);
    assert.equal(outcome.attempts, 1, "a definitive refusal is recorded once, not retried");
    assert.match(outcome.reason.message, scenario.message);
    assert.ok(outcome.order);
    assert.equal(outcome.order.status, "FAILED");

    const attempt = orders.attempts.at(-1);
    assert.ok(attempt);
    assert.equal(attempt.outcome, "rejected");
    assert.equal(attempt.reasonCode, "ORDER_REJECTED");
    assert.match(attempt.reason, scenario.message);
    const provider = attempt.providerResponse as { code?: string; error?: string; request?: { symbol?: string } };
    assert.equal(provider.code, scenario.code);
    assert.match(provider.error ?? "", scenario.message);
    assert.equal(provider.request?.symbol, "BTC/USDT", "what was sent is recorded alongside what came back");
  });
}

test("a venue timeout is looked up by our client id, and a venue that holds the order is not resent", async () => {
  // The venue stores the client id from the request even though its answer was lost —
  // which is exactly the situation the lookup after a timeout exists for.
  let storedClientOrderId: string | null = null;
  const { orders, deps, clock, calls } = harness({
    createOrder: async ({ params }) => {
      storedClientOrderId = typeof params?.newClientOrderId === "string" ? params.newClientOrderId : null;
      throw Object.assign(new Error("request timed out"), { name: "RequestTimeout" });
    },
    // No venueOrderId exists yet: the lookup has to find the order by the client id the
    // submission carried, which is what makes a retry safe.
    fetchOrders: async () => [open({ id: "77001", status: "NEW", ...(storedClientOrderId ? { clientOrderId: storedClientOrderId } : {}) })],
  });

  const submitted = await submitOrder({ intent, actorUserId: "dev-test-account" }, deps);
  assert.equal(submitted.kind, "submitted");
  assert.equal(submitted.status, 201);
  assert.match(submitted.reason.message, /timed out/);
  assert.equal(submitted.order?.venueOrderId, "77001");
  assert.equal(calls.createOrder, 1, "the order was not sent a second time");
  assert.ok(calls.fetchOrders >= 1, "the venue was asked whether it held the order");

  clock.advance(1_000);
  const summary = await reconcileOrders({ store: orders.store, venue: deps.venue!, now: clock.now });
  assert.equal(summary.checked, 1);
  assert.equal((await orders.store.findOrderById(submitted.order!.id))?.status, "SUBMITTED");

  // A second submission with the same intent is a replay, not a second order.
  const replay = await submitOrder({ intent, actorUserId: "dev-test-account" }, deps);
  assert.equal(replay.kind, "replayed");
  assert.equal(calls.createOrder, 1, "one intent, one venue order");
});

test("a venue that cannot be reached fails with the transport's reason, and a terminal failure is not reopened", async () => {
  const { orders, deps, clock } = harness({
    createOrder: async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND testnet.binance.vision"), { name: "NetworkError" });
    },
    fetchOrders: async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND testnet.binance.vision"), { name: "NetworkError" });
    },
  });

  const outcome = await submitOrder({ intent, actorUserId: "dev-test-account" }, deps);
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.attempts, 3, "a transport failure is retried, unlike a refusal");
  assert.match(outcome.reason.message, /ENOTFOUND/);
  assert.equal(outcome.order?.status, "FAILED");

  // A failed submission is terminal, and reconciliation leaves it alone: the record says
  // the venue was never reached, which is a different fact from "the order was lost".
  const before = orders.transitions.length;
  clock.advance(1_000);
  await reconcileOrders({ store: orders.store, venue: deps.venue!, now: clock.now });
  assert.equal(orders.transitions.length, before);
});

test("reconciliation never asks a venue that does not hold the order", async () => {
  // The order was placed on the paper venue; routing now selects the testnet. Asking the
  // testnet would answer "no such order", and after the grace window that would close a
  // live paper order as reconciled. The pass must leave it alone and say how many.
  const orders = createMemoryOrderStore();
  const seeded = orders.seed({ status: "SUBMITTED", requestedQuantity: "0.01", venue: "dev-paper" });
  const { exchange, calls } = scriptedTransport({});
  const testnet = createTestnetVenue(secret, { createExchange: () => exchange });
  const clock = createTestClock();

  const summary = await reconcileOrders({
    store: orders.store,
    resolveVenue: async (userId) => ({ kind: "resolved", venue: testnet, source: "testnet", detail: `routed for ${userId}` }),
    now: clock.now,
  });

  assert.equal(summary.checked, 1);
  assert.equal(summary.corrected, 0);
  assert.equal(summary.skippedByVenueMismatch, 1);
  assert.equal(summary.unresolved, 1);
  assert.equal(calls.fetchOrder + calls.fetchOrders, 0, "the wrong venue was never asked");
  assert.equal(orders.transitions.length, 0);
  assert.equal((await orders.store.findOrderById(seeded.id))?.status, "SUBMITTED");
  assert.match(summary.reason.message, /resolved elsewhere/);
});

test("a cancel after the fill is refused, and the venue's record closes the order as filled", async () => {
  const { orders, deps, clock, calls } = harness({
    createOrder: async () => open({ filled: "0.004", status: "PARTIALLY_FILLED" }),
    fetchOrder: async () => open({ status: "FILLED", filled: "0.01" }),
    cancelOrder: async () => {
      throw Object.assign(new Error("Unknown order sent."), { name: "InvalidOrder" });
    },
  });

  const submitted = await submitOrder({ intent, actorUserId: "dev-test-account" }, deps);
  assert.equal(submitted.kind, "submitted");
  const orderId = submitted.order!.id;

  clock.advance(1_000);
  const refused = await cancelOrder({ orderId, actorUserId: "dev-test-account", reason: "the owner cancelled this order." }, deps);
  assert.equal(refused.kind, "refused");
  assert.equal(refused.status, 409);
  assert.match(refused.reason.message, /Unknown order sent/);
  assert.equal(refused.order?.status, "FILLED", "the venue's record is the truth: the order had filled");
  assert.equal(refused.order?.filledQuantity, "0.01");
  assert.equal(calls.cancelOrder, 1);

  // Cancelling a filled order again is refused by the state machine before the venue is
  // contacted at all.
  const again = await cancelOrder({ orderId, actorUserId: "dev-test-account", reason: "try again" }, deps);
  assert.equal(again.kind, "refused");
  assert.equal(again.status, 409);
  assert.equal(calls.cancelOrder, 1, "a terminal order never reaches the venue");
  assert.match(again.reason.message, /already|cannot|FILLED/i);
  assert.equal((await orders.store.findOrderById(orderId))?.status, "FILLED");
});

test("order routing resolves the admin switch and the account's own testnet key, and refuses everything else", async () => {
  const credential: TestnetCredentialRow = {
    id: "cred-1",
    venue: "binance-testnet",
    label: "testnet trading key",
    readOnly: false,
    credentialCiphertext: "ciphertext",
    credentialIv: "iv",
    credentialAuthTag: "tag",
    createdAt: new Date("2026-10-17T12:00:00.000Z"),
  };
  const material = { apiKey: "k", apiSecret: "s", readOnly: false };
  const { exchange } = scriptedTransport({});
  const created: string[] = [];
  const createTestnet = (input: typeof material) => {
    created.push(input.apiKey);
    return createTestnetVenue(input, { createExchange: () => exchange });
  };

  const off = await resolveOrderVenue("user-1", {
    settings: async () => ({ testnetOrdersEnabled: false, liveExecutionEnabled: false }),
    credential: async () => credential,
    decrypt: () => material,
    createTestnet,
  });
  assert.equal(off.kind, "resolved");
  assert.equal(off.kind === "resolved" ? off.source : "", "paper");
  assert.equal(off.kind === "resolved" ? off.venue.environment : "", "paper");
  assert.equal(created.length, 0, "the switch being off means no key is read");

  const on = await resolveOrderVenue("user-1", {
    settings: async () => ({ testnetOrdersEnabled: true, liveExecutionEnabled: false }),
    credential: async () => credential,
    decrypt: () => material,
    createTestnet,
  });
  assert.equal(on.kind, "resolved");
  assert.equal(on.kind === "resolved" ? on.venue.id : "", "binance-testnet");
  assert.equal(on.kind === "resolved" ? on.source : "", "testnet");
  assert.match(on.kind === "resolved" ? on.detail : "", /sandbox endpoint only/);

  const missing = await resolveOrderVenue("user-1", {
    settings: async () => ({ testnetOrdersEnabled: true, liveExecutionEnabled: false }),
    credential: async () => null,
    createTestnet,
  });
  assert.equal(missing.kind, "refused");
  assert.equal(missing.kind === "refused" ? missing.code : "", TESTNET_CREDENTIAL_MISSING);
  assert.equal(missing.kind === "refused" ? missing.status : 0, 409);

  const readOnly = await resolveOrderVenue("user-1", {
    settings: async () => ({ testnetOrdersEnabled: true, liveExecutionEnabled: false }),
    credential: async () => ({ ...credential, readOnly: true }),
    decrypt: () => material,
    createTestnet,
  });
  assert.equal(readOnly.kind, "refused");
  assert.equal(readOnly.kind === "refused" ? readOnly.code : "", "READ_ONLY_CREDENTIAL");

  const liveKey = await resolveOrderVenue("user-1", {
    settings: async () => ({ testnetOrdersEnabled: true, liveExecutionEnabled: false }),
    credential: async () => ({ ...credential, venue: "binance" }),
    decrypt: () => material,
    createTestnet,
  });
  assert.equal(liveKey.kind, "refused", "a live credential is never selected for orders");

  const unreadable = await resolveOrderVenue("user-1", {
    settings: async () => ({ testnetOrdersEnabled: true, liveExecutionEnabled: false }),
    credential: async () => credential,
    decrypt: () => {
      throw new Error("bad auth tag");
    },
    createTestnet,
  });
  assert.equal(unreadable.kind, "refused");
  assert.equal(unreadable.kind === "refused" ? unreadable.status : 0, 503);

  const noSettings = await resolveOrderVenue("user-1", {
    settings: async () => {
      throw new Error("database unavailable");
    },
    createTestnet,
  });
  assert.equal(noSettings.kind, "refused");
  assert.equal(noSettings.kind === "refused" ? noSettings.code : "", "DATABASE_UNAVAILABLE");
  assert.equal(created.length, 1, "only the one resolvable configuration built a client");
});

test("a trade-capable testnet key backs orders even when a newer read-only key was added", () => {
  const tradeCapable = { ...row("cred-trade", false, "2026-10-01T00:00:00.000Z") };
  const newerReadOnly = row("cred-read", true, "2026-10-17T00:00:00.000Z");
  assert.equal(pickTestnetCredential([newerReadOnly, tradeCapable])?.id, "cred-trade");
  // Every key read-only: the newest is returned so the refusal can say "read-only" rather
  // than claim the account has no key at all.
  assert.equal(
    pickTestnetCredential([row("cred-old", true, "2026-10-01T00:00:00.000Z"), newerReadOnly])?.id,
    "cred-read",
  );
  assert.equal(pickTestnetCredential([]), null);
});

function row(id: string, readOnly: boolean, createdAt: string): TestnetCredentialRow {
  return {
    id,
    venue: "binance-testnet",
    label: id,
    readOnly,
    credentialCiphertext: "c",
    credentialIv: "i",
    credentialAuthTag: "t",
    createdAt: new Date(createdAt),
  };
}

test("the venue summary says where an order would go, and admits when it cannot know", async () => {
  const paper = await orderVenueSummary({ settings: async () => ({ testnetOrdersEnabled: false, liveExecutionEnabled: false }) });
  assert.equal(paper.environment, "paper");
  assert.equal(paper.venueId, "dev-paper");
  assert.equal(paper.available, true);
  assert.match(paper.detail, /no real funds move/);

  const testnet = await orderVenueSummary({ settings: async () => ({ testnetOrdersEnabled: true, liveExecutionEnabled: false }) });
  assert.equal(testnet.environment, "testnet");
  assert.equal(testnet.venueId, "binance-testnet");
  assert.match(testnet.detail, /no real funds/);

  const unknown = await orderVenueSummary({
    settings: async () => {
      throw new Error("database unavailable");
    },
  });
  assert.equal(unknown.available, false);
  assert.equal(unknown.environment, "paper");
  assert.match(unknown.detail, /refused rather than sent anywhere/);
});

test("the venue's vocabulary maps onto the lifecycle without inventing a state", () => {
  assert.equal(testnetOrderState({ status: "NEW", filled: "0", amount: "1" }), "OPEN");
  assert.equal(testnetOrderState({ status: "PARTIALLY_FILLED", filled: "0.5", amount: "1" }), "PARTIALLY_FILLED");
  assert.equal(testnetOrderState({ status: "FILLED", filled: "1", amount: "1" }), "FILLED");
  assert.equal(testnetOrderState({ status: "CLOSED", filled: "0.5", amount: "1" }), "PARTIALLY_FILLED");
  assert.equal(testnetOrderState({ status: "CANCELED", filled: "0", amount: "1" }), "CANCELLED");
  assert.equal(testnetOrderState({ status: "REJECTED" }), "REJECTED");
  assert.equal(testnetOrderState({ status: "weird" }), "UNKNOWN");
  assert.equal(testnetOrderState({}), "UNKNOWN");

  assert.deepEqual(classifyVenueError(Object.assign(new Error("nope"), { name: "BadSymbol" })), {
    kind: "invalid-pair",
    code: "INVALID_PAIR",
    reason: "nope",
  });
  assert.equal(classifyVenueError(Object.assign(new Error("x"), { name: "RequestTimeout" })).kind, "timeout");
  assert.equal(classifyVenueError(new Error("socket hang up")).kind, "unavailable");
  assert.equal(classifyVenueError(undefined).reason, "The venue did not answer.");
});
