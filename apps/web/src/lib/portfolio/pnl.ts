import DecimalJS from "decimal.js";
import { decimalOf, deriveBalances, userBalances, type AccountBalance } from "@/lib/ledger/accounts";
import { buildStatement, type Statement, type StatementAssetTotal, type StatementLine } from "@/lib/ledger/statements";
import {
  isLedgerTransactionKind,
  LEDGER_TRANSACTION_KINDS,
  parseMinorUnits,
  type LedgerAccountRow,
  type LedgerEntryRow,
  type LedgerTransactionRow,
} from "@/lib/ledger/integer-cent-ledger";
// Type-only: `paper-performance.ts` imports the replay above, and this module only
// needs the shape of the block it carries. Erased at build time, so no import cycle.
import type { AssistantPaperPerformance } from "@/lib/portfolio/paper-performance";

/**
 * Where the money is, derived from the book — and nothing else.
 *
 * This module answers one question the whole phase exists for: *what do I hold, what
 * did it cost, and what has it made me?* Every number in it is computed here from
 * rows that were already stored, and none of them is read from a stored total. That
 * is a deliberate limit, not modesty:
 *
 *  - **A balance is an entry sum, not a column.** {@link deriveBalances} is the only
 *    arithmetic a balance is made of, so the figure on the screen and the closing
 *    figure of a statement are the same function applied to the same rows. There is
 *    no `balanceMinor` column anywhere in the schema to drift from them.
 *  - **A position is a fill, costed at the order's own stated price.** The platform
 *    places orders on the development paper venue, which records what it was asked
 *    for (`requestedQuantity`) and what the caller said it was worth
 *    (`notionalUsdCents`). The unit price is those two divided, per order — never a
 *    market price guessed at afterwards — and the running cost is the average-cost
 *    method, computed in `decimal.js` so a fractional fill does not round.
 *  - **A mark is a named reading with a time on it.** {@link MarkPrice} is what a
 *    price source said and when it said it, and a position whose market has no mark
 *    reports `null` for its market value and its unrealised figure rather than a
 *    plausible number. That is the phase's "do not present an estimated or cached
 *    figure as a live one" made structural: there is no path here that produces a
 *    number when the source did not.
 *  - **A filter filters, and the totals follow it.** {@link AccountOverview.totals}
 *    is a reduction over the *rows on screen*, so "the screen total equals the ledger
 *    sum for this filter" is a property of one array rather than of two code paths
 *    that agree today. The statement's own per-asset totals are carried beside it
 *    (`statementClosed`) so the two reductions can be compared rather than trusted.
 *
 * The import is deliberately absent from this file. External, read-only venue
 * holdings arrive as a *separate* list ({@link ExternalImport}) and cannot reach
 * {@link AccountOverview.balances} at all: they are not entries in this book, and
 * the type they are carried in has no field a spendable figure could be assigned
 * to. "An imported balance is never spendable" is therefore a fact about the shape
 * of the data rather than a rule some code remembers to apply.
 */

const Decimal = DecimalJS.clone({ precision: 40 });

// ─────────────────────────────────────────────────────────────────────────────
// What the caller hands in: the rows, and the reading of a price.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The parts of a `Deposit` row a history line needs.
 *
 * Structural, not imported from the store, for the same reason every store in this
 * project is behind an interface: the overview can then be exercised against rows a
 * test states literally, with no database and no chain.
 */
export type DepositLike = {
  id: string;
  network: string;
  asset: string;
  decimals: number;
  amount: string;
  txHash: string;
  status: string;
  observedAt: Date;
  creditedAt: Date | null;
};

/** The parts of a `Withdrawal` row a history line needs. */
export type WithdrawalLike = {
  id: string;
  network: string;
  asset: string;
  decimals: number;
  amountMinor: string;
  feeMinor: string;
  netMinor: string;
  status: string;
  txHash: string | null;
  cancelTxHash: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
  destinationDisplay: string;
};

/** The parts of a `TradeOrder` row a position is costed from. */
export type FilledOrderLike = {
  id: string;
  venue: string;
  market: string;
  side: "BUY" | "SELL";
  status: string;
  requestedQuantity: string;
  filledQuantity: string;
  notionalUsdCents: number;
  occurredAt: Date;
};

/**
 * One price source's answer for one market, with the time it gave it.
 *
 * `asOf` is the provider's own observation time where it has one and the fetch time
 * otherwise, which is the distinction that makes a stale reading obvious instead of
 * merely old-looking.
 */
export type MarkPrice = {
  market: string;
  price: string;
  source: string;
  asOf: string;
  freshness: string;
};

/** Every block of figures carries the two things that make it judgeable. */
export type FigureSource = {
  label: string;
  detail: string;
  asOf: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// The view.
// ─────────────────────────────────────────────────────────────────────────────

export type AssetBalanceView = {
  asset: string;
  decimals: number;
  /** What can be spent right now: the `available` accounts, and nothing else. */
  availableMinor: string;
  available: string;
  /** Still owed and held against something in flight — a withdrawal. */
  heldMinor: string;
  held: string;
  /** available + held: the owner's whole claim, which is what a statement closes on. */
  totalMinor: string;
  total: string;
  /** The accounts this figure is the sum of, so the figure can be traced. */
  accounts: {
    code: string;
    bucket: string;
    label: string;
    description: string;
    balanceMinor: string;
    balance: string;
    entries: number;
  }[];
};

export type PositionPnl = {
  market: string;
  asset: string;
  venues: string[];
  quantity: string;
  averageCostUsd: string | null;
  costBasisUsd: string | null;
  realisedPnlUsd: string;
  markPriceUsd: string | null;
  markSource: string | null;
  markAsOf: string | null;
  markFreshness: string | null;
  marketValueUsd: string | null;
  unrealisedPnlUsd: string | null;
  filledOrders: number;
  /** Set when a figure on this row is absent, and why. Never a hedge for a guess. */
  note: string | null;
};

export type PnlSummary = {
  realisedUsd: string;
  /** `null` when at least one held position has no mark: a part has no answer. */
  unrealisedUsd: string | null;
  netUsd: string | null;
  pricedMarkets: number;
  unpricedMarkets: string[];
  sources: FigureSource[];
};

export type PeriodSummaryAsset = {
  asset: string;
  decimals: number;
  inflowMinor: string;
  inflow: string;
  outflowMinor: string;
  outflow: string;
  /** Withdrawal fees charged in the period, from the settled withdrawals. */
  withdrawalFeesMinor: string;
  withdrawalFees: string;
  /** Performance fees posted in the period, net of any reversal. */
  performanceFeesMinor: string;
  performanceFees: string;
  /** Withdrawal plus performance fees: every fee the owner paid in the period. */
  feesMinor: string;
  fees: string;
  /** inflow − outflow: what the outside world added to this account's claim. */
  netMinor: string;
  net: string;
  deposits: number;
  withdrawals: number;
};

export type PeriodSummary = {
  from: string;
  to: string;
  assets: PeriodSummaryAsset[];
  trading: { realisedUsd: string; filledOrders: number; markets: string[] };
  sources: FigureSource[];
};

export type HistoryCategory = "LEDGER" | "DEPOSIT" | "WITHDRAWAL";

/**
 * The types a history row can be filtered by.
 *
 * Two vocabularies in one list on purpose, because the two questions a person asks
 * are different: "show me my deposits" is a question about *the kind of thing that
 * happened*, and `DEPOSIT_CREDITED` is the ledger's name for the movement that
 * answered it. Both are offered, and neither is guessed at.
 */
export const HISTORY_TYPES = ["DEPOSIT", "WITHDRAWAL", ...LEDGER_TRANSACTION_KINDS] as const;
export type HistoryType = (typeof HISTORY_TYPES)[number];

export function isHistoryType(value: unknown): value is HistoryType {
  return typeof value === "string" && (HISTORY_TYPES as readonly string[]).includes(value);
}

export type HistoryRow = {
  id: string;
  occurredAt: string;
  category: HistoryCategory;
  type: string;
  status: string;
  asset: string;
  decimals: number;
  /** Signed on the owner's own side: + in, − out. The figure the totals add up. */
  amountMinor: string;
  amount: string;
  detail: string;
  counterparty: string | null;
  txHash: string | null;
  reference: string;
  source: string;
};

export type HistoryAssetTotal = {
  asset: string;
  decimals: number;
  inMinor: string;
  inDecimal: string;
  outMinor: string;
  outDecimal: string;
  netMinor: string;
  netDecimal: string;
  lineCount: number;
  /** The statement's own closing figure for the same range, reduced by the ledger. */
  statementClosingMinor: string | null;
  statementClosingDecimal: string | null;
  /** The derived whole-book balance right now, from the entries. */
  balanceMinor: string;
  balanceDecimal: string;
};

export type HistoryFilter = {
  from: Date;
  to: Date;
  asset: string | null;
  types: HistoryType[];
  hash: string | null;
};

export type AccountOverview = {
  userId: string;
  readAt: string;
  range: { from: string; to: string };
  filter: { asset: string | null; types: HistoryType[]; hash: string | null };
  balances: AssetBalanceView[];
  positions: PositionPnl[];
  pnl: PnlSummary;
  summary: PeriodSummary;
  history: HistoryRow[];
  /** The reduction the screen and the export both carry, for the selected filter. */
  totals: HistoryAssetTotal[];
  /** The ledger statement's own per-asset totals for the range, for the whole book. */
  statementTotals: StatementAssetTotal[];
  /** The derived whole-book balances the totals' `balance` column is checked against. */
  ledgerBalances: AccountBalance[];
  /**
   * The assistant's own paper orders, replayed against their own fills. A separate
   * block rather than a column on `positions` because it answers a different
   * question: not "what does this account hold" but "how did the assistant's orders
   * play out", which has to exclude every fill the owner or a strategy placed.
   */
  paperPerformance: AssistantPaperPerformance;
  sources: FigureSource[];
  notes: string[];
};

// ─────────────────────────────────────────────────────────────────────────────
// The filter.
// ─────────────────────────────────────────────────────────────────────────────

export type HistoryFilterQuery = {
  from: string | null;
  to: string | null;
  asset: string | null;
  type: string | null;
  hash: string | null;
};

export const MAX_RANGE_DAYS = 366;
export const DEFAULT_RANGE_DAYS = 30;
const MAX_TYPES = 8;

/**
 * Read a filter, or refuse it by name.
 *
 * A date with no time means the whole day it names — the same rule the ledger's own
 * range follows, and for the same reason: a range that excluded the day it named
 * would be a trap. An unknown type is refused with the whole vocabulary rather than
 * silently ignored, because a filter that quietly drops what it does not recognise
 * is a filter that shows a subset the owner did not ask for.
 */
export function parseHistoryFilter(
  query: HistoryFilterQuery,
  now: Date,
): { valid: true; filter: HistoryFilter } | { valid: false; error: string } {
  const read = (value: string | null, kind: "from" | "to"): Date | string | null => {
    if (value === null || value.trim() === "") return null;
    const trimmed = value.trim();
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
    const parsed = new Date(dateOnly ? `${trimmed}T00:00:00.000Z` : trimmed);
    if (Number.isNaN(parsed.getTime())) return `The "${kind}" value ${JSON.stringify(value)} is not a date.`;
    if (dateOnly && kind === "to") parsed.setUTCHours(23, 59, 59, 999);
    return parsed;
  };

  const from = read(query.from, "from");
  const to = read(query.to, "to");
  if (typeof from === "string") return { valid: false, error: from };
  if (typeof to === "string") return { valid: false, error: to };

  const start = from ?? new Date(now.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
  const end = to ?? now;
  if (start.getTime() > end.getTime()) {
    return { valid: false, error: `The filter's start (${start.toISOString()}) is after its end (${end.toISOString()}).` };
  }
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
    return { valid: false, error: `A history filter covers at most ${MAX_RANGE_DAYS} days; narrow the range.` };
  }

  const requestedTypes = (query.type ?? "")
    .split(",")
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
  if (requestedTypes.length > MAX_TYPES) {
    return { valid: false, error: `At most ${MAX_TYPES} types can be filtered at once.` };
  }
  const unknown = requestedTypes.filter((type) => !isHistoryType(type));
  if (unknown.length > 0) {
    return { valid: false, error: `Unknown history type: ${unknown.join(", ")}. Known types: ${HISTORY_TYPES.join(", ")}.` };
  }

  const asset = query.asset?.trim() ? query.asset.trim().toUpperCase() : null;
  if (asset && !/^[A-Z0-9]{2,12}$/.test(asset)) {
    return { valid: false, error: `The asset filter ${JSON.stringify(query.asset)} is not an asset symbol.` };
  }

  const rawHash = query.hash?.trim() ?? "";
  if (rawHash && rawHash.length < 6) {
    return { valid: false, error: "A transaction-hash search needs at least six characters." };
  }
  if (rawHash && !/^[0-9a-zA-Z:._-]+$/.test(rawHash)) {
    return { valid: false, error: "A transaction hash is letters, digits, and . _ : - only." };
  }

  return {
    valid: true,
    filter: {
      from: start,
      to: end,
      asset,
      types: requestedTypes as HistoryType[],
      hash: rawHash ? rawHash.toLowerCase() : null,
    },
  };
}

function withinRange(at: Date, filter: HistoryFilter): boolean {
  return at.getTime() >= filter.from.getTime() && at.getTime() <= filter.to.getTime();
}

function matchesAsset(asset: string, filter: HistoryFilter): boolean {
  return filter.asset === null || asset.toUpperCase() === filter.asset;
}

function matchesHash(hashes: readonly (string | null)[], filter: HistoryFilter): boolean {
  const wanted = filter.hash;
  if (wanted === null) return true;
  return hashes.some((hash) => hash !== null && hash.toLowerCase().includes(wanted));
}

function matchesType(type: HistoryType, filter: HistoryFilter): boolean {
  return filter.types.length === 0 || filter.types.includes(type);
}

// ─────────────────────────────────────────────────────────────────────────────
// History: the three sources, each line naming where it came from.
// ─────────────────────────────────────────────────────────────────────────────

function ledgerRowsFromLines(lines: readonly StatementLine[], filter: HistoryFilter): HistoryRow[] {
  return lines
    .filter(
      (line) =>
        matchesAsset(line.asset, filter) &&
        matchesHash([line.sourceId], filter) &&
        isLedgerTransactionKind(line.kind) &&
        matchesType(line.kind, filter),
    )
    .map((line) => ({
      id: `ledger:${line.entryId}`,
      occurredAt: line.occurredAt,
      category: "LEDGER" as const,
      type: line.kind,
      status: line.direction,
      asset: line.asset,
      decimals: line.decimals,
      amountMinor: line.signedMinor.toString(),
      amount: line.decimal,
      detail: `${line.accountLabel}${line.memo ? ` · ${line.memo}` : ""}`,
      counterparty: line.counterpartyLabel,
      txHash: line.sourceId,
      reference: line.transactionId,
      source: "ledger of record",
    }));
}

/**
 * The chain arrivals the watcher recorded.
 *
 * **These rows carry no money figure, and that is the point.** A deposit's arrival
 * is evidence; the money movement is the ledger line the credit posted, and it is
 * listed beside this row under the same transaction hash. Counting the arrival as
 * well would double every deposit in the totals and in the export, so the signed
 * figure here is a zero and the quantity that arrived is stated in the detail —
 * where the owner can read it without it being added up twice.
 */
function depositRows(deposits: readonly DepositLike[], filter: HistoryFilter): HistoryRow[] {
  if (!matchesType("DEPOSIT", filter)) return [];
  return deposits
    .filter(
      (deposit) =>
        withinRange(deposit.observedAt, filter) &&
        matchesAsset(deposit.asset, filter) &&
        matchesHash([deposit.txHash], filter),
    )
    .map((deposit) => ({
      id: `deposit:${deposit.id}`,
      occurredAt: deposit.observedAt.toISOString(),
      category: "DEPOSIT" as const,
      type: "DEPOSIT",
      status: deposit.status,
      asset: deposit.asset,
      decimals: deposit.decimals,
      amountMinor: "0",
      amount: "0",
      detail:
        `${deposit.amount} ${deposit.asset} arrival on ${deposit.network} · ${deposit.status}` +
        (deposit.creditedAt ? ` · credited ${deposit.creditedAt.toISOString()}` : " · not credited"),
      counterparty: null,
      txHash: deposit.txHash,
      reference: deposit.id,
      source: "deposit watcher",
    }));
}

/**
 * The withdrawal attempts, with the same rule as a deposit row: the money movement
 * belongs to the ledger, so the authorised amount is stated in the detail and the
 * signed figure is a zero. A cancelled, failed or still-held attempt therefore
 * cannot read as an outflow, and a confirmed one is counted exactly once — by the
 * `WITHDRAWAL_SETTLED` line that took it.
 */
function withdrawalRows(withdrawals: readonly WithdrawalLike[], filter: HistoryFilter): HistoryRow[] {
  if (!matchesType("WITHDRAWAL", filter)) return [];
  return withdrawals
    .filter(
      (withdrawal) =>
        withinRange(withdrawal.createdAt, filter) &&
        matchesAsset(withdrawal.asset, filter) &&
        matchesHash([withdrawal.txHash, withdrawal.cancelTxHash], filter),
    )
    .map((withdrawal) => {
      const fee = parseMinorUnits(withdrawal.feeMinor);
      return {
        id: `withdrawal:${withdrawal.id}`,
        occurredAt: withdrawal.createdAt.toISOString(),
        category: "WITHDRAWAL" as const,
        type: "WITHDRAWAL",
        status: withdrawal.status,
        asset: withdrawal.asset,
        decimals: withdrawal.decimals,
        amountMinor: "0",
        amount: "0",
        detail:
          `${decimalOf(parseMinorUnits(withdrawal.amountMinor), withdrawal.decimals)} ${withdrawal.asset}` +
          ` → ${withdrawal.destinationDisplay} on ${withdrawal.network} · ${withdrawal.status}` +
          (fee > BigInt(0) ? ` · fee ${decimalOf(fee, withdrawal.decimals)}` : ""),
        counterparty: null,
        txHash: withdrawal.txHash ?? withdrawal.cancelTxHash,
        reference: withdrawal.id,
        source: "withdrawal path",
      };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Totals: the reduction the screen and the export both carry.
// ─────────────────────────────────────────────────────────────────────────────

function historyTotals(
  rows: readonly HistoryRow[],
  statement: Statement,
  balances: readonly AccountBalance[],
): HistoryAssetTotal[] {
  const byAsset = new Map<string, { inMinor: bigint[]; outMinor: bigint[]; decimals: number; count: number }>();
  for (const row of rows) {
    if (row.category !== "LEDGER") continue;
    const amount = parseMinorUnits(row.amountMinor.replace(/^-/, ""));
    const bucket = byAsset.get(row.asset) ?? { inMinor: [], outMinor: [], decimals: row.decimals, count: 0 };
    (row.amountMinor.startsWith("-") ? bucket.outMinor : bucket.inMinor).push(amount);
    bucket.count += 1;
    byAsset.set(row.asset, bucket);
  }

  const statementByAsset = new Map(statement.totals.map((total) => [total.asset, total]));
  const balanceByAsset = new Map<string, bigint>();
  for (const balance of balances) {
    balanceByAsset.set(balance.asset, (balanceByAsset.get(balance.asset) ?? BigInt(0)) + balance.balanceMinor);
  }

  // Every asset that has either movement or a balance is reported, so a balance with
  // no movement in the range is visible as a zero row rather than as an absence.
  const assets = [...new Set([...byAsset.keys(), ...balanceByAsset.keys()])].sort();
  return assets.map((asset) => {
    const movement = byAsset.get(asset) ?? { inMinor: [], outMinor: [], decimals: statementByAsset.get(asset)?.decimals ?? 6, count: 0 };
    const inMinor = movement.inMinor.reduce((total, value) => total + value, BigInt(0));
    const outMinor = movement.outMinor.reduce((total, value) => total + value, BigInt(0));
    const netMinor = inMinor - outMinor;
    const statementTotal = statementByAsset.get(asset);
    return {
      asset,
      decimals: movement.decimals,
      inMinor: inMinor.toString(),
      inDecimal: decimalOf(inMinor, movement.decimals),
      outMinor: outMinor.toString(),
      outDecimal: decimalOf(outMinor, movement.decimals),
      netMinor: netMinor.toString(),
      netDecimal: decimalOf(netMinor, movement.decimals),
      lineCount: movement.count,
      statementClosingMinor: statementTotal ? statementTotal.closingMinor : null,
      statementClosingDecimal: statementTotal ? statementTotal.closingDecimal : null,
      balanceMinor: (balanceByAsset.get(asset) ?? BigInt(0)).toString(),
      balanceDecimal: decimalOf(balanceByAsset.get(asset) ?? BigInt(0), movement.decimals),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Balances: what is spendable, what is held, and which accounts say so.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The per-asset balance view the account page renders.
 *
 * Exported so the admin console derives a user's balance through the same
 * function rather than assembling a second figure that could disagree with
 * `/account`. It takes the same `AccountBalance[]` that `deriveBalances`
 * produces, so both surfaces are reading one arithmetic.
 */
export function assetBalanceViews(balances: readonly AccountBalance[]): AssetBalanceView[] {
  const byAsset = new Map<string, AccountBalance[]>();
  for (const balance of balances) {
    const list = byAsset.get(balance.asset) ?? [];
    list.push(balance);
    byAsset.set(balance.asset, list);
  }

  return [...byAsset.entries()]
    .map(([asset, accounts]) => {
      const available = accounts
        .filter((account) => account.bucket === "AVAILABLE")
        .reduce((total, account) => total + account.balanceMinor, BigInt(0));
      const held = accounts
        .filter((account) => account.bucket === "WITHDRAWALS_RESERVED")
        .reduce((total, account) => total + account.balanceMinor, BigInt(0));
      const decimals = accounts[0]?.decimals ?? 6;
      return {
        asset,
        decimals,
        availableMinor: available.toString(),
        available: decimalOf(available, decimals),
        heldMinor: held.toString(),
        held: decimalOf(held, decimals),
        totalMinor: (available + held).toString(),
        total: decimalOf(available + held, decimals),
        accounts: accounts.map((account) => ({
          code: account.code,
          bucket: account.bucket,
          label: account.label,
          description: bucketDescription(account.bucket),
          balanceMinor: account.balanceMinorText,
          balance: account.decimal,
          entries: account.entryCount,
        })),
      };
    })
    .sort((left, right) => left.asset.localeCompare(right.asset));
}

function bucketDescription(bucket: string): string {
  switch (bucket) {
    case "AVAILABLE":
      return "What this account holds and can spend.";
    case "WITHDRAWALS_RESERVED":
      return "Still owed to the account, and held against a withdrawal in flight so it cannot be spent twice.";
    default:
      return "A ledger account of this deployment, not the owner's to spend.";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Positions: fills costed at the order's own stated price, marked at a named reading.
// ─────────────────────────────────────────────────────────────────────────────

/** What one fill contributed to a market's ledger, so a single order can be explained. */
export type PositionLedgerFill = {
  orderId: string;
  /** The order's own stated price: its notional divided by the quantity it was for. */
  unitPriceUsd: string;
  filledQuantity: string;
  /** This fill's contribution to the market's realised result. */
  realisedUsd: string;
};

export type PositionLedger = {
  quantity: InstanceType<typeof Decimal>;
  cost: InstanceType<typeof Decimal>;
  realised: InstanceType<typeof Decimal>;
  orders: number;
  venues: Set<string>;
  abnormal: string | null;
  /** One entry per costed fill, in the order they were applied. */
  fills: PositionLedgerFill[];
};

/**
 * Replay fills at their own stated price, market by market, with average cost.
 *
 * Exported because the assistant's paper-performance block costs a *subset* of the
 * same fills (origin `assistant`) and must use the same arithmetic as the account's
 * positions, rather than a second implementation that could drift from this one.
 */
export function buildPositionLedgers(orders: readonly FilledOrderLike[]): Map<string, PositionLedger> {
  const byMarket = new Map<string, FilledOrderLike[]>();
  for (const order of orders) {
    if (order.status !== "FILLED" && order.status !== "PARTIALLY_FILLED") continue;
    const list = byMarket.get(order.market) ?? [];
    list.push(order);
    byMarket.set(order.market, list);
  }

  const result = new Map<string, PositionLedger>();
  for (const [market, fills] of byMarket) {
    const ledger: PositionLedger = {
      quantity: new Decimal(0),
      cost: new Decimal(0),
      realised: new Decimal(0),
      orders: 0,
      venues: new Set(),
      abnormal: null,
      fills: [],
    };
    for (const fill of [...fills].sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())) {
      const filled = new Decimal(fill.filledQuantity);
      if (!filled.isFinite() || filled.lte(0)) continue;
      const requested = new Decimal(fill.requestedQuantity);
      if (!requested.isFinite() || requested.lte(0)) continue;
      // The order's own stated price: what the caller said the order was worth,
      // divided by the quantity it was for. Nothing here consults a market price.
      const unit = new Decimal(fill.notionalUsdCents).div(100).div(requested);
      ledger.orders += 1;
      ledger.venues.add(fill.venue);

      if (fill.side === "BUY") {
        ledger.cost = ledger.cost.plus(filled.mul(unit));
        ledger.quantity = ledger.quantity.plus(filled);
        ledger.fills.push({
          orderId: fill.id,
          unitPriceUsd: unit.toFixed(),
          filledQuantity: filled.toFixed(),
          realisedUsd: "0",
        });
        continue;
      }

      if (ledger.quantity.lte(0)) {
        // A sell with nothing on the book to relieve. Its proceeds are real and its
        // basis is not, which is a fact to state rather than a figure to invent.
        const proceeds = filled.mul(unit);
        ledger.realised = ledger.realised.plus(proceeds);
        ledger.quantity = ledger.quantity.minus(filled);
        ledger.fills.push({
          orderId: fill.id,
          unitPriceUsd: unit.toFixed(),
          filledQuantity: filled.toFixed(),
          realisedUsd: proceeds.toFixed(),
        });
        ledger.abnormal = "A sell was recorded with no priced purchase before it, so its cost basis is unknown and its proceeds were taken as the result.";
        continue;
      }
      const average = ledger.cost.div(ledger.quantity);
      const result = filled.mul(unit.minus(average));
      ledger.realised = ledger.realised.plus(result);
      ledger.cost = ledger.cost.minus(filled.mul(average));
      ledger.quantity = ledger.quantity.minus(filled);
      ledger.fills.push({
        orderId: fill.id,
        unitPriceUsd: unit.toFixed(),
        filledQuantity: filled.toFixed(),
        realisedUsd: result.toFixed(),
      });
      if (ledger.quantity.lt(0)) {
        ledger.quantity = new Decimal(0);
        ledger.cost = new Decimal(0);
        ledger.abnormal = "The fills on this market oversold the position, so it was floored at zero.";
      }
    }
    result.set(market, ledger);
  }
  return result;
}

function baseAssetOf(market: string): string {
  return market.split("-")[0] ?? market;
}

/** The market rows a ledger set describes, with each market's mark and its result. */
export function positionsFromLedgers(
  ledgers: ReadonlyMap<string, PositionLedger>,
  marks: ReadonlyMap<string, MarkPrice>,
): { positions: PositionPnl[]; pricedMarkets: number; unpricedMarkets: string[] } {
  const positions: PositionPnl[] = [];
  const unpricedMarkets: string[] = [];
  let pricedMarkets = 0;

  for (const [market, ledger] of ledgers) {
    const holding = ledger.quantity.gt(0);
    const mark = marks.get(market) ?? null;
    const average = holding ? ledger.cost.div(ledger.quantity) : null;

    let markPriceUsd: string | null = null;
    let marketValueUsd: string | null = null;
    let unrealisedPnlUsd: string | null = null;
    let note = ledger.abnormal;

    if (holding) {
      if (mark) {
        const markValue = new Decimal(mark.price);
        if (markValue.isFinite() && markValue.gt(0) && average) {
          markPriceUsd = markValue.toFixed();
          marketValueUsd = ledger.quantity.mul(markValue).toFixed();
          unrealisedPnlUsd = ledger.quantity.mul(markValue.minus(average)).toFixed();
          pricedMarkets += 1;
        } else {
          unpricedMarkets.push(market);
          note ??= `No usable mark for ${market} was returned, so its market value and unrealised result are absent rather than estimated.`;
        }
      } else {
        unpricedMarkets.push(market);
        note ??= `No mark for ${market} was read, so its market value and unrealised result are absent rather than estimated.`;
      }
    }

    positions.push({
      market,
      asset: baseAssetOf(market),
      venues: [...ledger.venues].sort(),
      quantity: ledger.quantity.toFixed(),
      averageCostUsd: average ? average.toFixed() : null,
      costBasisUsd: holding ? ledger.cost.toFixed() : "0",
      realisedPnlUsd: ledger.realised.toFixed(),
      markPriceUsd,
      markSource: mark && markPriceUsd ? mark.source : null,
      markAsOf: mark && markPriceUsd ? mark.asOf : null,
      markFreshness: mark && markPriceUsd ? mark.freshness : null,
      marketValueUsd,
      unrealisedPnlUsd,
      filledOrders: ledger.orders,
      note,
    });
  }

  return {
    positions: positions.sort((left, right) => left.market.localeCompare(right.market)),
    pricedMarkets,
    unpricedMarkets: [...new Set(unpricedMarkets)].sort(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The per-period report: what came in, what went out, what it earned.
// ─────────────────────────────────────────────────────────────────────────────

type PeriodBucket = {
  asset: string;
  decimals: number;
  inflow: bigint;
  outflow: bigint;
  /** Withdrawal fees, read from the settled rows. */
  withdrawalFees: bigint;
  /** Performance fees, net of reversals, read from the owner's own entries. */
  performanceFees: bigint;
  depositIds: Set<string>;
  withdrawalIds: Set<string>;
};

function periodSummary(
  statement: Statement,
  withdrawals: readonly WithdrawalLike[],
  orders: readonly FilledOrderLike[],
  positions: readonly PositionPnl[],
  filter: HistoryFilter,
): PeriodSummary {
  const byAsset = new Map<string, PeriodBucket>();
  const bucketFor = (asset: string, decimals: number): PeriodBucket => {
    const existing = byAsset.get(asset);
    if (existing) return existing;
    const created: PeriodBucket = {
      asset,
      decimals,
      inflow: BigInt(0),
      outflow: BigInt(0),
      withdrawalFees: BigInt(0),
      performanceFees: BigInt(0),
      depositIds: new Set(),
      withdrawalIds: new Set(),
    };
    byAsset.set(asset, created);
    return created;
  };

  // Inflow and outflow are the ledger's own movements, on the owner's own side: a
  // credited deposit is the only thing that adds to the claim, and a settlement is
  // the only thing that takes from it. A reservation or a release is the same money
  // moving inside the book, so counting those would report a withdrawal twice.
  for (const line of statement.lines) {
    const magnitude = parseMinorUnits(line.signedMinor < BigInt(0) ? (-line.signedMinor).toString() : line.signedMinor.toString());
    if (line.kind === "DEPOSIT_CREDITED" && line.signedMinor > BigInt(0)) {
      const bucket = bucketFor(line.asset, line.decimals);
      bucket.inflow += magnitude;
      if (line.sourceId) bucket.depositIds.add(line.sourceId);
    } else if (line.kind === "WITHDRAWAL_SETTLED" && line.signedMinor < BigInt(0)) {
      const bucket = bucketFor(line.asset, line.decimals);
      bucket.outflow += magnitude;
      if (line.sourceId) bucket.withdrawalIds.add(line.sourceId);
    } else if (line.kind === "PERFORMANCE_FEE") {
      // A charge is negative on the owner's own side and its reversal is positive, so
      // the net fee is the negation of the signed sum. Netting rather than adding the
      // charges alone means a fee that was given back inside the period is not reported
      // as money the owner still paid.
      const bucket = bucketFor(line.asset, line.decimals);
      bucket.performanceFees += -line.signedMinor;
    }
  }

  // The fee comes from the withdrawal row that charged it, and only from one that
  // settled: the fee is the amount the owner authorised minus what the chain was
  // asked to send, and a withdrawal that never moved money was never charged. The
  // platform's fees account is not in the owner's own statement lines — it is the
  // other side of them — so reading it from there would report nothing.
  for (const withdrawal of withdrawals) {
    if (withdrawal.status !== "CONFIRMED") continue;
    if (!withinRange(withdrawal.confirmedAt ?? withdrawal.createdAt, filter)) continue;
    bucketFor(withdrawal.asset, withdrawal.decimals).withdrawalFees += parseMinorUnits(withdrawal.feeMinor);
  }

  const assets: PeriodSummaryAsset[] = [...byAsset.values()]
    .map((bucket) => ({
      asset: bucket.asset,
      decimals: bucket.decimals,
      inflowMinor: bucket.inflow.toString(),
      inflow: decimalOf(bucket.inflow, bucket.decimals),
      outflowMinor: bucket.outflow.toString(),
      outflow: decimalOf(bucket.outflow, bucket.decimals),
      withdrawalFeesMinor: bucket.withdrawalFees.toString(),
      withdrawalFees: decimalOf(bucket.withdrawalFees, bucket.decimals),
      performanceFeesMinor: bucket.performanceFees.toString(),
      performanceFees: decimalOf(bucket.performanceFees, bucket.decimals),
      feesMinor: (bucket.withdrawalFees + bucket.performanceFees).toString(),
      fees: decimalOf(bucket.withdrawalFees + bucket.performanceFees, bucket.decimals),
      netMinor: (bucket.inflow - bucket.outflow).toString(),
      net: decimalOf(bucket.inflow - bucket.outflow, bucket.decimals),
      deposits: bucket.depositIds.size,
      withdrawals: bucket.withdrawalIds.size,
    }))
    .sort((left, right) => left.asset.localeCompare(right.asset));

  const realised = positions.reduce((total, position) => total.plus(new Decimal(position.realisedPnlUsd)), new Decimal(0));
  const filled = orders.filter((order) => order.status === "FILLED" || order.status === "PARTIALLY_FILLED");
  const markets = [...new Set(filled.map((order) => order.market))].sort();

  return {
    from: statement.from,
    to: statement.to,
    assets,
    trading: { realisedUsd: realised.toFixed(), filledOrders: filled.length, markets },
    sources: [
      {
        label: "Ledger of record",
        detail: `${statement.lines.length} movement(s) on this account in ${statement.from.slice(0, 10)} → ${statement.to.slice(0, 10)}; inflow is a credited deposit and outflow is a settled withdrawal, both on the owner's own side.`,
        asOf: statement.to,
      },
      {
        label: "Withdrawal path and fee ledger",
        detail:
          "A withdrawal fee is read from the settled withdrawal's own record; a performance fee is read from its PERFORMANCE_FEE ledger entries, net of reversals. " +
          "Network cost is disclosed on the withdrawal screen and priced by the platform, never charged to the owner, so it is not part of this total.",
        asOf: statement.to,
      },
      {
        label: "Development paper venue",
        detail: markets.length > 0
          ? `${filled.length} filled order(s) across ${markets.length} market(s); the trading result is the realised figure, computed from the orders' own stated notionals and quantities.`
          : "No filled order falls in this period, so the trading result is zero because nothing was traded.",
        asOf: filter.to.toISOString(),
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The overview.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the whole view from rows that were already stored.
 *
 * Pure: no database, no network, no clock of its own. That is what lets the
 * reconciliation the acceptance criteria name — "screen totals equal ledger sums for
 * the selected filter" — be asserted against rows a test states literally, and what
 * keeps the figure on a page and the figure in an export the same computation.
 */
export function buildAccountOverview(input: {
  userId: string;
  now: Date;
  accounts: readonly LedgerAccountRow[];
  ownEntries: readonly { entry: LedgerEntryRow; transaction: LedgerTransactionRow }[];
  siblings: readonly LedgerEntryRow[];
  accountById: ReadonlyMap<string, { id: string; code: string; bucket: string; asset: string; ownerType: string }>;
  deposits: readonly DepositLike[];
  withdrawals: readonly WithdrawalLike[];
  orders: readonly FilledOrderLike[];
  marks: readonly MarkPrice[];
  filter: HistoryFilter;
  /**
   * The ledger read, when the caller has already made it.
   *
   * The account page needs the same balances and the same statement the ledger
   * surface shows; passing them in means one fold answers both pages instead of
   * two functions deriving the same figures from the same rows. A caller that has
   * only entries (a test, an assistant tool) still gets the array path.
   */
  statement?: Statement;
  balances?: readonly AccountBalance[];
  /**
   * The assistant's paper block, built by the caller that has each order's origin.
   * It is required rather than defaulted because an empty block and "no assistant
   * orders" are different claims, and a default here would let a caller that never
   * read the origins publish the second while meaning the first.
   */
  paperPerformance: AssistantPaperPerformance;
}): AccountOverview {
  const derived = input.balances ?? deriveBalances({ accounts: input.accounts, entries: input.ownEntries.map(({ entry }) => entry) });
  const own = userBalances(derived);

  const statement = input.statement ?? buildStatement({
    userId: input.userId,
    from: input.filter.from,
    to: input.filter.to,
    accounts: input.accounts,
    ownEntries: input.ownEntries,
    siblings: input.siblings,
    accountById: input.accountById,
  });

  // Positions are a holding *now*, built from every fill rather than from the filter:
  // the date range answers a question about history, and a position narrowed to a
  // period would be a different number wearing the same name. The period's trading
  // result is the part that is range-limited, and the summary names it as such.
  const ordersInRange = input.orders.filter((order) => withinRange(order.occurredAt, input.filter));
  const ledgers = buildPositionLedgers(input.orders);
  const marks = new Map(input.marks.map((mark) => [mark.market, mark]));
  const { positions, pricedMarkets, unpricedMarkets } = positionsFromLedgers(ledgers, marks);

  const history = [
    ...ledgerRowsFromLines(statement.lines, input.filter),
    ...depositRows(input.deposits, input.filter),
    ...withdrawalRows(input.withdrawals, input.filter),
  ].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));

  const totals = historyTotals(history, statement, own);
  const realised = positions.reduce((total, position) => total.plus(new Decimal(position.realisedPnlUsd)), new Decimal(0));
  const unrealisedParts = positions.filter((position) => new Decimal(position.quantity).gt(0));
  const allPriced = unrealisedParts.every((position) => position.unrealisedPnlUsd !== null);
  const unrealised = unrealisedParts.reduce(
    (total, position) => total.plus(new Decimal(position.unrealisedPnlUsd ?? 0)),
    new Decimal(0),
  );

  const notes = [
    "A balance is the sum of this account's ledger entries, not a stored column: the same function produces the figure here and the closing figure of a statement.",
    "Positions are a holding as of now, built from every fill this account has on the paper venue; the date range limits the history and the period's trading result, not the position.",
    "A credited deposit appears twice in the history by design — once as the chain arrival the watcher recorded, and once as the ledger movement that credited it. They share the transaction hash, which is what makes reconciling them possible.",
    "A deposit or withdrawal that has not moved money is listed with its amount and a zero signed figure, so an attempt that was cancelled or refused cannot read as an outflow.",
    "External, read-only venue holdings are never mixed into these balances: they are not entries in this book.",
  ];
  if (unpricedMarkets.length > 0) {
    notes.push(
      `No mark was read for ${unpricedMarkets.join(", ")}, so those positions carry no market value and no unrealised result rather than an estimate.`,
    );
  }

  return {
    userId: input.userId,
    readAt: input.now.toISOString(),
    range: { from: statement.from, to: statement.to },
    filter: { asset: input.filter.asset, types: input.filter.types, hash: input.filter.hash },
    balances: assetBalanceViews(own),
    positions,
    pnl: {
      realisedUsd: realised.toFixed(),
      unrealisedUsd: allPriced ? unrealised.toFixed() : null,
      netUsd: allPriced ? realised.plus(unrealised).toFixed() : null,
      pricedMarkets,
      unpricedMarkets,
      sources: [
        {
          label: "Filled orders on the development paper venue",
          detail: "Cost basis is each order's own stated notional divided by the quantity it was for, averaged across fills; the realised figure is computed against that average.",
          asOf: input.now.toISOString(),
        },
        {
          label: "Public market data",
          detail: `${pricedMarkets} market(s) marked from a named reading with its own observation time; a market with no reading is reported as unpriced.`,
          asOf: input.now.toISOString(),
        },
      ],
    },
    summary: periodSummary(statement, input.withdrawals, ordersInRange, positions, input.filter),
    history,
    totals,
    statementTotals: statement.totals,
    ledgerBalances: own,
    paperPerformance: input.paperPerformance,
    notes,
    sources: [
      {
        label: "Ledger of record",
        detail: `Balances and the statement are derived from ${statement.lineCount} entr(ies) in the range on ${input.accounts.length} account(s).`,
        asOf: input.now.toISOString(),
      },
      {
        label: "Deposit watcher and withdrawal path",
        detail: `${input.deposits.length} recorded arrival(s) and ${input.withdrawals.length} withdrawal(s) are listed beside the ledger; each line names its own source.`,
        asOf: input.now.toISOString(),
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The export: the same rows, as text, with the totals in the file.
// ─────────────────────────────────────────────────────────────────────────────

export const HISTORY_CSV_COLUMNS = [
  "occurredAt",
  "category",
  "type",
  "status",
  "asset",
  "amount",
  "signedMinor",
  "detail",
  "counterparty",
  "txHash",
  "reference",
  "source",
] as const;

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * The history as CSV: one row per line on screen, then one `TOTAL` row per asset.
 *
 * The total row is part of the file rather than a comment, because a file whose
 * total is a comment is a file whose total a spreadsheet cannot read — and the
 * check the phase names is "does the export match the screen". Every column the
 * owner needs for their own records is present, including the signed minor-unit
 * figure, so a re-import adds up exactly instead of through a decimal parse.
 */
export function overviewToCsv(overview: AccountOverview): string {
  const rows: string[][] = overview.history.map((row) => [
    row.occurredAt,
    row.category,
    row.type,
    row.status,
    row.asset,
    row.amount,
    row.amountMinor,
    row.detail,
    row.counterparty ?? "",
    row.txHash ?? "",
    row.reference,
    row.source,
  ]);
  for (const total of overview.totals) {
    rows.push([
      overview.range.to,
      "TOTAL",
      "NET",
      "",
      total.asset,
      total.netDecimal,
      total.netMinor,
      `in ${total.inDecimal}, out ${total.outDecimal}, of ${total.lineCount} ledger line(s)`,
      "",
      "",
      "",
      "ledger of record",
    ]);
  }
  const history = [HISTORY_CSV_COLUMNS as unknown as string[], ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");
  // The fee report is a separate block rather than extra history rows. A fee row with a
  // signed amount would be added to the totals a second time — the withdrawal that
  // charged it is already a line — so the block states the period's cost in its own
  // columns and the history above it still reconciles to the screen exactly.
  const fees = [
    "# PERIOD FEES — withdrawal and performance fees for this range, from the figures the screen shows",
    "asset,withdrawalFees,performanceFees,totalFees,totalFeesMinor",
    ...overview.summary.assets.map((asset) =>
      [asset.asset, asset.withdrawalFees, asset.performanceFees, asset.fees, asset.feesMinor].map(csvCell).join(","),
    ),
  ].join("\n");
  return `${history}\n${fees}\n${paperPerformanceCsv(overview.paperPerformance)}\n`;
}

/**
 * The assistant's paper block, as its own CSV section.
 *
 * A third block rather than extra history rows for the same reason the fees are one:
 * these orders are not ledger movements, and a signed column for them would be added
 * to the history totals a second time. The block carries the per-order rows and the
 * assistant's own sub-ledger, so "closed versus still open" survives the export
 * exactly as it appears on screen.
 */
function paperPerformanceCsv(performance: AssistantPaperPerformance): string {
  const orders = performance.orders.map((order) =>
    [
      order.orderId,
      order.occurredAt,
      order.market,
      order.side,
      order.orderType,
      order.status,
      order.outcome,
      order.requestedQuantity,
      order.filledQuantity,
      order.unitPriceUsd,
      order.notionalUsd,
      order.realisedUsd,
      order.markPriceUsd ?? "",
      order.markAsOf ?? "",
    ]
      .map(csvCell)
      .join(","),
  );
  return [
    "# ASSISTANT PAPER PERFORMANCE — orders placed by the assistant's place_paper_order tool, replayed against their own fills",
    "orderId,occurredAt,market,side,orderType,status,outcome,requestedQuantity,filledQuantity,unitPriceUsd,notionalUsd,realisedUsd,markPriceUsd,markAsOf",
    ...orders,
    "# ASSISTANT PAPER MARKETS — the assistant's own sub-ledger, closed and open",
    "market,quantity,averageCostUsd,costBasisUsd,realisedUsd,markPriceUsd,marketValueUsd,unrealisedPnlUsd,note",
    ...performance.markets.map((market) =>
      [
        market.market,
        market.quantity,
        market.averageCostUsd ?? "",
        market.costBasisUsd ?? "",
        market.realisedPnlUsd,
        market.markPriceUsd ?? "",
        market.marketValueUsd ?? "",
        market.unrealisedPnlUsd ?? "",
        market.note ?? "",
      ]
        .map(csvCell)
        .join(","),
    ),
    "# ASSISTANT PAPER TOTAL",
    "scope,realisedUsd,openUnrealisedUsd,orders,filledOrders,openMarkets,unpricedMarkets",
    [
      performance.scope,
      performance.summary.realisedUsd,
      performance.summary.openUnrealisedUsd ?? "",
      String(performance.summary.orders),
      String(performance.summary.filledOrders),
      performance.summary.openMarkets.join("|"),
      performance.summary.unpricedMarkets.join("|"),
    ]
      .map(csvCell)
      .join(","),
  ].join("\n");
}

/** The whole view as JSON, with the same totals the screen carries. */
export function overviewToJson(overview: AccountOverview): string {
  return `${JSON.stringify(
    {
      exportedAt: overview.readAt,
      userId: overview.userId,
      range: overview.range,
      filter: overview.filter,
      balances: overview.balances,
      positions: overview.positions,
      pnl: overview.pnl,
      summary: overview.summary,
      paperPerformance: overview.paperPerformance,
      totals: overview.totals,
      statementTotals: overview.statementTotals,
      history: overview.history,
      sources: overview.sources,
      notes: overview.notes,
    },
    null,
    2,
  )}\n`;
}

/**
 * Read an exported CSV back.
 *
 * This exists so "an export re-imported by a script reconciles to the same totals" is
 * a thing the repository can actually run, rather than a claim in a document. It
 * reads only the columns it sums — the signed minor units and the asset — and
 * returns both the per-asset sums and the file's own `TOTAL` rows so the caller can
 * compare all three: file rows, file totals, screen totals.
 */
export function parseHistoryCsv(csv: string): {
  rows: number;
  totals: { asset: string; netMinor: string }[];
  summed: { asset: string; netMinor: string }[];
} {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const header = splitCsvLine(lines[0] ?? "");
  const indexOf = (column: string) => header.indexOf(column);
  const assetAt = indexOf("asset");
  const minorAt = indexOf("signedMinor");
  const categoryAt = indexOf("category");
  if (assetAt === -1 || minorAt === -1 || categoryAt === -1) {
    throw new Error("The export is missing its asset, category or signedMinor column.");
  }

  const totals: { asset: string; netMinor: string }[] = [];
  const summed = new Map<string, bigint>();
  let rows = 0;

  for (const line of lines.slice(1)) {
    // The export ends with a `# PERIOD FEES` block. It is not history rows, and a reader
    // that summed it would double-count a fee already carried by the withdrawal line.
    if (line.startsWith("#")) break;
    const cells = splitCsvLine(line);
    const category = cells[categoryAt] ?? "";
    const asset = cells[assetAt] ?? "";
    const minor = cells[minorAt] ?? "0";
    if (category === "TOTAL") {
      totals.push({ asset, netMinor: minor });
      continue;
    }
    rows += 1;
    summed.set(asset, (summed.get(asset) ?? BigInt(0)) + BigInt(minor));
  }

  return {
    rows,
    totals,
    summed: [...summed.entries()].map(([asset, netMinor]) => ({ asset, netMinor: netMinor.toString() })).sort((a, b) => a.asset.localeCompare(b.asset)),
  };
}

/** One CSV line as cells, honouring the quoting `csvCell` writes. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        current += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      cells.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current);
  return cells;
}

/** `veylora-account-2026-10-01-to-2026-10-17.csv` — the range, in its own name. */
export function overviewFilename(overview: AccountOverview, format: "csv" | "json"): string {
  return `veylora-account-${overview.range.from.slice(0, 10)}-to-${overview.range.to.slice(0, 10)}.${format}`;
}
