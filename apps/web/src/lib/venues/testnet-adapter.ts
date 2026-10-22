import ccxt from "ccxt";
import DecimalJS from "decimal.js";
import type { StoredOrder } from "@/lib/orders/store";
import {
  assertTestnetEndpoints,
  binanceOrderState,
  classifyVenueError,
  clientOrderIdForVenue,
  usdtPairFor,
  type RawBinanceOrder,
} from "./binance-shared";
import type {
  OrderVenuePort,
  VenueCancelOutcome,
  VenueOrderReport,
  VenueOrderState,
  VenueSubmitOutcome,
} from "@/lib/orders/venue";
import { normalizeSpotBalances, type VerifiedSpotBalance } from "./ccxt-adapter";
import {
  assertWriteAllowed,
  CAPABILITY_LABELS,
  requireCapability,
  VENUE_DESCRIPTORS,
  VENUE_LABELS,
  VENUE_REFUSAL_CODES,
  VenueRefusal,
  type TestnetVenueId,
  type VenueAdapter,
  type VenueCancellation,
  type VenueCapability,
  type VenueHealthCheck,
  type VenueOrder,
  type VenueOrderStatus,
  type VenuePosition,
  type VenueSecret,
} from "./types";

/**
 * Binance Spot Testnet: a venue that really answers, with no money behind it.
 *
 * Phase 21's whole claim is that a testnet order and a live order take the same code
 * path, and the only way to make that true rather than approximately true is to make
 * the testnet *a venue*: its own descriptor, its own keys, its own endpoint, its own
 * balances and order ids. `process.ts` cannot tell the difference between this object
 * and phase 22's live one, because both implement {@link OrderVenuePort}; the
 * difference is which row of `VENUE_DESCRIPTORS` was selected and which key was
 * decrypted for it.
 *
 * Three properties are enforced here rather than promised in prose:
 *
 *  1. **The endpoint is the sandbox, and only the sandbox.** The client is built and
 *     then `setSandboxMode(true)` is applied, and the resulting API hosts are checked
 *     against the testnet hosts before the client is handed back
 *     ({@link assertTestnetEndpoints}). A ccxt change that quietly restored a
 *     production URL throws instead of placing a real order — and the check runs per
 *     client, not once at startup.
 *  2. **A read-only key never reaches the venue.** Every write calls
 *     {@link assertWriteAllowed} before a client exists, and the refusal is returned
 *     as a rejection with `READ_ONLY_CREDENTIAL` so the order row records why.
 *  3. **The venue's answer is recorded, not paraphrased.** Every submission returns
 *     the request it sent and the response it received; `process.ts` writes both into
 *     the attempt row, which is what makes "why did this order fail?" answerable from
 *     the record.
 *
 * Two honest differences from a live venue are written down rather than smoothed over:
 *
 *  - **The pair is mapped.** An intent names a USD market (`BTC-USD`, the Coinbase
 *    product id the rest of the build uses); Binance's spot book quotes `BTC/USDT`.
 *    {@link testnetSymbolFor} states that mapping once and returns `null` for anything
 *    it cannot map, which becomes a rejection with the mapping named. A testnet fill
 *    proves the lifecycle, not price parity, and the phase record says so.
 *  - **The testnet has no real liquidity.** A market order on a thin testnet book can
 *    rest unfilled; the adapter reports what the venue says (`OPEN`) and reconciliation
 *    waits, exactly as it would for a live order that has not filled yet.
 */

const Decimal = DecimalJS.clone({ precision: 40 });
const DEFAULT_ORDER_LIMIT = 50;
const MAX_ORDER_LIMIT = 200;

/**
 * The shared Binance vocabulary, re-exported under the names this adapter's callers and
 * tests already use. The implementation moved to `binance-shared.ts` in phase 22 so the
 * live adapter reads a fill through the same code rather than a copy of it.
 */
export { BINANCE_TESTNET_HOSTS, assertTestnetEndpoints, classifyVenueError, exchangeApiHosts } from "./binance-shared";
export type { ClassifiedVenueError, VenueErrorKind } from "./binance-shared";

type RawBalance = { free?: Record<string, string | number | null | undefined>; total?: Record<string, string | number | null | undefined> };

export type RawTestnetOrder = RawBinanceOrder;

/**
 * The slice of a CCXT exchange this adapter uses.
 *
 * Stated so the test double is a plain object rather than a partial `ccxt.Exchange`,
 * and so the adapter's whole surface is visible in one place. `createOrder` takes the
 * amount as a decimal *string*: JS floats lose the last digits of a quantity, and this
 * is the one number in the flow that must survive intact.
 */
export type TestnetExchange = {
  fetchBalance(): Promise<RawBalance>;
  fetchOrders(symbol?: string, since?: number, limit?: number): Promise<RawTestnetOrder[]>;
  fetchOrder(id: string, symbol?: string): Promise<RawTestnetOrder>;
  createOrder(
    symbol: string,
    type: string,
    side: string,
    amount: string,
    price?: string,
    params?: Record<string, unknown>,
  ): Promise<RawTestnetOrder>;
  cancelOrder(id: string, symbol?: string): Promise<RawTestnetOrder>;
  close(): Promise<void>;
  urls?: unknown;
};

/** The USD market as the Binance pair that can answer it; one mapping for both venues. */
export function testnetSymbolFor(market: string): string | null {
  return usdtPairFor(market);
}

/**
 * Production transport: Binance spot, sandboxed, checked before it is used.
 *
 * `adjustForTimeDifference` is on because a testnet's clock drifts and a signed request
 * more than a second out is rejected as a timestamp error — a failure that would look
 * like a venue fault in the evidence.
 */
export function createBinanceSpotTestnetExchange(secret: VenueSecret): TestnetExchange {
  const exchange = new ccxt.binance({
    apiKey: secret.apiKey,
    secret: secret.apiSecret,
    enableRateLimit: true,
    timeout: 10_000,
    options: { defaultType: "spot", adjustForTimeDifference: true },
  });
  exchange.setSandboxMode(true);
  assertTestnetEndpoints({ api: exchange.urls["api"] });
  return exchange as unknown as TestnetExchange;
}

/** Our client order id in the shape the venue accepts; one translation for both venues. */
export function testnetClientOrderId(clientOrderId: string): string {
  return clientOrderIdForVenue(clientOrderId);
}

/** The venue's lifecycle vocabulary, mapped once for both Binance venues. */
export function testnetOrderState(order: RawTestnetOrder): VenueOrderState {
  return binanceOrderState(order);
}

function decimalString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Decimal(String(value));
  return parsed.isFinite() ? parsed.toFixed() : null;
}

function normalizeOrder(order: RawTestnetOrder): VenueOrder {
  return {
    id: String(order.id ?? ""),
    symbol: String(order.symbol ?? ""),
    side: order.side === "buy" || order.side === "sell" ? order.side : "unknown",
    type: order.type ?? null,
    status: String(order.status ?? "unknown"),
    amount: decimalString(order.amount),
    filled: decimalString(order.filled),
    price: decimalString(order.price),
    createdAt:
      typeof order.timestamp === "number" && Number.isFinite(order.timestamp)
        ? new Date(order.timestamp).toISOString()
        : order.datetime ?? null,
  };
}

export type TestnetVenueOptions = {
  /** Test seam: the same adapter driven by a scripted transport. */
  createExchange?: (secret: VenueSecret) => TestnetExchange;
  now?: () => Date;
};

/** The port both the read surface and the order path see. */
export type TestnetVenue = VenueAdapter &
  OrderVenuePort & {
    id: TestnetVenueId;
    environment: "testnet";
    /** True when the client is built for the sandbox and no other endpoint. */
    sandboxed: true;
  };

function refusalOutcome(error: VenueRefusal): VenueSubmitOutcome {
  return { kind: "rejected", code: error.code, reason: error.message, providerResponse: { refusedBeforeRequest: true, code: error.code } };
}

export function createTestnetVenue(secret: VenueSecret, options: TestnetVenueOptions = {}): TestnetVenue {
  const id: TestnetVenueId = "binance-testnet";
  const descriptor = VENUE_DESCRIPTORS[id];
  const capabilities: readonly VenueCapability[] = descriptor.capabilities;
  const factory = options.createExchange ?? createBinanceSpotTestnetExchange;
  const clock = options.now ?? (() => new Date());

  if (descriptor.environment !== "testnet" || !capabilities.includes("place")) {
    throw new VenueRefusal(
      VENUE_REFUSAL_CODES.unsupported,
      `${descriptor.label} is not a testnet venue that may place orders; this build only places on a sandbox.`,
    );
  }

  async function withExchange<T>(operation: (exchange: TestnetExchange) => Promise<T>): Promise<T> {
    const exchange = factory(secret);
    // The guard runs here too, not only in the production factory: a caller may inject a
    // transport, and an injected transport that points at production must still be
    // refused before it is used.
    assertTestnetEndpoints(exchange.urls);
    try {
      return await operation(exchange);
    } finally {
      await exchange.close().catch(() => undefined);
    }
  }

  async function reportFor(order: StoredOrder, raw: RawTestnetOrder, note?: string): Promise<VenueOrderReport> {
    const state = testnetOrderState(raw);
    return {
      state,
      ...(raw.id ? { venueOrderId: String(raw.id) } : order.venueOrderId ? { venueOrderId: order.venueOrderId } : {}),
      ...(decimalString(raw.filled) ? { filledQuantity: decimalString(raw.filled) as string } : {}),
      reason: note,
      reportedAt: clock().toISOString(),
      providerResponse: { venue: id, order: raw },
    };
  }

  /** Find the venue's record by its id, or — after a timeout — by our own client id. */
  async function findOrder(exchange: TestnetExchange, order: StoredOrder, symbol: string): Promise<RawTestnetOrder | null> {
    if (order.venueOrderId) {
      try {
        return await exchange.fetchOrder(order.venueOrderId, symbol);
      } catch (error) {
        const classified = classifyVenueError(error);
        // Only "the venue does not know that id" falls through to the client-id search.
        // A timeout or a network error is not evidence of absence.
        if (classified.code !== "ORDER_NOT_FOUND" && classified.kind !== "rejected") throw error;
      }
    }
    const orders = await exchange.fetchOrders(symbol, undefined, DEFAULT_ORDER_LIMIT);
    const clientOrderId = testnetClientOrderId(order.clientOrderId);
    return orders.find((candidate) => candidate.clientOrderId === clientOrderId) ?? null;
  }

  return {
    id,
    label: descriptor.label,
    environment: "testnet",
    sandboxed: true,
    paper: false,
    capabilities,

    quoteAssetFor(market: string): string | null {
      return usdtPairFor(market) ? "USDT" : null;
    },

    async submit({ order, idempotencyKey, attempt }): Promise<VenueSubmitOutcome> {
      requireCapability(id, "place");
      try {
        assertWriteAllowed(id, secret, "place an order");
      } catch (error) {
        if (error instanceof VenueRefusal) return refusalOutcome(error);
        throw error;
      }

      const symbol = testnetSymbolFor(order.market);
      if (!symbol) {
        return {
          kind: "rejected",
          code: "INVALID_PAIR",
          reason: `Binance Spot Testnet quotes a USDT pair, and ${order.market} does not name a BASE-USD market this build can map onto one.`,
          providerResponse: { venue: id, request: { market: order.market }, mappedSymbol: null },
        };
      }

      const limit = order.orderType === "LIMIT" ? order.limitPrice : null;
      if (order.orderType === "LIMIT" && !limit) {
        return {
          kind: "rejected",
          code: "LIMIT_PRICE_MISSING",
          reason: "A LIMIT order needs a limit price; this one carried none, so nothing was sent.",
          providerResponse: { venue: id, request: { symbol, type: order.orderType }, mappedSymbol: symbol },
        };
      }

      const clientOrderId = testnetClientOrderId(order.clientOrderId);
      const request = {
        symbol,
        type: order.orderType === "LIMIT" ? "limit" : "market",
        side: order.side === "SELL" ? "sell" : "buy",
        amount: order.requestedQuantity,
        ...(limit ? { price: limit } : {}),
        /** The local client id, kept for the record. */
        clientOrderId: order.clientOrderId,
        /** What was actually sent: the venue's 36-character spelling of it. */
        newClientOrderId: clientOrderId,
        attempt,
        idempotencyKey,
      };

      try {
        const raw = await withExchange((exchange) =>
          exchange.createOrder(
            symbol,
            request.type,
            request.side,
            order.requestedQuantity,
            limit ?? undefined,
            { newClientOrderId: clientOrderId },
          ),
        );
        return {
          kind: "accepted",
          venueOrderId: String(raw.id ?? order.clientOrderId),
          reported: testnetOrderState(raw),
          filledQuantity: decimalString(raw.filled) ?? "0",
          providerResponse: { venue: id, request, response: raw },
        };
      } catch (error) {
        const classified = classifyVenueError(error);
        const providerResponse = { venue: id, request, error: classified.reason, code: classified.code };
        if (classified.kind === "insufficient-funds" || classified.kind === "invalid-pair" || classified.kind === "rejected") {
          return { kind: "rejected", code: classified.code, reason: classified.reason, providerResponse };
        }
        return { kind: classified.kind === "timeout" ? "timeout" : "unavailable", reason: classified.reason, providerResponse };
      }
    },

    async lookup({ order }): Promise<VenueOrderReport> {
      const symbol = testnetSymbolFor(order.market);
      const reportedAt = clock().toISOString();
      if (!symbol) {
        return {
          state: "NOT_FOUND",
          ...(order.venueOrderId ? { venueOrderId: order.venueOrderId } : {}),
          reason: `${order.market} does not map onto a Binance Spot Testnet pair, so the venue cannot hold this order.`,
          reportedAt,
        };
      }

      try {
        const raw = await withExchange((exchange) => findOrder(exchange, order, symbol));
        if (!raw) {
          return {
            state: "NOT_FOUND",
            ...(order.venueOrderId ? { venueOrderId: order.venueOrderId } : {}),
            reason: `${id} holds no order with id ${order.venueOrderId ?? "(unset)"} or client id ${order.clientOrderId}.`,
            reportedAt,
          };
        }
        return await reportFor(order, raw);
      } catch (error) {
        const classified = classifyVenueError(error);
        return {
          state: "UNKNOWN",
          ...(order.venueOrderId ? { venueOrderId: order.venueOrderId } : {}),
          reason: `${id} could not be asked: ${classified.reason}`,
          reportedAt,
          providerResponse: { venue: id, error: classified.reason, code: classified.code },
        };
      }
    },

    async cancel({ order, reason }): Promise<VenueCancelOutcome> {
      try {
        assertWriteAllowed(id, secret, "cancel an order");
      } catch (error) {
        if (error instanceof VenueRefusal) return { kind: "refused", reason: error.message };
        throw error;
      }

      const symbol = testnetSymbolFor(order.market);
      if (!symbol) {
        return { kind: "refused", reason: `${order.market} is not a pair this testnet venue can hold, so there is nothing to cancel.` };
      }

      try {
        return await withExchange(async (exchange) => {
          const existing = await findOrder(exchange, order, symbol);
          if (!existing) {
            return {
              kind: "refused" as const,
              reason: `${id} holds no order ${order.venueOrderId ?? order.clientOrderId}, so there was nothing to cancel.`,
            };
          }
          const venueOrderId = String(existing.id ?? order.venueOrderId ?? "");
          try {
            const cancelled = await exchange.cancelOrder(venueOrderId, symbol);
            return {
              kind: "cancelled" as const,
              report: {
                state: "CANCELLED" as const,
                venueOrderId: String(cancelled.id ?? venueOrderId),
                filledQuantity: decimalString(cancelled.filled) ?? decimalString(existing.filled) ?? "0",
                reason,
                reportedAt: clock().toISOString(),
                providerResponse: { venue: id, response: cancelled },
              },
            };
          } catch (error) {
            const classified = classifyVenueError(error);
            if (classified.kind === "timeout" || classified.kind === "unavailable") {
              return { kind: classified.kind, reason: classified.reason };
            }
            // The venue refused the cancel. Its record is read again and returned with
            // the refusal, because "the order is already filled" is the answer the owner
            // needs — a bare error would leave the local row guessing.
            const after = await exchange.fetchOrder(venueOrderId, symbol).catch(() => null);
            return {
              kind: "refused" as const,
              reason: `${id} refused the cancel: ${classified.reason}`,
              ...(after ? { report: await reportFor(order, after, classified.reason) } : {}),
            };
          }
        });
      } catch (error) {
        const classified = classifyVenueError(error);
        if (classified.kind === "timeout" || classified.kind === "unavailable") {
          return { kind: classified.kind, reason: classified.reason };
        }
        return { kind: "refused", reason: classified.reason };
      }
    },

    async readBalances(): Promise<VerifiedSpotBalance[]> {
      requireCapability(id, "balances");
      return withExchange(async (exchange) => normalizeSpotBalances(await exchange.fetchBalance()));
    },

    async readPositions(): Promise<VenuePosition[]> {
      requireCapability(id, "positions");
      // Unreachable while the descriptor omits `positions`: a spot account has none.
      throw new VenueRefusal(VENUE_REFUSAL_CODES.capability, `${descriptor.label} spot accounts report no ${CAPABILITY_LABELS.positions}.`);
    },

    async readOrders(limit = DEFAULT_ORDER_LIMIT): Promise<VenueOrder[]> {
      requireCapability(id, "orders");
      const bounded = Math.min(Math.max(Math.trunc(limit) || DEFAULT_ORDER_LIMIT, 1), MAX_ORDER_LIMIT);
      return withExchange(async (exchange) => (await exchange.fetchOrders(undefined, undefined, bounded)).map(normalizeOrder));
    },

    async readOrderStatus(orderId: string): Promise<VenueOrderStatus> {
      requireCapability(id, "orderStatus");
      if (!orderId.trim()) {
        throw new VenueRefusal(VENUE_REFUSAL_CODES.invalidOrderId, "An order ID is required to read an order's status.");
      }
      return withExchange(async (exchange) => {
        const raw = await exchange.fetchOrder(orderId);
        const amountValue = raw.amount === null || raw.amount === undefined ? null : new Decimal(String(raw.amount));
        const filledValue = raw.filled === null || raw.filled === undefined ? null : new Decimal(String(raw.filled));
        return {
          id: String(raw.id ?? orderId),
          status: String(raw.status ?? "unknown"),
          filled: decimalString(raw.filled),
          remaining:
            amountValue && filledValue ? Decimal.max(amountValue.minus(filledValue), 0).toFixed() : null,
        };
      });
    },

    async cancelOrder(orderId: string): Promise<VenueCancellation> {
      requireCapability(id, "cancel");
      assertWriteAllowed(id, secret, "cancel an order");
      if (!orderId.trim()) {
        throw new VenueRefusal(VENUE_REFUSAL_CODES.invalidOrderId, "An order ID is required to cancel an order.");
      }
      return withExchange(async (exchange) => {
        const cancelled = await exchange.cancelOrder(orderId);
        return { id: String(cancelled?.id ?? orderId), status: "cancelled" as const };
      });
    },

    async checkHealth(): Promise<VenueHealthCheck> {
      const startedAt = Date.now();
      const checkedAt = clock().toISOString();
      try {
        const balances = await withExchange(async (exchange) => normalizeSpotBalances(await exchange.fetchBalance()));
        return {
          ok: true,
          checkedAt,
          latencyMs: Date.now() - startedAt,
          evidence: `${balances.length} non-zero testnet balance${balances.length === 1 ? "" : "s"} read from ${VENUE_LABELS[id]} (sandbox endpoints only)`,
          // Binance's testnet does not answer the apiRestrictions question, so the honest
          // answer is "not reported" rather than a guess from the request succeeding.
          permissions: null,
          balances,
        };
      } catch (error) {
        return {
          ok: false,
          checkedAt,
          latencyMs: Date.now() - startedAt,
          evidence: "No testnet read completed.",
          permissions: null,
          error: error instanceof Error && error.message ? error.message.slice(0, 280) : "The venue did not answer.",
        };
      }
    },
  };
}
