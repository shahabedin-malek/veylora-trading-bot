import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { DepositAuditEntry } from "@/lib/deposits/addresses";
import { createLedgerStore, type LedgerStore, type LedgerStoreOptions } from "@/lib/ledger/store";
import { requireWithdrawalState, WITHDRAWAL_LIVE_STATES, type WithdrawalState } from "./states";
import type { WithdrawalAddressStore } from "./addresses";
import { auditCreate } from "@/lib/audit/record";

/**
 * The database half of withdrawals.
 *
 * Every rule above this file — validation, reservation, signing, confirmation, the
 * failure taxonomy — is written against the interfaces below rather than against
 * Prisma, which is what lets the whole flow be exercised in a test against an
 * in-memory store instead of a database. This file is the only place that knows the
 * rows, and it is deliberately thin: reads come back through
 * {@link toWithdrawalRow}, which validates the status a row carries, so a status
 * this build does not understand is refused instead of being rendered as a
 * withdrawal in some third state.
 *
 * Two details are load-bearing.
 *
 * **`claimWithdrawal` is a compare-and-set, not an assignment.** A row is moved out
 * of one state, or out of one of a set of states, only if it is still in one of
 * them, and the store reports whether this caller won. That is the same shape the
 * deposit credit uses, and it is what makes two runners advancing the same
 * withdrawal produce one broadcast and one audit row rather than two.
 *
 * **`ledger()` is bound to the same client this store was built with.** The
 * reservation is claimed *and* posted inside one `transaction`, so a withdrawal row
 * cannot exist without the ledger movement that holds its money, and a crash between
 * the two is not a state the database can be left in.
 */

export type WithdrawalRow = {
  id: string;
  userId: string;
  network: string;
  chainId: number;
  asset: string;
  decimals: number;
  /** The gross amount the owner authorised, held at request time. */
  amountMinor: string;
  /** The platform's cut of this withdrawal. */
  feeMinor: string;
  /** What the chain is asked to send: gross minus fee. */
  netMinor: string;
  /** Lowercased destination, the identity. */
  destination: string;
  /** Checksummed destination, what the owner reads. */
  destinationDisplay: string;
  status: WithdrawalState;
  reasonCode: string | null;
  reasonMessage: string | null;
  idempotencyKey: string;
  fromAddress: string | null;
  nonce: number | null;
  /** The signed bytes that were broadcast, kept so a retry re-sends them. */
  rawTransaction: string | null;
  txHash: string | null;
  /** The signed replacement transaction a cancel broadcasts at the same nonce. */
  cancelRawTransaction: string | null;
  cancelTxHash: string | null;
  attempts: number;
  confirmations: number;
  confirmationsRequired: number | null;
  /** When the owner's own new-address window ends. Null when there is no hold. */
  holdUntil: Date | null;
  /** When an unsent request expires and its amount is released. */
  expiresAt: Date;
  /** When a sent-but-unconfirmed withdrawal becomes cancellable. */
  timeoutAt: Date | null;
  broadcastAt: Date | null;
  confirmedAt: Date | null;
  failedAt: Date | null;
  cancelledAt: Date | null;
  releasedAt: Date | null;
  lastCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type NewWithdrawalRow = Omit<WithdrawalRow, "id" | "createdAt" | "updatedAt">;

export type WithdrawalPatch = Partial<
  Omit<WithdrawalRow, "id" | "userId" | "idempotencyKey" | "createdAt" | "updatedAt">
>;

export type WithdrawalAuditEntry = DepositAuditEntry;

export type WithdrawalStore = WithdrawalAddressStore & {
  findWithdrawalById(id: string): Promise<WithdrawalRow | null>;
  findWithdrawalByIdempotencyKey(key: string): Promise<WithdrawalRow | null>;
  /** Every withdrawal that ever used this hash, so "one transaction" is checkable. */
  findWithdrawalsByTxHash(txHash: string): Promise<WithdrawalRow[]>;
  insertWithdrawalOnce(row: NewWithdrawalRow): Promise<{ created: boolean; row: WithdrawalRow }>;
  updateWithdrawal(id: string, patch: WithdrawalPatch): Promise<WithdrawalRow>;
  /**
   * Move a row out of `from`, but only if it is still in one of those states.
   * False when another run got there first, which is how two runners cannot both
   * broadcast one withdrawal.
   */
  claimWithdrawal(id: string, from: readonly WithdrawalState[], patch: WithdrawalPatch): Promise<boolean>;
  listWithdrawalsForUser(userId: string, limit: number): Promise<WithdrawalRow[]>;
  /** Every row a run still has to advance, oldest first. */
  listLiveWithdrawals(limit: number): Promise<WithdrawalRow[]>;
  /**
   * How many withdrawals sit in each state, for the health signal.
   *
   * Counted in the database rather than by reading the rows: the health read has to answer
   * when the table is large, which is exactly when "how many are stuck?" is worth asking.
   * A state this build does not understand is reported under its stored name rather than
   * dropped, so a count that does not add up is visible instead of silent.
   */
  countWithdrawalsByStatus(): Promise<Record<string, number>>;
  recordAudit(entry: WithdrawalAuditEntry): Promise<void>;
  transaction<T>(work: (store: WithdrawalStore) => Promise<T>): Promise<T>;
  ledger(): LedgerStore;
};

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

type WithdrawalRecord = Omit<WithdrawalRow, "status"> & { status: string };

function toWithdrawalRow(record: WithdrawalRecord): WithdrawalRow {
  return { ...record, status: requireWithdrawalState(record.status) };
}

function withdrawalSelection() {
  return {
    id: true,
    userId: true,
    network: true,
    chainId: true,
    asset: true,
    decimals: true,
    amountMinor: true,
    feeMinor: true,
    netMinor: true,
    destination: true,
    destinationDisplay: true,
    status: true,
    reasonCode: true,
    reasonMessage: true,
    idempotencyKey: true,
    fromAddress: true,
    nonce: true,
    rawTransaction: true,
    txHash: true,
    cancelRawTransaction: true,
    cancelTxHash: true,
    attempts: true,
    confirmations: true,
    confirmationsRequired: true,
    holdUntil: true,
    expiresAt: true,
    timeoutAt: true,
    broadcastAt: true,
    confirmedAt: true,
    failedAt: true,
    cancelledAt: true,
    releasedAt: true,
    lastCheckedAt: true,
    createdAt: true,
    updatedAt: true,
  } as const;
}

function addressSelection() {
  return {
    id: true,
    userId: true,
    network: true,
    chainId: true,
    address: true,
    addressDisplay: true,
    useCount: true,
    firstSeenAt: true,
    lastUsedAt: true,
  } as const;
}

/** `inTransaction` is the same flag `createLedgerStore` takes, and for the same reason. */
export function createWithdrawalStore(client: PrismaClient = prisma, options: LedgerStoreOptions = {}): WithdrawalStore {
  const inTransaction = options.inTransaction === true;
  const store: WithdrawalStore = {
    async findWithdrawalById(id) {
      const row = await client.withdrawal.findUnique({ where: { id }, select: withdrawalSelection() });
      return row ? toWithdrawalRow(row) : null;
    },

    async findWithdrawalByIdempotencyKey(key) {
      const row = await client.withdrawal.findUnique({ where: { idempotencyKey: key }, select: withdrawalSelection() });
      return row ? toWithdrawalRow(row) : null;
    },

    async findWithdrawalsByTxHash(txHash) {
      const rows = await client.withdrawal.findMany({
        where: { OR: [{ txHash }, { cancelTxHash: txHash }] },
        orderBy: { createdAt: "asc" },
        select: withdrawalSelection(),
      });
      return rows.map(toWithdrawalRow);
    },

    async insertWithdrawalOnce(row) {
      try {
        const created = await client.withdrawal.create({ data: row, select: withdrawalSelection() });
        return { created: true, row: toWithdrawalRow(created) };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // The idempotency key is taken: whoever holds it asked for this withdrawal.
        const existing = await client.withdrawal.findUnique({
          where: { idempotencyKey: row.idempotencyKey },
          select: withdrawalSelection(),
        });
        if (!existing) throw error;
        return { created: false, row: toWithdrawalRow(existing) };
      }
    },

    async updateWithdrawal(id, patch) {
      const updated = await client.withdrawal.update({ where: { id }, data: patch, select: withdrawalSelection() });
      return toWithdrawalRow(updated);
    },

    async claimWithdrawal(id, from, patch) {
      if (from.length === 0) return false;
      const claimed = await client.withdrawal.updateMany({
        where: { id, status: { in: [...from] } },
        data: patch,
      });
      return claimed.count === 1;
    },

    async listWithdrawalsForUser(userId, limit) {
      const rows = await client.withdrawal.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: withdrawalSelection(),
      });
      return rows.map(toWithdrawalRow);
    },

    async listLiveWithdrawals(limit) {
      const rows = await client.withdrawal.findMany({
        where: { status: { in: [...WITHDRAWAL_LIVE_STATES] } },
        orderBy: { createdAt: "asc" },
        take: limit,
        select: withdrawalSelection(),
      });
      return rows.map(toWithdrawalRow);
    },

    async countWithdrawalsByStatus() {
      const rows = await client.withdrawal.groupBy({ by: ["status"], _count: { _all: true } });
      const counts: Record<string, number> = {};
      for (const row of rows) counts[row.status] = row._count._all;
      return counts;
    },

    async recordAudit(entry) {
      await auditCreate(client, {
        data: {
          actorUserId: entry.actorUserId,
          action: entry.action,
          objectType: entry.objectType,
          objectId: entry.objectId,
          outcome: entry.outcome,
          redactedJson: JSON.stringify(entry.payload),
        },
      });
    },

    async findWithdrawalAddress({ userId, network, address }) {
      const row = await client.withdrawalAddress.findUnique({
        where: { userId_network_address: { userId, network, address } },
        select: addressSelection(),
      });
      return row ? { ...row } : null;
    },

    async listWithdrawalAddresses(userId) {
      const rows = await client.withdrawalAddress.findMany({
        where: { userId },
        orderBy: { lastUsedAt: "desc" },
        select: addressSelection(),
      });
      return rows.map((row) => ({ ...row }));
    },

    async rememberWithdrawalAddress(row) {
      // The upsert is the whole mechanism: the unique `(userId, network, address)`
      // pair decides, so two requests that arrive together produce one row and two
      // increments rather than two rows.
      const written = await client.withdrawalAddress.upsert({
        where: { userId_network_address: { userId: row.userId, network: row.network, address: row.address } },
        create: { ...row, useCount: 1, lastUsedAt: row.firstSeenAt },
        update: { useCount: { increment: 1 }, lastUsedAt: row.firstSeenAt, addressDisplay: row.addressDisplay },
        select: addressSelection(),
      });
      return { ...written };
    },

    async transaction<T>(work: (store: WithdrawalStore) => Promise<T>) {
      if (inTransaction) return work(store);
      return client.$transaction(async (transaction) =>
        work(createWithdrawalStore(transaction as PrismaClient, { inTransaction: true })),
      );
    },

    ledger() {
      // Rebuilt from `client`, never cached across a transaction: inside a
      // `transaction` this is the transaction's own client, which is what makes the
      // reservation row and its ledger movement one commit.
      return createLedgerStore(client, { inTransaction });
    },
  };

  return store;
}

/** The store the running application uses. */
export const withdrawalStore: WithdrawalStore = createWithdrawalStore();
