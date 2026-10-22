import ccxt from "ccxt";
import DecimalJS from "decimal.js";
import type { StoredOrder } from "@/lib/orders/store";
import type {
  OrderVenuePort,
  VenueCancelOutcome,
  VenueOrderReport,
  VenueSubmitOutcome,
} from "@/lib/orders/venue";
import { createCcxtVenue, type CcxtExchange } from "./ccxt-adapter";
import {
  assertLiveEndpoints,
  binanceOrderState,
  classifyVenueError,
  clientOrderIdForVenue,
  usdtPairFor,
  type RawBinanceOrder,
} from "./binance-shared";
import {
  assertWriteAllowed,
  VENUE_DESCRIPTORS,
  VENUE_LABELS,
  VENUE_REFUSAL_CODES,
  VenueRefusal,
  type LiveOrderVenueId,
  type VenueAdapter,
  type VenueCapability,
  type VenueSecret,
} from "./types";

/**
 * Binance, live: the real exchange, with real money behind the key.
 *
 * Phase 21 built the testnet as a *venue*, and this is its other endpoint. The order
 * path cannot tell them apart: both implement {@link OrderVenuePort}, both map a site
 * product id onto the same USDT pair, both translate the idempotency key into the same
 * legal client order id, and both classify a refusal with the same table. What differs is
 * which endpoint the client is built for and whether the owner's switch allows the venue
 * to be selected at all — and the switch is checked in the registry, not here.
 *
 * Two things this adapter deliberately does **not** do:
 *
 *  - **It does not gate a live order.** No balance check, health check or risk evaluation
 *    stands between `submit` and the exchange. The pre-trade notices are gathered and
 *    reported by the order route; the venue is what answers, in its own words.
 *  - **It does not run the sandbox.** A client whose API hosts are a Binance testnet is
 *    refused before an order is built, because a venue reported as live must not be a
 *    sandbox: that difference is the whole meaning of the switch. A production client
 *    passes the guard untouched.
 *
 * The read half is the phase-20 CCXT adapter, unchanged: balances, orders, one order's
 * status, a cancel and the health check are the same code the connected-accounts panel
 * already trusts, including Binance's permission report.
 */

/** The live half of the endpoint guard, re-exported where the adapter is imported from. */
export { assertLiveEndpoints } from "./binance-shared";

const Decimal = DecimalJS.clone({ precision: 40 });
/** How many recent orders a lookup by client id reads, the phase-20 adapter's own bound. */
const DEFAULT_ORDER_LIMIT = 50;

/**
 * The slice of a live exchange this adapter uses, including the writes.
 *
 * The three read methods are narrowed to the order shape that carries `clientOrderId`: the
 * lookup after a timeout finds the venue's record by our own client id, and the phase-20
 * read type does not carry that field. A transport that satisfies this satisfies
 * {@link CcxtExchange} as well, so the read adapter takes it unchanged.
 */
export type LiveExchange = Omit<CcxtExchange, "fetchOrders" | "fetchOrder" | "cancelOrder"> & {
  fetchOrders(symbol?: string, since?: number, limit?: number): Promise<RawBinanceOrder[]>;
  fetchOrder(id: string, symbol?: string): Promise<RawBinanceOrder>;
  cancelOrder(id: string, symbol?: string): Promise<RawBinanceOrder>;
  createOrder(
    symbol: string,
    type: string,
    side: string,
    amount: string,
    price?: string,
    params?: Record<string, unknown>,
  ): Promise<RawBinanceOrder>;
  urls?: unknown;
};

/**
 * Production transport: Binance spot, no sandbox mode, checked before it is used.
 *
 * `adjustForTimeDifference` is on because a signed request more than a second out is
 * rejected as a timestamp error — a failure that would look like a venue fault in the
 * evidence.
 */
export function createBinanceSpotLiveExchange(secret: VenueSecret): LiveExchange {
  const exchange = new ccxt.binance({
    apiKey: secret.apiKey,
    secret: secret.apiSecret,
    enableRateLimit: true,
    timeout: 10_000,
    options: { defaultType: "spot", adjustForTimeDifference: true },
  });
  assertLiveEndpoints({ api: exchange.urls["api"] });
  return exchange as unknown as LiveExchange;
}

function decimalString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Decimal(String(value));
  return parsed.isFinite() ? parsed.toFixed() : null;
}

export type LiveVenueOptions = {
  /** Test seam: the same adapter driven by a scripted transport. */
  createExchange?: (secret: VenueSecret) => LiveExchange;
  now?: () => Date;
};

/** The port both the read surface and the order path see. */
export type LiveVenue = VenueAdapter &
  OrderVenuePort & {
    id: LiveOrderVenueId;
    environment: "live";
  };

function refusalOutcome(error: VenueRefusal): VenueSubmitOutcome {
  return { kind: "rejected", code: error.code, reason: error.message, providerResponse: { refusedBeforeRequest: true, code: error.code } };
}

export function createLiveVenue(
  secret: VenueSecret,
  options: LiveVenueOptions = {},
): LiveVenue {
  const id: LiveOrderVenueId = "binance";
  const descriptor = VENUE_DESCRIPTORS[id];
  const capabilities: readonly VenueCapability[] = descriptor.capabilities;
  const factory = options.createExchange ?? createBinanceSpotLiveExchange;
  const clock = options.now ?? (() => new Date());

  if (descriptor.environment !== "live" || !capabilities.includes("place")) {
    throw new VenueRefusal(
      VENUE_REFUSAL_CODES.unsupported,
      `${descriptor.label} is not a live venue that may place orders in this build.`,
    );
  }

  // The read half is the phase-20 adapter. It is given the same transport factory, so an
  // injected script covers reads and writes alike; production builds a Binance client per
  // call exactly as the testnet adapter does.
  const reads = createCcxtVenue(id, secret, {
    createExchange: () => factory(secret) as unknown as CcxtExchange,
  });

  async function withExchange<T>(operation: (exchange: LiveExchange) => Promise<T>): Promise<T> {
    const exchange = factory(secret);
    // The guard runs here too, not only in the production factory: a caller may inject a
    // transport, and an injected transport that is a sandbox must still be refused.
    assertLiveEndpoints(exchange.urls);
    try {
      return await operation(exchange);
    } finally {
      await exchange.close().catch(() => undefined);
    }
  }

  async function reportFor(order: StoredOrder, raw: RawBinanceOrder, note?: string): Promise<VenueOrderReport> {
    const state = binanceOrderState(raw);
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
  async function findOrder(exchange: LiveExchange, order: StoredOrder, symbol: string): Promise<RawBinanceOrder | null> {
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
    const clientOrderId = clientOrderIdForVenue(order.clientOrderId);
    return orders.find((candidate) => candidate.clientOrderId === clientOrderId) ?? null;
  }

  return {
    ...reads,
    id,
    environment: "live",
    paper: false,
    capabilities,

    quoteAssetFor(market: string): string | null {
      return usdtPairFor(market) ? "USDT" : null;
    },

    async submit({ order, idempotencyKey, attempt }): Promise<VenueSubmitOutcome> {
      try {
        assertWriteAllowed(id, secret, "place an order");
      } catch (error) {
        if (error instanceof VenueRefusal) return refusalOutcome(error);
        throw error;
      }

      const symbol = usdtPairFor(order.market);
      if (!symbol) {
        return {
          kind: "rejected",
          code: "INVALID_PAIR",
          reason: `${VENUE_LABELS[id]} quotes a USDT pair, and ${order.market} does not name a BASE-USD market this build can map onto one.`,
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

      const clientOrderId = clientOrderIdForVenue(order.clientOrderId);
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
          reported: binanceOrderState(raw),
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
      const symbol = usdtPairFor(order.market);
      const reportedAt = clock().toISOString();
      if (!symbol) {
        return {
          state: "NOT_FOUND",
          ...(order.venueOrderId ? { venueOrderId: order.venueOrderId } : {}),
          reason: `${order.market} does not map onto a Binance pair, so the venue cannot hold this order.`,
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

      const symbol = usdtPairFor(order.market);
      if (!symbol) {
        return { kind: "refused", reason: `${order.market} is not a pair ${id} can hold, so there is nothing to cancel.` };
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
  };
}
