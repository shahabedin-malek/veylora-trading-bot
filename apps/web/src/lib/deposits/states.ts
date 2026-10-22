/**
 * The states a deposit can be in, as data.
 *
 * A `Deposit` row is not a boolean ("did it count?") but a state with a reason,
 * because the six things that can happen to an arrival on chain need six
 * different sentences and only one of them is money:
 *
 *   PENDING        seen on chain, waiting for the confirmations this network requires
 *   CREDITED       confirmations reached; the only state that adds to what the account holds
 *   REVERTED       the block that carried it is gone (a reorg), so the pending row is void
 *   BELOW_DUST     real, on chain, and below the deposit minimum — recorded, never credited
 *   TOKEN_DISABLED the token that arrived is not the one the owner enabled on this network
 *                  (kept for rows written before any-token crediting existed)
 *   AWAITING_VALUATION the asset arrived in a token this network does not configure; it is
 *                  recorded for the owner to credit at a USDT value, and is never
 *                  auto-credited under the network's own token
 *   UNMATCHED      the recipient is not a deposit address this deployment issued
 *
 * The set lives here rather than in the database for the same reason every other
 * state set in this project does: `scripts/dev-database.mjs` refuses to derive
 * the SQLite development schema from a schema file containing an enum, and a
 * second copy of the rule would drift from this one. Values are validated on the
 * way out by {@link isDepositState}.
 */

export const DEPOSIT_STATES = [
  "PENDING",
  "CREDITED",
  "REVERTED",
  "BELOW_DUST",
  "TOKEN_DISABLED",
  "AWAITING_VALUATION",
  "UNMATCHED",
] as const;

export type DepositState = (typeof DEPOSIT_STATES)[number];

export function isDepositState(value: unknown): value is DepositState {
  return typeof value === "string" && (DEPOSIT_STATES as readonly string[]).includes(value);
}

/** The one state that increases what the account holds. */
export function depositStateCreditsMoney(state: DepositState): boolean {
  return state === "CREDITED";
}

/**
 * States a later run may still move out of. Only PENDING is provisional: every
 * other state is a decision with a reason attached, and re-deciding it on the
 * next run would make the reason untrustworthy.
 */
export function depositStateIsSettled(state: DepositState): boolean {
  return state !== "PENDING";
}

/** The short label the deposit panel shows. */
export function depositStateLabel(state: DepositState): string {
  switch (state) {
    case "PENDING":
      return "PENDING";
    case "CREDITED":
      return "CREDITED";
    case "REVERTED":
      return "REVERTED";
    case "BELOW_DUST":
      return "BELOW MINIMUM";
    case "TOKEN_DISABLED":
      return "TOKEN NOT ENABLED";
    case "AWAITING_VALUATION":
      return "AWAITING CREDIT";
    case "UNMATCHED":
      return "UNMATCHED";
  }
}
