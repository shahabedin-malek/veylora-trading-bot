import DecimalJS from "decimal.js";
import type { VenueOrderState } from "@/lib/orders/venue";
import { VENUE_REFUSAL_CODES, VenueRefusal } from "./types";

/**
 * The Binance facts both of its venues share.
 *
 * Phase 21 built the Spot Testnet adapter and phase 22 the real one. They differ in
 * exactly two things — which endpoints the client is built for, and whether real funds
 * are behind the key — and agree on everything else: how a site product id maps onto a
 * Binance pair, how our idempotency key becomes a legal `newClientOrderId`, which errors
 * are definitive, and how the venue's lifecycle words map onto ours.
 *
 * Putting those in one module is what keeps the live path from being "the testnet path
 * with the guard removed": there is one translation, one classifier and one state
 * mapping, so a fill on the testnet and a fill on the exchange are read by the same code.
 */

const Decimal = DecimalJS.clone({ precision: 40 });

/** The only hosts a testnet client may talk to. */
export const BINANCE_TESTNET_HOSTS = ["testnet.binance.vision", "testnet.binancefuture.com"] as const;

export type RawBinanceOrder = {
  id?: string | null;
  clientOrderId?: string | null;
  symbol?: string | null;
  side?: string | null;
  type?: string | null;
  status?: string | null;
  amount?: string | number | null;
  filled?: string | number | null;
  remaining?: string | number | null;
  price?: string | number | null;
  average?: string | number | null;
  timestamp?: number | null;
  datetime?: string | null;
};

export type RawBinanceBalance = {
  free?: Record<string, string | number | null | undefined>;
  total?: Record<string, string | number | null | undefined>;
};

/**
 * The USD market the order names, as the Binance pair that can answer it.
 *
 * `BTC-USD` → `BTC/USDT`. Only a `BASE-USD` product id maps: a market with another
 * quote, a malformed id or a non-alphanumeric base returns `null`, and the caller turns
 * that into a rejection that names the mapping rather than sending a request the venue
 * would answer with a generic error. The site's product ids are Coinbase-style; the
 * venue quotes USDT, and saying so once is better than two adapters guessing separately.
 */
export function usdtPairFor(market: string): string | null {
  const parts = market.trim().toUpperCase().split("-");
  if (parts.length !== 2) return null;
  const [base, quote] = parts;
  if (!base || quote !== "USD") return null;
  if (!/^[A-Z0-9]{2,12}$/.test(base)) return null;
  return `${base}/USDT`;
}

/** Every host an exchange's API URLs point at, for the endpoint guards and their tests. */
export function exchangeApiHosts(urls: unknown): string[] {
  if (typeof urls !== "object" || urls === null) return [];
  const api = (urls as Record<string, unknown>).api;
  if (typeof api !== "object" || api === null) return [];
  const hosts = new Set<string>();
  for (const value of Object.values(api as Record<string, unknown>)) {
    if (typeof value !== "string" || !value.trim()) continue;
    try {
      hosts.add(new URL(value).host);
    } catch {
      // A relative or malformed URL is not a production host; the empty result below
      // makes the guard refuse, which is the safe direction.
    }
  }
  return [...hosts].sort();
}

/**
 * Refuse a client whose API URLs are not the testnet's.
 *
 * Called on every testnet client the factory builds. The refusal is a `VenueRefusal`
 * with `UNSUPPORTED_VENUE`, because that is what this is: this adapter cannot place a
 * testnet order against an endpoint whose hosts say otherwise.
 */
export function assertTestnetEndpoints(urls: unknown): void {
  const hosts = exchangeApiHosts(urls);
  const allowed = new Set<string>(BINANCE_TESTNET_HOSTS);
  const foreign = hosts.filter((host) => !allowed.has(host));
  if (hosts.length === 0 || foreign.length > 0) {
    throw new VenueRefusal(
      VENUE_REFUSAL_CODES.unsupported,
      hosts.length === 0
        ? "The testnet client published no API endpoint, so it cannot be used: an endpoint that cannot be read is not one this build may send an order to."
        : `The testnet client points at ${foreign.join(", ")}, which is not a Binance testnet host. This build refuses to place an order against a live exchange endpoint.`,
    );
  }
}

/**
 * Refuse a "live" client whose API URLs are a sandbox.
 *
 * The mirror of the testnet guard, and it exists for the same reason: a client that is
 * reported as live while it talks to a sandbox would let a real-money order be recorded as
 * something it never reached. It is not a gate in front of a live order — a production
 * client passes it — it is the refusal to call a sandbox live.
 */
export function assertLiveEndpoints(urls: unknown): void {
  const hosts = exchangeApiHosts(urls);
  const testnet = hosts.filter((host) => (BINANCE_TESTNET_HOSTS as readonly string[]).includes(host));
  if (hosts.length === 0 || testnet.length > 0) {
    throw new VenueRefusal(
      VENUE_REFUSAL_CODES.unsupported,
      hosts.length === 0
        ? "The live client published no API endpoint, so it cannot be used: an endpoint that cannot be read is not one this build may send an order to."
        : `The live client points at ${testnet.join(", ")}, which is a Binance sandbox host. A venue reported as live must not be a sandbox, so this client is refused before an order is built.`,
    );
  }
}

export type VenueErrorKind = "insufficient-funds" | "invalid-pair" | "rejected" | "timeout" | "unavailable";

export type ClassifiedVenueError = {
  kind: VenueErrorKind;
  /** A stable word for the record, independent of the venue's prose. */
  code: string;
  reason: string;
};

/**
 * Which venue errors are definitive and which are worth retrying.
 *
 * This table is the difference between three attempts at an order the venue already
 * refused and one: `BadRequest` and `InvalidOrder` are the venue saying no, and retrying
 * a "no" is how a refusal turns into three refusals in the record. Only transport-class
 * errors (timeout, network, venue down, rate limit) are answered with a retryable kind.
 */
const ERROR_KINDS: Record<string, { kind: VenueErrorKind; code: string }> = {
  InsufficientFunds: { kind: "insufficient-funds", code: "INSUFFICIENT_VENUE_BALANCE" },
  BadSymbol: { kind: "invalid-pair", code: "INVALID_PAIR" },
  InvalidOrder: { kind: "rejected", code: "ORDER_REJECTED" },
  BadRequest: { kind: "rejected", code: "ORDER_REJECTED" },
  ArgumentsRequired: { kind: "rejected", code: "ORDER_REJECTED" },
  OrderNotFound: { kind: "rejected", code: "ORDER_NOT_FOUND" },
  NotSupported: { kind: "rejected", code: "NOT_SUPPORTED" },
  PermissionDenied: { kind: "rejected", code: "PERMISSION_DENIED" },
  AuthenticationError: { kind: "rejected", code: "AUTHENTICATION_FAILED" },
  ExchangeError: { kind: "rejected", code: "VENUE_REFUSED" },
  RateLimitExceeded: { kind: "unavailable", code: "RATE_LIMITED" },
  DDoSProtection: { kind: "unavailable", code: "RATE_LIMITED" },
  RequestTimeout: { kind: "timeout", code: "VENUE_TIMEOUT" },
  NetworkError: { kind: "unavailable", code: "VENUE_UNAVAILABLE" },
  ExchangeNotAvailable: { kind: "unavailable", code: "VENUE_UNAVAILABLE" },
};

/**
 * Our client order id, in the shape Binance accepts: 1–36 of `A-Za-z0-9-_`.
 *
 * The idempotency key the order path derives is longer and may contain `.` or `:`, and
 * Binance answers such an id with `-1100 Illegal characters found in parameter
 * 'newClientOrderId'`. That refusal is what the first testnet run recorded, so the
 * adapters — not the order path — own the translation: the key stays the key, and the
 * venue gets a stable id derived from it. The same function is used when looking an order
 * up by client id, so the two spellings cannot drift.
 */
export function clientOrderIdForVenue(clientOrderId: string): string {
  const cleaned = clientOrderId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 36);
  return cleaned || "veylora-order";
}

function errorNames(error: unknown): string[] {
  const names: string[] = [];
  if (error instanceof Error) {
    names.push(error.name);
    const constructorName = (error as { constructor?: { name?: string } }).constructor?.name;
    if (constructorName) names.push(constructorName);
  }
  return names;
}

/**
 * Translate a venue error into the four things the order path can act on.
 *
 * The classification is by CCXT's own error class name, with a fallback to the message
 * for a transport that does not use those classes (a test double, or a future client).
 * The *reason* is the venue's own sentence — the point of the exercise is to record what
 * the venue said, not a paraphrase that hides it.
 */
export function classifyVenueError(error: unknown): ClassifiedVenueError {
  const message =
    error instanceof Error && error.message.trim()
      ? error.message.trim().slice(0, 500)
      : typeof error === "string" && error.trim()
        ? error.trim().slice(0, 500)
        : "The venue did not answer.";

  for (const name of errorNames(error)) {
    const match = ERROR_KINDS[name];
    if (match) return { ...match, reason: message };
  }

  const lowered = message.toLowerCase();
  if (lowered.includes("insufficient") || lowered.includes("balance is insufficient")) {
    return { kind: "insufficient-funds", code: "INSUFFICIENT_VENUE_BALANCE", reason: message };
  }
  if (lowered.includes("invalid symbol") || lowered.includes("unknown symbol") || lowered.includes("does not exist")) {
    return { kind: "invalid-pair", code: "INVALID_PAIR", reason: message };
  }
  if (lowered.includes("timeout") || lowered.includes("timed out")) {
    return { kind: "timeout", code: "VENUE_TIMEOUT", reason: message };
  }
  return { kind: "unavailable", code: "VENUE_UNAVAILABLE", reason: message };
}

/**
 * The venue's own lifecycle vocabulary for one order.
 *
 * `closed` is not automatically `FILLED`: a venue can close an order it only partly
 * executed (an iceberg's remainder, a cancellation race). The executed quantity decides,
 * which is the same rule `reconcile.ts` applies when it applies a report. One function for
 * both Binance venues means a live fill cannot be read differently from a testnet one.
 */
export function binanceOrderState(order: RawBinanceOrder): VenueOrderState {
  const status = (order.status ?? "").toLowerCase();
  const filled = order.filled === null || order.filled === undefined ? null : new Decimal(String(order.filled));
  const amount = order.amount === null || order.amount === undefined ? null : new Decimal(String(order.amount));
  const partiallyExecuted = filled !== null && filled.gt(0);
  const fullyExecuted = filled !== null && amount !== null && amount.gt(0) && filled.gte(amount);

  if (status === "open" || status === "new" || status === "partially_filled") {
    return partiallyExecuted ? "PARTIALLY_FILLED" : "OPEN";
  }
  if (status === "closed" || status === "filled") return fullyExecuted || !partiallyExecuted ? "FILLED" : "PARTIALLY_FILLED";
  if (status === "canceled" || status === "cancelled" || status === "expired") return "CANCELLED";
  if (status === "rejected") return "REJECTED";
  return "UNKNOWN";
}
