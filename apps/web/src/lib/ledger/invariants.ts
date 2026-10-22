import { reason, serializeReason, type Reason, type SerializedReason } from "@/lib/observability/reason";
import { decimalOf, deriveBalances, type AccountBalance } from "./accounts";
import type { LedgerStore } from "./store";
import type { MinorUnits } from "./integer-cent-ledger";
import { formatMinorUnits, parseMinorUnits, sumMinorUnits } from "./integer-cent-ledger";

/**
 * The invariants that make losing money impossible to do *silently*.
 *
 * Four claims, each one a statement that would be a lie if a movement were
 * written wrong, and each one checked against the stored rows rather than against
 * the code that wrote them:
 *
 *   TRANSACTIONS_BALANCED   every stored transaction's debits equal its credits,
 *                           per asset, in minor units — a transaction is either
 *                           whole or it is not a transaction;
 *   LEDGER_BALANCED         the same claim for the ledger as a whole, per asset:
 *                           money that appeared on one side appeared on the other
 *                           somewhere, so nothing was minted or destroyed;
 *   NO_ORPHAN_ENTRY         every entry's transaction and account exist, so a
 *                           figure is always attributable to a movement and a
 *                           counterparty;
 *   NO_OVERDRAWN_ACCOUNT    no account holder's balance is negative unless that
 *                           account carries an explicit credit line.
 *
 * Two decisions are worth stating plainly.
 *
 * **The sums are taken in this process, not in SQL.** A `SUM` over the text column
 * an amount is stored in is exact on one engine and a float on another, and the
 * point of a ledger is that a number is the same number everywhere — so the rows
 * are read and added with {@link sumMinorUnits}, and a fractional or unreadable
 * amount throws rather than being skipped.
 *
 * **The check reads the whole ledger.** It is deliberately not a sample or a
 * window: an invariant that looked at the newest page of entries would pass while
 * the rest of the book was wrong. That is affordable while the ledger is small,
 * which is why it runs on the runner's cadence and on the admin health read
 * rather than on every page load.
 */

export const LEDGER_INVARIANT_IDS = [
  "TRANSACTIONS_BALANCED",
  "LEDGER_BALANCED",
  "NO_ORPHAN_ENTRY",
  "NO_OVERDRAWN_ACCOUNT",
] as const;
export type LedgerInvariantId = (typeof LEDGER_INVARIANT_IDS)[number];

const CHECK_LABELS: Record<LedgerInvariantId, string> = {
  TRANSACTIONS_BALANCED: "Every transaction balances",
  LEDGER_BALANCED: "Every asset's debits equal its credits",
  NO_ORPHAN_ENTRY: "Every entry belongs to a transaction and an account",
  NO_OVERDRAWN_ACCOUNT: "No account holder is overdrawn without a credit line",
};

export type LedgerInvariantViolation = {
  check: LedgerInvariantId;
  /** One sentence naming the row that fails and how. */
  detail: string;
  transactionId?: string;
  accountCode?: string;
};

export type LedgerAssetTotals = {
  asset: string;
  decimals: number;
  debitMinor: MinorUnits;
  creditMinor: MinorUnits;
  debitDecimal: string;
  creditDecimal: string;
  balanced: boolean;
};

export type LedgerInvariantReport = {
  ok: boolean;
  checkedAt: string;
  counts: { accounts: number; transactions: number; entries: number };
  totals: LedgerAssetTotals[];
  checks: { id: LedgerInvariantId; label: string; ok: boolean; detail: string }[];
  violations: LedgerInvariantViolation[];
  /** The reason to show when the ledger is not sound, ready for a heartbeat. */
  reason: SerializedReason | null;
};

/**
 * A violated ledger, as a thrown error.
 *
 * The runner treats a thrown job as a failure and records it as one, which is the
 * only honest status for "the book does not add up" — so the check is thrown
 * rather than reported as an idle run that carries a reason nobody reads.
 */
export class LedgerInvariantError extends Error {
  readonly reason: Reason;
  readonly report: LedgerInvariantReport;

  constructor(report: LedgerInvariantReport, errorReason: Reason) {
    super(errorReason.message);
    this.name = "LedgerInvariantError";
    this.reason = errorReason;
    this.report = report;
  }
}

/**
 * Check every invariant against the stored rows.
 *
 * Returns the report rather than throwing, so a surface that wants to *show* the
 * state of the ledger (the admin health panel, the balance panel) can do that
 * without treating a violation as an exception. {@link assertLedgerInvariants} is
 * the throwing form the runner uses.
 */
export async function checkLedgerInvariants(
  store: LedgerStore,
  input: { now?: Date } = {},
): Promise<LedgerInvariantReport> {
  const [accounts, transactions, entries] = await Promise.all([
    store.listAccounts(),
    store.listAllTransactions(),
    store.listAllEntries(),
  ]);

  const violations: LedgerInvariantViolation[] = [];
  const accountIds = new Set(accounts.map((account) => account.id));
  const transactionIds = new Set(transactions.map((transaction) => transaction.id));

  // ── every entry belongs to a transaction and an account ────────────────────
  for (const entry of entries) {
    if (!transactionIds.has(entry.transactionId)) {
      violations.push({
        check: "NO_ORPHAN_ENTRY",
        detail: `Entry ${entry.id} names transaction ${entry.transactionId}, which does not exist.`,
        transactionId: entry.transactionId,
      });
    }
    if (!accountIds.has(entry.accountId)) {
      violations.push({
        check: "NO_ORPHAN_ENTRY",
        detail: `Entry ${entry.id} names account ${entry.accountId}, which does not exist.`,
      });
    }
  }

  // ── every transaction balances, per asset ─────────────────────────────────
  const legsByTransaction = new Map<string, typeof entries>();
  for (const entry of entries) {
    const legs = legsByTransaction.get(entry.transactionId) ?? [];
    legs.push(entry);
    legsByTransaction.set(entry.transactionId, legs);
  }
  for (const transaction of transactions) {
    const legs = legsByTransaction.get(transaction.id) ?? [];
    if (legs.length === 0) {
      violations.push({
        check: "TRANSACTIONS_BALANCED",
        detail: `${transaction.kind} transaction ${transaction.id} has no entries, so it moves nothing and says otherwise.`,
        transactionId: transaction.id,
      });
      continue;
    }
    for (const [asset, totals] of perAsset(legs)) {
      if (totals.debit !== totals.credit) {
        violations.push({
          check: "TRANSACTIONS_BALANCED",
          detail:
            `${transaction.kind} transaction ${transaction.id} debits ${totals.debit} and credits ${totals.credit} ` +
            `${asset} minor units.`,
          transactionId: transaction.id,
        });
      }
    }
  }

  // ── the ledger as a whole balances, per asset ─────────────────────────────
  const totalsByAsset = perAsset(entries);
  const totals: LedgerAssetTotals[] = [...totalsByAsset.entries()]
    .map(([asset, movement]) => ({
      asset,
      decimals: movement.decimals,
      debitMinor: formatMinorUnits(movement.debit),
      creditMinor: formatMinorUnits(movement.credit),
      debitDecimal: decimalOf(movement.debit, movement.decimals),
      creditDecimal: decimalOf(movement.credit, movement.decimals),
      balanced: movement.debit === movement.credit,
    }))
    .sort((left, right) => left.asset.localeCompare(right.asset));
  for (const asset of totals) {
    if (asset.balanced) continue;
    violations.push({
      check: "LEDGER_BALANCED",
      detail:
        `${asset.asset} has ${asset.debitDecimal} debited and ${asset.creditDecimal} credited across the ledger, ` +
        "so a figure was added on one side that is missing on the other.",
    });
  }

  // ── no account holder is overdrawn without an explicit credit line ────────
  const balances = deriveBalances({ accounts, entries });
  for (const balance of balances) {
    if (balance.ownerType !== "USER") continue;
    if (balance.balanceMinor >= BigInt(0)) continue;
    if (balance.creditLineMinor !== null) continue;
    violations.push({
      check: "NO_OVERDRAWN_ACCOUNT",
      detail:
        `${balance.code} holds ${balance.decimal} ${balance.asset}; a negative balance needs an explicit credit line ` +
        "on the account.",
      accountCode: balance.code,
    });
  }

  const failing = new Set(violations.map((violation) => violation.check));
  const checks = LEDGER_INVARIANT_IDS.map((id) => ({
    id,
    label: CHECK_LABELS[id],
    ok: !failing.has(id),
    detail: checkDetail(id, { accounts, transactions, entries, balances, totals, violations }),
  }));

  const checkedAt = (input.now ?? new Date()).toISOString();
  const report: LedgerInvariantReport = {
    ok: violations.length === 0,
    checkedAt,
    counts: { accounts: accounts.length, transactions: transactions.length, entries: entries.length },
    totals,
    checks,
    violations,
    reason: null,
  };
  const reportReason = invariantReason(report);
  return { ...report, reason: reportReason ? serializeReason(reportReason) : null };
}

function checkDetail(
  id: LedgerInvariantId,
  input: {
    accounts: readonly { id: string }[];
    transactions: readonly { id: string }[];
    entries: readonly { id: string }[];
    balances: readonly AccountBalance[];
    totals: readonly LedgerAssetTotals[];
    violations: readonly LedgerInvariantViolation[];
  },
): string {
  const failed = input.violations.filter((violation) => violation.check === id).length;
  if (failed > 0) return `${failed} violation(s) found.`;
  switch (id) {
    case "TRANSACTIONS_BALANCED":
      return `${input.transactions.length} transaction(s) checked, every one balanced in its asset's minor units.`;
    case "LEDGER_BALANCED":
      return input.totals.length === 0
        ? "The ledger is empty, so there is nothing to balance."
        : `${input.totals.length} asset(s) checked; debits equal credits in each.`;
    case "NO_ORPHAN_ENTRY":
      return `${input.entries.length} entr(ies) checked against ${input.transactions.length} transaction(s) and ${input.accounts.length} account(s).`;
    case "NO_OVERDRAWN_ACCOUNT":
      return `${input.balances.filter((balance) => balance.ownerType === "USER").length} account holder account(s) checked.`;
  }
}

/** The one reason a violated ledger reports, with the first failure's sentence. */
export function invariantReason(report: LedgerInvariantReport): Reason | null {
  if (report.ok) return null;
  const first = report.violations[0]!;
  const checks = [...new Set(report.violations.map((violation) => CHECK_LABELS[violation.check]))];
  return reason("LEDGER_UNBALANCED", {
    message:
      `${report.violations.length} ledger invariant violation(s): ${checks.join("; ")}. ${first.detail}`,
    detail: report.checkedAt,
  });
}

/** The throwing form: what the runner job uses, so a violation is a failed run. */
export async function assertLedgerInvariants(store: LedgerStore, input: { now?: Date } = {}): Promise<LedgerInvariantReport> {
  const report = await checkLedgerInvariants(store, input);
  if (!report.ok) {
    const failed = invariantReason(report) ?? reason("LEDGER_UNBALANCED");
    throw new LedgerInvariantError(report, failed);
  }
  return report;
}

export type LedgerHealth = {
  id: "ledger";
  label: string;
  status: "reachable" | "degraded" | "unknown";
  detail: string;
  /** Counts, so a healthy ledger still says how much it looked at. */
  counts: { accounts: number; transactions: number; entries: number };
  totals: LedgerAssetTotals[];
  violations: LedgerInvariantViolation[];
  checks: LedgerInvariantReport["checks"];
  checkedAt: string | null;
  reason: SerializedReason | null;
};

/**
 * The health signal the admin panel reads.
 *
 * "Reachable" for a ledger means its invariants hold — there is no other property
 * to be healthy *about* — and the sentence always says how much was checked, so a
 * green row on an empty ledger cannot be mistaken for a green row on a busy one.
 * A read that fails is `unknown` rather than healthy: a check that did not run
 * asserted nothing.
 */
/**
 * The last report, for a caller that asked for a bounded age (phase 38).
 *
 * Checking the book's invariants means reading every entry, which is the right
 * cost for a health sweep and the wrong cost on every balance page — 3.4 s of a
 * 4 s response at the phase-38 volume. A cached report is only returned when the
 * caller states how old it may be, and the report still carries the `checkedAt` it
 * was produced at, so a surface cannot show this check as fresher than it is. The
 * runner's own sweep calls without a bound and therefore always checks.
 */
let lastHealth: { report: LedgerHealth; checkedAtMs: number } | null = null;

export async function readLedgerHealth(
  store: LedgerStore,
  input: { now?: Date; maxAgeMs?: number } = {},
): Promise<LedgerHealth> {
  if (!input.now && input.maxAgeMs !== undefined && lastHealth && Date.now() - lastHealth.checkedAtMs <= input.maxAgeMs) {
    return lastHealth.report;
  }
  try {
    const report = await checkLedgerInvariants(store, input);
    const counts = report.counts;
    const scope = `${counts.entries} entr(ies) across ${counts.transactions} transaction(s) and ${counts.accounts} account(s)`;
    const health: LedgerHealth = {
      id: "ledger",
      label: "Ledger of record",
      status: report.ok ? "reachable" : "degraded",
      detail: report.ok
        ? `Every invariant holds: ${scope} checked at ${report.checkedAt}.`
        : `${report.violations[0]!.detail} (${report.violations.length} violation(s) across ${scope}.)`,
      counts,
      totals: report.totals,
      violations: report.violations,
      checks: report.checks,
      checkedAt: report.checkedAt,
      reason: report.reason,
    };
    if (!input.now && input.maxAgeMs !== undefined) lastHealth = { report: health, checkedAtMs: Date.now() };
    return health;
  } catch (error) {
    lastHealth = null;
    return {
      id: "ledger",
      label: "Ledger of record",
      status: "unknown",
      detail: `The ledger's invariants could not be checked: ${error instanceof Error ? error.message : "unknown error"}`,
      counts: { accounts: 0, transactions: 0, entries: 0 },
      totals: [],
      violations: [],
      checks: [],
      checkedAt: null,
      reason: null,
    };
  }
}

/** Debits and credits per asset, summed exactly. */
function perAsset(entries: readonly { asset: string; direction: string; amountMinor: MinorUnits; decimals: number }[]) {
  const byAsset = new Map<string, { debits: bigint[]; credits: bigint[]; decimals: number }>();
  for (const entry of entries) {
    const movement = byAsset.get(entry.asset) ?? { debits: [], credits: [], decimals: entry.decimals };
    (entry.direction === "DEBIT" ? movement.debits : movement.credits).push(parseMinorUnits(entry.amountMinor));
    byAsset.set(entry.asset, movement);
  }
  return new Map(
    [...byAsset.entries()].map(([asset, movement]) => [
      asset,
      { debit: sumMinorUnits(movement.debits), credit: sumMinorUnits(movement.credits), decimals: movement.decimals },
    ]),
  );
}
