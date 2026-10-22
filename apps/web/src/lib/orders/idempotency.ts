import { createHash } from "node:crypto";
import { reason, serializeReason, type Reason } from "@/lib/observability/reason";

/**
 * Idempotency for every mutating order operation.
 *
 * The rule this exists to enforce: a retried request must return the original
 * result instead of placing a second order. Two things are needed for that, and
 * both are here:
 *
 *  - **A key derived from the caller's intent.** `deriveIdempotencyKey` hashes
 *    the caller's own key when they supply one, and otherwise a canonical form of
 *    the intent (account, venue, market, side, type, quantity, prices). Two
 *    identical submissions therefore produce the same key without the caller
 *    having to remember anything, which is the retry case this protects.
 *  - **A reservation that only one caller can win.** The key is unique in the
 *    database, so `reserve` is atomic: the insert either creates the reservation
 *    or hits the constraint, and the loser reads the winner's row to learn
 *    whether the work is still in flight, finished (replay) or bound to a
 *    different intent (conflict). No advisory lock, no process memory — a second
 *    serverless instance gets the same answer.
 *
 * A deliberate second identical order is possible: the caller passes its own key
 * (an `Idempotency-Key` header, or `idempotencyKey` in the body), which is
 * exactly how a client distinguishes "the same request again" from "do it again".
 * Without one, an identical intent is treated as the *same* operation — for money
 * that is the safe default, and it is stated in the UI rather than implied.
 */

export const IDEMPOTENCY_SCOPES = {
  submitOrder: "order.submit",
  cancelOrder: "order.cancel",
} as const;

export type IdempotencyScope = (typeof IDEMPOTENCY_SCOPES)[keyof typeof IDEMPOTENCY_SCOPES];

export type OrderIntent = {
  userId: string;
  venue: string;
  market: string;
  side: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT";
  quantity: string;
  limitPrice?: string | null;
  stopLossPrice?: string | null;
  notionalUsdCents: number;
  verifiedBalanceCents: number;
  /** The caller's own key, when it supplied one. */
  clientKey?: string | null;
};

const KEY_PATTERN = /^[A-Za-z0-9._:@-]{8,200}$/;

export function isUsableClientKey(value: unknown): value is string {
  return typeof value === "string" && KEY_PATTERN.test(value.trim());
}

/**
 * The canonical form of an intent: one `field=value` line per field, in a fixed
 * order, with the quantity and prices normalised so `"0.10"` and `"0.1"` are the
 * same intent. Two intents that read the same produce the same string, which is
 * what makes the derived key stable across a retry.
 */
export function canonicalOrderIntent(intent: OrderIntent): string {
  const normaliseDecimal = (value: string | null | undefined): string => {
    const trimmed = (value ?? "").trim();
    if (!trimmed) return "";
    // Drop trailing zeros and a trailing point without importing a decimal
    // library: the intent is a string contract, not arithmetic.
    return trimmed.includes(".") ? trimmed.replace(/0+$/, "").replace(/\.$/, "") : trimmed;
  };
  return [
    `intent=order.v1`,
    `userId=${intent.userId.trim()}`,
    `venue=${intent.venue.trim().toLowerCase()}`,
    `market=${intent.market.trim().toUpperCase()}`,
    `side=${intent.side}`,
    `orderType=${intent.orderType}`,
    `quantity=${normaliseDecimal(intent.quantity)}`,
    `limitPrice=${normaliseDecimal(intent.limitPrice)}`,
    `stopLossPrice=${normaliseDecimal(intent.stopLossPrice)}`,
    `notionalUsdCents=${intent.notionalUsdCents}`,
    `verifiedBalanceCents=${intent.verifiedBalanceCents}`,
  ].join("\n");
}

/** A stable fingerprint of an intent, stored beside the key so a mismatch is detectable. */
export function fingerprintIntent(intent: OrderIntent): string {
  return createHash("sha256").update(canonicalOrderIntent(intent)).digest("hex");
}

/**
 * The idempotency key for an intent.
 *
 * A key the caller supplied (`Idempotency-Key`, or `idempotencyKey` in the body)
 * *is* the key: it names the operation, which is how a client says "this is the
 * same request" and "this is a deliberate second one". Reusing that key for a
 * different intent is then detectable — the stored fingerprint will not match —
 * and it is refused rather than replayed, because the alternative is silently
 * answering a different request with an earlier result.
 *
 * With no key from the caller, the intent alone decides: the canonical form of
 * the order is hashed, so an identical submission is the *same* operation. For
 * money that is the safe default, and the UI says so rather than implying it.
 */
export function deriveIdempotencyKey(intent: OrderIntent, scope: IdempotencyScope = IDEMPOTENCY_SCOPES.submitOrder): string {
  const clientKey = (intent.clientKey ?? "").trim();
  return createHash("sha256")
    .update(clientKey ? `${scope}\nclientKey=${clientKey}` : `${scope}\n${canonicalOrderIntent(intent)}`)
    .digest("hex");
}

/**
 * The idempotency key for an operation whose intent is not a plain order — a
 * cancel, say, whose intent is "this order, for this reason". The caller's own
 * key still wins when it supplies one, so a client can distinguish "the same
 * request again" (replay) from "cancel it again" (a new key).
 */
export function deriveOperationKey(input: {
  scope: IdempotencyScope;
  parts: readonly (string | number)[];
  clientKey?: string | null;
}): string {
  const clientKey = (input.clientKey ?? "").trim();
  return createHash("sha256")
    .update([input.scope, clientKey ? `clientKey=${clientKey}` : "", ...input.parts.map((part) => String(part))].join("\n"))
    .digest("hex");
}

/**
 * The client order id the venue sees. Derived from the key, so a retry of the
 * same intent arrives at the venue under the same client id — the other half of
 * "one order, not two" for a venue that honours client ids.
 */
export function deriveClientOrderId(key: string): string {
  return `ord_${key.slice(0, 40)}`;
}

export type IdempotencyReservation =
  | { kind: "reserved"; recordId: string }
  | { kind: "replay"; recordId: string; result: unknown; completedAt: string | null }
  | { kind: "in-flight"; recordId: string; startedAt: string }
  | { kind: "conflict"; recordId: string; reason: Reason };

export type IdempotencyStore = {
  reserve(input: {
    scope: IdempotencyScope;
    key: string;
    fingerprint: string;
    actorUserId: string | null;
    now: number;
  }): Promise<IdempotencyReservation>;
  complete(input: { scope: IdempotencyScope; key: string; result: unknown; orderId?: string; now: number }): Promise<void>;
  /** A failed operation releases the key so a later retry can try again. */
  release(input: { scope: IdempotencyScope; key: string; reason: string; now: number }): Promise<void>;
};

type StoredIdempotencyRow = {
  id: string;
  fingerprint: string;
  status: string;
  resultJson: string;
  createdAt: Date;
  completedAt: Date | null;
};

/**
 * Decide what an existing reservation means for this caller. Exported because
 * both the Prisma store and the in-memory test store answer this question, and
 * they must answer it identically.
 */
export function interpretReservation(row: StoredIdempotencyRow, fingerprint: string): IdempotencyReservation {
  if (row.fingerprint !== fingerprint) {
    return {
      kind: "conflict",
      recordId: row.id,
      reason: reason("IDEMPOTENCY_KEY_REUSED", {
        message:
          "This idempotency key is already bound to a different operation, so the request was refused rather than replayed.",
        detail: "Send a new key to perform a second, different operation.",
        retryable: false,
      }),
    };
  }
  if (row.status === "COMPLETED") {
    return {
      kind: "replay",
      recordId: row.id,
      result: parseResult(row.resultJson),
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }
  if (row.status === "FAILED") {
    // A released key is free again: the caller may retry the same intent.
    return { kind: "reserved", recordId: row.id };
  }
  return { kind: "in-flight", recordId: row.id, startedAt: row.createdAt.toISOString() };
}

export function parseResult(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function serializeReservationReason(reservation: IdempotencyReservation): unknown {
  return reservation.kind === "conflict" ? serializeReason(reservation.reason) : null;
}

/**
 * The Prisma-backed store. `@/lib/db` is imported inside each call so importing
 * this module never constructs a database client.
 *
 * `reserve` inserts and lets the unique constraint decide the winner, rather than
 * reading first and writing second: the read-then-write version has a window in
 * which two callers both see no row and both insert, which is exactly the double
 * submission this module exists to prevent.
 */
export function createPrismaIdempotencyStore(): IdempotencyStore {
  return {
    async reserve({ scope, key, fingerprint, actorUserId, now }) {
      const { prisma } = await import("@/lib/db");
      try {
        const created = await prisma.idempotencyRecord.create({
          data: {
            scope,
            key,
            fingerprint,
            actorUserId,
            status: "IN_PROGRESS",
            createdAt: new Date(now),
          },
          select: { id: true },
        });
        return { kind: "reserved", recordId: created.id };
      } catch (error) {
        if (!isUniqueConstraintViolation(error)) throw error;
        const existing = await prisma.idempotencyRecord.findUnique({
          where: { scope_key: { scope, key } },
          select: { id: true, fingerprint: true, status: true, resultJson: true, createdAt: true, completedAt: true },
        });
        // The constraint fired, so the row exists; a null read here would mean it
        // was deleted in between, which is worth refusing rather than guessing at.
        if (!existing) {
          return {
            kind: "conflict",
            recordId: "unknown",
            reason: reason("UNKNOWN", { detail: "The idempotency reservation disappeared between the insert and the read." }),
          };
        }
        return interpretReservation(existing, fingerprint);
      }
    },

    async complete({ scope, key, result, orderId, now }) {
      const { prisma } = await import("@/lib/db");
      await prisma.idempotencyRecord.update({
        where: { scope_key: { scope, key } },
        data: {
          status: "COMPLETED",
          resultJson: JSON.stringify(result ?? {}),
          ...(orderId ? { orderId } : {}),
          completedAt: new Date(now),
        },
      });
    },

    async release({ scope, key, reason: text, now }) {
      const { prisma } = await import("@/lib/db");
      await prisma.idempotencyRecord.update({
        where: { scope_key: { scope, key } },
        data: { status: "FAILED", reason: text.slice(0, 500), completedAt: new Date(now) },
      });
    },
  };
}

export function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

let sharedStore: IdempotencyStore | null = null;

/** The store the running application uses. */
export function idempotencyStore(): IdempotencyStore {
  sharedStore ??= createPrismaIdempotencyStore();
  return sharedStore;
}
