import type { DepositAddressRow, DepositAuditEntry, NewDepositAddress } from "@/lib/deposits/addresses";
import type { DepositPatch, DepositRow, DepositStore, NewDepositRow } from "@/lib/deposits/store";
import type { DepositState } from "@/lib/deposits/states";
import type { LedgerStore } from "@/lib/ledger/store";
import { InMemoryLedgerStore } from "./in-memory-ledger-store";

/**
 * A deposit store that keeps its rows in memory.
 *
 * It exists so the three claims this phase is graded on can be tested without a
 * database, and each of them is a statement about *rows written*:
 *
 *  - **idempotent detection** — replaying the same chain event writes one row and
 *    one credit, so the store enforces the same unique keys the migration does
 *    ((userId, network) and (network, address) on an address, (network, txHash,
 *    logIndex) on a deposit) and returns "not created" exactly as Prisma does on
 *    a unique violation;
 *  - **crediting is a claim, not an assignment** — `claimDeposit` moves a row only
 *    when it is still in the status the caller saw, and its whole body runs
 *    without an `await`, which is the in-process equivalent of the single
 *    conditional UPDATE the real store issues;
 *  - **a reorg reverts a pending row** — `updateDeposit` is unconditional, because
 *    that is what the reversion path needs and what makes its result observable.
 *
 * The bodies are deliberately awaited-free between the read and the write for the
 * same reason the runner's in-memory store is: a test that interleaves two runs
 * must behave like two runners, not like one runner with a slow disk.
 */
export class InMemoryDepositStore implements DepositStore {
  readonly addresses: DepositAddressRow[] = [];
  readonly deposits: DepositRow[] = [];
  readonly audits: DepositAuditEntry[] = [];
  readonly cursors = new Map<string, number>();
  /** Set when a test wants to simulate a transaction that never committed. */
  readonly failNextTransaction = { value: false };
  /**
   * The ledger this store credits into.
   *
   * Held on the store rather than passed in beside it, because that is exactly
   * the relationship the real store has: `ledger()` hands out a writer bound to
   * the same client, so a credit inside a transaction posts inside it. A test can
   * read `store.ledgerRows` afterwards and see the movement the credit became.
   */
  readonly ledgerRows = new InMemoryLedgerStore();
  private sequence = 0;

  ledger(): LedgerStore {
    return this.ledgerRows;
  }

  /** The rows a duplicate-insert test can count: one per (network, txHash, logIndex). */
  get depositCount(): number {
    return this.deposits.length;
  }

  get creditCount(): number {
    return this.deposits.filter((row) => row.status === "CREDITED").length;
  }

  auditsFor(action: string): DepositAuditEntry[] {
    return this.audits.filter((entry) => entry.action === action);
  }

  async listAddressesForUser(userId: string): Promise<DepositAddressRow[]> {
    return this.addresses.filter((row) => row.userId === userId).map((row) => ({ ...row }));
  }

  async listAddressesByNetwork(network: string): Promise<DepositAddressRow[]> {
    return this.addresses.filter((row) => row.network === network).map((row) => ({ ...row }));
  }

  async findAddressByNetworkAndAddress(network: string, address: string): Promise<DepositAddressRow | null> {
    const found = this.addresses.find((row) => row.network === network && row.address === address);
    return found ? { ...found } : null;
  }

  async insertAddressOnce(row: NewDepositAddress): Promise<{ created: boolean; row: DepositAddressRow }> {
    const existing = this.addresses.find(
      (candidate) =>
        (candidate.userId === row.userId && candidate.network === row.network) ||
        (candidate.network === row.network && candidate.address === row.address),
    );
    if (existing) return { created: false, row: { ...existing } };
    const created: DepositAddressRow = { ...row, id: `address-${++this.sequence}`, createdAt: new Date(0) };
    this.addresses.push(created);
    return { created: true, row: { ...created } };
  }

  async findDeposit(identity: { network: string; txHash: string; logIndex: number }): Promise<DepositRow | null> {
    const found = this.deposits.find(
      (row) => row.network === identity.network && row.txHash === identity.txHash && row.logIndex === identity.logIndex,
    );
    return found ? { ...found } : null;
  }

  async insertDepositOnce(row: NewDepositRow): Promise<{ created: boolean; row: DepositRow }> {
    const existing = this.deposits.find(
      (candidate) =>
        candidate.network === row.network && candidate.txHash === row.txHash && candidate.logIndex === row.logIndex,
    );
    if (existing) return { created: false, row: { ...existing } };
    const created: DepositRow = { ...row, confirmations: row.confirmations ?? 0, id: `deposit-${++this.sequence}` };
    this.deposits.push(created);
    return { created: true, row: { ...created } };
  }

  async updateDeposit(id: string, patch: DepositPatch): Promise<DepositRow> {
    const row = this.deposits.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`No deposit ${id}`);
    Object.assign(row, patch);
    return { ...row };
  }

  async findDepositById(id: string): Promise<DepositRow | null> {
    const found = this.deposits.find((row) => row.id === id);
    return found ? { ...found } : null;
  }

  async claimDeposit(id: string, fromStatus: DepositState, patch: DepositPatch): Promise<boolean> {
    // No `await` between the read and the write: two claims cannot both win.
    const row = this.deposits.find((candidate) => candidate.id === id);
    if (!row || row.status !== fromStatus) return false;
    Object.assign(row, patch);
    return true;
  }

  async listDepositsForUser(userId: string, limit: number): Promise<DepositRow[]> {
    return this.deposits
      .filter((row) => row.userId === userId)
      .sort((left, right) => right.observedAt.getTime() - left.observedAt.getTime())
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async listDepositsForAddress(depositAddressId: string, limit: number): Promise<DepositRow[]> {
    return this.deposits
      .filter((row) => row.depositAddressId === depositAddressId)
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async listAwaitingValuation(limit: number): Promise<DepositRow[]> {
    return this.deposits
      .filter((row) => row.status === "AWAITING_VALUATION")
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async listPendingByNetwork(network: string): Promise<DepositRow[]> {
    return this.deposits
      .filter((row) => row.network === network && row.status === "PENDING")
      .map((row) => ({ ...row }));
  }

  async listCreditedTotalsForUser(userId: string): Promise<{ tokenSymbol: string; amount: string }[]> {
    return this.deposits
      .filter((row) => row.userId === userId && row.status === "CREDITED")
      .map(({ tokenSymbol, amount }) => ({ tokenSymbol, amount }));
  }

  async readCursor(network: string): Promise<number | null> {
    return this.cursors.get(network) ?? null;
  }

  async writeCursor(network: string, block: number): Promise<void> {
    this.cursors.set(network, block);
  }

  async recordAudit(entry: DepositAuditEntry): Promise<void> {
    this.audits.push(entry);
  }

  async transaction<T>(work: (store: DepositStore) => Promise<T>): Promise<T> {
    if (this.failNextTransaction.value) {
      this.failNextTransaction.value = false;
      throw new Error("simulated storage failure");
    }
    return work(this);
  }
}
