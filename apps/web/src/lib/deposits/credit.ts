import DecimalJS from "decimal.js";
import { ensurePlatformAccounts, ensureUserAccount } from "@/lib/ledger/accounts";
import {
  LedgerAmountError,
  minorUnitsFromDecimalString,
  postLedgerTransaction,
  reversingPostings,
  type MinorUnits,
} from "@/lib/ledger/integer-cent-ledger";
import type { LedgerStore } from "@/lib/ledger/store";
import { reason, serializeReason, type Reason } from "@/lib/observability/reason";
import type { DepositNetworkPolicy } from "./policy";
import type { DepositRow, DepositStore } from "./store";

const Decimal = DecimalJS.clone({ precision: 80 });

/**
 * Crediting: the one transition that makes an arrival money, and the seam between
 * the two phases that share it.
 *
 * It happens exactly once per transfer, only after the confirmation count the
 * owner configured for that network, and it is claimed rather than assigned: the
 * row is moved out of PENDING with a conditional update, and the audit event is
 * written in the same transaction. Two watchers running at once therefore produce
 * one credit and one audit row, not two of each — the same compare-and-set shape
 * the orders lifecycle uses for the same reason.
 *
 * Phase 13 changes *what a credit is*. It is no longer only a durable record that
 * the money arrived: it is a **balanced movement in the ledger of record**, posted
 * in the same database transaction as the claim —
 *
 *   DEBIT  platform:treasury:<asset>            the platform holds the funds
 *   CREDIT user:<userId>:<asset>:available      the account is owed them
 *
 * — so a deposit cannot be credited without a movement that explains it, and the
 * balance the balance panel shows is the sum of those movements. The idempotency
 * key is the deposit's own (`deposit:<id>:credit`), which makes the pair of
 * writes exactly-once under retries, re-read block ranges and a second runner.
 *
 * One case is refused rather than credited, and it is refused *loudly on the row*:
 * a transfer whose human amount and raw amount are not the same value at the
 * token's scale (`"10.5"` and `"10500000"` at 6 decimals) cannot become exact
 * money, so it stays PENDING with that reason attached and an audit event saying
 * so — and the watcher moves on to the next pending transfer instead of blocking
 * the ones behind it. That state does not occur for rows this code writes: both
 * values are derived from the same integer.
 */

export type CreditOutcome = {
  credited: boolean;
  confirmations: number;
  /** The ledger movement the credit became, when it became one. */
  ledgerTransactionId: string | null;
  /** Why it did not become money, when it did not. Null while it is simply early. */
  refusal: Reason | null;
};

/** The key that makes one deposit's credit exactly-once. */
export function depositCreditIdempotencyKey(depositId: string): string {
  return `deposit:${depositId}:credit`;
}

/** The key that makes one deposit's reversal exactly-once. */
export function depositReversalIdempotencyKey(depositId: string): string {
  return `deposit:${depositId}:reversal`;
}

/**
 * The exact amount a deposit row is for, or a refusal naming both values.
 *
 * This is the door between "a transfer the watcher recorded" and "an exact count
 * of minor units the ledger may post". It re-derives the amount from the row's
 * own raw value and compares, rather than trusting either field: a row whose two
 * amounts disagree is corruption, and corruption must not become money.
 */
export function depositAmountMinor(row: Pick<DepositRow, "amount" | "rawAmount" | "decimals" | "tokenSymbol">): MinorUnits {
  const raw = row.rawAmount.trim();
  let derived: MinorUnits;
  try {
    derived = minorUnitsFromDecimalString(row.amount, row.decimals);
  } catch (error) {
    if (error instanceof LedgerAmountError) {
      throw new Error(
        `The transfer's amount ${JSON.stringify(row.amount)} cannot be read as an exact amount of ${row.tokenSymbol} ` +
          `at ${row.decimals} decimals (${error.code}), so it cannot be credited.`,
      );
    }
    throw error;
  }
  if (derived !== raw) {
    throw new Error(
      `The transfer's amount ${JSON.stringify(row.amount)} at ${row.decimals} decimals is ${derived} minor units of ` +
        `${row.tokenSymbol}, and its raw amount is ${raw}; the two disagree, so it cannot be credited.`,
    );
  }
  return derived;
}

export async function creditDeposit(input: {
  store: DepositStore;
  policy: DepositNetworkPolicy;
  row: DepositRow;
  confirmations: number;
  now: Date;
}): Promise<CreditOutcome> {
  const { store, policy, row, now } = input;
  const early: CreditOutcome = { credited: false, confirmations: input.confirmations, ledgerTransactionId: null, refusal: null };
  if (input.confirmations < policy.confirmations) return early;
  if (!row.userId) {
    // A row with no account is not money to anybody. It is recorded as a refusal
    // rather than credited to the account that happens to exist.
    return {
      ...early,
      refusal: reason("UNKNOWN_RECIPIENT", {
        message: `The transfer ${row.txHash} was not attributed to an account, so there is nobody to credit.`,
      }),
    };
  }

  let amountMinor: MinorUnits;
  try {
    amountMinor = depositAmountMinor(row);
  } catch (error) {
    const refusal = reason("LEDGER_POSTING_REFUSED", {
      message: error instanceof Error ? error.message : "The transfer's amount could not be read exactly.",
    });
    // The refusal is written to the row and the audit trail in one transaction,
    // and the row stays PENDING: nothing was credited, and the reason is where a
    // surface reading the row will find it.
    await store.transaction(async (transaction) => {
      await transaction.updateDeposit(row.id, {
        reasonCode: refusal.code,
        reasonMessage: refusal.message,
        lastCheckedAt: now,
      });
      await transaction.recordAudit({
        actorUserId: row.userId,
        action: "DEPOSIT_CREDIT_REFUSED",
        objectType: "Deposit",
        objectId: row.id,
        outcome: "REFUSED",
        payload: {
          network: row.network,
          txHash: row.txHash,
          logIndex: row.logIndex,
          amount: row.amount,
          rawAmount: row.rawAmount,
          decimals: row.decimals,
          tokenSymbol: row.tokenSymbol,
          reason: serializeReason(refusal),
        },
      });
    });
    return { ...early, refusal };
  }

  const credited = await store.transaction(async (transaction) => {
    const claimed = await transaction.claimDeposit(row.id, "PENDING", {
      status: "CREDITED",
      confirmations: input.confirmations,
      creditedAt: now,
      lastCheckedAt: now,
      reasonCode: null,
      reasonMessage: null,
    });
    if (!claimed) return null;

    const posted = await postDepositCredit(transaction.ledger(), {
      depositId: row.id,
      userId: row.userId as string,
      asset: row.tokenSymbol,
      decimals: row.decimals,
      amountMinor,
      occurredAt: now,
      network: row.network,
      txHash: row.txHash,
      logIndex: row.logIndex,
    });
    if (!posted.posted) {
      // Unreachable by construction: the key is the deposit's own and it is
      // created here. If it does happen, the claim is rolled back with it rather
      // than leaving a credited deposit whose movement already existed.
      throw new Error(`The ledger refused to post the credit for deposit ${row.id}: ${posted.reason?.message ?? "no reason"}`);
    }

    await transaction.recordAudit({
      actorUserId: row.userId,
      action: "DEPOSIT_CREDITED",
      objectType: "Deposit",
      objectId: row.id,
      outcome: "SUCCESS",
      payload: {
        network: row.network,
        chainId: row.chainId,
        txHash: row.txHash,
        logIndex: row.logIndex,
        blockNumber: row.blockNumber,
        blockHash: row.blockHash,
        tokenSymbol: row.tokenSymbol,
        tokenAddress: row.tokenAddress,
        amount: row.amount,
        rawAmount: row.rawAmount,
        decimals: row.decimals,
        amountMinor,
        confirmations: input.confirmations,
        confirmationsRequired: policy.confirmations,
        creditedAt: now.toISOString(),
        // The ledger movement this credit *is*, so the audit trail and the book
        // can be tied together from either end.
        ledgerTransactionId: posted.transactionId,
        ledgerTransactionKey: depositCreditIdempotencyKey(row.id),
        // The evidence the credit was decided from, kept with the decision.
        evidence: safeParse(row.evidenceJson),
      },
    });
    return posted.transactionId;
  });

  return { credited: credited !== null, confirmations: input.confirmations, ledgerTransactionId: credited, refusal: null };
}

/**
 * Post one credited deposit as a balanced movement: treasury debited, the account
 * credited.
 *
 * The accounts are issued here rather than assumed, on the same client the posting
 * uses, so the first deposit an account ever receives creates its account and the
 * platform counterparties in the same transaction that moves the money into them.
 */
export async function postDepositCredit(
  ledger: LedgerStore,
  input: {
    depositId: string;
    userId: string;
    asset: string;
    decimals: number;
    amountMinor: MinorUnits;
    occurredAt: Date;
    network: string;
    txHash: string;
    logIndex: number;
  },
): Promise<{ posted: boolean; transactionId: string | null; reason: Reason | null }> {
  const user = await ensureUserAccount(ledger, { userId: input.userId, asset: input.asset, decimals: input.decimals });
  const platform = await ensurePlatformAccounts(ledger, { asset: input.asset, decimals: input.decimals });
  const treasury = platform.find((account) => account.bucket === "TREASURY");
  if (!treasury) throw new Error(`No treasury account exists for ${input.asset}.`);

  const outcome = await postLedgerTransaction(ledger, {
    kind: "DEPOSIT_CREDITED",
    idempotencyKey: depositCreditIdempotencyKey(input.depositId),
    occurredAt: input.occurredAt,
    actorUserId: input.userId,
    sourceType: "Deposit",
    sourceId: input.depositId,
    memo: `${input.asset} deposit ${input.txHash}#${input.logIndex} on ${input.network}`,
    postings: [
      { accountId: treasury.id, direction: "DEBIT", amountMinor: input.amountMinor },
      { accountId: user.row.id, direction: "CREDIT", amountMinor: input.amountMinor },
    ],
  });

  return {
    posted: outcome.posted,
    transactionId: outcome.transactionId,
    reason: outcome.reason,
  };
}

export type ReverseDepositOutcome = {
  reversed: boolean;
  transactionId: string | null;
  /** Why it was not reversed, when it was not. Null when it was. */
  reason: Reason | null;
};

/**
 * Un-credit a deposit by compensating it, never by editing it.
 *
 * The reversal is a new transaction whose legs are the credit's legs with each
 * direction flipped, and it names the credit it undoes. That is the whole
 * mechanism, and it is chosen over the alternatives on purpose: changing the
 * amount of a posted entry or deleting it would leave a book that cannot answer
 * "what did we believe, and when?" — and a reorg is exactly the situation where
 * that question gets asked.
 *
 * Two refusals are deliberate. A deposit with no credit has nothing to reverse,
 * and a deposit that has already been reversed is not reversed twice: a second
 * reversal would double the compensation and mint a negative balance out of a
 * bookkeeping mistake. A transfer that comes back after being reversed is a fresh
 * decision for the operator, not an automatic re-credit — the credit's key is
 * spent and says so.
 *
 * What is *not* automatic: a credited deposit whose block later disappears is not
 * un-credited by the watcher. Phase 12's watcher re-reads pending rows only, so
 * detecting that case needs a fresh read of the block a credited row's evidence
 * names, which is a reconciliation this phase does not implement. The operation
 * below is the mechanism it would call, and the operator has it now.
 */
export async function reverseDepositCredit(
  ledger: LedgerStore,
  input: { depositId: string; actorUserId: string; now: Date; memo?: string },
): Promise<ReverseDepositOutcome> {
  const reversalKey = depositReversalIdempotencyKey(input.depositId);
  const existingReversal = await ledger.findTransactionByIdempotencyKey(reversalKey);
  if (existingReversal) {
    return {
      reversed: false,
      transactionId: existingReversal.id,
      reason: reason("ALREADY_COMPLETED", {
        message: `The deposit ${input.depositId} was already reversed at ${existingReversal.occurredAt.toISOString()}, so it was not reversed again.`,
        detail: existingReversal.id,
      }),
    };
  }

  const credit = await ledger.findTransactionByIdempotencyKey(depositCreditIdempotencyKey(input.depositId));
  if (!credit) {
    return {
      reversed: false,
      transactionId: null,
      reason: reason("NO_ENTRY_CONDITION", {
        message: `The deposit ${input.depositId} was never credited, so there is no ledger movement to reverse.`,
      }),
    };
  }

  const entries = await ledger.listEntriesForTransactions([credit.id]);
  if (entries.length === 0) {
    return {
      reversed: false,
      transactionId: credit.id,
      reason: reason("NO_ENTRY_CONDITION", {
        message: `The credit for deposit ${input.depositId} has no entries, so there is nothing to compensate.`,
      }),
    };
  }

  const outcome = await postLedgerTransaction(ledger, {
    kind: "DEPOSIT_REVERSED",
    idempotencyKey: reversalKey,
    occurredAt: input.now,
    actorUserId: input.actorUserId,
    sourceType: "Deposit",
    sourceId: input.depositId,
    memo: input.memo ?? `Reversal of deposit ${input.depositId}`,
    reversesTransactionId: credit.id,
    postings: reversingPostings(entries),
  });

  return outcome.posted
    ? { reversed: true, transactionId: outcome.transactionId, reason: null }
    : {
        reversed: false,
        transactionId: outcome.transactionId,
        reason: outcome.reason ?? reason("ALREADY_COMPLETED", { message: "This reversal was already posted." }),
      };
}

/**
 * Reverse one deposit on behalf of the account that owns it, with the audit trail.
 *
 * The row is looked up among the deposits the account can see, so the id in a
 * request is never an authorization: an account cannot reverse a movement it
 * cannot read. The ledger reversal and the audit event are written together, so
 * the record of "who asked for this and why" cannot be missing from a reversal
 * that exists.
 */
export async function reverseDepositForUser(input: {
  userId: string;
  depositId: string;
  store: DepositStore;
  now: Date;
  memo?: string;
  limit?: number;
}): Promise<ReverseDepositOutcome & { deposit: DepositRow | null }> {
  const { store, now } = input;
  const visible = await store.listDepositsForUser(input.userId, input.limit ?? 50);
  const row = visible.find((candidate) => candidate.id === input.depositId) ?? null;
  if (!row) {
    return {
      reversed: false,
      transactionId: null,
      deposit: null,
      reason: reason("NOT_PERMITTED", {
        message: `No deposit ${input.depositId} is visible to this account, so it was not touched.`,
      }),
    };
  }

  const outcome = await reverseDepositCredit(store.ledger(), {
    depositId: row.id,
    actorUserId: input.userId,
    now,
    ...(input.memo ? { memo: input.memo } : {}),
  });

  await store.transaction(async (transaction) => {
    await transaction.recordAudit({
      actorUserId: input.userId,
      action: outcome.reversed ? "DEPOSIT_REVERSED" : "DEPOSIT_REVERSAL_REFUSED",
      objectType: "Deposit",
      objectId: row.id,
      outcome: outcome.reversed ? "SUCCESS" : "REFUSED",
      payload: {
        network: row.network,
        txHash: row.txHash,
        logIndex: row.logIndex,
        amount: row.amount,
        tokenSymbol: row.tokenSymbol,
        ledgerTransactionId: outcome.transactionId,
        reversesTransactionKey: depositCreditIdempotencyKey(row.id),
        reason: outcome.reason ? serializeReason(outcome.reason) : null,
        requestedAt: now.toISOString(),
      },
    });
  });

  return { ...outcome, deposit: row };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

export type CreditedTotal = { tokenSymbol: string; amount: string };

/**
 * What has actually been credited to an account, summed by token.
 *
 * Summed with decimals and rendered as a string: an amount of USDT is not a
 * floating-point number, and the panel that shows it must not round it into one.
 *
 * This is phase 12's running total of credited rows — the figure the *deposit*
 * panel shows. Since phase 13 it should agree with the ledger's own balance, and
 * the balance panel is where the ledger's answer lives; the two are separate
 * reads of separate tables on purpose, because a deposit surface that could only
 * render what the ledger says is a deposit surface that goes blank when the
 * ledger is unreadable.
 */
export function sumCreditedTotals(rows: readonly { tokenSymbol: string; amount: string }[]): CreditedTotal[] {
  const totals = new Map<string, DecimalJS>();
  for (const row of rows) {
    let amount: DecimalJS;
    try {
      amount = new Decimal(row.amount);
    } catch {
      continue;
    }
    if (!amount.isFinite()) continue;
    totals.set(row.tokenSymbol, (totals.get(row.tokenSymbol) ?? new Decimal(0)).plus(amount));
  }
  return [...totals.entries()]
    .map(([tokenSymbol, amount]) => ({ tokenSymbol, amount: amount.toFixed() }))
    .sort((left, right) => left.tokenSymbol.localeCompare(right.tokenSymbol));
}

export async function creditedTotalsForUser(store: DepositStore, userId: string): Promise<CreditedTotal[]> {
  return sumCreditedTotals(await store.listCreditedTotalsForUser(userId));
}

/**
 * Why a pending deposit has not become money yet, in the shared vocabulary, for a
 * surface that is describing rows rather than running a watcher.
 */
export function describeDepositWait(row: DepositRow, policy: DepositNetworkPolicy) {
  const remaining = Math.max(0, policy.confirmations - row.confirmations);
  return reason("AWAITING_CONFIRMATIONS", {
    message:
      remaining === 0
        ? `The transfer of ${row.amount} ${row.tokenSymbol} has ${row.confirmations} confirmation(s) of the ${policy.confirmations} required; the next watcher run credits it.`
        : `The transfer of ${row.amount} ${row.tokenSymbol} has ${row.confirmations} of ${policy.confirmations} confirmation(s); ${remaining} more before it is credited.`,
    detail: `block ${row.blockNumber}`,
  });
}

export { serializeReason };
