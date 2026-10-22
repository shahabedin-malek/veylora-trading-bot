import { LedgerAmountError, decimalStringFromMinorUnits, minorUnitsFromDecimalString, type MinorUnits } from "@/lib/ledger/integer-cent-ledger";
import { postDepositCredit } from "./credit";
import type { DepositStore } from "./store";

/**
 * Crediting an arrival the network does not configure, at the value the owner puts on it.
 *
 * Any token is accepted, but only the network's configured token has a price the code
 * can prove. Everything else — a BEP-20 someone sent instead of USDT, an airdrop, the
 * native coin — arrives as `AWAITING_VALUATION` with its own symbol, decimals and raw
 * amount kept on the row. This is the door that turns one of those rows into money.
 *
 * Three rules make it safe:
 *
 *  1. **The owner names the value.** No price is inferred and no feed is trusted at
 *     credit time, because a fake token with a real-looking quote is exactly how a
 *     custodian pays a fortune for nothing. The amount is entered in USDT, in exact
 *     minor units, and the original asset is kept in the audit payload.
 *  2. **It is a claim, not an assignment.** The row moves out of `AWAITING_VALUATION`
 *     with the same compare-and-set the automatic credit uses, so two admins clicking
 *     at once produce one credit.
 *  3. **The movement and the decision are one transaction.** The ledger posts USDT, the
 *     row becomes `CREDITED`, and the audit event is written together. The ledger's own
 *     idempotency key is the deposit's, so a replay cannot post twice even if the row
 *     somehow returned to the queue.
 */

export const VALUATION_ASSET = "USDT";
export const VALUATION_DECIMALS = 6;

export type ValuationParse = { ok: true; minor: MinorUnits; display: string } | { ok: false; error: string };

/** The owner's USDT figure, exact to six decimals and strictly above zero. */
export function parseValuation(value: string): ValuationParse {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, error: "Enter the USDT value of this arrival." };
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    return { ok: false, error: "Use a USDT amount with up to six decimals, for example 12.50." };
  }
  try {
    const minor = minorUnitsFromDecimalString(trimmed, VALUATION_DECIMALS);
    if (BigInt(minor) <= BigInt(0)) return { ok: false, error: "A valuation of zero credits nothing; enter the amount it is worth." };
    return { ok: true, minor, display: decimalStringFromMinorUnits(minor, VALUATION_DECIMALS) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof LedgerAmountError ? error.message : "That is not an amount this ledger can hold.",
    };
  }
}

export type ManualCreditOutcome =
  | { credited: true; ledgerTransactionId: string | null; amountMinor: string }
  | { credited: false; error: string };

export async function creditDepositAtValuation(input: {
  store: DepositStore;
  depositId: string;
  usdAmount: string;
  actorUserId: string;
  now?: Date;
}): Promise<ManualCreditOutcome> {
  const now = input.now ?? new Date();
  const parsed = parseValuation(input.usdAmount);
  if (!parsed.ok) return { credited: false, error: parsed.error };

  const row = await input.store.findDepositById(input.depositId);
  if (!row) return { credited: false, error: "No deposit with that id exists." };
  if (row.status === "CREDITED") return { credited: false, error: "That deposit has already been credited." };
  if (row.status !== "AWAITING_VALUATION") {
    return {
      credited: false,
      error: `That deposit is ${row.status.replaceAll("_", " ").toLowerCase()}, so there is nothing to value.`,
    };
  }
  if (!row.userId) return { credited: false, error: "That arrival is not attributed to an account, so it cannot be credited." };

  const credited = await input.store.transaction(async (transaction) => {
    const claimed = await transaction.claimDeposit(row.id, "AWAITING_VALUATION", {
      status: "CREDITED",
      creditedAt: now,
      lastCheckedAt: now,
      reasonCode: null,
      reasonMessage: null,
    });
    if (!claimed) return null;

    const posted = await postDepositCredit(transaction.ledger(), {
      depositId: row.id,
      userId: row.userId as string,
      asset: VALUATION_ASSET,
      decimals: VALUATION_DECIMALS,
      amountMinor: parsed.minor,
      occurredAt: now,
      network: row.network,
      txHash: row.txHash,
      logIndex: row.logIndex,
    });
    if (!posted.posted) throw new Error(`The ledger refused the manual credit for deposit ${row.id}.`);

    await transaction.recordAudit({
      actorUserId: input.actorUserId,
      action: "DEPOSIT_CREDITED_MANUALLY",
      objectType: "Deposit",
      objectId: row.id,
      outcome: "SUCCESS",
      payload: {
        network: row.network,
        txHash: row.txHash,
        logIndex: row.logIndex,
        tokenSymbol: row.tokenSymbol,
        tokenAddress: row.tokenAddress,
        amount: row.amount,
        rawAmount: row.rawAmount,
        decimals: row.decimals,
        valuedIn: VALUATION_ASSET,
        valuationMinor: parsed.minor,
        valuation: parsed.display,
        ledgerTransactionId: posted.transactionId,
        creditedAt: now.toISOString(),
      },
    });

    return posted.transactionId;
  });

  if (credited === null) {
    return { credited: false, error: "Another pass settled that deposit first; reload the queue." };
  }
  return { credited: true, ledgerTransactionId: credited, amountMinor: parsed.minor };
}
