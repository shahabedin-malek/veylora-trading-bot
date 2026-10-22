import { reason, type Reason } from "@/lib/observability/reason";
import type { LedgerStore } from "./store";
import {
  deriveBalances,
  ensureUserBucketAccount,
  ensurePlatformAccounts,
  feeBucket,
  treasuryBucket,
  withdrawalHoldBucket,
  type LedgerBucket,
} from "./accounts";
import {
  postLedgerTransaction,
  type LedgerPosting,
  type MinorUnits,
  type PostLedgerTransactionOutcome,
} from "./integer-cent-ledger";

/**
 * The three movements a withdrawal is made of, and the balance reads that decide
 * whether it may happen.
 *
 * A withdrawal touches the ledger four times and no more, and each one is a
 * balanced transaction with its own kind, so a statement, an audit and the
 * invariant check can all tell them apart without consulting the withdrawal row:
 *
 *   WITHDRAWAL_RESERVED  DEBIT  user:<id>:<asset>:available            (gross)
 *                        CREDIT user:<id>:<asset>:withdrawal-reserved  (gross)
 *
 *   WITHDRAWAL_RELEASED  DEBIT  user:<id>:<asset>:withdrawal-reserved  (gross)
 *                        CREDIT user:<id>:<asset>:available            (gross)
 *
 *   WITHDRAWAL_SETTLED   DEBIT  user:<id>:<asset>:withdrawal-reserved  (gross)
 *                        CREDIT platform:treasury:<asset>              (net)
 *                        CREDIT platform:fees:<asset>                  (fee)
 *
 * **The reservation is the whole of "two requests cannot spend the same balance".**
 * It is not a pending flag on a balance row — there is no balance row — it is a
 * movement that has already happened: the money leaves `AVAILABLE` the instant the
 * owner asks. A second request reads the reduced balance and is refused, and a
 * reader of any single account still sees an amount that is owed to somebody. The
 * gross amount is what is held, because the fee is the platform's cut of *this*
 * transfer: releasing or settling the gross and taking the fee out at settlement
 * is what keeps the hold equal to what the owner authorised in both directions.
 *
 * **A settlement cannot keep a fee without the transfer.** The fee leg is written
 * in the same transaction as the net leg, so \"revenue the platform has kept\" and
 * \"money that left the treasury\" can never disagree — which is the only reason a
 * revenue figure in this book is worth reading.
 *
 * **Releasing is the same movement backwards, not a deletion.** A failed, cancelled
 * or expired withdrawal posts `WITHDRAWAL_RELEASED` and stops. Nothing is edited
 * and nothing is removed, so \"the owner asked for this and got it back\" stays
 * answerable from the book alone.
 *
 * The keys are derived from the withdrawal's id (`withdrawal:<id>:reserve` and
 * friends) rather than minted per attempt, which is what makes each movement
 * exactly-once under a retry, a second runner and two concurrent requests: the key
 * *is* the claim, exactly as it is for a deposit's credit.
 */

/** The key that makes one withdrawal's reservation exactly-once. */
export function withdrawalReservationKey(withdrawalId: string): string {
  return `withdrawal:${withdrawalId}:reserve`;
}

/** The key that makes one withdrawal's release exactly-once. */
export function withdrawalReleaseKey(withdrawalId: string): string {
  return `withdrawal:${withdrawalId}:release`;
}

/** The key that makes one withdrawal's settlement exactly-once. */
export function withdrawalSettlementKey(withdrawalId: string): string {
  return `withdrawal:${withdrawalId}:settle`;
}

export type WithdrawalMovementOutcome = {
  posted: boolean;
  transactionId: string | null;
  /** Why the movement was not posted, when it was not. Null when it was. */
  reason: Reason | null;
};

function movementOutcome(outcome: PostLedgerTransactionOutcome): WithdrawalMovementOutcome {
  return { posted: outcome.posted, transactionId: outcome.transactionId, reason: outcome.reason };
}

export type WithdrawalMovementInput = {
  withdrawalId: string;
  userId: string;
  asset: string;
  decimals: number;
  /** The gross amount: what the owner authorised, and what the hold is for. */
  amountMinor: MinorUnits;
  occurredAt: Date;
  network: string;
  /** The wallet the money is going to, for the memo. Never a secret. */
  destination: string;
  memo?: string;
};

/**
 * Hold the amount: out of what the owner can spend, still owed to them.
 *
 * The accounts are issued on the same client the posting uses, so the first
 * withdrawal an account ever asks for creates the hold account and the platform
 * counterparties in the transaction that moves the money into them. A failed
 * posting throws rather than returning, because its caller is inside a database
 * transaction that must not commit a reservation that did not happen.
 */
export async function reserveWithdrawal(
  ledger: LedgerStore,
  input: WithdrawalMovementInput,
): Promise<WithdrawalMovementOutcome> {
  const available = await ensureUserBucketAccount(ledger, {
    userId: input.userId,
    asset: input.asset,
    decimals: input.decimals,
    bucket: "AVAILABLE",
  });
  const hold = await ensureUserBucketAccount(ledger, {
    userId: input.userId,
    asset: input.asset,
    decimals: input.decimals,
    bucket: withdrawalHoldBucket(),
  });

  const outcome = await postLedgerTransaction(ledger, {
    kind: "WITHDRAWAL_RESERVED",
    idempotencyKey: withdrawalReservationKey(input.withdrawalId),
    occurredAt: input.occurredAt,
    actorUserId: input.userId,
    sourceType: "Withdrawal",
    sourceId: input.withdrawalId,
    memo: input.memo ?? `Reserve ${input.asset} for a withdrawal to ${input.destination} on ${input.network}`,
    postings: [
      { accountId: available.row.id, direction: "DEBIT", amountMinor: input.amountMinor },
      { accountId: hold.row.id, direction: "CREDIT", amountMinor: input.amountMinor },
    ],
  });
  return movementOutcome(outcome);
}

/**
 * Give the amount back, because the withdrawal did not happen.
 *
 * The legs are the reservation's with each direction flipped, written as a *new*
 * transaction rather than by touching the original. That is the same compensating
 * shape a reorged deposit's reversal uses, and for the same reason: the book has to
 * be able to answer what was believed and when.
 */
export async function releaseWithdrawal(
  ledger: LedgerStore,
  input: WithdrawalMovementInput,
): Promise<WithdrawalMovementOutcome> {
  const available = await ensureUserBucketAccount(ledger, {
    userId: input.userId,
    asset: input.asset,
    decimals: input.decimals,
    bucket: "AVAILABLE",
  });
  const hold = await ensureUserBucketAccount(ledger, {
    userId: input.userId,
    asset: input.asset,
    decimals: input.decimals,
    bucket: withdrawalHoldBucket(),
  });

  const outcome = await postLedgerTransaction(ledger, {
    kind: "WITHDRAWAL_RELEASED",
    idempotencyKey: withdrawalReleaseKey(input.withdrawalId),
    occurredAt: input.occurredAt,
    actorUserId: input.userId,
    sourceType: "Withdrawal",
    sourceId: input.withdrawalId,
    memo: input.memo ?? `Release the reserve for withdrawal ${input.withdrawalId}`,
    postings: [
      { accountId: hold.row.id, direction: "DEBIT", amountMinor: input.amountMinor },
      { accountId: available.row.id, direction: "CREDIT", amountMinor: input.amountMinor },
    ],
  });
  return movementOutcome(outcome);
}

export type SettleWithdrawalInput = WithdrawalMovementInput & {
  /** What the chain actually sent, at the asset's scale. */
  netMinor: MinorUnits;
  /** The platform's cut of this transfer. Zero is a legitimate fee. */
  feeMinor: MinorUnits;
  /** The transaction hash the settlement is for, for the memo. */
  txHash: string;
};

/**
 * The money is gone: discharge the hold, reduce what the platform holds, keep the fee.
 *
 * `feasible` is checked rather than assumed. If the gross is not the net plus the
 * fee, the movement would not balance and the writer would refuse it as
 * `NOT_BALANCED` — a refusal that arrives as an exception from three layers down
 * instead of a sentence about a withdrawal. So the arithmetic is verified here
 * first, against the same bigints the postings will be built from, and a
 * disagreement is reported as a refusal the caller can record on the row.
 */
export async function settleWithdrawal(
  ledger: LedgerStore,
  input: SettleWithdrawalInput,
): Promise<WithdrawalMovementOutcome> {
  const amount = BigInt(input.amountMinor);
  const net = BigInt(input.netMinor);
  const fee = BigInt(input.feeMinor);
  if (net + fee !== amount) {
    return {
      posted: false,
      transactionId: null,
      reason: reason("LEDGER_POSTING_REFUSED", {
        message:
          `Withdrawal ${input.withdrawalId} would settle ${net.toString()} net plus ${fee.toString()} fee ` +
          `${input.asset} minor units against a hold of ${amount.toString()}, so the movement would not balance and was refused.`,
      }),
    };
  }

  const hold = await ensureUserBucketAccount(ledger, {
    userId: input.userId,
    asset: input.asset,
    decimals: input.decimals,
    bucket: withdrawalHoldBucket(),
  });
  const platform = await ensurePlatformAccounts(ledger, { asset: input.asset, decimals: input.decimals });
  const treasury = platform.find((account) => account.bucket === treasuryBucket());
  if (!treasury) throw new Error(`No treasury account exists for ${input.asset}.`);
  const fees = platform.find((account) => account.bucket === feeBucket());
  if (!fees) throw new Error(`No fee account exists for ${input.asset}.`);

  // A zero fee is a legitimate configuration and a zero posting is not a posting,
  // so the fee leg is written only when there is a fee to keep.
  const postings: LedgerPosting[] = [
    { accountId: hold.row.id, direction: "DEBIT", amountMinor: input.amountMinor },
    { accountId: treasury.id, direction: "CREDIT", amountMinor: input.netMinor },
  ];
  if (fee > BigInt(0)) postings.push({ accountId: fees.id, direction: "CREDIT", amountMinor: input.feeMinor });

  const outcome = await postLedgerTransaction(ledger, {
    kind: "WITHDRAWAL_SETTLED",
    idempotencyKey: withdrawalSettlementKey(input.withdrawalId),
    occurredAt: input.occurredAt,
    actorUserId: input.userId,
    sourceType: "Withdrawal",
    sourceId: input.withdrawalId,
    memo: input.memo ?? `Settle withdrawal ${input.withdrawalId}: ${input.txHash} sent ${input.destination}`,
    postings,
  });
  return movementOutcome(outcome);
}

/**
 * What one account holds in one asset, per bucket, at the asset's scale.
 *
 * Derived from the entries, never stored, and derived through the same function the
 * balance panel and the invariant check use — so the figure a withdrawal is judged
 * against is the figure the owner is shown, not a second computation that happens
 * to agree today.
 */
export async function userAssetBalances(
  ledger: LedgerStore,
  input: { userId: string; asset: string },
): Promise<Map<LedgerBucket, { minor: bigint; accountId: string; decimals: number }>> {
  const accounts = (await ledger.listAccountsForUser(input.userId)).filter((account) => account.asset === input.asset);
  const result = new Map<LedgerBucket, { minor: bigint; accountId: string; decimals: number }>();
  if (accounts.length === 0) return result;

  const entries = await ledger.listEntriesForAccounts(accounts.map((account) => account.id));
  const balances = deriveBalances({ accounts, entries: entries.map((row) => row.entry) });
  for (const balance of balances) {
    result.set(balance.bucket, { minor: balance.balanceMinor, accountId: balance.accountId, decimals: balance.decimals });
  }
  return result;
}

/** What this account can spend right now, in minor units. Zero when nothing is held. */
export async function availableBalanceMinor(ledger: LedgerStore, input: { userId: string; asset: string }): Promise<bigint> {
  const balances = await userAssetBalances(ledger, input);
  return balances.get("AVAILABLE")?.minor ?? BigInt(0);
}

/** What this account has in flight to wallets, in minor units. */
export async function heldBalanceMinor(ledger: LedgerStore, input: { userId: string; asset: string }): Promise<bigint> {
  const balances = await userAssetBalances(ledger, input);
  return balances.get(withdrawalHoldBucket())?.minor ?? BigInt(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// A mutex around one account's one asset, for the length of one decision.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long a balance decision may hold the lock before another attempt may take it.
 *
 * Not a timeout on the work itself: it is the window after which a lock whose holder
 * was killed mid-decision stops blocking the account. Thirty seconds is far longer
 * than one decision takes (two reads and one insert) and far shorter than an owner's
 * patience.
 */
export const BALANCE_LOCK_TTL_MS = 30_000;

/**
 * How long a second attempt waits for the first to finish before giving up.
 *
 * This is the difference between the two interesting answers. An attempt that waits
 * and then reads the *reduced* balance is refused with the honest sentence — it spent
 * more than the account has left — while an attempt that gave up immediately would
 * report a busy lock, which tells the owner nothing about their money. The wait is
 * bounded; past it the refusal is the busy lock, because after five seconds of an
 * account being locked by a live decision a new request is the wrong thing to accept.
 */
export const BALANCE_LOCK_WAIT_MS = 5_000;

/** The lock on one account's one asset. Per account and per asset, never per user alone. */
export function userBalanceLockKey(userId: string, asset: string): string {
  return `balance:${userId}:${asset}`;
}

export type BalanceLockOutcome<T> =
  | { ok: true; holder: string; release: () => Promise<void>; value: T }
  | { ok: false; holder: string | null };

/**
 * Run one decision about an account's balance under the account's lock.
 *
 * The lock is taken *outside* the transaction that follows, on purpose. A lock row
 * written inside a transaction is invisible to another attempt until that transaction
 * commits, and a waiter that polls inside its own open transaction would hold a
 * database transaction open for the length of the wait — which is how a mutex turns
 * into a lock convoy. Taking it in its own statement means:
 *
 *   1. an attempt that loses *waits* for the winner rather than failing, so the second
 *      of two overlapping requests is judged against the already-reserved balance and
 *      is refused on insufficient balance rather than on a busy lock;
 *   2. the transaction that follows is short;
 *   3. a lock left behind by a process that died is reclaimed when its TTL passes,
 *      which is what the expiry is for — the unique key is the concurrency guarantee,
 *      and the expiry is the recovery path.
 *
 * `holder` is fresh per attempt, so the lock is not reentrant for anyone else; the
 * store deliberately lets a holder extend its own row, which is what makes a nested
 * call inside one attempt safe. The release is scoped to the holder, so an attempt
 * that lost can never delete the winner's row on its way out.
 */
export async function withBalanceLock<T>(
  ledger: LedgerStore,
  input: {
    userId: string;
    asset: string;
    holder: string;
    now: Date;
    ttlMs?: number;
    waitMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
  work: () => Promise<T>,
): Promise<BalanceLockOutcome<T>> {
  const key = userBalanceLockKey(input.userId, input.asset);
  const ttlMs = input.ttlMs ?? BALANCE_LOCK_TTL_MS;
  const waitMs = input.waitMs ?? BALANCE_LOCK_WAIT_MS;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // A small, fixed poll rather than an exponential backoff: the wait is bounded by
  // seconds, the contended path is two requests from one owner, and a long backoff
  // would make the second request slow for no benefit. The wait is counted in
  // attempts rather than read off the wall clock, so an injected `now` in a test does
  // not change how many times the lock is tried.
  const pollMs = 25;
  const maxAttempts = Math.max(1, Math.ceil(waitMs / pollMs) + 1);

  for (let attemptNumber = 0; attemptNumber < maxAttempts; attemptNumber += 1) {
    const attempt = await ledger.acquireAccountLock({ key, holder: input.holder, ttlMs, now: input.now });
    if (attempt.acquired) {
      const release = async () => {
        await ledger.releaseAccountLock({ key, holder: input.holder });
      };
      try {
        return { ok: true, holder: input.holder, release, value: await work() };
      } finally {
        await release();
      }
    }
    if (attemptNumber < maxAttempts - 1) await sleep(pollMs);
    else return { ok: false, holder: attempt.holder };
  }
  return { ok: false, holder: null };
}
