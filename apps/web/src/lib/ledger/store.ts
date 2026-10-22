import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isLedgerBucket, isLedgerOwnerType, type AccountEntryTotals, type LedgerAccountStore, type NewLedgerAccount } from "./accounts";
import {
  isMoneyDirection,
  type InsertedLedgerTransaction,
  type LedgerAccountRow,
  type LedgerEntryRow,
  type LedgerTransactionRow,
  type LedgerTransactionStore,
  type MoneyDirection,
  type NewLedgerTransactionInput,
} from "./integer-cent-ledger";

/**
 * The database half of the ledger of record.
 *
 * Everything above this file — balancing, derivation, statements, invariants —
 * is written against the interfaces below rather than against Prisma, which is
 * what lets the whole ledger be exercised in a test against an in-memory store
 * instead of a database. This file is deliberately thin and mechanical: it knows
 * the rows, it enforces the unique keys the migration enforces, and it validates
 * the two state columns a row carries (`ownerType`, `bucket`, `direction`), so a
 * value this build does not understand is refused on the way out instead of being
 * rendered or summed.
 *
 * One design note that is not incidental: **the insert of a transaction and its
 * entries is one call and one database transaction.** A transaction row is never
 * observable without the legs that make it balanced, so "every stored movement
 * balances" is a property of the data rather than a hope about the writer. The
 * caller may wrap a wider unit of work around it (`transaction`, which is what
 * the deposit credit does), but it cannot narrow this one.
 */

const ACCOUNT_SELECTION = {
  id: true,
  code: true,
  ownerType: true,
  bucket: true,
  asset: true,
  decimals: true,
  userId: true,
  creditLineMinor: true,
  createdAt: true,
} as const;

const TRANSACTION_SELECTION = {
  id: true,
  kind: true,
  idempotencyKey: true,
  actorUserId: true,
  sourceType: true,
  sourceId: true,
  memo: true,
  occurredAt: true,
  createdAt: true,
  reversesTransactionId: true,
} as const;

const ENTRY_SELECTION = {
  id: true,
  transactionId: true,
  accountId: true,
  asset: true,
  direction: true,
  amountMinor: true,
  decimals: true,
  sequence: true,
  createdAt: true,
} as const;

type AccountRecord = Omit<LedgerAccountRow, "ownerType" | "bucket"> & { ownerType: string; bucket: string };
type EntryRecord = Omit<LedgerEntryRow, "direction"> & { direction: string };
type EntryWithTransactionRecord = EntryRecord & { transaction: LedgerTransactionRow };

export type LedgerDateRange = { from: Date; to: Date };

export type LedgerEntryWithTransaction = {
  entry: LedgerEntryRow;
  transaction: LedgerTransactionRow;
};

/**
 * The whole ledger surface: the two interfaces the writer and the account layer
 * need, plus the reads a statement and an invariant check are made of.
 *
 * The reads are all "load the rows, decide in code". Sums are never taken in SQL:
 * a `SUM` over a text column is a float on one engine and a numeric on another,
 * and the entire point of this ledger is that a figure is the same number
 * everywhere it is computed. Deriving in the process also means the in-memory
 * store a test uses and the database the deployment uses run through the same
 * arithmetic.
 */
export type LedgerStore = LedgerAccountStore &
  LedgerTransactionStore & {
    listEntriesForAccounts(accountIds: readonly string[], range?: LedgerDateRange): Promise<LedgerEntryWithTransaction[]>;
    /**
     * The same entries, one bounded page at a time.
     *
     * A statement over a year of history is a fold, not an array: this is the
     * primitive that lets the read hold one page and a running total instead of
     * every entry. The order is by id — it is a *complete* iteration, not a
     * chronological one, because the caller that needs display order asks for the
     * newest page explicitly.
     *
     * Optional on the interface so an in-memory test store can keep its array
     * reads; the database store is the one that has a reason to stream.
     */
    iterateEntriesForAccounts?(
      accountIds: readonly string[],
      options?: { range?: LedgerDateRange; batchSize?: number },
    ): AsyncGenerator<LedgerEntryWithTransaction>;
    /**
     * Debits and credits per account, summed by the database.
     *
     * A balance is a fold, and folding 100,000 rows in the process to answer
     * "what is held" is the cost this method exists to remove: `SUM` over the
     * exact minor-unit column is the same addition, done where the data is. The
     * normal side is still applied in `balancesFromTotals`, so the aggregate and
     * the streamed fold produce the same balance by construction rather than by
     * two implementations agreeing.
     *
     * Optional so an in-memory test store keeps its array arithmetic.
     */
    sumEntriesByAccount?(
      accountIds: readonly string[],
      range?: LedgerDateRange,
    ): Promise<Map<string, AccountEntryTotals>>;
    /** The newest lines of a range, for a statement page. */
    listLatestEntriesForAccounts?(
      accountIds: readonly string[],
      range: LedgerDateRange,
      limit: number,
    ): Promise<LedgerEntryWithTransaction[]>;
    /**
     * The range in statement order, a page at a time, continuing from where the
     * last page stopped.
     *
     * Offset paging is what this replaced: the hundredth page of a year of history
     * still made the database walk the first ninety-nine, so the export took longer
     * the more it had already written. A cursor on (occurredAt, sequence, id) is the
     * same order without the re-reading.
     */
    iterateEntriesForAccountsChronological?(
      accountIds: readonly string[],
      range: LedgerDateRange,
      options?: { batchSize?: number },
    ): AsyncGenerator<LedgerEntryWithTransaction>;
    /** One chronological page of the range, for an export that streams rather than collects. */
    pageEntriesForAccounts?(
      accountIds: readonly string[],
      range: LedgerDateRange,
      page: { offset: number; limit: number },
    ): Promise<LedgerEntryWithTransaction[]>;
    listEntriesForTransactions(transactionIds: readonly string[]): Promise<LedgerEntryRow[]>;
    /** Everything, for the invariant check. Exact rather than paged, on purpose. */
    listAllEntries(): Promise<LedgerEntryRow[]>;
    listAllTransactions(): Promise<LedgerTransactionRow[]>;
    /**
     * Take the mutex on one account, for the length of one transaction.
     *
     * A balance here is the sum of its entries, so there is no balance row to lock
     * and no `UPDATE ... WHERE balance >= amount` to lean on: two reservations that
     * each read the same available balance and then each insert their own entries
     * are individually valid and together spend the same money. The lock is the
     * row that makes them mutually exclusive — inserted before the read, released
     * before the transaction ends, unique on its key so only one holder can ever
     * have it. See {@link AcquireAccountLockInput} for why a holder may take its
     * own lock again and why an expired lock can be taken over.
     */
    acquireAccountLock(input: AcquireAccountLockInput): Promise<AcquireAccountLockOutcome>;
    releaseAccountLock(input: { key: string; holder: string }): Promise<void>;
    transaction<T>(work: (store: LedgerStore) => Promise<T>): Promise<T>;
  };

/**
 * Taking a lock for a bounded window, as the caller states it.
 *
 * `holder` identifies the *attempt*, not the account: a fresh value per attempt is
 * what makes the lock non-reentrant for everyone else. The one exception is stated
 * by the store rather than guessed at by the caller — a holder that already owns
 * the key may extend it, which is what lets the outer transaction re-acquire its
 * own lock after a nested pass without deadlocking against itself.
 *
 * `expiresAt` exists so a process killed mid-transaction cannot wedge an account
 * forever. It is not the concurrency mechanism — the unique key is. It is the
 * recovery path for a lock whose holder will never release it.
 */
export type AcquireAccountLockInput = { key: string; holder: string; ttlMs: number; now: Date };

export type AcquireAccountLockOutcome = {
  acquired: boolean;
  /** Who holds it when this attempt lost, so the refusal can name the state. */
  holder: string | null;
  expiresAt: Date | null;
};

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

function requireDirection(value: string): MoneyDirection {
  if (!isMoneyDirection(value)) throw new Error(`Stored ledger direction ${JSON.stringify(value)} is not DEBIT or CREDIT.`);
  return value;
}

/**
 * A bucket or owner type this build cannot read is a hard error, not a guess —
 * the same rule the deposit store applies to a status it does not know. The
 * taxonomy that decides what is valid lives in `accounts.ts`, so this check and
 * the one the account layer makes can never drift apart.
 */
function toAccountRow(record: AccountRecord): LedgerAccountRow {
  if (!isLedgerOwnerType(record.ownerType)) {
    throw new Error(`Stored ledger owner type ${JSON.stringify(record.ownerType)} is not one this build understands.`);
  }
  if (!isLedgerBucket(record.bucket)) {
    throw new Error(`Stored ledger bucket ${JSON.stringify(record.bucket)} is not one this build understands.`);
  }
  return { ...record, ownerType: record.ownerType, bucket: record.bucket };
}

function toEntryRow(record: EntryRecord): LedgerEntryRow {
  return { ...record, direction: requireDirection(record.direction) };
}

/**
 * `inTransaction` says the client handed in is already inside a database
 * transaction. Prisma refuses a nested `$transaction` on an interactive
 * transaction client, and rightly so — the work is already atomic — so the flag
 * turns the two wraps below into plain writes instead of a second begin. The
 * credit path is the caller that needs it: it opens one transaction over the
 * deposit claim and posts the ledger movement through the store built on that
 * same transaction client.
 */
export type LedgerStoreOptions = { inTransaction?: boolean };

export function createLedgerStore(client: PrismaClient = prisma, options: LedgerStoreOptions = {}): LedgerStore {
  const inTransaction = options.inTransaction === true;
  const store: LedgerStore = {
    async findAccountById(id) {
      const row = await client.ledgerAccount.findUnique({ where: { id }, select: ACCOUNT_SELECTION });
      return row ? toAccountRow(row) : null;
    },

    async findAccountByCode(code) {
      const row = await client.ledgerAccount.findUnique({ where: { code }, select: ACCOUNT_SELECTION });
      return row ? toAccountRow(row) : null;
    },

    async insertAccountOnce(account: NewLedgerAccount) {
      try {
        const created = await client.ledgerAccount.create({
          data: { ...account, creditLineMinor: account.creditLineMinor ?? null },
          select: ACCOUNT_SELECTION,
        });
        return { created: true, row: toAccountRow(created) };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Another writer issued this account between the lookup and the insert.
        // The row that owns the code is the answer, exactly as the issuance
        // contract says.
        const existing = await client.ledgerAccount.findUnique({ where: { code: account.code }, select: ACCOUNT_SELECTION });
        if (!existing) throw error;
        return { created: false, row: toAccountRow(existing) };
      }
    },

    async listAccountsForUser(userId) {
      const rows = await client.ledgerAccount.findMany({
        where: { userId },
        orderBy: [{ asset: "asc" }, { bucket: "asc" }],
        select: ACCOUNT_SELECTION,
      });
      return rows.map(toAccountRow);
    },

    async listAccounts() {
      const rows = await client.ledgerAccount.findMany({
        orderBy: [{ asset: "asc" }, { code: "asc" }],
        select: ACCOUNT_SELECTION,
      });
      return rows.map(toAccountRow);
    },

    async findTransactionById(id) {
      return client.ledgerTransaction.findUnique({ where: { id }, select: TRANSACTION_SELECTION });
    },

    async findTransactionByIdempotencyKey(key) {
      return client.ledgerTransaction.findUnique({ where: { idempotencyKey: key }, select: TRANSACTION_SELECTION });
    },

    async insertTransactionOnce(input: NewLedgerTransactionInput): Promise<InsertedLedgerTransaction> {
      const write = async (writer: PrismaClient): Promise<InsertedLedgerTransaction> => {
        const created = await writer.ledgerTransaction.create({
          data: input.transaction,
          select: TRANSACTION_SELECTION,
        });
        const entryIds: string[] = [];
        for (const entry of input.entries) {
          const written = await writer.ledgerEntry.create({
            data: { ...entry, transactionId: created.id },
            select: { id: true },
          });
          entryIds.push(written.id);
        }
        return { created: true, row: created, entryIds };
      };
      try {
        // One transaction, never a nested one: a transaction row is never
        // observable without the legs that make it balanced.
        return inTransaction ? await write(client) : await client.$transaction((transaction) => write(transaction as PrismaClient));
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // The idempotency key is taken: whoever holds it posted this movement.
        const existing = await client.ledgerTransaction.findUnique({
          where: { idempotencyKey: input.transaction.idempotencyKey },
          select: TRANSACTION_SELECTION,
        });
        if (!existing) throw error;
        return { created: false, row: existing, entryIds: [] };
      }
    },

    async listEntriesForAccounts(accountIds, range) {
      if (accountIds.length === 0) return [];
      // The range filters on when the movement *happened* (the transaction's own
      // `occurredAt`), not on when its row was written: a backfilled entry would
      // otherwise answer a question about a date it has nothing to do with.
      const rows = await client.ledgerEntry.findMany({
        where: {
          accountId: { in: [...accountIds] },
          ...(range ? { transaction: { occurredAt: { gte: range.from, lte: range.to } } } : {}),
        },
        orderBy: [{ transaction: { occurredAt: "asc" } }, { sequence: "asc" }],
        select: { ...ENTRY_SELECTION, transaction: { select: TRANSACTION_SELECTION } },
      });
      return rows.map((row) => {
        const { transaction, ...entry } = row;
        return { entry: toEntryRow(entry), transaction };
      });
    },

    async sumEntriesByAccount(accountIds, range) {
      const totals = new Map<string, AccountEntryTotals>();
      if (accountIds.length === 0) return totals;
      // `CAST(... AS DECIMAL)` is exact on both engines: SQLite keeps an integer
      // sum in integer arithmetic and Postgres sums numeric, so a figure is never
      // rounded on its way out of the database.
      const rows = await client.$queryRaw<
        Array<{ accountId: string; direction: string; total: unknown; entries: unknown }>
      >(Prisma.sql`
        SELECT e."accountId" AS "accountId", e."direction" AS "direction",
               SUM(CAST(e."amountMinor" AS DECIMAL)) AS "total",
               COUNT(*) AS "entries"
        FROM "LedgerEntry" e
        ${range ? Prisma.sql`JOIN "LedgerTransaction" t ON t."id" = e."transactionId"` : Prisma.empty}
        WHERE e."accountId" IN (${Prisma.join([...accountIds])})
        ${range ? Prisma.sql`AND t."occurredAt" >= ${range.from} AND t."occurredAt" <= ${range.to}` : Prisma.empty}
        GROUP BY e."accountId", e."direction"
      `);
      for (const row of rows) {
        if (row.direction !== "DEBIT" && row.direction !== "CREDIT") {
          throw new Error(`Stored ledger direction ${JSON.stringify(row.direction)} is not one this build understands.`);
        }
        const current = totals.get(row.accountId) ?? { debits: BigInt(0), credits: BigInt(0), count: 0 };
        const amount = exactInteger(row.total, `account ${row.accountId}`);
        if (row.direction === "DEBIT") current.debits += amount;
        else current.credits += amount;
        current.count += Number(exactInteger(row.entries, `account ${row.accountId} entry count`));
        totals.set(row.accountId, current);
      }
      return totals;
    },

    async *iterateEntriesForAccountsChronological(
      accountIds: readonly string[],
      range: LedgerDateRange,
      options: { batchSize?: number } = {},
    ): AsyncGenerator<LedgerEntryWithTransaction> {
      if (accountIds.length === 0) return;
      const batchSize = Math.min(Math.max(options.batchSize ?? 500, 1), 2_000);
      // Chronological order is a property of the *transaction*, so the page is a
      // page of transactions: one index walk on `occurredAt`, then one indexed read
      // of that page's entries on the accounts asked for. Sorting entries through
      // their transaction instead made every page a scan of the whole book, which is
      // why the export got slower the more of it had already written.
      let cursor: { at: Date; id: string } | null = null;
      for (;;) {
        const transactions: LedgerTransactionRow[] = await client.ledgerTransaction.findMany({
          where: {
            occurredAt: { gte: range.from, lte: range.to },
            ...(cursor
              ? {
                  OR: [
                    { occurredAt: { gt: cursor.at } },
                    { occurredAt: cursor.at, id: { gt: cursor.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
          take: batchSize,
          select: TRANSACTION_SELECTION,
        });
        if (transactions.length === 0) return;
        const transactionById = new Map(transactions.map((transaction) => [transaction.id, transaction]));
        const rows: EntryRecord[] = await client.ledgerEntry.findMany({
          where: { transactionId: { in: [...transactionById.keys()] }, accountId: { in: [...accountIds] } },
          orderBy: [{ sequence: "asc" }, { id: "asc" }],
          select: ENTRY_SELECTION,
        });
        const entriesByTransaction = new Map<string, EntryRecord[]>();
        for (const row of rows) {
          const list = entriesByTransaction.get(row.transactionId) ?? [];
          list.push(row);
          entriesByTransaction.set(row.transactionId, list);
        }
        // Emitted in the transaction page's order, not the entry query's: a
        // statement reads movements in time, and the legs within one movement in
        // their own sequence.
        for (const transaction of transactions) {
          for (const row of entriesByTransaction.get(transaction.id) ?? []) {
            yield { entry: toEntryRow(row), transaction };
          }
        }
        if (transactions.length < batchSize) return;
        const last = transactions[transactions.length - 1]!;
        cursor = { at: last.occurredAt, id: last.id };
      }
    },

    async listLatestEntriesForAccounts(accountIds, range, limit) {
      if (accountIds.length === 0) return [];
      // Newest first so the database can stop early, then reversed into the order
      // a statement reads. The page is a page: the caller states its size.
      const rows: EntryWithTransactionRecord[] = await client.ledgerEntry.findMany({
        where: { accountId: { in: [...accountIds] }, transaction: { occurredAt: { gte: range.from, lte: range.to } } },
        orderBy: [{ transaction: { occurredAt: "desc" } }, { sequence: "desc" }, { id: "desc" }],
        take: Math.min(Math.max(limit, 1), 5_000),
        select: { ...ENTRY_SELECTION, transaction: { select: TRANSACTION_SELECTION } },
      });
      return rows.reverse().map((row) => {
        const { transaction, ...entry } = row;
        return { entry: toEntryRow(entry), transaction };
      });
    },

    async *iterateEntriesForAccounts(
      accountIds: readonly string[],
      options: { range?: LedgerDateRange; batchSize?: number } = {},
    ): AsyncGenerator<LedgerEntryWithTransaction> {
      if (accountIds.length === 0) return;
      const batchSize = Math.min(Math.max(options.batchSize ?? 2_000, 1), 10_000);
      const range = options.range;
      let cursor: string | null = null;
      for (;;) {
        const rows: EntryWithTransactionRecord[] = await client.ledgerEntry.findMany({
          where: {
            accountId: { in: [...accountIds] },
            ...(cursor ? { id: { gt: cursor } } : {}),
            ...(range ? { transaction: { occurredAt: { gte: range.from, lte: range.to } } } : {}),
          },
          orderBy: { id: "asc" },
          take: batchSize,
          select: { ...ENTRY_SELECTION, transaction: { select: TRANSACTION_SELECTION } },
        });
        if (rows.length === 0) return;
        for (const row of rows) {
          const { transaction, ...entry } = row;
          yield { entry: toEntryRow(entry), transaction };
        }
        if (rows.length < batchSize) return;
        cursor = rows[rows.length - 1]!.id;
      }
    },

    async pageEntriesForAccounts(accountIds, range, page) {
      if (accountIds.length === 0) return [];
      const rows = await client.ledgerEntry.findMany({
        where: { accountId: { in: [...accountIds] }, transaction: { occurredAt: { gte: range.from, lte: range.to } } },
        orderBy: [{ transaction: { occurredAt: "asc" } }, { sequence: "asc" }],
        skip: Math.max(0, page.offset),
        take: Math.min(Math.max(page.limit, 1), 5_000),
        select: { ...ENTRY_SELECTION, transaction: { select: TRANSACTION_SELECTION } },
      });
      return rows.map((row) => {
        const { transaction, ...entry } = row;
        return { entry: toEntryRow(entry), transaction };
      });
    },

    async listEntriesForTransactions(transactionIds) {
      if (transactionIds.length === 0) return [];
      const rows = await client.ledgerEntry.findMany({
        where: { transactionId: { in: [...transactionIds] } },
        orderBy: [{ transactionId: "asc" }, { sequence: "asc" }],
        select: ENTRY_SELECTION,
      });
      return rows.map(toEntryRow);
    },

    async listAllEntries() {
      const rows = await client.ledgerEntry.findMany({
        orderBy: [{ createdAt: "asc" }, { sequence: "asc" }],
        select: ENTRY_SELECTION,
      });
      return rows.map(toEntryRow);
    },

    async listAllTransactions() {
      const rows = await client.ledgerTransaction.findMany({
        orderBy: { occurredAt: "asc" },
        select: TRANSACTION_SELECTION,
      });
      return rows.map((row) => ({ ...row }));
    },

    async acquireAccountLock({ key, holder, ttlMs, now }) {
      const expiresAt = new Date(now.getTime() + ttlMs);
      const existing = await client.ledgerAccountLock.findUnique({ where: { key } });
      if (existing && existing.holder === holder) {
        // The same attempt, taking its own lock again: extend it rather than
        // refusing, so a nested pass inside one transaction does not deadlock.
        await client.ledgerAccountLock.update({ where: { key }, data: { acquiredAt: now, expiresAt } });
        return { acquired: true, holder, expiresAt };
      }
      if (existing && existing.expiresAt.getTime() > now.getTime()) {
        return { acquired: false, holder: existing.holder, expiresAt: existing.expiresAt };
      }
      if (existing) {
        // Expired: take it over, but only from the holder whose row was read, so a
        // holder that refreshed it in between is not stolen from.
        const taken = await client.ledgerAccountLock.updateMany({
          where: { key, holder: existing.holder, expiresAt: existing.expiresAt },
          data: { holder, acquiredAt: now, expiresAt },
        });
        if (taken.count === 1) return { acquired: true, holder, expiresAt };
        const loss = await client.ledgerAccountLock.findUnique({ where: { key } });
        return { acquired: false, holder: loss?.holder ?? null, expiresAt: loss?.expiresAt ?? null };
      }
      try {
        await client.ledgerAccountLock.create({ data: { key, holder, acquiredAt: now, expiresAt } });
        return { acquired: true, holder, expiresAt };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Another attempt inserted the key between the read and this write, which
        // is the unique constraint doing the deciding rather than a check.
        const loss = await client.ledgerAccountLock.findUnique({ where: { key } });
        return { acquired: false, holder: loss?.holder ?? null, expiresAt: loss?.expiresAt ?? null };
      }
    },

    async releaseAccountLock({ key, holder }) {
      // Scoped to the holder: an attempt that lost the race can never delete the
      // winner's row on its way out.
      await client.ledgerAccountLock.deleteMany({ where: { key, holder } });
    },

    async transaction<T>(work: (store: LedgerStore) => Promise<T>) {
      if (inTransaction) return work(store);
      return client.$transaction(async (transaction) =>
        work(createLedgerStore(transaction as PrismaClient, { inTransaction: true })),
      );
    },
  };

  return store;
}

/**
 * A sum the database returned, as exact minor units.
 *
 * SQLite hands back a number or a bigint, Postgres a numeric that Prisma exposes
 * as a decimal string; all three are the same integer here. Anything that is not
 * an integer is refused rather than rounded, for the same reason a stored amount
 * is refused: a balance is not a value a machine may approximate.
 */
function exactInteger(value: unknown, where: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`The database sum for ${where} is not an exact safe integer.`);
    return BigInt(value);
  }
  const text = String(value ?? "");
  const [whole, fraction] = text.split(".");
  if (!/^-?\d+$/.test(whole ?? "")) throw new Error(`The database sum for ${where} is not an integer (${text}).`);
  if (fraction !== undefined && !/^0*$/.test(fraction)) {
    throw new Error(`The database sum for ${where} has a fractional part (${text}).`);
  }
  return BigInt(whole);
}

/** The store the running application uses. */
export const ledgerStore: LedgerStore = createLedgerStore();
