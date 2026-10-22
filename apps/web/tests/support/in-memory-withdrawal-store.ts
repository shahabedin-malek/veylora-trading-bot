import type { DepositAuditEntry } from "@/lib/deposits/addresses";
import type { LedgerStore } from "@/lib/ledger/store";
import type { NewWithdrawalAddress, WithdrawalAddressRow } from "@/lib/withdrawals/addresses";
import type { NewWithdrawalRow, WithdrawalPatch, WithdrawalRow, WithdrawalStore } from "@/lib/withdrawals/store";
import { InMemoryLedgerStore } from "./in-memory-ledger-store";

/**
 * A withdrawal store that keeps its rows in memory.
 *
 * It exists so this phase's claims can be tested without a database, and each claim is a
 * statement about *rows written* and *keys held*:
 *
 *  - **the idempotency key is unique** — a second insert with the same key reports
 *    `created: false` and the row that holds it, exactly as Prisma answers a unique
 *    violation, so a replayed request resolves to the original withdrawal;
 *  - **`(network, fromAddress, nonce)` is unique** — claiming a row with a nonce another
 *    withdrawal already holds throws the same `P2002` Prisma throws, which is how the
 *    execution path turns a nonce collision into a `NONCE_CONFLICT` instead of two
 *    transactions at one nonce;
 *  - **a claim is a compare-and-set** — a row moves only out of the states it was said to be
 *    in, and the caller is told whether it won, so two runners cannot both advance one
 *    withdrawal;
 *  - **the address book upserts** — one row per `(userId, network, address)` with the use
 *    count bumped, so the new-address window cannot be defeated by case or repetition.
 *
 * The bodies are deliberately awaited-free between the read and the write, for the same
 * reason the deposit store's are: a test that interleaves two writers must behave like two
 * writers, not like one with a slow disk. The ledger is the in-memory one, so a withdrawal's
 * reservation, release and settlement are real movements in a real book — which is what lets
 * the invariant check be asserted after them.
 */

function uniqueViolation(target: string[]): Error & { code: string } {
  const error = new Error(`Unique constraint failed on the fields: (${target.join(",")})`) as Error & { code: string };
  error.code = "P2002";
  return error;
}

export class InMemoryWithdrawalStore implements WithdrawalStore {
  readonly ledgerStore = new InMemoryLedgerStore();
  readonly rows: WithdrawalRow[] = [];
  readonly addresses: WithdrawalAddressRow[] = [];
  readonly audits: DepositAuditEntry[] = [];
  /** Set to make the next write fail, so a transaction that never committed can be tested. */
  readonly failNextWrite = { value: false };
  private sequence = 0;

  row(id: string): WithdrawalRow | null {
    return this.rows.find((candidate) => candidate.id === id) ?? null;
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  private findNonceCollision(candidate: { id: string; network: string; fromAddress: string | null; nonce: number | null }): void {
    if (candidate.fromAddress === null || candidate.nonce === null) return;
    const clash = this.rows.find(
      (row) =>
        row.id !== candidate.id &&
        row.network === candidate.network &&
        row.fromAddress === candidate.fromAddress &&
        row.nonce === candidate.nonce,
    );
    if (clash) throw uniqueViolation(["network", "fromAddress", "nonce"]);
  }

  async findWithdrawalById(id: string): Promise<WithdrawalRow | null> {
    const found = this.row(id);
    return found ? { ...found } : null;
  }

  async findWithdrawalByIdempotencyKey(key: string): Promise<WithdrawalRow | null> {
    const found = this.rows.find((row) => row.idempotencyKey === key) ?? null;
    return found ? { ...found } : null;
  }

  async findWithdrawalsByTxHash(txHash: string): Promise<WithdrawalRow[]> {
    return this.rows
      .filter((row) => row.txHash === txHash || row.cancelTxHash === txHash)
      .map((row) => ({ ...row }));
  }

  async insertWithdrawalOnce(row: NewWithdrawalRow): Promise<{ created: boolean; row: WithdrawalRow }> {
    if (this.failNextWrite.value) {
      this.failNextWrite.value = false;
      throw new Error("simulated storage failure");
    }
    const existing = this.rows.find((candidate) => candidate.idempotencyKey === row.idempotencyKey);
    if (existing) return { created: false, row: { ...existing } };

    const created: WithdrawalRow = { ...row, id: this.nextId("withdrawal"), createdAt: new Date(0), updatedAt: new Date(0) };
    this.findNonceCollision(created);
    this.rows.push(created);
    return { created: true, row: { ...created } };
  }

  async updateWithdrawal(id: string, patch: WithdrawalPatch): Promise<WithdrawalRow> {
    const found = this.row(id);
    if (!found) throw new Error(`No withdrawal ${id}.`);
    const next = { ...found, ...patch, updatedAt: new Date(0) };
    this.findNonceCollision(next);
    Object.assign(found, next);
    return { ...found };
  }

  async claimWithdrawal(id: string, from: readonly WithdrawalRow["status"][], patch: WithdrawalPatch): Promise<boolean> {
    const found = this.row(id);
    if (!found || !from.includes(found.status)) return false;
    const next = { ...found, ...patch, updatedAt: new Date(0) };
    // The unique key is checked *before* the row changes, so a losing claim leaves the row
    // exactly as it was — which is what the execution path relies on when it catches it.
    this.findNonceCollision(next);
    Object.assign(found, next);
    return true;
  }

  async listWithdrawalsForUser(userId: string, limit: number): Promise<WithdrawalRow[]> {
    return this.rows
      .filter((row) => row.userId === userId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async listLiveWithdrawals(limit: number): Promise<WithdrawalRow[]> {
    const live = new Set(["HELD", "RESERVED", "BROADCAST_FAILED", "BROADCAST"]);
    return this.rows
      .filter((row) => live.has(row.status))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async countWithdrawalsByStatus(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const row of this.rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
    return counts;
  }

  async recordAudit(entry: DepositAuditEntry): Promise<void> {
    this.audits.push(entry);
  }

  async findWithdrawalAddress(input: { userId: string; network: string; address: string }): Promise<WithdrawalAddressRow | null> {
    const found =
      this.addresses.find(
        (row) => row.userId === input.userId && row.network === input.network && row.address === input.address,
      ) ?? null;
    return found ? { ...found } : null;
  }

  async listWithdrawalAddresses(userId: string): Promise<WithdrawalAddressRow[]> {
    return this.addresses.filter((row) => row.userId === userId).map((row) => ({ ...row }));
  }

  async rememberWithdrawalAddress(row: NewWithdrawalAddress): Promise<WithdrawalAddressRow> {
    const existing = this.addresses.find(
      (candidate) => candidate.userId === row.userId && candidate.network === row.network && candidate.address === row.address,
    );
    if (existing) {
      existing.useCount += 1;
      existing.lastUsedAt = row.firstSeenAt;
      existing.addressDisplay = row.addressDisplay;
      return { ...existing };
    }
    const created: WithdrawalAddressRow = { ...row, id: this.nextId("withdrawal-address"), useCount: 1, lastUsedAt: row.firstSeenAt };
    this.addresses.push(created);
    return { ...created };
  }

  async transaction<T>(work: (store: WithdrawalStore) => Promise<T>): Promise<T> {
    return work(this);
  }

  ledger(): LedgerStore {
    return this.ledgerStore;
  }
}
