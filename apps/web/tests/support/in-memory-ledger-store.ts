import type { NewLedgerAccount } from "@/lib/ledger/accounts";
import type {
  InsertedLedgerTransaction,
  LedgerAccountRow,
  LedgerEntryRow,
  LedgerTransactionRow,
  NewLedgerTransactionInput,
} from "@/lib/ledger/integer-cent-ledger";
import type {
  AcquireAccountLockInput,
  AcquireAccountLockOutcome,
  LedgerDateRange,
  LedgerEntryWithTransaction,
  LedgerStore,
} from "@/lib/ledger/store";

/**
 * A ledger store that keeps its rows in memory.
 *
 * It exists so the claims this phase is graded on can be tested without a
 * database, and each of them is a statement about *rows written*:
 *
 *  - **an unbalanced transaction is not a transaction** — `insertTransactionOnce`
 *    takes a whole transaction with its legs and stores them together, so a
 *    partial write is not representable;
 *  - **posting is exactly-once** — the idempotency key is unique here the way the
 *    migration makes it unique, and a duplicate insert reports `created: false`
 *    with the row that holds the key, exactly as Prisma does on a unique
 *    violation;
 *  - **an account is issued once** — the code is unique and the same
 *    "existing row wins" answer comes back.
 *
 * The bodies are deliberately awaited-free between the read and the write, for
 * the same reason the deposit store's are: a test that interleaves two writers
 * must behave like two writers, not like one with a slow disk.
 *
 * The account lock is implemented with the same rule the database enforces: one row
 * per key, the holder that already owns it may extend it, and an expired one can be
 * taken over. So a test that runs two reservations at once is testing the *policy*
 * and not this class's tolerance for being called twice — the store serialises exactly
 * the way the unique constraint makes the database serialise.
 */
export class InMemoryLedgerStore implements LedgerStore {
  readonly accounts: LedgerAccountRow[] = [];
  readonly transactions: LedgerTransactionRow[] = [];
  readonly entries: LedgerEntryRow[] = [];
  readonly locks = new Map<string, { holder: string; acquiredAt: Date; expiresAt: Date }>();
  /** When set, the next call into this store throws — for a transaction that never committed. */
  readonly failNextWrite = { value: false };
  private sequence = 0;

  accountByCode(code: string): LedgerAccountRow | null {
    return this.accounts.find((account) => account.code === code) ?? null;
  }

  entriesForAccount(accountId: string): LedgerEntryRow[] {
    return this.entries.filter((entry) => entry.accountId === accountId);
  }

  /** Remove a leg outright, so a test can plant the corruption the checks must catch. */
  corruptRemoveEntry(entryId: string): void {
    const index = this.entries.findIndex((entry) => entry.id === entryId);
    if (index >= 0) this.entries.splice(index, 1);
  }

  /** Break an amount, so a test can prove a stored value is validated on the way out. */
  corruptEntryAmount(entryId: string, amountMinor: string): void {
    const entry = this.entries.find((candidate) => candidate.id === entryId);
    if (entry) entry.amountMinor = amountMinor;
  }

  async findAccountById(id: string): Promise<LedgerAccountRow | null> {
    return this.accounts.find((account) => account.id === id) ?? null;
  }

  async findAccountByCode(code: string): Promise<LedgerAccountRow | null> {
    return this.accountByCode(code);
  }

  async insertAccountOnce(account: NewLedgerAccount): Promise<{ created: boolean; row: LedgerAccountRow }> {
    const existing = this.accountByCode(account.code);
    if (existing) return { created: false, row: { ...existing } };
    const created: LedgerAccountRow = {
      id: `ledger-account-${++this.sequence}`,
      code: account.code,
      ownerType: account.ownerType,
      bucket: account.bucket,
      asset: account.asset,
      decimals: account.decimals,
      userId: account.userId,
      creditLineMinor: account.creditLineMinor ?? null,
      createdAt: new Date(0),
    };
    this.accounts.push(created);
    return { created: true, row: { ...created } };
  }

  async listAccountsForUser(userId: string): Promise<LedgerAccountRow[]> {
    return this.accounts.filter((account) => account.userId === userId).map((account) => ({ ...account }));
  }

  async listAccounts(): Promise<LedgerAccountRow[]> {
    return this.accounts.map((account) => ({ ...account }));
  }

  async findTransactionById(id: string): Promise<LedgerTransactionRow | null> {
    return this.transactions.find((transaction) => transaction.id === id) ?? null;
  }

  async findTransactionByIdempotencyKey(key: string): Promise<LedgerTransactionRow | null> {
    return this.transactions.find((transaction) => transaction.idempotencyKey === key) ?? null;
  }

  async insertTransactionOnce(input: NewLedgerTransactionInput): Promise<InsertedLedgerTransaction> {
    if (this.failNextWrite.value) {
      this.failNextWrite.value = false;
      throw new Error("simulated storage failure");
    }
    const existing = this.transactions.find(
      (transaction) => transaction.idempotencyKey === input.transaction.idempotencyKey,
    );
    if (existing) return { created: false, row: { ...existing }, entryIds: [] };

    const created: LedgerTransactionRow = {
      ...input.transaction,
      id: `ledger-transaction-${++this.sequence}`,
      createdAt: new Date(0),
    };
    this.transactions.push(created);
    const entryIds: string[] = [];
    for (const entry of input.entries) {
      const written: LedgerEntryRow = {
        ...entry,
        id: `ledger-entry-${++this.sequence}`,
        transactionId: created.id,
        createdAt: created.occurredAt,
      };
      this.entries.push(written);
      entryIds.push(written.id);
    }
    return { created: true, row: { ...created }, entryIds };
  }

  async listEntriesForAccounts(
    accountIds: readonly string[],
    range?: LedgerDateRange,
  ): Promise<LedgerEntryWithTransaction[]> {
    const wanted = new Set(accountIds);
    return this.entries
      .filter((entry) => wanted.has(entry.accountId))
      .map((entry) => {
        const transaction = this.transactions.find((candidate) => candidate.id === entry.transactionId);
        return transaction ? { entry: { ...entry }, transaction: { ...transaction } } : null;
      })
      .filter((row): row is LedgerEntryWithTransaction => row !== null)
      .filter(({ transaction }) => !range || (transaction.occurredAt >= range.from && transaction.occurredAt <= range.to))
      .sort(
        (left, right) =>
          left.transaction.occurredAt.getTime() - right.transaction.occurredAt.getTime() ||
          left.entry.sequence - right.entry.sequence,
      );
  }

  async listEntriesForTransactions(transactionIds: readonly string[]): Promise<LedgerEntryRow[]> {
    const wanted = new Set(transactionIds);
    return this.entries
      .filter((entry) => wanted.has(entry.transactionId))
      .map((entry) => ({ ...entry }))
      .sort((left, right) => left.transactionId.localeCompare(right.transactionId) || left.sequence - right.sequence);
  }

  async listAllEntries(): Promise<LedgerEntryRow[]> {
    return this.entries.map((entry) => ({ ...entry }));
  }

  async listAllTransactions(): Promise<LedgerTransactionRow[]> {
    return this.transactions.map((transaction) => ({ ...transaction }));
  }

  async acquireAccountLock(input: AcquireAccountLockInput): Promise<AcquireAccountLockOutcome> {
    const expiresAt = new Date(input.now.getTime() + input.ttlMs);
    const existing = this.locks.get(input.key);
    if (existing && existing.holder === input.holder) {
      this.locks.set(input.key, { holder: input.holder, acquiredAt: input.now, expiresAt });
      return { acquired: true, holder: input.holder, expiresAt };
    }
    if (existing && existing.expiresAt.getTime() > input.now.getTime()) {
      return { acquired: false, holder: existing.holder, expiresAt: existing.expiresAt };
    }
    // Free, or expired and therefore free to take over. The unique key is what makes
    // this a decision rather than a check: one map entry, one holder.
    this.locks.set(input.key, { holder: input.holder, acquiredAt: input.now, expiresAt });
    return { acquired: true, holder: input.holder, expiresAt };
  }

  async releaseAccountLock(input: { key: string; holder: string }): Promise<void> {
    const existing = this.locks.get(input.key);
    if (existing && existing.holder !== input.holder) return;
    this.locks.delete(input.key);
  }

  async transaction<T>(work: (store: LedgerStore) => Promise<T>): Promise<T> {
    return work(this);
  }
}
