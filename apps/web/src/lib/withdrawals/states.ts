import { isReasonCode, reasonMessage, type ReasonCode } from "@/lib/observability/reason";

/**
 * The states a withdrawal can be in, as data.
 *
 * A withdrawal is not a boolean ("did it leave?") and not a single failure state
 * either. The seven ways it can fail need seven sentences and two different
 * answers to "should the next run try again?", and the two are related but not the
 * same question — so the state set below is the outcome vocabulary and the reason
 * code carried beside each row says which failure it was:
 *
 *   REFUSED           the request was refused before anything was reserved, so the
 *                     amount is still in `available`: insufficient balance, an
 *                     invalid destination, an unusable amount, or a network this
 *                     deployment cannot send on. Terminal.
 *   HELD              reserved, waiting out the owner's own new-address window. The
 *                     next run releases it into RESERVED when the window has passed.
 *   RESERVED          reserved and not yet attempted. The next run signs and sends.
 *   BROADCAST_FAILED  reserved, and a send was refused — the RPC endpoint was
 *                     unreachable or the nonce was taken. Retryable: the amount
 *                     stays held and the next attempt re-uses the bytes already
 *                     signed, if there are any, so a retry cannot become a second
 *                     transaction.
 *   BROADCAST         the signed bytes are with the network; awaiting confirmations.
 *                     The amount stays reserved for as long as this lasts, however
 *                     long that is.
 *   CONFIRMED         the transfer has the confirmations this network requires, the
 *                     hold is settled and the fee taken. Terminal.
 *   CANCELLED         the owner cancelled, or a replacement transaction won the
 *                     nonce, and the amount went back to `available`. Terminal.
 *   FAILED            the transfer is dead — the transaction reverted on chain, or
 *                     the request expired before it was ever sent — and the amount
 *                     went back to `available`. Terminal.
 *
 * The split between BROADCAST_FAILED and FAILED is the one that matters for money:
 * a broadcast that never landed has taken nothing, so retrying it is free, while a
 * reverted transaction has spent gas and moved nothing, so retrying it would only
 * fail again. Collapsing the two would make the UI offer a retry that cannot work,
 * or hide one that can.
 *
 * The set lives here rather than in the database for the same reason every other
 * state set in this project does: `scripts/dev-database.mjs` refuses to derive the
 * SQLite development schema from a schema file containing an enum, and a second
 * copy of the rule would drift from this one. Values are validated on the way out
 * by {@link isWithdrawalState}.
 */

export const WITHDRAWAL_STATES = [
  "REFUSED",
  "HELD",
  "RESERVED",
  "BROADCAST_FAILED",
  "BROADCAST",
  "CONFIRMED",
  "CANCELLED",
  "FAILED",
] as const;

export type WithdrawalState = (typeof WITHDRAWAL_STATES)[number];

export function isWithdrawalState(value: unknown): value is WithdrawalState {
  return typeof value === "string" && (WITHDRAWAL_STATES as readonly string[]).includes(value);
}

export function requireWithdrawalState(value: string): WithdrawalState {
  if (!isWithdrawalState(value)) throw new Error(`Stored withdrawal status ${JSON.stringify(value)} is not one this build understands.`);
  return value;
}

/** States whose amount is reserved in the ledger and must eventually be settled or released. */
export const WITHDRAWAL_LIVE_STATES = ["HELD", "RESERVED", "BROADCAST_FAILED", "BROADCAST"] as const;

/** States that hold the amount in `withdrawal-reserved` right now. */
export function withdrawalIsLive(state: WithdrawalState): boolean {
  return (WITHDRAWAL_LIVE_STATES as readonly string[]).includes(state);
}

/**
 * States a run may still move a row out of.
 *
 * Only the live four: every other state is a decision with a reason attached, and
 * re-deciding it on the next pass would make the reason untrustworthy — and, for
 * CANCELLED and FAILED, would release the same amount twice.
 */
export function withdrawalIsSettled(state: WithdrawalState): boolean {
  return !withdrawalIsLive(state);
}

/** True when this state means the amount has been given back to `available`. */
export function withdrawalReleasedTheAmount(state: WithdrawalState): boolean {
  return state === "CANCELLED" || state === "FAILED";
}

/** True when this state means the money left. */
export function withdrawalMovedMoney(state: WithdrawalState): boolean {
  return state === "CONFIRMED";
}

/**
 * The failure code each state is only ever written with, for the states that are a
 * failure. Used by the check that every failure in the taxonomy is reachable and by
 * the panel, so neither can grow a case the state machine does not have.
 */
export const WITHDRAWAL_STATE_REASON_CODES: Partial<Record<WithdrawalState, readonly ReasonCode[]>> = {
  REFUSED: ["INSUFFICIENT_BALANCE", "INVALID_DESTINATION", "INVALID_AMOUNT", "NETWORK_UNSUPPORTED"],
  BROADCAST_FAILED: ["NETWORK_UNAVAILABLE", "NONCE_CONFLICT", "NETWORK_UNSUPPORTED", "INVALID_CREDENTIAL", "MISSING_CONFIGURATION"],
  FAILED: ["TRANSACTION_REVERTED", "WITHDRAWAL_EXPIRED"],
  HELD: ["WITHDRAWAL_HELD"],
};

/** The short label the withdrawal panel shows where there is no room for a sentence. */
export function withdrawalStateLabel(state: WithdrawalState): string {
  switch (state) {
    case "REFUSED":
      return "REFUSED";
    case "HELD":
      return "HELD";
    case "RESERVED":
      return "RESERVED";
    case "BROADCAST_FAILED":
      return "BROADCAST FAILED";
    case "BROADCAST":
      return "BROADCAST";
    case "CONFIRMED":
      return "CONFIRMED";
    case "CANCELLED":
      return "CANCELLED";
    case "FAILED":
      return "FAILED";
  }
}

/**
 * The state and its reason said together, which is what a row in the list shows.
 *
 * A state on its own is not an answer — "RESERVED" does not say whether the delay
 * is the owner's own hold window or a network that would not take the send — and the
 * reason code is what distinguishes them. The message is preferred where the row has
 * one, because it was written with the specific values in it.
 */
export function withdrawalStateSummary(state: WithdrawalState, reasonCode: string | null, reasonMessageText: string | null): string {
  const label = withdrawalStateLabel(state);
  if (!reasonCode) return label;
  const sentence = reasonMessageText?.trim() || (isReasonCode(reasonCode) ? reasonMessage(reasonCode) : null);
  return sentence ? `${label} · ${sentence}` : `${label} · ${reasonCode}`;
}
