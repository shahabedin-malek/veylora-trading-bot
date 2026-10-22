import { ensurePlatformAccounts, ensureUserBucketAccount, feeBucket } from "@/lib/ledger/accounts";
import {
  postLedgerTransaction,
  reversingPostings,
  type LedgerAccountRow,
  type LedgerPosting,
  type MinorUnits,
} from "@/lib/ledger/integer-cent-ledger";
import { availableBalanceMinor, withBalanceLock } from "@/lib/ledger/withdrawals";
import type { LedgerStore } from "@/lib/ledger/store";
import { reason, type Reason } from "@/lib/observability/reason";
import { percentToBasisPoints } from "./amounts";
import type { FeeScheduleValues } from "./table";

/**
 * Applying a fee, and the two rules that make it a ledger entry rather than a number.
 *
 * **A fee is a movement, not a deduction.** Charging one posts a balanced transaction:
 * the owner's `AVAILABLE` account is debited by the fee and the platform's `FEES`
 * account is credited by the same amount, in one asset, under a key derived from the
 * originating action (`strategy-result:<id>:fee`). So the fee appears on the owner's
 * own statement, it appears in the platform's revenue account, and the two figures are
 * the same number by construction — which is what "traceable" has to mean if it is to
 * be checkable. The transaction also carries `sourceType`/`sourceId`, so the entry names
 * the action that earned it without a join table.
 *
 * **A fee percentage applies only to a profit.** {@link performanceFeeMinor} returns
 * zero for a losing or flat result before any percentage is consulted, so there is no
 * path from a loss to a fee — not a branch in a route, and not a "negative fee" that
 * would credit the owner. The phase's second acceptance criterion is this function.
 *
 * **Reversal is a compensating transaction.** {@link reversePerformanceFee} reads the
 * original entries and posts their opposite, referencing the original by id. Nothing is
 * edited or deleted, so "the fee was charged and then given back" stays answerable, and
 * a double reversal is one reversal because the key is the action's.
 *
 * What this module does not do: credit the profit itself. In this build a strategy
 * result is a paper result and its proceeds are not posted to the ledger; the fee is
 * charged from the account's available balance, and a result that cannot cover its fee
 * is reported as a refusal rather than by overdrawing the account. Phase 24's runner
 * credits proceeds before it charges, which is the order the balance check assumes.
 */

export type FeeApplicationOutcome = {
  /** True only when a transaction was actually posted by this call. */
  charged: boolean;
  feeMinor: string;
  feeDecimal: string;
  transactionId: string | null;
  reason: Reason | null;
};

/**
 * The fee a profitable result pays, in exact minor units.
 *
 * Floor, not round: the fraction of a minor unit that cannot be charged is not
 * collected, which is the only direction that cannot overcharge. A result at or below
 * zero pays nothing at all, whatever the configured percentage says.
 */
export function performanceFeeMinor(
  schedule: Pick<FeeScheduleValues, "performanceFeePercent">,
  profitMinor: bigint,
): bigint {
  if (profitMinor <= BigInt(0)) return BigInt(0);
  const basisPoints = percentToBasisPoints(schedule.performanceFeePercent);
  if (basisPoints === null || basisPoints <= BigInt(0)) return BigInt(0);
  return (profitMinor * basisPoints) / BigInt(10_000);
}

/** The key that makes one result's fee exactly-once. */
export function performanceFeeKey(resultId: string): string {
  return `strategy-result:${resultId}:fee`;
}

/** The key that makes one result's fee reversal exactly-once. */
export function performanceFeeReversalKey(resultId: string): string {
  return `strategy-result:${resultId}:fee-reversal`;
}

function outcome(
  posted: boolean,
  transactionId: string | null,
  feeMinor: bigint,
  decimals: number,
  refusal: Reason | null,
): FeeApplicationOutcome {
  const digits = feeMinor.toString();
  return {
    charged: posted,
    feeMinor: digits,
    feeDecimal: decimalFromMinor(feeMinor, decimals),
    transactionId,
    reason: refusal,
  };
}

function decimalFromMinor(value: bigint, decimals: number): string {
  const digits = value.toString();
  if (decimals === 0) return digits;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

export type ChargePerformanceFeeInput = {
  userId: string;
  asset: string;
  decimals: number;
  /** The action the fee belongs to: the strategy result's own id. */
  resultId: string;
  /** The result's profit in minor units. Zero or negative pays nothing. */
  profitMinor: MinorUnits | bigint;
  occurredAt: Date;
  /** The result's own label, for the memo — e.g. the strategy's name. */
  label?: string;
  lockWaitMs?: number;
  holder?: string;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Charge the platform's cut of a profitable result, as one balanced transaction.
 *
 * The balance is read under the account's own asset lock and the fee is refused when
 * the available balance cannot cover it — a fee that overdrew the account would be a
 * movement this ledger's invariants would have to explain. The lock is the same one a
 * withdrawal takes, so a fee and a withdrawal cannot both spend the last unit.
 */
export async function chargePerformanceFee(
  ledger: LedgerStore,
  schedule: Pick<FeeScheduleValues, "performanceFeePercent">,
  input: ChargePerformanceFeeInput,
): Promise<FeeApplicationOutcome> {
  const profit = typeof input.profitMinor === "bigint" ? input.profitMinor : BigInt(input.profitMinor);
  const feeMinor = performanceFeeMinor(schedule, profit);
  if (feeMinor === BigInt(0)) {
    return outcome(false, null, BigInt(0), input.decimals, null);
  }

  const locked = await withBalanceLock(
    ledger,
    {
      userId: input.userId,
      asset: input.asset,
      holder: input.holder ?? `fee:${input.resultId}`,
      now: input.occurredAt,
      ...(input.lockWaitMs !== undefined ? { waitMs: input.lockWaitMs } : {}),
      ...(input.sleep ? { sleep: input.sleep } : {}),
    },
    async () => {
      const available = await availableBalanceMinor(ledger, { userId: input.userId, asset: input.asset });
      if (available < feeMinor) {
        return {
          posted: false,
          transactionId: null,
          feeMinor,
          refusal: reason("INSUFFICIENT_BALANCE", {
            message:
              `The performance fee on ${input.resultId} is ${decimalFromMinor(feeMinor, input.decimals)} ${input.asset}, ` +
              `and the account can spend ${decimalFromMinor(available, input.decimals)} ${input.asset}, so no fee was charged and nothing was moved.`,
            detail: `available ${available.toString()} minor units`,
          }),
        };
      }

      const owner = await ensureUserBucketAccount(ledger, {
        userId: input.userId,
        asset: input.asset,
        decimals: input.decimals,
        bucket: "AVAILABLE",
      });
      const platform = await ensurePlatformAccounts(ledger, { asset: input.asset, decimals: input.decimals });
      const fees = platform.find((account) => account.bucket === feeBucket());
      if (!fees) throw new Error(`No fee account exists for ${input.asset}.`);

      const postings: LedgerPosting[] = [
        { accountId: owner.row.id, direction: "DEBIT", amountMinor: feeMinor },
        { accountId: fees.id, direction: "CREDIT", amountMinor: feeMinor },
      ];
      const posted = await postLedgerTransaction(ledger, {
        kind: "PERFORMANCE_FEE",
        idempotencyKey: performanceFeeKey(input.resultId),
        occurredAt: input.occurredAt,
        actorUserId: input.userId,
        sourceType: "StrategyResult",
        sourceId: input.resultId,
        memo:
          input.label !== undefined
            ? `Performance fee on ${input.label} (${input.resultId}): ${decimalFromMinor(profit, input.decimals)} ${input.asset} profit`
            : `Performance fee on ${input.resultId}`,
        postings,
      });
      return {
        posted: posted.posted,
        transactionId: posted.transactionId,
        feeMinor,
        refusal: posted.reason,
      };
    },
  );

  if (!locked.ok) {
    return outcome(
      false,
      null,
      feeMinor,
      input.decimals,
      reason("ALREADY_RUNNING", {
        message: `Another balance decision for this account's ${input.asset} was in progress, so the fee on ${input.resultId} was not charged. Try again.`,
      }),
    );
  }
  return outcome(locked.value.posted, locked.value.transactionId, feeMinor, input.decimals, locked.value.refusal);
}

export type FeeReversalOutcome = {
  reversed: boolean;
  transactionId: string | null;
  reason: Reason | null;
};

/**
 * Give one charged fee back, as the compensating transaction its entries describe.
 *
 * The original is read from the book rather than reconstructed from the schedule: the
 * amounts that were actually posted are the amounts that are returned, even if the
 * table has changed since. A missing original is a refusal with the id named, because a
 * reversal that posted nothing must not report success.
 */
export async function reversePerformanceFee(
  ledger: LedgerStore,
  input: {
    resultId: string;
    originalTransactionId: string;
    occurredAt: Date;
    memo?: string;
  },
): Promise<FeeReversalOutcome> {
  const original = await ledger.findTransactionById(input.originalTransactionId);
  if (!original) {
    return {
      reversed: false,
      transactionId: null,
      reason: reason("LEDGER_POSTING_REFUSED", {
        message: `No ledger transaction ${input.originalTransactionId} exists, so the fee on ${input.resultId} was not reversed.`,
      }),
    };
  }
  const entries = await ledger.listEntriesForTransactions([original.id]);
  if (entries.length === 0) {
    return {
      reversed: false,
      transactionId: null,
      reason: reason("LEDGER_POSTING_REFUSED", {
        message: `Ledger transaction ${original.id} has no entries, so the fee on ${input.resultId} was not reversed.`,
      }),
    };
  }

  const posted = await postLedgerTransaction(ledger, {
    kind: "PERFORMANCE_FEE",
    idempotencyKey: performanceFeeReversalKey(input.resultId),
    occurredAt: input.occurredAt,
    actorUserId: original.actorUserId,
    sourceType: "StrategyResult",
    sourceId: input.resultId,
    reversesTransactionId: original.id,
    memo: input.memo ?? `Reverse the performance fee on ${input.resultId}`,
    postings: reversingPostings(entries),
  });
  return { reversed: posted.posted, transactionId: posted.transactionId, reason: posted.reason };
}

/**
 * The platform's fee revenue for one asset, derived from the entries.
 *
 * Not used by a screen yet — the period report reads the owner's own statement — but it
 * is the reconciliation figure a later admin panel asks for, and it is one line because
 * the bucket is one account. Exported so "the fee account holds what the fees posted"
 * can be asserted rather than assumed.
 */
export async function platformFeeBalanceMinor(
  ledger: LedgerStore,
  input: { asset: string; decimals: number },
): Promise<bigint> {
  const accounts: LedgerAccountRow[] = await ensurePlatformAccounts(ledger, { asset: input.asset, decimals: input.decimals });
  const fees = accounts.find((account) => account.bucket === feeBucket());
  if (!fees) throw new Error(`No fee account exists for ${input.asset}.`);
  const entries = await ledger.listEntriesForAccounts([fees.id]);
  return entries.reduce((total, { entry }) => {
    const amount = BigInt(entry.amountMinor);
    return total + (entry.direction === "CREDIT" ? amount : -amount);
  }, BigInt(0));
}
