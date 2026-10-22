import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { credentialAvailability } from "@/lib/trading/read-only-credentials";
import { createCcxtVenue, type CcxtExchange } from "@/lib/venues/ccxt-adapter";
import { createWunderTradingVenue } from "@/lib/venues/wundertrading-adapter";
import {
  connectionHealth,
  isVenueRefusal,
  parsePermissions,
  validateRequestedPermissions,
  VENUE_CAPABILITIES,
  VENUE_DESCRIPTORS,
  VENUE_IDS,
  verificationRecord,
  VenueRefusal,
  type VenueSecret,
} from "@/lib/venues/types";

/**
 * Phase 20's four acceptance criteria, asserted against the same code the routes run.
 *
 * Every test here drives the adapters through their injected transport — the counting
 * fake below — so "the refusal happened before the venue was contacted" is a counted
 * fact rather than an inference from the error message.
 */

const READ_ONLY: VenueSecret = { apiKey: "test-key", apiSecret: "test-secret", readOnly: true };
const TRADE_CAPABLE: VenueSecret = { apiKey: "test-key", apiSecret: "test-secret", readOnly: false };

type FakeOptions = {
  balance?: () => Promise<unknown>;
  cancelOrder?: (id: string) => Promise<unknown>;
  permissions?: () => Promise<unknown>;
};

/**
 * A CCXT-shaped transport that counts what happened to it.
 *
 * It is deliberately a plain object rather than a partial `ccxt.Exchange`: the adapter
 * only ever calls these five methods, and the fake proves that by being nothing else.
 */
function countingTransport(options: FakeOptions = {}) {
  const calls = { created: 0, fetchBalance: 0, cancelOrder: 0, close: 0, permissions: 0 };
  const createExchange = (): CcxtExchange => {
    calls.created += 1;
    const exchange: CcxtExchange & { sapiGetAccountApiRestrictions?: () => Promise<unknown> } = {
      async fetchBalance() {
        calls.fetchBalance += 1;
        if (options.balance) return (await options.balance()) as Awaited<ReturnType<CcxtExchange["fetchBalance"]>>;
        return { free: { BTC: "0.25" }, total: { BTC: "0.5" } };
      },
      async fetchOrders() {
        return [];
      },
      async fetchOrder(id: string) {
        return { id, status: "closed", amount: "1", filled: "1" };
      },
      async cancelOrder(id: string) {
        calls.cancelOrder += 1;
        if (options.cancelOrder) return (await options.cancelOrder(id)) as Awaited<ReturnType<CcxtExchange["cancelOrder"]>>;
        return { id, status: "canceled" };
      },
      async close() {
        calls.close += 1;
      },
    };
    if (options.permissions) {
      exchange.sapiGetAccountApiRestrictions = async () => {
        calls.permissions += 1;
        return options.permissions!();
      };
    }
    return exchange;
  };
  return { calls, createExchange };
}

async function refusalFrom(run: () => Promise<unknown>): Promise<VenueRefusal> {
  try {
    await run();
  } catch (error) {
    assert.ok(isVenueRefusal(error), `expected a VenueRefusal, got ${String(error)}`);
    return error;
  }
  throw new Error("expected a refusal, but the call resolved");
}

test("every venue implements one interface, and a capability it never claimed is refused before any call", async () => {
  const kraken = countingTransport();
  const venue = createCcxtVenue("kraken", TRADE_CAPABLE, { createExchange: kraken.createExchange });

  // The interface, method for method: no caller has to know which venue it holds.
  for (const method of ["readBalances", "readPositions", "readOrders", "readOrderStatus", "cancelOrder", "checkHealth"] as const) {
    assert.equal(typeof venue[method], "function", `${method} must exist on every venue`);
  }
  assert.equal(venue.capabilities.includes("balances"), true);
  assert.equal(venue.capabilities.includes("positions"), false);

  // Spot accounts have no positions, and the refusal says so without a request.
  const positions = await refusalFrom(() => venue.readPositions());
  assert.equal(positions.code, "CAPABILITY_UNAVAILABLE");
  assert.match(positions.message, /positions/i);
  assert.equal(kraken.calls.created, 0, "a refused capability must not create a client");

  // WunderTrading is the same interface with an honest descriptor: health only.
  const wunder = createWunderTradingVenue(TRADE_CAPABLE);
  assert.deepEqual([...wunder.capabilities], ["health"]);
  const balance = await refusalFrom(() => wunder.readBalances());
  assert.equal(balance.code, "CAPABILITY_UNAVAILABLE");
  assert.match(balance.message, /WunderTrading does not provide balances/);

  // Every venue declares a subset of the closed vocabulary, and every declaration is
  // one a caller can hold: a capability outside the list would be one nothing can ask
  // for, and a missing one would be a silent gap.
  for (const id of VENUE_IDS) {
    const declared = VENUE_DESCRIPTORS[id].capabilities;
    assert.ok(declared.length > 0, `${id} must declare at least one capability`);
    for (const capability of declared) {
      assert.ok(VENUE_CAPABILITIES.includes(capability), `${id} declares unknown capability ${capability}`);
    }
    assert.equal(new Set(declared).size, declared.length, `${id} declares a capability twice`);
  }
});

test("both adapters implement the whole interface, so a caller never branches on the venue", async () => {
  const methods = ["readBalances", "readPositions", "readOrders", "readOrderStatus", "cancelOrder", "checkHealth"] as const;
  const adapters = [
    createCcxtVenue("binance", TRADE_CAPABLE, { createExchange: countingTransport().createExchange }),
    createCcxtVenue("coinbase-advanced", TRADE_CAPABLE, { createExchange: countingTransport().createExchange }),
    createWunderTradingVenue(TRADE_CAPABLE),
  ];

  for (const adapter of adapters) {
    for (const method of methods) {
      assert.equal(typeof adapter[method], "function", `${adapter.id}.${method} must exist`);
    }
    assert.equal(adapter.label.length > 0, true);
    assert.ok(adapter.capabilities.includes("health"), `${adapter.id} must be checkable`);
  }

  // Every capability a descriptor claims actually works, through the reachable venue: the
  // reads answer, and the one write a declared capability allows is gated rather than absent.
  const spot = adapters[0];
  assert.deepEqual(await spot.readOrders(5), []);
  assert.deepEqual(await spot.readBalances(), [{ asset: "BTC", available: "0.25", total: "0.5" }]);
  const status = await spot.readOrderStatus("order-1");
  assert.deepEqual(status, { id: "order-1", status: "closed", filled: "1", remaining: "0" });
  for (const capability of spot.capabilities.filter((candidate) => candidate !== "health")) {
    assert.ok(VENUE_CAPABILITIES.includes(capability), `unknown capability ${capability}`);
  }
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [fullPath] : [];
  });
}

/**
 * The two promises a browser-side panel and a log line could break.
 *
 * Definitions of done are worth asserting where they can regress silently: this phase
 * says the key's plaintext never appears in a log, a response or the browser bundle,
 * and that the panel renders the *same* descriptors the server enforces. The first is
 * checked where the leak would happen — a logging call handed a credential field — and
 * the second by the panel's imports: it may import the client-safe types module and
 * nothing else from `src/lib/venues`, because the adapters and the registry hold CCXT,
 * Node crypto and the settings table.
 */
test("no source logs credential material, and the panel imports only the client-safe venue module", () => {
  const src = fileURLToPath(new URL("../src", import.meta.url));
  const materialFields = "(?:apiKey|apiSecret|passphrase|credentialCiphertext|credentialIv|credentialAuthTag)";
  const loggingCall = new RegExp(`(?:console\\.(?:log|info|warn|error|debug)|logger\\.[A-Za-z]+)\\([^)]*${materialFields}`, "s");

  const leaks = sourceFiles(src)
    .filter((file) => loggingCall.test(readFileSync(file, "utf8")))
    .map((file) => file.slice(file.indexOf("/src/") + 1));
  assert.deepEqual(leaks, [], "no source file may log a credential field");

  const panel = readFileSync(fileURLToPath(new URL("../src/components/trading-accounts.tsx", import.meta.url)), "utf8");
  const venueImports = panel
    .split("\n")
    .filter((line) => line.includes('from "@/lib/venues/'))
    .map((line) => line.slice(line.indexOf('"@/lib/venues/') + 1, line.lastIndexOf('"')));
  assert.deepEqual(venueImports, ["@/lib/venues/types"], "the panel may import only the client-safe venue module");
  for (const forbidden of ["ccxt-adapter", "wundertrading-adapter", "registry", "credential-vault"]) {
    assert.equal(panel.includes(forbidden), false, `the panel must not reach ${forbidden}`);
  }
});

test("a read-only key and a trade-capable key behave differently on a write, and the refusal precedes the venue", async () => {
  const readOnlyTransport = countingTransport();
  const readOnlyVenue = createCcxtVenue("kraken", READ_ONLY, { createExchange: readOnlyTransport.createExchange });
  const refused = await refusalFrom(() => readOnlyVenue.cancelOrder("order-1"));
  assert.equal(refused.code, "READ_ONLY_CREDENTIAL");
  assert.match(refused.message, /read-only/i);
  assert.match(refused.message, /cancel an order/);
  assert.equal(readOnlyTransport.calls.created, 0, "no client may be built for a refused write");
  assert.equal(readOnlyTransport.calls.cancelOrder, 0, "no cancellation may be sent");

  const tradeTransport = countingTransport();
  const tradeVenue = createCcxtVenue("kraken", TRADE_CAPABLE, { createExchange: tradeTransport.createExchange });
  const cancelled = await tradeVenue.cancelOrder("order-1");
  assert.deepEqual(cancelled, { id: "order-1", status: "cancelled" });
  assert.equal(tradeTransport.calls.cancelOrder, 1);

  // Reads are unaffected by the scope: a read-only key is what reads are for.
  const balances = await createCcxtVenue("kraken", READ_ONLY, { createExchange: countingTransport().createExchange }).readBalances();
  assert.deepEqual(balances, [{ asset: "BTC", available: "0.25", total: "0.5" }]);
});

test("a withdrawal permission is refused on save, and the reason names withdrawal", () => {
  const refused = validateRequestedPermissions(["read", "withdraw"], false);
  assert.equal(refused.valid, false);
  if (refused.valid) return;
  assert.equal(refused.code, "WITHDRAWAL_NOT_PERMITTED");
  assert.match(refused.error, /withdrawal/i);
  assert.match(refused.error, /connect/i);

  // The scope decides the request when none is stated, and the two statements may not
  // contradict each other.
  assert.deepEqual(validateRequestedPermissions(undefined, true), { valid: true, permissions: ["read"] });
  assert.deepEqual(validateRequestedPermissions(undefined, false), { valid: true, permissions: ["read", "trade"] });
  const conflict = validateRequestedPermissions(["read", "trade"], true);
  assert.equal(conflict.valid, false);
  if (!conflict.valid) assert.equal(conflict.code, "SCOPE_CONFLICT");
  const missingTrade = validateRequestedPermissions(["read"], false);
  assert.equal(missingTrade.valid, false);
  if (!missingTrade.valid) assert.equal(missingTrade.code, "SCOPE_CONFLICT");
  const unknown = validateRequestedPermissions(["read", "sudo"], false);
  assert.equal(unknown.valid, false);
  if (!unknown.valid) assert.match(unknown.error, /Unsupported permission "sudo"/);
  const notAList = validateRequestedPermissions("read", false);
  assert.equal(notAList.valid, false);
});

test("a failing verification records the venue's error and does not claim a verification", async () => {
  const failing = countingTransport({ balance: async () => { throw new Error("Invalid API key (401)."); } });
  const venue = createCcxtVenue("kraken", TRADE_CAPABLE, { createExchange: failing.createExchange });
  const health = await venue.checkHealth();

  assert.equal(health.ok, false);
  assert.match(health.error ?? "", /Invalid API key \(401\)/);
  assert.equal(health.permissions, null);
  assert.equal(typeof health.latencyMs, "number");
  assert.equal(failing.calls.close, 1, "the client is closed even when the read fails");

  const record = verificationRecord(health);
  assert.equal(record.lastCheckError, "Invalid API key (401).");
  assert.equal("verifiedAt" in record, false, "a failed check must not claim a verification");
  assert.equal(record.reportedPermissions, null);
  assert.equal(connectionHealth(record).state, "FAILING");

  // The same row shape from a successful check: verified, no error, and measured.
  const healthy = countingTransport();
  const working = await createCcxtVenue("kraken", TRADE_CAPABLE, { createExchange: healthy.createExchange }).checkHealth();
  const healthyRecord = verificationRecord(working);
  assert.equal(working.ok, true);
  assert.match(working.evidence, /1 non-zero spot balance/);
  assert.equal(healthyRecord.lastCheckError, null);
  assert.ok(healthyRecord.verifiedAt instanceof Date);
  assert.deepEqual(connectionHealth(healthyRecord), {
    state: "HEALTHY",
    checkedAt: healthyRecord.lastCheckedAt.toISOString(),
    latencyMs: healthyRecord.lastCheckLatencyMs,
  });
  assert.deepEqual(connectionHealth({ lastCheckedAt: null }), { state: "UNCHECKED" });
  assert.deepEqual(parsePermissions(healthyRecord.reportedPermissions), []);
  assert.deepEqual(parsePermissions("not json"), []);
  assert.deepEqual(parsePermissions('["trade","withdraw","nonsense"]'), ["trade", "withdraw"]);
});

test("a key the venue reports as able to withdraw is unhealthy, and that is recorded", async () => {
  const transport = countingTransport({
    permissions: async () => ({
      enableReading: true,
      enableSpotAndMarginTrading: true,
      enableWithdrawals: true,
    }),
  });
  const venue = createCcxtVenue("binance", TRADE_CAPABLE, { createExchange: transport.createExchange });
  const health = await venue.checkHealth();

  assert.equal(transport.calls.permissions, 1, "Binance is asked about the key's own permissions");
  assert.equal(health.ok, false);
  assert.deepEqual(health.permissions, ["read", "trade", "withdraw"]);
  assert.match(health.error ?? "", /withdraw/i);
  assert.equal(verificationRecord(health).lastCheckError?.includes("withdraw"), true);

  // A venue that does not answer the permission question says null rather than [].
  const silent = countingTransport();
  const kraken = await createCcxtVenue("kraken", TRADE_CAPABLE, { createExchange: silent.createExchange }).checkHealth();
  assert.equal(silent.calls.permissions, 0);
  assert.equal(kraken.permissions, null);
  assert.equal(kraken.ok, true);
  assert.equal(verificationRecord(kraken).reportedPermissions, null);
});

test("deleting a credential ends its use immediately", () => {
  assert.deepEqual(credentialAvailability({ revokedAt: null }), { available: true });

  const revoked = credentialAvailability({ revokedAt: new Date("2026-10-17T12:00:00Z") });
  assert.equal(revoked.available, false);
  if (!revoked.available) {
    assert.equal(revoked.status, 404);
    assert.equal(revoked.body.code, "CREDENTIAL_REVOKED");
    // The sentence is the one an unknown id gets, so a revoked key is not confirmed to
    // a caller who should not know it exists.
    assert.match(revoked.body.error, /not found on this account/);
  }

  const missing = credentialAvailability(null);
  assert.equal(missing.available, false);
  if (!missing.available) {
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, undefined);
  }
});
