import {
  BUCKET_DEFINITIONS,
  balancesFromTotals,
  bucketDefinition,
  createBalanceAccumulator,
  decimalOf,
  deriveBalances,
  describeAccount,
  ensurePlatformAccounts,
  ensureUserAccount,
  isUserOwned,
  normalDirectionOf,
  platformBalances,
  requireBucket,
  userBalances,
  type AccountBalance,
} from "./accounts";
import type { LedgerStore } from "./store";
import type { LedgerEntryRow, LedgerTransactionRow, MinorUnits, MoneyDirection } from "./integer-cent-ledger";
import { formatMinorUnits, parseMinorUnits } from "./integer-cent-ledger";

/**
 * The read surface of the ledger: what an account holder's balances are, and the
 * statement that explains them.
 *
 * Three rules run through this file.
 *
 *  - **The balance is derived, never read from a column.** {@link deriveBalances}
 *    is the only arithmetic; a statement's opening and closing figures are the
 *    same function applied to a different cut of the entries, which is why
 *    `opening + net === closing` holds by construction rather than by luck.
 *  - **A line names its counterparty.** A statement that shows money appearing
 *    from nowhere teaches nothing, so every line carries the accounts on the
 *    other side of its own transaction.
 *  - **The export is the same rows.** The CSV is built from the lines on screen
 *    and carries their total, so "the export matches the screen" is a property of
 *    one array rather than of two code paths that agree today.
 */

export type StatementLine = {
  entryId: string;
  transactionId: string;
  kind: string;
  occurredAt: string;
  /** Which way this movement moved *this* account on its own normal side. */
  direction: MoneyDirection;
  amountMinor: MinorUnits;
  /** The same figure signed on the account's normal side: + in, − out. */
  signedMinor: bigint;
  decimal: string;
  asset: string;
  decimals: number;
  accountCode: string;
  accountLabel: string;
  /** The accounts on the other side of this line's transaction. */
  counterpartyCode: string | null;
  counterpartyLabel: string | null;
  memo: string | null;
  sourceType: string | null;
  sourceId: string | null;
  /** Set when this line is part of a compensating transaction. */
  reversesTransactionId: string | null;
};

export type StatementAssetTotal = {
  asset: string;
  decimals: number;
  /** The sum of this range's increases on the account holder's accounts. */
  inMinor: MinorUnits;
  inDecimal: string;
  outMinor: MinorUnits;
  outDecimal: string;
  /**
   * The sum of every line: in minus out, as signed digits. The figure the export
   * carries, and the one the lines must add up to.
   */
  netMinor: string;
  netDecimal: string;
  /** The derived balance immediately before the range, signed. */
  openingMinor: string;
  openingDecimal: string;
  /** The derived balance at the end of the range: opening plus net, always. */
  closingMinor: string;
  closingDecimal: string;
  lineCount: number;
};

export type Statement = {
  userId: string;
  from: string;
  to: string;
  lines: StatementLine[];
  totals: StatementAssetTotal[];
  /** Accounts with no movement in the range are absent from `totals` but present here. */
  accounts: AccountBalance[];
  /** A single figure for a heading, when every line is one asset. */
  headline: StatementAssetTotal | null;
  /**
   * True when the range holds more lines than the page returned.
   *
   * The statement is a page of a range, not the whole range: a year of history is
   * one fold (whose totals are exact) and one bounded page of lines. A surface that
   * hid this would show a subtotal of what it happened to load, so the flag and the
   * count travel with the lines.
   */
  truncated: boolean;
  /** Every line in the range, whether or not this page carries it. */
  lineCount: number;
};

/**
 * The number of statement lines one read returns.
 *
 * Deliberately a page rather than a limit on the range: the totals above the lines
 * are computed over the whole range, so a narrow range and a wide one both state
 * the truth. The seed volume of 100,000 entries would otherwise be 100,000 rendered
 * rows and a 1.7 MB response.
 */
export const STATEMENT_LINE_LIMIT = 500;

export type LedgerView = {
  userId: string;
  /** What this account holds, per asset. */
  balances: AccountBalance[];
  /** The platform's own side, shown so a counterparty can be looked up. */
  platform: AccountBalance[];
  statement: Statement;
  readAt: string;
};

/**
 * Issue the accounts an account holder's balances are read from.
 *
 * Reading a balance is the first thing a new account does, and "you hold nothing
 * yet" is the honest answer for an account with no movements — which requires the
 * account to exist so the ledger can say that, rather than an empty list that
 * reads like a missing feature.
 */
export async function ensureUserLedgerAccounts(
  store: LedgerStore,
  input: { userId: string; assets: readonly { asset: string; decimals: number }[] },
): Promise<AccountBalance[]> {
  for (const holding of input.assets) {
    await ensureUserAccount(store, { userId: input.userId, asset: holding.asset, decimals: holding.decimals });
    // The platform side of a movement has to exist before anything can post one,
    // so the counterparties are issued alongside the account itself.
    await ensurePlatformAccounts(store, { asset: holding.asset, decimals: holding.decimals });
  }
  return balancesForUser(store, input.userId);
}

/** What every account of this user holds, derived from its entries. */
export async function balancesForUser(store: LedgerStore, userId: string): Promise<AccountBalance[]> {
  const accounts = await store.listAccountsForUser(userId);
  if (accounts.length === 0) return [];
  if (store.sumEntriesByAccount) {
    return balancesFromTotals(accounts, await store.sumEntriesByAccount(accounts.map((account) => account.id))).sort(
      (left, right) => left.asset.localeCompare(right.asset),
    );
  }
  const entries = await store.listEntriesForAccounts(accounts.map((account) => account.id));
  return deriveBalances({
    accounts,
    entries: entries.map(({ entry }) => entry),
  }).sort((left, right) => left.asset.localeCompare(right.asset));
}

/**
 * Both sides: what the account holder holds and what the platform holds.
 *
 * The read is a fold over the database, not an array of it. The entries are
 * consumed one bounded page at a time and every row is fed to two accumulators
 * (the all-time balance and the range's totals) plus a bounded page of display
 * lines; nothing proportional to the history is retained. That is what makes a
 * statement over a year of history cost the same memory as one over a day, and it
 * is why `truncated` exists: the page says how many lines it is not showing.
 */
export async function readLedgerView(
  store: LedgerStore,
  input: { userId: string; from: Date; to: Date; now?: Date; lineLimit?: number },
): Promise<LedgerView> {
  const [accounts, allAccounts] = await Promise.all([store.listAccountsForUser(input.userId), store.listAccounts()]);
  const lineLimit = Math.max(1, input.lineLimit ?? STATEMENT_LINE_LIMIT);
  const ownAccountIds = accounts.map((account) => account.id);
  const platformAccounts = allAccounts.filter((account) => !isUserOwned(account));

  const aggregatePromise = readAggregate(store, accounts, input.from, input.to);
  const pagePromise = readLinePage(store, ownAccountIds, input.from, input.to, lineLimit);
  const platformPromise = readPlatformBalances(store, platformAccounts);
  const [aggregate, page, platform] = await Promise.all([aggregatePromise, pagePromise, platformPromise]);

  const siblings = await store.listEntriesForTransactions([...new Set(page.map(({ entry }) => entry.transactionId))]);
  const accountById = new Map(allAccounts.map((account) => [account.id, account]));
  const statement = buildStatement({
    userId: input.userId,
    from: input.from,
    to: input.to,
    accounts,
    ownEntries: page,
    siblings,
    accountById,
    aggregate,
  });

  return {
    userId: input.userId,
    balances: userBalances(aggregate.accounts),
    platform: platformBalances(platform),
    statement,
    readAt: (input.now ?? new Date()).toISOString(),
  };
}

/**
 * The range's three figures, from the database's own sums when it can do them.
 *
 * The aggregate path answers opening, in/out and closing from three grouped
 * `SUM`s and never holds a row; the fold path is what an in-memory store (and a
 * store without the aggregate) uses, and produces the same structure from the
 * same addition. Which one ran is a property of the store, not of the answer.
 */
async function readAggregate(
  store: LedgerStore,
  accounts: readonly StatementAccount[],
  from: Date,
  to: Date,
): Promise<StatementAggregate> {
  if (!store.sumEntriesByAccount || accounts.length === 0) {
    const fold = createStatementFold(accounts, from, to);
    await forEachEntry(store, accounts.map((account) => account.id), (row) => fold.add(row.entry, row.transaction.occurredAt));
    return fold.finish();
  }

  const accountIds = accounts.map((account) => account.id);
  const [allTime, before, inRange] = await Promise.all([
    store.sumEntriesByAccount(accountIds),
    store.sumEntriesByAccount(accountIds, { from: new Date(0), to: new Date(from.getTime() - 1) }),
    store.sumEntriesByAccount(accountIds, { from, to }),
  ]);
  return aggregateFromTotals(accounts, allTime, before, inRange);
}

/** Build the statement aggregate from per-account sums. */
function aggregateFromTotals(
  accounts: readonly StatementAccount[],
  allTime: ReadonlyMap<string, { debits: bigint; credits: bigint; count: number }>,
  before: ReadonlyMap<string, { debits: bigint; credits: bigint; count: number }>,
  inRange: ReadonlyMap<string, { debits: bigint; credits: bigint; count: number }>,
): StatementAggregate {
  const derived = balancesFromTotals(accounts, allTime);
  const accountMeta = new Map(accounts.map((account) => [account.id, account]));
  const openingByAsset = sumByAsset(balancesFromTotals(accounts, before));
  const closingByAsset = sumByAsset(derived);
  const movements = new Map<string, { in: bigint; out: bigint; decimals: number; lines: number }>();
  for (const [accountId, totals] of inRange) {
    const account = accountMeta.get(accountId);
    if (!account) continue;
    const normalSide = normalDirectionOf(account) === "DEBIT" ? totals.debits : totals.credits;
    const otherSide = normalDirectionOf(account) === "DEBIT" ? totals.credits : totals.debits;
    const movement = movements.get(account.asset) ?? { in: BigInt(0), out: BigInt(0), decimals: account.decimals, lines: 0 };
    movement.in += normalSide;
    movement.out += otherSide;
    movement.lines += totals.count;
    movements.set(account.asset, movement);
  }
  const totals = totalsFromMovements(movements, openingByAsset, closingByAsset);
  return { totals, accounts: derived, openingByAsset, closingByAsset, lineCount: totals.reduce((sum, total) => sum + total.lineCount, 0) };
}

/** The statement page: the newest lines of the range, in reading order. */
async function readLinePage(
  store: LedgerStore,
  accountIds: readonly string[],
  from: Date,
  to: Date,
  limit: number,
): Promise<StatementLineInput[]> {
  if (accountIds.length === 0) return [];
  if (store.listLatestEntriesForAccounts) {
    return store.listLatestEntriesForAccounts(accountIds, { from, to }, limit);
  }
  const all = await store.listEntriesForAccounts(accountIds, { from, to });
  const page: StatementLineInput[] = [];
  for (const row of all) keepNewestLine(page, row, limit);
  return page;
}

/** What the platform holds, from the database's sums when it can do them. */
async function readPlatformBalances(store: LedgerStore, accounts: readonly StatementAccount[]): Promise<AccountBalance[]> {
  if (accounts.length === 0) return [];
  if (store.sumEntriesByAccount) {
    return balancesFromTotals(accounts, await store.sumEntriesByAccount(accounts.map((account) => account.id)));
  }
  const accumulator = createBalanceAccumulator(accounts);
  await forEachEntry(store, accounts.map((account) => account.id), (row) => accumulator.add(row.entry));
  return accumulator.balances();
}

/**
 * Feed every entry on these accounts to a visitor, one page at a time.
 *
 * The database store streams; an in-memory store a test uses has no reason to, so
 * it falls back to its array read and the same visitor sees the same rows. Both
 * paths feed the same fold, so the two cannot disagree about a total.
 */
async function forEachEntry(
  store: LedgerStore,
  accountIds: readonly string[],
  visit: (row: { entry: LedgerEntryRow; transaction: LedgerTransactionRow }) => void,
): Promise<void> {
  if (accountIds.length === 0) return;
  if (store.iterateEntriesForAccounts) {
    for await (const row of store.iterateEntriesForAccounts(accountIds)) visit(row);
    return;
  }
  for (const row of await store.listEntriesForAccounts(accountIds)) visit(row);
}

/** Keep the newest `limit` lines, sorted the way a statement reads. */
function keepNewestLine(
  page: StatementLineInput[],
  row: StatementLineInput,
  limit: number,
): void {
  const occurredAt = row.transaction.occurredAt.getTime();
  let insertAt = page.length;
  while (insertAt > 0) {
    const previous = page[insertAt - 1]!;
    const previousAt = previous.transaction.occurredAt.getTime();
    if (previousAt < occurredAt || (previousAt === occurredAt && previous.entry.id <= row.entry.id)) break;
    insertAt -= 1;
  }
  page.splice(insertAt, 0, row);
  if (page.length > limit) page.shift();
}

/**
 * Build the statement for a range, from rows the caller has already read.
 *
 * Pure on purpose: the range arithmetic (opening, net, closing, and the total per
 * asset) is the part worth testing without a database, and it is also the part
 * the acceptance criterion names — "a statement for a date range matches the sum
 * of its entries exactly" — so the sum and the lines are produced by the same
 * pass over the same array.
 */
export type StatementLineInput = { entry: LedgerEntryRow; transaction: LedgerTransactionRow };

type StatementAccount = {
  id: string;
  code: string;
  ownerType: string;
  bucket: string;
  asset: string;
  decimals: number;
  userId: string | null;
  creditLineMinor: string | null;
  createdAt: Date;
};

export type StatementAggregate = {
  totals: StatementAssetTotal[];
  /** The derived balance of every account after every entry — the closing figure's source. */
  accounts: AccountBalance[];
  openingByAsset: Map<string, bigint>;
  closingByAsset: Map<string, bigint>;
  /** Every line in the range, not only the page. */
  lineCount: number;
};

/**
 * The statement's arithmetic as a fold.
 *
 * `readLedgerView` feeds this from a streamed read, and `buildStatement` feeds it
 * from an array; both produce totals from the same addition. The three figures a
 * statement states are here: the range's in/out per asset, the balance immediately
 * before it (opening), and the balance after everything (closing).
 */
export function createStatementFold(
  accounts: readonly StatementAccount[],
  from: Date,
  to: Date,
): { add(entry: LedgerEntryRow, occurredAt: Date): void; finish(): StatementAggregate } {
  const accountMeta = new Map(accounts.map((account) => [account.id, account]));
  const closing = createBalanceAccumulator(accounts);
  const openingByAccount = new Map<string, bigint>();
  const movements = new Map<string, { in: bigint; out: bigint; decimals: number; lines: number }>();

  return {
    add(entry, occurredAt) {
      closing.add(entry);
      const account = accountMeta.get(entry.accountId);
      if (!account) return;
      const amount = parseMinorUnits(entry.amountMinor);
      const normalSide = entry.direction === normalDirectionOf(account);
      if (occurredAt < from) {
        const signed = normalSide ? amount : -amount;
        openingByAccount.set(entry.accountId, (openingByAccount.get(entry.accountId) ?? BigInt(0)) + signed);
        return;
      }
      // After the range is the future: it counts towards the closing balance and
      // towards nothing else, exactly as the array implementation did.
      if (occurredAt > to) return;
      const movement = movements.get(account.asset) ?? { in: BigInt(0), out: BigInt(0), decimals: account.decimals, lines: 0 };
      if (normalSide) movement.in += amount;
      else movement.out += amount;
      movement.lines += 1;
      movements.set(account.asset, movement);
    },
    finish() {
      const derived = closing.balances();
      const openingByAsset = new Map<string, bigint>();
      for (const account of accounts) {
        if (!isUserOwned(account)) continue;
        const signed = openingByAccount.get(account.id);
        if (signed === undefined) continue;
        openingByAsset.set(account.asset, (openingByAsset.get(account.asset) ?? BigInt(0)) + signed);
      }
      const closingByAsset = sumByAsset(derived);
      const totals = totalsFromMovements(movements, openingByAsset, closingByAsset);
      return { totals, accounts: derived, openingByAsset, closingByAsset, lineCount: totals.reduce((sum, total) => sum + total.lineCount, 0) };
    },
  };
}

/** One asset's four figures, from its in-range movement and the two balances. */
function totalsFromMovements(
  movements: ReadonlyMap<string, { in: bigint; out: bigint; decimals: number; lines: number }>,
  openingByAsset: ReadonlyMap<string, bigint>,
  closingByAsset: ReadonlyMap<string, bigint>,
): StatementAssetTotal[] {
  return [...movements.entries()]
    .map(([asset, movement]) => {
      const netMinor = movement.in - movement.out;
      const openingMinor = openingByAsset.get(asset) ?? BigInt(0);
      const closingMinor = closingByAsset.get(asset) ?? BigInt(0);
      return {
        asset,
        decimals: movement.decimals,
        inMinor: formatMinorUnits(movement.in),
        inDecimal: decimalOf(movement.in, movement.decimals),
        outMinor: formatMinorUnits(movement.out),
        outDecimal: decimalOf(movement.out, movement.decimals),
        netMinor: netMinor.toString(),
        netDecimal: decimalOf(netMinor, movement.decimals),
        openingMinor: openingMinor.toString(),
        openingDecimal: decimalOf(openingMinor, movement.decimals),
        closingMinor: closingMinor.toString(),
        closingDecimal: decimalOf(closingMinor, movement.decimals),
        lineCount: movement.lines,
      };
    })
    .sort((left, right) => left.asset.localeCompare(right.asset));
}

/**
 * The rendered lines for the entries in a range.
 *
 * Pure and shared: the whole-statement call and the streamed CSV export build
 * their rows here, so a line in the file and a line on the screen carry the same
 * counterparty, amount and source rather than two implementations that agree today.
 */
export function statementLines(input: {
  accounts: readonly StatementAccount[];
  ownEntries: readonly StatementLineInput[];
  siblings: readonly LedgerEntryRow[];
  accountById: ReadonlyMap<string, { id: string; code: string; bucket: string; asset: string; ownerType: string }>;
  from: Date;
  to: Date;
}): StatementLine[] {
  const ownAccountIds = new Set(input.accounts.map((account) => account.id));
  const siblingsByTransaction = new Map<string, LedgerEntryRow[]>();
  for (const sibling of input.siblings) {
    const list = siblingsByTransaction.get(sibling.transactionId) ?? [];
    list.push(sibling);
    siblingsByTransaction.set(sibling.transactionId, list);
  }
  const accountMeta = new Map(input.accounts.map((account) => [account.id, account]));
  const lines: StatementLine[] = [];

  for (const { entry, transaction } of input.ownEntries) {
    const account = accountMeta.get(entry.accountId);
    if (!account) continue;
    if (transaction.occurredAt < input.from || transaction.occurredAt > input.to) continue;

    const normalSide = entry.direction === normalDirectionOf(account);
    const amount = parseMinorUnits(entry.amountMinor);
    const others = (siblingsByTransaction.get(transaction.id) ?? []).filter((sibling) => !ownAccountIds.has(sibling.accountId));
    const counterpartyCodes = [...new Set(others.map((sibling) => input.accountById.get(sibling.accountId)?.code ?? sibling.accountId))];
    const counterpartyLabels = [
      ...new Set(
        others.map((sibling) => {
          const other = input.accountById.get(sibling.accountId);
          return other ? describeAccount(other) : sibling.accountId;
        }),
      ),
    ];

    lines.push({
      entryId: entry.id,
      transactionId: transaction.id,
      kind: transaction.kind,
      occurredAt: transaction.occurredAt.toISOString(),
      direction: entry.direction,
      amountMinor: formatMinorUnits(amount),
      signedMinor: normalSide ? amount : -amount,
      decimal: decimalOf(normalSide ? amount : -amount, entry.decimals),
      asset: entry.asset,
      decimals: entry.decimals,
      accountCode: account.code,
      accountLabel: describeAccount(account),
      counterpartyCode: counterpartyCodes.length > 0 ? counterpartyCodes.join(", ") : null,
      counterpartyLabel: counterpartyLabels.length > 0 ? counterpartyLabels.join(", ") : null,
      memo: transaction.memo,
      sourceType: transaction.sourceType,
      sourceId: transaction.sourceId,
      reversesTransactionId: transaction.reversesTransactionId,
    });
  }

  lines.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.entryId.localeCompare(right.entryId));
  return lines;
}

export function buildStatement(input: {
  userId: string;
  from: Date;
  to: Date;
  accounts: readonly StatementAccount[];
  ownEntries: readonly StatementLineInput[];
  siblings: readonly LedgerEntryRow[];
  accountById: ReadonlyMap<string, { id: string; code: string; bucket: string; asset: string; ownerType: string }>;
  /** The range's totals, when the caller folded a stream that is larger than this page. */
  aggregate?: StatementAggregate;
}): Statement {
  const lines = statementLines({
    accounts: input.accounts,
    ownEntries: input.ownEntries,
    siblings: input.siblings,
    accountById: input.accountById,
    from: input.from,
    to: input.to,
  });

  let aggregate = input.aggregate;
  if (!aggregate) {
    const fold = createStatementFold(input.accounts, input.from, input.to);
    for (const { entry, transaction } of input.ownEntries) fold.add(entry, transaction.occurredAt);
    aggregate = fold.finish();
  }

  return {
    userId: input.userId,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    lines,
    totals: aggregate.totals,
    accounts: userBalances(aggregate.accounts),
    headline: aggregate.totals.length === 1 ? aggregate.totals[0]! : null,
    truncated: aggregate.lineCount > lines.length,
    lineCount: aggregate.lineCount,
  };
}

/**
 * One figure per asset across an account holder's accounts.
 *
 * Only user-owned accounts count: the platform's own accounts are the other side
 * of these movements, and adding them in would double every number.
 */
function sumByAsset(balances: readonly AccountBalance[]): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const balance of balances) {
    if (!isUserOwned(balance)) continue;
    totals.set(balance.asset, (totals.get(balance.asset) ?? BigInt(0)) + balance.balanceMinor);
  }
  return totals;
}

/**
 * The statement as CSV, from the lines on screen.
 *
 * One row per line, in the order they were rendered, then one `TOTAL` row per
 * asset carrying the net the heading shows. The total row is part of the file
 * rather than a comment, because a file whose total is a comment is a file whose
 * total a spreadsheet cannot read — and the manual check is "does the export
 * match the screen".
 */
const CSV_HEADER = [
  "occurredAt",
  "transactionId",
  "kind",
  "asset",
  "amount",
  "direction",
  "account",
  "counterparty",
  "source",
  "memo",
] as const;

function csvLine(line: StatementLine): string {
  return [
    line.occurredAt,
    line.transactionId,
    line.kind,
    line.asset,
    line.decimal,
    line.direction,
    line.accountCode,
    line.counterpartyCode ?? "",
    line.sourceId ?? "",
    line.memo ?? "",
  ]
    .map(csvCell)
    .join(",");
}

function csvTotal(total: StatementAssetTotal, to: string): string {
  return [
    to,
    "",
    "TOTAL",
    total.asset,
    total.netDecimal,
    "",
    "",
    "",
    "",
    `in ${total.inDecimal}, out ${total.outDecimal}, opening ${total.openingDecimal}, closing ${total.closingDecimal}`,
  ]
    .map(csvCell)
    .join(",");
}

export function statementToCsv(statement: Statement): string {
  const rows = statement.lines.map(csvLine);
  for (const total of statement.totals) rows.push(csvTotal(total, statement.to));
  return [CSV_HEADER.map(csvCell).join(","), ...rows].join("\n") + "\n";
}

/**
 * The statement as CSV, a page at a time.
 *
 * An export of a year of history is exactly the case where building one string
 * would hold the whole ledger twice — once as rows, once as text. The generator
 * yields the header, then a batch of rows, then the range's totals, so the route
 * can hand the response body a stream and the memory cost stays proportional to
 * one batch.
 *
 * The total row is the same fold `readLedgerView` uses, fed by the same rows the
 * file contains: the export's total is the screen's total, not a second sum.
 */
export async function* statementCsvChunks(
  store: LedgerStore,
  input: { userId: string; from: Date; to: Date; batchSize?: number },
): AsyncGenerator<string> {
  const [accounts, allAccounts] = await Promise.all([store.listAccountsForUser(input.userId), store.listAccounts()]);
  const accountById = new Map(allAccounts.map((account) => [account.id, account]));
  const accountIds = accounts.map((account) => account.id);
  const fold = createStatementFold(accounts, input.from, input.to);
  const batchSize = Math.min(Math.max(input.batchSize ?? 1_000, 1), 5_000);

  yield `${CSV_HEADER.map(csvCell).join(",")}\n`;
  if (accountIds.length === 0) {
    for (const total of fold.finish().totals) yield `${csvTotal(total, input.to.toISOString())}\n`;
    return;
  }

  const emit = async function* (rows: StatementLineInput[]): AsyncGenerator<string> {
    if (rows.length === 0) return;
    const siblings = await store.listEntriesForTransactions([...new Set(rows.map(({ entry }) => entry.transactionId))]);
    const lines = statementLines({ accounts, ownEntries: rows, siblings, accountById, from: input.from, to: input.to });
    // One chunk per page, not per line: the route hands each chunk to the response
    // body, and fifty thousand single-line chunks is fifty thousand awaits.
    if (lines.length > 0) yield `${lines.map(csvLine).join("\n")}\n`;
    for (const row of rows) fold.add(row.entry, row.transaction.occurredAt);
  };

  if (store.iterateEntriesForAccountsChronological) {
    let batch: StatementLineInput[] = [];
    for await (const row of store.iterateEntriesForAccountsChronological(accountIds, { from: input.from, to: input.to }, { batchSize })) {
      batch.push(row);
      if (batch.length >= batchSize) {
        yield* emit(batch);
        batch = [];
      }
    }
    yield* emit(batch);
  } else {
    let offset = 0;
    for (;;) {
      const rows = store.pageEntriesForAccounts
        ? await store.pageEntriesForAccounts(accountIds, { from: input.from, to: input.to }, { offset, limit: batchSize })
        : offset === 0
          ? await store.listEntriesForAccounts(accountIds, { from: input.from, to: input.to })
          : [];
      if (rows.length === 0) break;
      yield* emit(rows);
      offset += rows.length;
      if (rows.length < batchSize) break;
    }
  }
  for (const total of fold.finish().totals) yield `${csvTotal(total, input.to.toISOString())}\n`;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** `veylora-ledger-2026-10-16.csv` — the range it covers, in its own name. */
export function statementFilename(statement: Statement): string {
  return `veylora-ledger-${statement.from.slice(0, 10)}-to-${statement.to.slice(0, 10)}.csv`;
}

/** The ledger's own accounts, in a fixed order, for a surface that lists them. */
export function bucketLabels(): { bucket: string; label: string; description: string }[] {
  return BUCKET_DEFINITIONS.map((definition) => ({
    bucket: definition.bucket,
    label: definition.label,
    description: definition.description,
  }));
}

export { bucketDefinition, requireBucket };
