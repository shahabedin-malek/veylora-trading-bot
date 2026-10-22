import { ORDER_STATUS_DETAIL, type OrderStatus } from "@/lib/orders/state-machine";
import { isUsableClientKey, type OrderIntent } from "@/lib/orders/idempotency";
import type { StoredOrder } from "@/lib/orders/store";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";

/**
 * What an order request must look like, and what an order looks like when it is
 * answered with.
 *
 * Validation lives here rather than in the route so the same rules are used by the
 * route, by a test, and by anything else that has to decide whether a submission
 * is well-formed — a route is not a good place for a rule that must not drift.
 *
 * The two amounts (`notionalUsdCents`, `verifiedBalanceCents`) are stated by the
 * caller. That is honest for this phase and it is written down rather than
 * implied: the order path is the development paper venue, the Binance Spot Testnet
 * (phase 21) or the live Binance venue behind the owner's switch (phase 22), and
 * phase 25 replaces a caller-supplied valuation with one the server computes and checks
 * against the risk policy. Until then the values are recorded and audited as what the
 * caller claimed, not as a verified balance.
 *
 * `execution` is how a request says which of those it wants. Omitted, routing decides
 * (live when the owner's switch is on, then testnet, then paper). It exists so the trading
 * page can offer the choice and so "I asked for live and the switch is off" is a named
 * answer instead of silence — it is not an approval step, and when the switch is on the
 * live path adds no question of its own.
 */

export const MAX_TEXT_LENGTH = 280;

export const EXECUTION_TARGETS = ["auto", "paper", "testnet", "live"] as const;
export type ExecutionTarget = (typeof EXECUTION_TARGETS)[number];

const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const MAX_QUANTITY = 1e12;
const MAX_AMOUNT_CENTS = 1e12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MARKETS = new Set<string>(USD_WATCHLIST.map(({ productId }) => productId));

export type OrderSubmissionFields = {
  market: string;
  side: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT";
  quantity: string;
  limitPrice: string | null;
  stopLossPrice: string;
  notionalUsdCents: number;
  verifiedBalanceCents: number;
  clientKey: string | null;
  /** `auto` means "wherever order routing currently points". */
  execution: ExecutionTarget;
};

export type OrderSubmissionValidation =
  | { valid: true; value: OrderSubmissionFields }
  | { valid: false; error: string };

function decimal(value: unknown, input: { field: string; allowZero: boolean; max: number }): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: false, error: `${input.field} must be a decimal string.` };
  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) return { ok: false, error: `${input.field} must be a plain decimal, for example "0.01".` };
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) return { ok: false, error: `${input.field} is not a readable number.` };
  if (input.allowZero ? numeric < 0 : numeric <= 0) {
    return { ok: false, error: `${input.field} must be ${input.allowZero ? "zero or more" : "greater than zero"}.` };
  }
  if (numeric > input.max) return { ok: false, error: `${input.field} is larger than this build allows.` };
  return { ok: true, value: trimmed };
}

function cents(value: unknown, field: string): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_AMOUNT_CENTS) {
    return { ok: false, error: `${field} must be a whole number of US cents.` };
  }
  return { ok: true, value };
}

/**
 * Validate a submission. Every refusal names the field and what would be
 * acceptable, because "invalid body" tells the person nothing.
 */
export function validateOrderSubmission(value: unknown, clientKeyFromHeader: string | null = null): OrderSubmissionValidation {
  if (!isRecord(value)) return { valid: false, error: "The request body must be a JSON object." };

  if (typeof value.market !== "string" || !MARKETS.has(value.market)) {
    return { valid: false, error: "Choose a supported Coinbase USD market." };
  }
  if (value.side !== "BUY" && value.side !== "SELL") return { valid: false, error: "Side must be BUY or SELL." };
  if (value.orderType !== "MARKET" && value.orderType !== "LIMIT") {
    return { valid: false, error: "Order type must be MARKET or LIMIT." };
  }

  const quantity = decimal(value.quantity, { field: "Quantity", allowZero: false, max: MAX_QUANTITY });
  if (!quantity.ok) return { valid: false, error: quantity.error };

  let limitPrice: string | null = null;
  if (value.orderType === "LIMIT") {
    const parsed = decimal(value.limitPrice, { field: "Limit price", allowZero: false, max: MAX_QUANTITY });
    if (!parsed.ok) return { valid: false, error: `${parsed.error} A LIMIT order needs one.` };
    limitPrice = parsed.value;
  } else if (value.limitPrice !== undefined && value.limitPrice !== null) {
    return { valid: false, error: "A MARKET order does not carry a limit price." };
  }

  let stopLossPrice = "0";
  if (value.stopLossPrice !== undefined && value.stopLossPrice !== null) {
    const parsed = decimal(value.stopLossPrice, { field: "Stop-loss price", allowZero: true, max: MAX_QUANTITY });
    if (!parsed.ok) return { valid: false, error: parsed.error };
    stopLossPrice = parsed.value;
  }

  const notional = cents(value.notionalUsdCents, "Notional");
  if (!notional.ok) return { valid: false, error: notional.error };
  if (notional.value <= 0) return { valid: false, error: "Notional must be greater than zero." };
  const balance = cents(value.verifiedBalanceCents, "Verified balance");
  if (!balance.ok) return { valid: false, error: balance.error };

  let execution: ExecutionTarget = "auto";
  if (value.execution !== undefined && value.execution !== null) {
    const requested = typeof value.execution === "string" ? value.execution.trim().toLowerCase() : "";
    if (!(EXECUTION_TARGETS as readonly string[]).includes(requested)) {
      return { valid: false, error: `Execution must be one of ${EXECUTION_TARGETS.join(", ")}.` };
    }
    execution = requested as ExecutionTarget;
  }

  const headerKey = (clientKeyFromHeader ?? "").trim();
  if (headerKey && !isUsableClientKey(headerKey)) {
    return { valid: false, error: "The Idempotency-Key header must be 8–200 characters of letters, digits, . _ : @ or -." };
  }
  const bodyKey = value.idempotencyKey;
  if (bodyKey !== undefined && bodyKey !== null && !isUsableClientKey(bodyKey)) {
    return { valid: false, error: "idempotencyKey must be 8–200 characters of letters, digits, . _ : @ or -." };
  }

  return {
    valid: true,
    value: {
      market: value.market,
      side: value.side,
      orderType: value.orderType,
      quantity: quantity.value,
      limitPrice,
      stopLossPrice,
      notionalUsdCents: notional.value,
      verifiedBalanceCents: balance.value,
      // The header wins: a client that sets it is stating its own key explicitly.
      clientKey: headerKey || (typeof bodyKey === "string" ? bodyKey.trim() : null),
      execution,
    },
  };
}

export function orderIntentFrom(fields: OrderSubmissionFields, input: { userId: string; venue: string }): OrderIntent {
  return {
    userId: input.userId,
    venue: input.venue,
    market: fields.market,
    side: fields.side,
    orderType: fields.orderType,
    quantity: fields.quantity,
    limitPrice: fields.limitPrice,
    stopLossPrice: fields.stopLossPrice,
    notionalUsdCents: fields.notionalUsdCents,
    verifiedBalanceCents: fields.verifiedBalanceCents,
    clientKey: fields.clientKey,
  };
}

export type CancellationValidation = { valid: true; reason: string; clientKey: string | null } | { valid: false; error: string };

export function validateCancellation(value: unknown, clientKeyFromHeader: string | null = null): CancellationValidation {
  if (value !== undefined && value !== null && !isRecord(value)) {
    return { valid: false, error: "The request body must be a JSON object when one is sent." };
  }
  const body = isRecord(value) ? value : {};
  const reason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim()
      : "The owner cancelled this order.";
  if (reason.length > MAX_TEXT_LENGTH) return { valid: false, error: `The reason must be at most ${MAX_TEXT_LENGTH} characters.` };

  const headerKey = (clientKeyFromHeader ?? "").trim();
  if (headerKey && !isUsableClientKey(headerKey)) {
    return { valid: false, error: "The Idempotency-Key header must be 8–200 characters of letters, digits, . _ : @ or -." };
  }
  const bodyKey = body.idempotencyKey;
  if (bodyKey !== undefined && bodyKey !== null && !isUsableClientKey(bodyKey)) {
    return { valid: false, error: "idempotencyKey must be 8–200 characters of letters, digits, . _ : @ or -." };
  }
  return { valid: true, reason, clientKey: headerKey || (typeof bodyKey === "string" ? bodyKey.trim() : null) };
}

/**
 * The JSON shape of one order. The status is sent with the sentence that explains
 * it (`ORDER_STATUS_DETAIL`), so a surface rendering this order never has to
 * hard-code a status it cannot describe.
 */
export function orderResource(order: StoredOrder) {
  const detail = ORDER_STATUS_DETAIL[order.status];
  return {
    id: order.id,
    venue: order.venue,
    market: order.market,
    side: order.side,
    orderType: order.orderType,
    status: order.status,
    statusLabel: detail.label,
    statusDetail: detail.detail,
    terminal: detail.terminal,
    requestedQuantity: order.requestedQuantity,
    filledQuantity: order.filledQuantity,
    remainingQuantity: order.remainingQuantity,
    clientOrderId: order.clientOrderId,
    venueOrderId: order.venueOrderId,
    idempotencyKey: order.idempotencyKey,
    limitPrice: order.limitPrice,
    stopLossPrice: order.stopLossPrice,
    notionalUsdCents: order.notionalUsdCents,
    verifiedBalanceCents: order.verifiedBalanceCents,
    attempts: order.attempts,
    lastAttemptAt: order.lastAttemptAt,
    lastAttemptReason: order.lastAttemptReason,
    submittedAt: order.submittedAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

/** The lifecycle as the API states it, so every status a row may carry is explained. */
export function lifecycleResource() {
  return Object.entries(ORDER_STATUS_DETAIL).map(([status, detail]) => ({
    status: status as OrderStatus,
    label: detail.label,
    detail: detail.detail,
    terminal: detail.terminal,
  }));
}

/** A status filter from `?status=SUBMITTED,FILLED`, refusing an unknown one by name. */
export function parseStatusFilter(value: string | null): { valid: true; statuses: OrderStatus[] } | { valid: false; error: string } {
  if (!value?.trim()) return { valid: true, statuses: [] };
  const requested = value.split(",").map((part) => part.trim().toUpperCase()).filter(Boolean);
  const known = new Set(Object.keys(ORDER_STATUS_DETAIL));
  const unknown = requested.filter((status) => !known.has(status));
  if (unknown.length > 0) {
    return { valid: false, error: `Unknown order status: ${unknown.join(", ")}. Known statuses: ${[...known].join(", ")}.` };
  }
  return { valid: true, statuses: requested as OrderStatus[] };
}

export function parseLimit(value: string | null, fallback: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}
