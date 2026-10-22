import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { createLedgerStore, type LedgerStore, type LedgerStoreOptions } from "@/lib/ledger/store";
import type { DepositAddressRow, DepositAddressStore, DepositAuditEntry, NewDepositAddress } from "./addresses";
import { isDepositState, type DepositState } from "./states";
import { auditCreate } from "@/lib/audit/record";

/**
 * The database half of deposits.
 *
 * Every rule above this file — derivation, classification, confirmations,
 * crediting, reversion — is written against the interfaces below rather than
 * against Prisma, which is what lets the whole flow be exercised in a test
 * against an in-memory store instead of a database. This file is the only place
 * that knows the rows, and it is deliberately thin: reads come back through
 * `toDepositRow`/`toAddressRow`, which validate the states a row carries, so a
 * status this build does not understand is refused instead of being rendered.
 */

export type DepositRow = {
  id: string;
  userId: string | null;
  depositAddressId: string | null;
  network: string;
  chainId: number;
  tokenSymbol: string;
  tokenAddress: string | null;
  decimals: number;
  amount: string;
  rawAmount: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  confirmations: number;
  status: DepositState;
  reasonCode: string | null;
  reasonMessage: string | null;
  evidenceJson: string;
  origin: string;
  observedAt: Date;
  creditedAt: Date | null;
  lastCheckedAt: Date | null;
  revertedAt: Date | null;
};

export type NewDepositRow = Omit<DepositRow, "id" | "confirmations"> & { confirmations?: number };

export type DepositPatch = Partial<
  Pick<DepositRow, "status" | "reasonCode" | "reasonMessage" | "confirmations" | "creditedAt" | "lastCheckedAt" | "revertedAt" | "blockHash" | "blockNumber">
>;

export type DepositStore = Omit<DepositAddressStore, "transaction"> & {
  listAddressesByNetwork(network: string): Promise<DepositAddressRow[]>;
  findDeposit(identity: { network: string; txHash: string; logIndex: number }): Promise<DepositRow | null>;
  /** One row by its own id — how the owner's manual credit names the arrival it is valuing. */
  findDepositById(id: string): Promise<DepositRow | null>;
  insertDepositOnce(row: NewDepositRow): Promise<{ created: boolean; row: DepositRow }>;
  updateDeposit(id: string, patch: DepositPatch): Promise<DepositRow>;
  /**
   * Move a row out of `fromStatus`, but only if it is still in it. Returns false
   * when another run (or a second runner) got there first, which is how two
   * concurrent watchers can never both credit the same transfer.
   */
  claimDeposit(id: string, fromStatus: DepositState, patch: DepositPatch): Promise<boolean>;
  listDepositsForUser(userId: string, limit: number): Promise<DepositRow[]>;
  listDepositsForAddress(depositAddressId: string, limit: number): Promise<DepositRow[]>;
  /** Arrivals in a token this network does not configure, oldest first — the owner's queue. */
  listAwaitingValuation(limit: number): Promise<DepositRow[]>;
  listPendingByNetwork(network: string): Promise<DepositRow[]>;
  listCreditedTotalsForUser(userId: string): Promise<{ tokenSymbol: string; amount: string }[]>;
  readCursor(network: string): Promise<number | null>;
  writeCursor(network: string, block: number): Promise<void>;
  recordAudit(entry: DepositAuditEntry): Promise<void>;
  /**
   * The `transaction` here is redeclared rather than inherited: an intersection
   * of the two would leave the callback typed as the *narrower* address store, so
   * code inside a transaction could not reach `claimDeposit` — which is the
   * compare-and-set crediting is built on. The wider signature still satisfies
   * the address store's, so an issuance call site can take either.
   */
  transaction<T>(work: (store: DepositStore) => Promise<T>): Promise<T>;
  /**
   * The ledger of record, bound to the same client this store was built with.
   *
   * This is the seam that makes crediting atomic across two phases' tables. The
   * credit is claimed *and* posted inside one `transaction`, and the ledger
   * writer it posts through is the one this store hands out — which, inside a
   * transaction, is the transaction's own client. So a credit cannot exist
   * without the ledger movement that explains it, and a crash between the two is
   * not a state the database can be left in. A store built on a plain client
   * hands out a ledger writer on that same client, which is what the reads and
   * the reconciliation paths outside a transaction use.
   */
  ledger(): LedgerStore;
};

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/** A status this build cannot read is a hard error, not a row to guess about. */
function requireState(value: string): DepositState {
  if (!isDepositState(value)) throw new Error(`Stored deposit status "${value}" is not one this build understands.`);
  return value;
}

type AddressRecord = {
  id: string;
  userId: string;
  network: string;
  chainId: number;
  address: string;
  derivationIndex: number;
  tokenSymbol: string | null;
  tokenAddress: string | null;
  tokenDecimals: number | null;
  createdAt: Date;
};

type DepositRecord = Omit<DepositRow, "status"> & { status: string };

function toAddressRow(record: AddressRecord): DepositAddressRow {
  return { ...record };
}

function toDepositRow(record: DepositRecord): DepositRow {
  return { ...record, status: requireState(record.status) };
}

function addressSelection() {
  return {
    id: true,
    userId: true,
    network: true,
    chainId: true,
    address: true,
    derivationIndex: true,
    tokenSymbol: true,
    tokenAddress: true,
    tokenDecimals: true,
    createdAt: true,
  } as const;
}

function depositSelection() {
  return {
    id: true,
    userId: true,
    depositAddressId: true,
    network: true,
    chainId: true,
    tokenSymbol: true,
    tokenAddress: true,
    decimals: true,
    amount: true,
    rawAmount: true,
    txHash: true,
    logIndex: true,
    blockNumber: true,
    blockHash: true,
    confirmations: true,
    status: true,
    reasonCode: true,
    reasonMessage: true,
    evidenceJson: true,
    origin: true,
    observedAt: true,
    creditedAt: true,
    lastCheckedAt: true,
    revertedAt: true,
  } as const;
}

/** `inTransaction` is the same flag `createLedgerStore` takes, and for the same reason. */
export function createDepositStore(client: PrismaClient = prisma, options: LedgerStoreOptions = {}): DepositStore {
  const inTransaction = options.inTransaction === true;
  const store: DepositStore = {
    async listAddressesForUser(userId) {
      const rows = await client.depositAddress.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        select: addressSelection(),
      });
      return rows.map(toAddressRow);
    },

    async listAddressesByNetwork(network) {
      const rows = await client.depositAddress.findMany({
        where: { network },
        orderBy: { createdAt: "asc" },
        select: addressSelection(),
      });
      return rows.map(toAddressRow);
    },

    async findAddressByNetworkAndAddress(network, address) {
      const row = await client.depositAddress.findFirst({
        where: { network, address },
        select: addressSelection(),
      });
      return row ? toAddressRow(row) : null;
    },

    async insertAddressOnce(row: NewDepositAddress) {
      try {
        const created = await client.depositAddress.create({ data: row, select: addressSelection() });
        return { created: true, row: toAddressRow(created) };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Either this account already has an address on this network (the same
        // derived value) or the address belongs to another account (a derivation
        // collision). Both are reported as "not created" with the row that owns
        // the key; the caller distinguishes them by the row's userId.
        const existing = await client.depositAddress.findFirst({
          where: { OR: [{ userId: row.userId, network: row.network }, { network: row.network, address: row.address }] },
          select: addressSelection(),
        });
        if (!existing) throw error;
        return { created: false, row: toAddressRow(existing) };
      }
    },

    async findDeposit({ network, txHash, logIndex }) {
      const row = await client.deposit.findUnique({
        where: { network_txHash_logIndex: { network, txHash, logIndex } },
        select: depositSelection(),
      });
      return row ? toDepositRow(row) : null;
    },

    async findDepositById(id) {
      const row = await client.deposit.findUnique({ where: { id }, select: depositSelection() });
      return row ? toDepositRow(row) : null;
    },

    async insertDepositOnce(row: NewDepositRow) {
      try {
        const created = await client.deposit.create({
          data: { ...row, confirmations: row.confirmations ?? 0 },
          select: depositSelection(),
        });
        return { created: true, row: toDepositRow(created) };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const existing = await client.deposit.findUnique({
          where: { network_txHash_logIndex: { network: row.network, txHash: row.txHash, logIndex: row.logIndex } },
          select: depositSelection(),
        });
        if (!existing) throw error;
        return { created: false, row: toDepositRow(existing) };
      }
    },

    async updateDeposit(id, patch) {
      const updated = await client.deposit.update({ where: { id }, data: patch, select: depositSelection() });
      return toDepositRow(updated);
    },

    async claimDeposit(id, fromStatus, patch) {
      const claimed = await client.deposit.updateMany({ where: { id, status: fromStatus }, data: patch });
      return claimed.count === 1;
    },

    async listDepositsForUser(userId, limit) {
      const rows = await client.deposit.findMany({
        where: { userId },
        orderBy: { observedAt: "desc" },
        take: limit,
        select: depositSelection(),
      });
      return rows.map(toDepositRow);
    },

    async listAwaitingValuation(limit) {
      const rows = await client.deposit.findMany({
        where: { status: "AWAITING_VALUATION" },
        orderBy: { observedAt: "asc" },
        take: limit,
        select: depositSelection(),
      });
      return rows.map(toDepositRow);
    },

    async listDepositsForAddress(depositAddressId, limit) {
      const rows = await client.deposit.findMany({
        where: { depositAddressId },
        orderBy: { observedAt: "desc" },
        take: limit,
        select: depositSelection(),
      });
      return rows.map(toDepositRow);
    },

    async listPendingByNetwork(network) {
      const rows = await client.deposit.findMany({
        where: { network, status: "PENDING" },
        orderBy: { blockNumber: "asc" },
        select: depositSelection(),
      });
      return rows.map(toDepositRow);
    },

    async listCreditedTotalsForUser(userId) {
      const rows = await client.deposit.findMany({
        where: { userId, status: "CREDITED" },
        select: { tokenSymbol: true, amount: true },
      });
      return rows.map(({ tokenSymbol, amount }) => ({ tokenSymbol, amount }));
    },

    async readCursor(network) {
      const row = await client.depositScanCursor.findUnique({ where: { network }, select: { lastScannedBlock: true } });
      return row?.lastScannedBlock ?? null;
    },

    async writeCursor(network, block) {
      await client.depositScanCursor.upsert({
        where: { network },
        create: { network, lastScannedBlock: block },
        update: { lastScannedBlock: block },
      });
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

    async transaction<T>(work: (store: DepositStore) => Promise<T>) {
      if (inTransaction) return work(store);
      return client.$transaction(async (transaction) =>
        work(createDepositStore(transaction as PrismaClient, { inTransaction: true })),
      );
    },

    ledger() {
      // Rebuilt from `client`, never cached across a transaction: the whole point
      // is that this writer is the one the surrounding `transaction` opened, so a
      // store built inside one hands out a ledger writer inside the same one.
      return createLedgerStore(client, { inTransaction });
    },
  };

  return store;
}

/** The store the running application uses. */
export const depositStore: DepositStore = createDepositStore();
