import { prisma } from "@/lib/db";
import type { SignalRefusalCode } from "./map";
import { maskSignalToken, normalizeReplayWindowSeconds, type SignalVerificationFailure } from "./verify";

/**
 * The signal log (phase 31).
 *
 * Every attempt is a row: a bad signature, a stale timestamp, a replayed id, a bound that
 * refused the size and an accepted signal that became an order. The phase is explicit that a
 * refusal must not fail silently, and the shape of this module is how that is honoured — the
 * route cannot answer until a row exists.
 *
 * Two mechanics are worth naming:
 *
 *  - **The claim.** A row is inserted with the unique `dedupeKey` before anything is submitted,
 *    so two concurrent deliveries of the same signal cannot both reach the order path. The
 *    loser of that race is not an error: it is the duplicate case, and it is stored as its own
 *    row pointing at the original.
 *  - **The resolution.** The claimed row is updated in place with the outcome (accepted with an
 *    order id, or refused with the bound that refused it). If the process dies between the two
 *    the row stays `PENDING`, which is the honest record of "received, never resolved" rather
 *    than a success that did not happen.
 *
 * Neither the token nor the secret is ever written here: the token appears as its masked
 * prefix, and the body as a SHA-256 digest.
 */

export const SIGNAL_DECISIONS = ["PENDING", "ACCEPTED", "REJECTED", "DUPLICATE"] as const;
export type SignalDecision = (typeof SIGNAL_DECISIONS)[number];

export type SignalReasonCode =
  | SignalRefusalCode
  | SignalVerificationFailure
  | "TOKEN_UNKNOWN"
  | "TOKEN_REVOKED"
  | "SIGNAL_RECEIVED"
  | "SIGNAL_ACCEPTED"
  | "SIGNAL_DUPLICATE"
  | "RISK_LIMIT_REACHED"
  | "ORDER_REFUSED"
  | "ORDER_FAILED";

export const SIGNAL_REASON_LABELS: Record<SignalReasonCode, string> = {
  SIGNAL_INVALID: "Signal body was not usable",
  ACTION_UNSUPPORTED: "Action not supported",
  STRATEGY_NOT_FOUND: "Strategy not found",
  STRATEGY_NOT_RUNNING: "Strategy not running",
  KILL_SWITCH_ENGAGED: "Kill switch engaged",
  MARKET_NOT_SUPPORTED: "Market not supported",
  MARKET_NOT_APPROVED: "Market not approved",
  STRATEGY_MARKET_MISMATCH: "Market does not match the strategy",
  PRICE_UNAVAILABLE: "Price unavailable",
  STOP_LOSS_MISSING: "No stop-loss configured",
  SIGNAL_SIZE_INVALID: "Size invalid",
  MAX_ORDER_NOTIONAL: "Above the per-order cap",
  STRATEGY_BUDGET: "Above the strategy budget",
  STRATEGY_POSITION_CAP: "Above the strategy position cap",
  NO_OPEN_POSITION: "No open position",
  EXIT_EXCEEDS_POSITION: "Exit larger than the position",
  BODY_TOO_LARGE: "Body too large",
  SIGNATURE_MISSING: "Signature missing",
  TIMESTAMP_MISSING: "Timestamp missing",
  TIMESTAMP_INVALID: "Timestamp unreadable",
  TIMESTAMP_OUT_OF_WINDOW: "Timestamp outside the replay window",
  SIGNATURE_INVALID: "Signature invalid",
  TOKEN_UNKNOWN: "Token not recognised",
  TOKEN_REVOKED: "Token revoked",
  SIGNAL_RECEIVED: "Received",
  SIGNAL_ACCEPTED: "Accepted",
  SIGNAL_DUPLICATE: "Duplicate signal id",
  RISK_LIMIT_REACHED: "Refused by the risk policy",
  ORDER_REFUSED: "Order path refused it",
  ORDER_FAILED: "Order path failed",
};

export function labelForSignalReason(code: string): string {
  return SIGNAL_REASON_LABELS[code as SignalReasonCode] ?? code.replaceAll("_", " ").toLowerCase();
}

export type SignalAttemptInput = {
  userId: string;
  tokenId: string | null;
  signalId: string | null;
  source: string;
  signatureStatus: "valid" | "invalid" | "missing";
  decision: SignalDecision;
  reasonCode: SignalReasonCode;
  reasonMessage: string;
  action?: string | null;
  market?: string | null;
  notionalUsd?: string | null;
  bodyHash: string;
  orderId?: string | null;
  duplicateOfId?: string | null;
};

function dedupeKey(tokenId: string | null, signalId: string | null): string | null {
  return tokenId && signalId ? `${tokenId}:${signalId}` : null;
}

/**
 * Insert one attempt. Returns the duplicate's original when the insert lost the unique race.
 *
 * A duplicate is written as a second row (with a null `dedupeKey`) so "the sender retried and
 * we refused it" is visible in the log next to the signal that actually acted.
 */
export async function recordSignalEvent(
  input: SignalAttemptInput,
): Promise<{ id: string; duplicateOf: { id: string; receivedAt: Date; reasonMessage: string } | null }> {
  const key = input.decision === "DUPLICATE" ? null : dedupeKey(input.tokenId, input.signalId);
  try {
    const created = await prisma.signalEvent.create({
      data: {
        userId: input.userId,
        tokenId: input.tokenId,
        signalId: input.signalId,
        source: input.source,
        signatureStatus: input.signatureStatus,
        decision: input.decision,
        reasonCode: input.reasonCode,
        reasonMessage: input.reasonMessage,
        action: input.action ?? null,
        market: input.market ?? null,
        notionalUsd: input.notionalUsd ?? null,
        bodyHash: input.bodyHash,
        orderId: input.orderId ?? null,
        duplicateOfId: input.duplicateOfId ?? null,
        dedupeKey: key,
      },
      select: { id: true },
    });
    return { id: created.id, duplicateOf: null };
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code !== "P2002" || !key) throw error;

    const original = await prisma.signalEvent.findUnique({
      where: { dedupeKey: key },
      select: { id: true, receivedAt: true, reasonMessage: true },
    });
    if (!original) throw error;

    const duplicate = await prisma.signalEvent.create({
      data: {
        userId: input.userId,
        tokenId: input.tokenId,
        signalId: input.signalId,
        source: input.source,
        signatureStatus: input.signatureStatus,
        decision: "DUPLICATE",
        reasonCode: input.reasonCode === "SIGNAL_ACCEPTED" ? "SIGNAL_DUPLICATE" : input.reasonCode,
        reasonMessage: input.reasonMessage,
        action: input.action ?? null,
        market: input.market ?? null,
        notionalUsd: input.notionalUsd ?? null,
        bodyHash: input.bodyHash,
        duplicateOfId: original.id,
      },
      select: { id: true },
    });
    return { id: duplicate.id, duplicateOf: original };
  }
}

/**
 * Claim the signal id before acting on it.
 *
 * The claim is a `PENDING` row whose `dedupeKey` is unique. Two deliveries of the same signal
 * therefore produce one claim and one duplicate; the duplicate is written by
 * `recordSignalEvent`, so the caller has a single refusal path.
 */
export async function claimSignalAttempt(
  input: Omit<SignalAttemptInput, "decision" | "reasonCode" | "reasonMessage">,
): Promise<
  | { claimed: true; id: string }
  | { claimed: false; original: { id: string; receivedAt: Date; reasonMessage: string } }
> {
  const key = dedupeKey(input.tokenId, input.signalId);
  try {
    const created = await prisma.signalEvent.create({
      data: {
        userId: input.userId,
        tokenId: input.tokenId,
        signalId: input.signalId,
        source: input.source,
        signatureStatus: input.signatureStatus,
        decision: "PENDING",
        reasonCode: "SIGNAL_RECEIVED",
        reasonMessage: "The signal passed verification and was being mapped to an action when this row was written.",
        action: input.action ?? null,
        market: input.market ?? null,
        notionalUsd: input.notionalUsd ?? null,
        bodyHash: input.bodyHash,
        dedupeKey: key,
      },
      select: { id: true },
    });
    return { claimed: true, id: created.id };
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== "P2002" || !key) throw error;
    const original = await prisma.signalEvent.findUnique({
      where: { dedupeKey: key },
      select: { id: true, receivedAt: true, reasonMessage: true },
    });
    if (!original) throw error;
    return { claimed: false, original };
  }
}

/** Write the outcome onto the claimed row. */
export async function resolveSignalAttempt(
  id: string,
  input: {
    decision: Exclude<SignalDecision, "DUPLICATE">;
    reasonCode: SignalReasonCode;
    reasonMessage: string;
    notionalUsd?: string | null;
    orderId?: string | null;
  },
): Promise<void> {
  await prisma.signalEvent.update({
    where: { id },
    data: {
      decision: input.decision,
      reasonCode: input.reasonCode,
      reasonMessage: input.reasonMessage,
      notionalUsd: input.notionalUsd ?? undefined,
      orderId: input.orderId ?? null,
    },
  });
}

// ---------------------------------------------------------------------------------------
// What the settings panel reads
// ---------------------------------------------------------------------------------------

export type SignalTokenView = {
  id: string;
  label: string;
  /** The masked token — never the credential itself. */
  tokenPrefix: string;
  replayWindowSeconds: number;
  status: string;
  lastUsedAt: string | null;
  createdAt: string;
};

export async function listSignalTokens(userId: string): Promise<SignalTokenView[]> {
  const rows = await prisma.signalToken.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      label: true,
      tokenPrefix: true,
      replayWindowSeconds: true,
      status: true,
      lastUsedAt: true,
      createdAt: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    tokenPrefix: row.tokenPrefix,
    replayWindowSeconds: row.replayWindowSeconds,
    status: row.status,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export type SignalLogEntry = {
  id: string;
  receivedAt: string;
  signalId: string | null;
  source: string;
  tokenPrefix: string | null;
  signatureStatus: string;
  decision: string;
  reasonCode: string;
  reasonLabel: string;
  reasonMessage: string;
  action: string | null;
  market: string | null;
  notionalUsd: string | null;
  orderId: string | null;
  duplicateOfId: string | null;
};

export async function listSignalEvents(userId: string, limit = 50): Promise<SignalLogEntry[]> {
  const rows = await prisma.signalEvent.findMany({
    where: { userId },
    orderBy: { receivedAt: "desc" },
    take: Math.min(200, Math.max(1, limit)),
    select: {
      id: true,
      receivedAt: true,
      signalId: true,
      source: true,
      signatureStatus: true,
      decision: true,
      reasonCode: true,
      reasonMessage: true,
      action: true,
      market: true,
      notionalUsd: true,
      orderId: true,
      duplicateOfId: true,
      token: { select: { tokenPrefix: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    receivedAt: row.receivedAt.toISOString(),
    signalId: row.signalId,
    source: row.source,
    tokenPrefix: row.token?.tokenPrefix ?? null,
    signatureStatus: row.signatureStatus,
    decision: row.decision,
    reasonCode: row.reasonCode,
    reasonLabel: labelForSignalReason(row.reasonCode),
    reasonMessage: row.reasonMessage,
    action: row.action,
    market: row.market,
    notionalUsd: row.notionalUsd,
    orderId: row.orderId,
    duplicateOfId: row.duplicateOfId,
  }));
}

/** Revoke a token. Revoking is not deleting: the log keeps referring to it by prefix. */
export async function revokeSignalToken(userId: string, tokenId: string): Promise<boolean> {
  const result = await prisma.signalToken.updateMany({
    where: { id: tokenId, userId, status: "ACTIVE" },
    data: { status: "REVOKED", revokedAt: new Date() },
  });
  return result.count === 1;
}

/** Change one token's replay window. Returns the stored value, clamped by the shared rule. */
export async function setSignalReplayWindow(
  userId: string,
  tokenId: string,
  value: unknown,
): Promise<number | null> {
  const seconds = normalizeReplayWindowSeconds(value);
  const result = await prisma.signalToken.updateMany({
    where: { id: tokenId, userId, status: "ACTIVE" },
    data: { replayWindowSeconds: seconds },
  });
  return result.count === 1 ? seconds : null;
}

/** Safe display helper for a token prefix that is already masked. */
export function displayTokenPrefix(prefix: string): string {
  return prefix.includes("…") ? prefix : maskSignalToken(prefix);
}
