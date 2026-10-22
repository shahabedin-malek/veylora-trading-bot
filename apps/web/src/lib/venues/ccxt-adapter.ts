import ccxt from "ccxt";
import DecimalJS from "decimal.js";
import {
  assertWriteAllowed,
  CAPABILITY_LABELS,
  requireCapability,
  VENUE_DESCRIPTORS,
  VENUE_LABELS,
  VENUE_REFUSAL_CODES,
  VenueRefusal,
  type VenueAdapter,
  type VenueBalance,
  type VenueCancellation,
  type VenueCapability,
  type VenueHealthCheck,
  type VenueId,
  type VenueOrder,
  type VenueOrderStatus,
  type VenuePermission,
  type VenuePosition,
  type VenueSecret,
} from "./types";

/**
 * The exchange-API half of the venue interface: Binance, Kraken and Coinbase Advanced.
 *
 * All three are spoken to through CCXT, and all three are **spot** accounts here. That
 * one fact is why `positions` is absent from the descriptor rather than a method that
 * returns an empty list: a spot account has no positions, and a caller reading `[]`
 * cannot tell "flat" from "this venue cannot tell you". The descriptor answers that
 * before the call is made.
 *
 * **Every write passes {@link assertWriteAllowed} first.** A read-only key's refusal
 * therefore happens before an exchange object exists, so it costs no socket, no
 * signature and no request — which is also what makes the refusal testable by counting
 * the transport's calls.
 *
 * The transport is injectable (`options.createExchange`) for exactly that reason: the
 * test suite drives the same adapter code with a counting fake, and production gets
 * the CCXT factory. Nothing in this file inspects the credential beyond handing it to
 * the client, and nothing logs it.
 */

const Decimal = DecimalJS.clone({ precision: 80 });
const MAX_BALANCE_ASSETS = 200;
const DEFAULT_ORDER_LIMIT = 50;
const MAX_ORDER_LIMIT = 200;

export type VerifiedSpotBalance = VenueBalance;

type RawBalance = {
  free?: Record<string, string | number | null | undefined>;
  total?: Record<string, string | number | null | undefined>;
};

type RawOrder = {
  id?: string | null;
  symbol?: string | null;
  side?: string | null;
  type?: string | null;
  status?: string | null;
  amount?: string | number | null;
  filled?: string | number | null;
  price?: string | number | null;
  timestamp?: number | null;
  datetime?: string | null;
};

/**
 * The slice of a CCXT exchange this adapter uses. Stating it is what lets the test
 * double be a plain object instead of a partial `ccxt.Exchange`.
 */
export type CcxtExchange = {
  fetchBalance(): Promise<RawBalance>;
  fetchOrders(symbol?: string, since?: number, limit?: number): Promise<RawOrder[]>;
  fetchOrder(id: string, symbol?: string): Promise<RawOrder>;
  cancelOrder(id: string, symbol?: string): Promise<RawOrder>;
  close(): Promise<void>;
};

/** The permission question only Binance answers, as the generated CCXT method. */
type PermissionReportingExchange = CcxtExchange & {
  sapiGetAccountApiRestrictions?: (params?: Record<string, unknown>) => Promise<unknown>;
  privateGetSapiV1AccountApiRestrictions?: (params?: Record<string, unknown>) => Promise<unknown>;
};

function amount(value: string | number | null | undefined): InstanceType<typeof Decimal> {
  if (value === null || value === undefined) return new Decimal(0);
  const parsed = new Decimal(String(value));
  if (!parsed.isFinite() || parsed.isNegative()) throw new Error("Venue returned an invalid balance.");
  return parsed;
}

/**
 * Keep the assets that hold something, sorted, with exact decimal strings.
 *
 * The same rule the balance panel has always used: zero balances are omitted rather
 * than listed, the count is bounded so a hostile or broken response cannot fill the
 * page, and an unreadable amount fails the read instead of printing `NaN` as money.
 */
export function normalizeSpotBalances(balance: RawBalance): VerifiedSpotBalance[] {
  const free = balance.free ?? {};
  const total = balance.total ?? {};
  const assets = [...new Set([...Object.keys(free), ...Object.keys(total)])].sort();
  if (assets.length > MAX_BALANCE_ASSETS) throw new Error("Venue returned too many balance assets.");

  return assets.flatMap((asset) => {
    const available = amount(free[asset]);
    const held = amount(total[asset]);
    if (available.isZero() && held.isZero()) return [];
    return [{ asset, available: available.toFixed(), total: held.toFixed() }];
  });
}

function decimalString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Decimal(String(value));
  return parsed.isFinite() ? parsed.toFixed() : null;
}

function orderSide(value: string | null | undefined): VenueOrder["side"] {
  const side = (value ?? "").toLowerCase();
  return side === "buy" || side === "sell" ? side : "unknown";
}

function normalizeOrder(order: RawOrder): VenueOrder {
  return {
    id: String(order.id ?? ""),
    symbol: String(order.symbol ?? ""),
    side: orderSide(order.side),
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

function normalizeOrderStatus(order: RawOrder): VenueOrderStatus {
  const normalized = normalizeOrder(order);
  const amountValue = normalized.amount === null ? null : new Decimal(normalized.amount);
  const filledValue = normalized.filled === null ? null : new Decimal(normalized.filled);
  return {
    id: normalized.id,
    status: normalized.status,
    filled: normalized.filled,
    remaining:
      amountValue && filledValue
        ? Decimal.max(amountValue.minus(filledValue), 0).toFixed()
        : null,
  };
}

/**
 * Binance's own answer about the key, when the client exposes it.
 *
 * `GET /sapi/v1/account/apiRestrictions` is the documented endpoint that says whether
 * a key may read, trade or withdraw. CCXT generates the method at runtime, so its name
 * is probed rather than assumed; if neither spelling exists (a client upgrade, a
 * different build) the answer is `null`, which the panel reads as "not reported".
 * A failed call is also `null`: a permissions question that cannot be asked must not
 * turn a working key into a failing connection.
 */
async function readReportedPermissions(exchange: CcxtExchange): Promise<VenuePermission[] | null> {
  const candidate = exchange as PermissionReportingExchange;
  const call = candidate.sapiGetAccountApiRestrictions ?? candidate.privateGetSapiV1AccountApiRestrictions;
  if (typeof call !== "function") return null;

  let payload: unknown;
  try {
    payload = await call.call(exchange, {});
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;

  const permissions: VenuePermission[] = [];
  if (record.enableReading === true) permissions.push("read");
  if (record.enableSpotAndMarginTrading === true) permissions.push("trade");
  if (record.enableWithdrawals === true) permissions.push("withdraw");
  return permissions;
}

function createCcxtExchange(venue: VenueId, secret: VenueSecret): CcxtExchange {
  const config = {
    apiKey: secret.apiKey,
    secret: secret.apiSecret,
    ...(secret.passphrase ? { password: secret.passphrase } : {}),
    enableRateLimit: true,
    timeout: 10_000,
  };

  if (venue === "binance") {
    return new ccxt.binance({ ...config, options: { defaultType: "spot" } }) as unknown as CcxtExchange;
  }
  if (venue === "kraken") {
    return new ccxt.kraken(config) as unknown as CcxtExchange;
  }
  if (venue === "coinbase-advanced") {
    return new ccxt.coinbase(config) as unknown as CcxtExchange;
  }
  throw new VenueRefusal(
    VENUE_REFUSAL_CODES.unsupported,
    `${VENUE_LABELS[venue]} is not an exchange API venue; it has its own adapter.`,
  );
}

export type CcxtVenueOptions = {
  createExchange?: (venue: VenueId, secret: VenueSecret) => CcxtExchange;
};

function healthMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 280);
  return "The venue did not answer.";
}

export function createCcxtVenue(
  venue: VenueId,
  secret: VenueSecret,
  options: CcxtVenueOptions = {},
): VenueAdapter {
  const descriptor = VENUE_DESCRIPTORS[venue];
  const factory = options.createExchange ?? createCcxtExchange;
  const capabilities: readonly VenueCapability[] = descriptor.capabilities;

  if (!capabilities.includes("balances")) {
    throw new VenueRefusal(
      VENUE_REFUSAL_CODES.unsupported,
      `${descriptor.label} is not an exchange API venue; it has its own adapter.`,
    );
  }

  /**
   * One client per operation, closed in `finally`.
   *
   * A shared client would keep an idle socket pool alive for a request that is over,
   * and CCXT exchanges are cheap to construct. The cost is one extra handshake per
   * call; the benefit is that no credential outlives the operation that used it.
   */
  async function withExchange<T>(operation: (exchange: CcxtExchange) => Promise<T>): Promise<T> {
    const exchange = factory(venue, secret);
    try {
      return await operation(exchange);
    } finally {
      await exchange.close().catch(() => undefined);
    }
  }

  return {
    id: venue,
    label: descriptor.label,
    capabilities,

    async readBalances(): Promise<VenueBalance[]> {
      requireCapability(venue, "balances");
      return withExchange(async (exchange) => normalizeSpotBalances(await exchange.fetchBalance()));
    },

    async readPositions(): Promise<VenuePosition[]> {
      requireCapability(venue, "positions");
      // Unreachable while the descriptor omits `positions`; kept so the interface is
      // implemented rather than pretended, and so adding a derivatives venue is a
      // descriptor change plus this body, not a new shape.
      throw new VenueRefusal(
        VENUE_REFUSAL_CODES.capability,
        `${descriptor.label} spot accounts report no ${CAPABILITY_LABELS.positions}.`,
      );
    },

    async readOrders(limit = DEFAULT_ORDER_LIMIT): Promise<VenueOrder[]> {
      requireCapability(venue, "orders");
      const bounded = Math.min(Math.max(Math.trunc(limit) || DEFAULT_ORDER_LIMIT, 1), MAX_ORDER_LIMIT);
      return withExchange(async (exchange) =>
        (await exchange.fetchOrders(undefined, undefined, bounded)).map(normalizeOrder),
      );
    },

    async readOrderStatus(orderId: string): Promise<VenueOrderStatus> {
      requireCapability(venue, "orderStatus");
      if (!orderId.trim()) {
        throw new VenueRefusal(VENUE_REFUSAL_CODES.invalidOrderId, "An order ID is required to read an order's status.");
      }
      return withExchange(async (exchange) => normalizeOrderStatus(await exchange.fetchOrder(orderId)));
    },

    async cancelOrder(orderId: string): Promise<VenueCancellation> {
      requireCapability(venue, "cancel");
      // Before the exchange exists: a read-only key never reaches the venue.
      assertWriteAllowed(venue, secret, "cancel an order");
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
      const checkedAt = new Date().toISOString();
      try {
        const result = await withExchange(async (exchange) => {
          const balances = normalizeSpotBalances(await exchange.fetchBalance());
          const permissions = venue === "binance" ? await readReportedPermissions(exchange) : null;
          return { balances, permissions };
        });
        const latencyMs = Date.now() - startedAt;
        const withdrew = result.permissions?.includes("withdraw") === true;
        return {
          ok: !withdrew,
          checkedAt,
          latencyMs,
          evidence: `${result.balances.length} non-zero spot balance${result.balances.length === 1 ? "" : "s"} read`,
          permissions: result.permissions,
          balances: result.balances,
          ...(withdrew
            ? {
                error:
                  "This key can withdraw at the venue. Veylora never withdraws, so it will not use a key that can: " +
                  "switch withdrawals off for the API key and check again.",
              }
            : {}),
        };
      } catch (error) {
        return {
          ok: false,
          checkedAt,
          latencyMs: Date.now() - startedAt,
          evidence: "No read completed.",
          permissions: null,
          error: healthMessage(error),
        };
      }
    },
  };
}
