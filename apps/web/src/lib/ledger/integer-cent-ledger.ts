export type LedgerEntryType = "CASH" | "PNL" | "FEE";

export type IntegerCentLedgerEntry = {
  idempotencyKey: string;
  accountId: string;
  actorUserId: string;
  type: LedgerEntryType;
  amountCents: number;
  occurredAt: Date;
};

export type LedgerSnapshot = {
  accountId: string;
  cashBalanceCents: number;
  pnlCents: number;
  feesCents: number;
};

export interface LedgerPersistence {
  appendLedgerEntry(entry: IntegerCentLedgerEntry): Promise<{ applied: boolean }>;
  listLedgerEntries(accountId: string): Promise<readonly IntegerCentLedgerEntry[]>;
}

export async function appendIntegerCentLedgerEntry(
  persistence: LedgerPersistence,
  entry: IntegerCentLedgerEntry,
): Promise<{ applied: boolean }> {
  if (!entry.idempotencyKey.trim() || !entry.accountId.trim() || !entry.actorUserId.trim()) {
    throw new Error("Ledger identity fields are required.");
  }
  if (!Number.isSafeInteger(entry.amountCents)) throw new Error("Ledger amounts must be safe integer cents.");
  if (entry.type === "FEE" && entry.amountCents < 0) throw new Error("Fee entries must use non-negative cents.");
  if (!(entry.occurredAt instanceof Date) || !Number.isFinite(entry.occurredAt.getTime())) {
    throw new Error("Ledger timestamp is invalid.");
  }
  return persistence.appendLedgerEntry(entry);
}

export async function getIntegerCentLedgerSnapshot(
  persistence: LedgerPersistence,
  accountId: string,
): Promise<LedgerSnapshot> {
  const entries = await persistence.listLedgerEntries(accountId);
  const snapshot: LedgerSnapshot = { accountId, cashBalanceCents: 0, pnlCents: 0, feesCents: 0 };
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.amountCents)) throw new Error("Stored ledger entry is not integer cents.");
    if (entry.type === "CASH") snapshot.cashBalanceCents += entry.amountCents;
    else if (entry.type === "PNL") snapshot.pnlCents += entry.amountCents;
    else snapshot.feesCents += entry.amountCents;
  }
  for (const amount of [snapshot.cashBalanceCents, snapshot.pnlCents, snapshot.feesCents]) {
    if (!Number.isSafeInteger(amount)) throw new Error("Ledger aggregate exceeds the safe integer range.");
  }
  return snapshot;
}