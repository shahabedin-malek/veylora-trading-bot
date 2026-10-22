/**
 * One venue, described once — and the vocabulary every caller uses to talk to it.
 *
 * Phase 20's promise is that a trading path never branches on a venue's *name*. It
 * asks for the capabilities the venue published, calls the method, and gets either a
 * result or a {@link VenueRefusal} that says which capability (or which permission)
 * was missing. The names `binance`, `kraken`, `coinbase-advanced` and
 * `wundertrading` therefore appear here, in the descriptor table, and in the two
 * adapters — nowhere else. A caller that switches on `venue === "wundertrading"` is
 * the defect this file exists to prevent.
 *
 * **This module is client-safe on purpose.** It holds no `node:` import and no
 * network client, so the connected-accounts panel renders the same labels and the
 * same capability sentences the server enforces. The adapters that *do* hold keys
 * live beside it (`ccxt-adapter.ts`, `wundertrading-adapter.ts`) and are only ever
 * imported by the server. A shared label is one more place two answers could drift
 * apart; a shared descriptor is one answer.
 */

/** The venues this build connects to. Adding one means adding an adapter, not a branch. */
export const VENUE_IDS = ["binance", "coinbase-advanced", "kraken", "wundertrading", "binance-testnet"] as const;
export type VenueId = (typeof VENUE_IDS)[number];

/**
 * The venues that are simulations of an exchange rather than the exchange (phase 21).
 *
 * A testnet is a *venue*, not a mode: it has its own keys, its own balances, its own
 * order ids, and its own endpoint. That is what lets the order path treat it exactly
 * like a live venue — the only difference is which row of this table is selected — and
 * what made the sandbox provable while real money was still unreachable (phase 21), the
 * same property that later let phase 22 add a live row rather than a second code path.
 */
export const TESTNET_VENUE_IDS = ["binance-testnet"] as const;
export type TestnetVenueId = (typeof TESTNET_VENUE_IDS)[number];

export function isTestnetVenueId(value: unknown): value is TestnetVenueId {
  return typeof value === "string" && (TESTNET_VENUE_IDS as readonly string[]).includes(value);
}

/**
 * The live venues that may place an order once the owner's switch is on (phase 22).
 *
 * One name today, and it is the venue the testnet phase proved: the same pair mapping,
 * the same client-order-id translation and the same error classification run on both, so
 * a live order is not a second implementation that has to earn trust separately. The
 * switch — owner data, default off — is what decides whether this list may be used; the
 * list is what decides which names it may be used for.
 */
export const LIVE_ORDER_VENUE_IDS = ["binance"] as const;
export type LiveOrderVenueId = (typeof LIVE_ORDER_VENUE_IDS)[number];

export function isLiveOrderVenueId(value: unknown): value is LiveOrderVenueId {
  return typeof value === "string" && (LIVE_ORDER_VENUE_IDS as readonly string[]).includes(value);
}

export function isVenueId(value: unknown): value is VenueId {
  return typeof value === "string" && (VENUE_IDS as readonly string[]).includes(value);
}

export const VENUE_LABELS: Record<VenueId, string> = {
  binance: "Binance",
  "coinbase-advanced": "Coinbase Advanced",
  kraken: "Kraken",
  wundertrading: "WunderTrading",
  "binance-testnet": "Binance Spot Testnet",
};

/**
 * What a caller may ask a venue to do.
 *
 * The list is closed, and it is the whole interface: balances, positions, orders,
 * one order's status, a cancellation and a health check. A venue that cannot do one
 * of these says so in its descriptor rather than by failing with a transport error,
 * so an unavailable capability is a sentence before it is a request.
 */
export const VENUE_CAPABILITIES = [
  "balances",
  "positions",
  "orders",
  "orderStatus",
  "place",
  "cancel",
  "health",
] as const;
export type VenueCapability = (typeof VENUE_CAPABILITIES)[number];

export const CAPABILITY_LABELS: Record<VenueCapability, string> = {
  balances: "balances",
  positions: "positions",
  orders: "orders",
  orderStatus: "order status",
  place: "place an order",
  cancel: "cancel an order",
  health: "connection health",
};

/**
 * What a key is allowed to do, as the owner states it and as the venue reports it.
 *
 * `withdraw` exists so it can be refused: no key is ever stored with it, and a venue
 * that reports it makes the connection unhealthy rather than quietly usable. Keeping
 * the word in the vocabulary is what lets a refusal name the thing that was asked
 * for — a refusal that cannot say "withdrawal" is not a refusal the owner can act on.
 */
export const VENUE_PERMISSIONS = ["read", "trade", "withdraw"] as const;
export type VenuePermission = (typeof VENUE_PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<VenuePermission, string> = {
  read: "read",
  trade: "trade",
  withdraw: "withdraw",
};

export type VenueDescriptor = {
  id: VenueId;
  label: string;
  /**
   * Which endpoint the adapter talks to. `"testnet"` means the venue's sandbox — its
   * own keys, its own balances, no real funds; `"live"` means the exchange itself.
   *
   * `place` is a property of the descriptor, not of a route: phase 21 published it on
   * the testnet row only. Phase 22 publishes it on {@link LIVE_ORDER_VENUE_IDS} as well,
   * and the owner's switch — not the table — decides whether a live descriptor may be
   * used. A live venue outside that list still cannot be asked to place by any caller.
   */
  environment: "live" | "testnet";
  capabilities: readonly VenueCapability[];
  /**
   * `"venue"` means the venue answers a question about the key's own permission set
   * (Binance's `account/apiRestrictions`); `"none"` means it does not, and the panel
   * says so rather than guessing. A guessed permission is worse than an absent one.
   */
  permissionReport: "venue" | "none";
};

/**
 * The adapters' capability lists, in one table.
 *
 * The three CCXT venues are spot accounts: they hold balances and orders, they can
 * cancel, and they have no positions to report. That is a property of a spot account,
 * not of the exchange API, so it is stated rather than discovered — `fetchPositions`
 * on a spot-only account answers an empty list or a `NotSupported`, and either would
 * be a worse answer than "this connection has no positions".
 */
const SPOT_CAPABILITIES: readonly VenueCapability[] = ["balances", "orders", "orderStatus", "cancel", "health"];

/**
 * A Binance spot account that can place, on either endpoint.
 *
 * The other two live rows stay read-only: their placement paths have not been proved and
 * are not part of this phase. Binance's testnet and live rows share this list because
 * they share the code that submits; the difference between them is the endpoint and the
 * key, not the capability.
 */
const BINANCE_CAPABILITIES: readonly VenueCapability[] = [...SPOT_CAPABILITIES, "place"];

export const VENUE_DESCRIPTORS: Record<VenueId, VenueDescriptor> = {
  binance: {
    // The exchange itself (phase 22). It publishes `place` because the adapter behind it
    // implements the order port; the owner's switch is what makes that reachable, and
    // `orderPlacementRefusal` refuses it by name while the switch is off.
    id: "binance",
    label: VENUE_LABELS.binance,
    environment: "live",
    capabilities: BINANCE_CAPABILITIES,
    permissionReport: "venue",
  },
  "coinbase-advanced": {
    id: "coinbase-advanced",
    label: VENUE_LABELS["coinbase-advanced"],
    environment: "live",
    capabilities: SPOT_CAPABILITIES,
    permissionReport: "none",
  },
  kraken: {
    id: "kraken",
    label: VENUE_LABELS.kraken,
    environment: "live",
    capabilities: SPOT_CAPABILITIES,
    permissionReport: "none",
  },
  wundertrading: {
    // A strategy platform, not an exchange: its read surface answers profile and
    // strategy questions. It is connected here for the health check that proves the
    // key works, and the dedicated WunderTrading page owns the strategy reads.
    id: "wundertrading",
    label: VENUE_LABELS.wundertrading,
    environment: "live",
    capabilities: ["health"],
    permissionReport: "none",
  },
  "binance-testnet": {
    // The sandbox of the venue above, reached at Binance's own testnet host. It has no
    // real funds and its keys are separate, which is why an order could be placed here
    // before the owner's real-money switch existed — and why it stays selectable after.
    id: "binance-testnet",
    label: VENUE_LABELS["binance-testnet"],
    environment: "testnet",
    capabilities: BINANCE_CAPABILITIES,
    permissionReport: "venue",
  },
};

export function venueDescriptor(id: VenueId): VenueDescriptor {
  return VENUE_DESCRIPTORS[id];
}

export function supportsCapability(id: VenueId, capability: VenueCapability): boolean {
  return VENUE_DESCRIPTORS[id].capabilities.includes(capability);
}

/**
 * The permissions a key of each scope asks for.
 *
 * "Read-only first" is the phase's ordering: the form defaults to a read-only key,
 * and a read-only key requests `read` and nothing else. A trade-capable key requests
 * `read` and `trade`. Nothing requests `withdraw` — that path is refused before it
 * reaches this function.
 */
export function permissionsForScope(readOnly: boolean): VenuePermission[] {
  return readOnly ? ["read"] : ["read", "trade"];
}

/**
 * Read a stored permission list without trusting it.
 *
 * A row written by an older build, a hand-edited column or a future value must not
 * make a panel or a decision crash; unknown words are dropped and the remaining known
 * ones are deduplicated in vocabulary order. Malformed JSON reads as an empty list,
 * which the panel shows as "not recorded" — the honest reading of a column it cannot
 * understand.
 */
export function parsePermissions(value: string | null | undefined): VenuePermission[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const present = new Set(
    parsed.filter((item): item is VenuePermission => typeof item === "string" && (VENUE_PERMISSIONS as readonly string[]).includes(item)),
  );
  return VENUE_PERMISSIONS.filter((permission) => present.has(permission));
}

export type RequestedPermissionsValidation =
  | { valid: true; permissions: VenuePermission[] }
  | { valid: false; error: string; code: string };

/**
 * What the save path accepts as a permission request.
 *
 * Three refusals, and each names the thing that was asked for:
 *
 *  - `withdraw` is never requested or stored. The platform cannot withdraw from a
 *    venue, so a key carrying that permission is strictly more dangerous than the
 *    task needs; the owner is told to connect a key without it.
 *  - a read-only key cannot also request `trade`; the two statements contradict each
 *    other, and guessing which one the owner meant is how a read-only key trades.
 *  - a list that is not made of the known words is refused rather than filtered,
 *    because a request this build does not understand is not a request it may narrow.
 *
 * Omitting the list entirely is the normal case: the scope decides it (see
 * {@link permissionsForScope}).
 */
export function validateRequestedPermissions(
  value: unknown,
  readOnly: boolean,
): RequestedPermissionsValidation {
  if (value === undefined) return { valid: true, permissions: permissionsForScope(readOnly) };
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return { valid: false, code: "PERMISSIONS_INVALID", error: "Requested permissions must be a list of permission names." };
  }
  if (value.includes("withdraw")) {
    return {
      valid: false,
      code: "WITHDRAWAL_NOT_PERMITTED",
      error:
        "Withdrawal permission is never requested or stored. Veylora cannot withdraw from a venue, so it will not hold a key that can: " +
        "switch withdrawals off for this API key at the venue (or create a key without it) and connect that key instead.",
    };
  }
  const unknown = value.filter((item) => !(VENUE_PERMISSIONS as readonly string[]).includes(item));
  if (unknown.length > 0) {
    return {
      valid: false,
      code: "PERMISSIONS_INVALID",
      error: `Unsupported permission ${unknown.map((item) => `"${item}"`).join(", ")}. This build understands ${VENUE_PERMISSIONS.join(", ")}.`,
    };
  }
  const requested = VENUE_PERMISSIONS.filter((permission) => value.includes(permission));
  if (readOnly && requested.includes("trade")) {
    return {
      valid: false,
      code: "SCOPE_CONFLICT",
      error: "A read-only key cannot request trade permission. Clear read-only to connect a key that may trade, or request read only.",
    };
  }
  if (!readOnly && !requested.includes("trade")) {
    return {
      valid: false,
      code: "SCOPE_CONFLICT",
      error: "A trade-capable key must request trade permission. Tick read-only to connect a key that only reads.",
    };
  }
  return { valid: true, permissions: requested };
}

export type VenueBalance = { asset: string; available: string; total: string };

export type VenuePosition = {
  symbol: string;
  side: "long" | "short" | "unknown";
  contracts: string;
  entryPrice: string | null;
  notional: string | null;
  unrealizedPnl: string | null;
};

export type VenueOrder = {
  id: string;
  symbol: string;
  side: "buy" | "sell" | "unknown";
  type: string | null;
  status: string;
  amount: string | null;
  filled: string | null;
  price: string | null;
  createdAt: string | null;
};

export type VenueOrderStatus = {
  id: string;
  status: string;
  filled: string | null;
  remaining: string | null;
};

export type VenueCancellation = { id: string; status: "cancelled" };

/** One line of human-readable evidence a read produced (profiles, for example). */
export type VenueReadoutItem = { title: string; detail: string };

/**
 * The answer to "does this connection work?", never thrown.
 *
 * Verification is the one venue call whose failure is data: an expired key, a
 * wrong secret or a venue outage is recorded on the credential and shown to the
 * owner, so `checkHealth` returns `ok: false` with the venue's own message instead
 * of raising. Every other method throws, because a typed refusal is what a caller
 * can act on.
 *
 * `latencyMs` is measured inside the adapter, around the call that did the work, so
 * it is the venue's round trip rather than the route's total. `permissions` is
 * `null` when the venue does not report a key's permission set — the distinction
 * between "reported none" and "does not report" is the difference between a clean
 * key and an unknown one.
 */
export type VenueHealthCheck = {
  ok: boolean;
  checkedAt: string;
  latencyMs: number;
  evidence: string;
  permissions: VenuePermission[] | null;
  balances?: VenueBalance[];
  items?: VenueReadoutItem[];
  error?: string;
};

/** The material an adapter is allowed to see. It never leaves the server. */
export type VenueSecret = {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
  readOnly: boolean;
};

export type VenueAdapter = {
  id: VenueId;
  label: string;
  capabilities: readonly VenueCapability[];
  readBalances(): Promise<VenueBalance[]>;
  readPositions(): Promise<VenuePosition[]>;
  readOrders(limit?: number): Promise<VenueOrder[]>;
  readOrderStatus(orderId: string): Promise<VenueOrderStatus>;
  cancelOrder(orderId: string): Promise<VenueCancellation>;
  checkHealth(): Promise<VenueHealthCheck>;
};

export const VENUE_REFUSAL_CODES = {
  readOnly: "READ_ONLY_CREDENTIAL",
  capability: "CAPABILITY_UNAVAILABLE",
  withdrawal: "WITHDRAWAL_NOT_PERMITTED",
  invalidOrderId: "INVALID_ORDER_ID",
  unsupported: "UNSUPPORTED_VENUE",
} as const;

/**
 * A refusal a caller can act on: a stable code, a sentence, and no provider call.
 *
 * It is an `Error` so an unexpected throw path still surfaces in logs, but its
 * message is written for the owner rather than an operator: "this key is read-only"
 * is something a person can fix, "403" is not.
 */
export class VenueRefusal extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VenueRefusal";
    this.code = code;
  }
}

export function isVenueRefusal(error: unknown): error is VenueRefusal {
  return error instanceof VenueRefusal;
}

/**
 * A capability the venue never claimed, refused before anything is sent.
 *
 * `never` rather than `void` so a method using it as its only statement typechecks
 * without a trailing `throw`: the interface is implemented by refusing, and the
 * compiler is told that is the whole implementation.
 */
export function capabilityRefusal(id: VenueId, capability: VenueCapability): never {
  const label = VENUE_LABELS[id];
  throw new VenueRefusal(
    VENUE_REFUSAL_CODES.capability,
    `${label} does not provide ${CAPABILITY_LABELS[capability]} through this connection${capability === "positions" ? " (these are spot accounts, which hold no positions)" : ""}.`,
  );
}

export function requireCapability(id: VenueId, capability: VenueCapability): void {
  if (!supportsCapability(id, capability)) capabilityRefusal(id, capability);
}

/**
 * The write gate, shared by both adapters.
 *
 * Every write goes through this before a client is created, so a read-only key's
 * refusal costs no network call and no venue sees a request. The sentence names the
 * key, the action and the remedy, because the owner is the person who can fix it.
 */
export function assertWriteAllowed(id: VenueId, secret: Pick<VenueSecret, "readOnly">, action: string): void {
  if (!secret.readOnly) return;
  throw new VenueRefusal(
    VENUE_REFUSAL_CODES.readOnly,
    `The ${VENUE_LABELS[id]} key is stored as read-only, so it cannot ${action}. A read-only key is for balances and history; connect a key created for trading to ${action}.`,
  );
}

export const VENUE_PERMISSION_REPORT_ABSENT =
  "This venue does not report a key's permission set, so the requested scope is what the owner stated, not what the venue confirmed.";

export const VENUE_CUSTODY_STATEMENT =
  "Funds stay at the venue. Veylora holds no custody of them, cannot withdraw them, and never requests withdrawal permission on a key.";

/**
 * The row update a verification writes, derived from the health answer.
 *
 * Pure, so the rule "a failed check records the error and does not claim a
 * verification" is asserted without a database. `verifiedAt` is omitted (Prisma
 * treats `undefined` as "leave alone") when the check failed, so a key that worked
 * yesterday and is broken today keeps the last time it actually worked while
 * `lastCheckError` says what happened since.
 */
export type VerificationRecord = {
  verifiedAt?: Date;
  lastCheckedAt: Date;
  lastCheckLatencyMs: number;
  lastCheckError: string | null;
  reportedPermissions: string | null;
};

export function verificationRecord(health: VenueHealthCheck): VerificationRecord {
  const checkedAt = new Date(health.checkedAt);
  const at = Number.isFinite(checkedAt.getTime()) ? checkedAt : new Date();
  return {
    ...(health.ok ? { verifiedAt: at } : {}),
    lastCheckedAt: at,
    lastCheckLatencyMs: Math.max(0, Math.round(health.latencyMs)),
    lastCheckError: health.ok ? null : health.error ?? "The venue did not answer.",
    reportedPermissions: health.permissions === null ? null : JSON.stringify(health.permissions),
  };
}

export type ConnectionHealth =
  | { state: "HEALTHY"; checkedAt: string | null; latencyMs: number | null }
  | { state: "FAILING"; checkedAt: string | null; latencyMs: number | null; error: string }
  | { state: "UNCHECKED" };

/**
 * What the panel says about a connection, from the two columns that record it.
 *
 * A connection that has never been checked is not "healthy" and not "failing": it
 * is unchecked, and the panel says so. That is the difference between an absence of
 * evidence and evidence of absence, and it is the reason this is a three-way state.
 */
export function connectionHealth(credential: {
  lastCheckedAt?: Date | string | null;
  lastCheckLatencyMs?: number | null;
  lastCheckError?: string | null;
}): ConnectionHealth {
  if (!credential.lastCheckedAt) return { state: "UNCHECKED" };
  const checkedAt = new Date(credential.lastCheckedAt).toISOString();
  if (credential.lastCheckError) {
    return {
      state: "FAILING",
      checkedAt,
      latencyMs: credential.lastCheckLatencyMs ?? null,
      error: credential.lastCheckError,
    };
  }
  return { state: "HEALTHY", checkedAt, latencyMs: credential.lastCheckLatencyMs ?? null };
}
