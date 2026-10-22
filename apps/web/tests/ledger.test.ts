import assert from "node:assert/strict";
import test from "node:test";
import {
  bucketDefinition,
  deriveBalances,
  ensureLedgerAccount,
  ensurePlatformAccounts,
  ensureUserAccount,
  platformAccountCode,
  userAccountCode,
} from "@/lib/ledger/accounts";
import {
  decimalStringFromMinorUnits,
  LedgerAmountError,
  LedgerPostingError,
  minorUnitsFromDecimalString,
  parseMinorUnits,
  postLedgerTransaction,
  reversingPostings,
  type LedgerPosting,
  type PostLedgerTransactionInput,
} from "@/lib/ledger/integer-cent-ledger";
import { assertLedgerInvariants, checkLedgerInvariants, LedgerInvariantError, readLedgerHealth } from "@/lib/ledger/invariants";
import { buildStatement, readLedgerView, statementToCsv } from "@/lib/ledger/statements";
import { InMemoryLedgerStore } from "./support/in-memory-ledger-store";

/**
 * The ledger of record.
 *
 * Four claims are exercised here, and each one is what the phase is graded on:
 *
 *  1. **Money is exact.** An amount is an integer count of minor units, a
 *     fractional one cannot enter, and a failing insert writes nothing.
 *  2. **A movement balances.** Debits equal credits per asset, or the writer
 *     refuses it before it writes — tested by asserting the store is untouched.
 *  3. **A balance is derived.** It is the sum of the entries on the account's own
 *     normal side and nothing else, so a reversal moves it back with a *new*
 *     entry rather than by removing one.
 *  4. **A statement reconciles.** Its total is the sum of its own lines, and its
 *     opening plus its net equals the derived balance at the end of the range.
 *
 * The store is the in-memory one, so the arithmetic and the refusal rules are
 * tested without a database; the Prisma implementation is the same interface.
 */

const USER = "user-1";
const NOW = new Date("2026-10-16T12:00:00.000Z");
const USDT = { asset: "USDT", decimals: 6 };

/**
 * An account holder with an available account and the platform's counterparties,
 * as the ids a posting names.
 */
async function funded(store: InMemoryLedgerStore) {
  const user = await ensureUserAccount(store, { userId: USER, ...USDT });
  const platform = await ensurePlatformAccounts(store, USDT);
  const treasury = platform.find((account) => account.bucket === "TREASURY");
  const fees = platform.find((account) => account.bucket === "FEES");
  const depositsPending = platform.find((account) => account.bucket === "DEPOSITS_PENDING");
  assert.ok(treasury && fees && depositsPending);
  return { user: user.row.id, treasury: treasury!.id, fees: fees!.id, depositsPending: depositsPending!.id };
}

/** Every leg of one transaction — what a reversal has to compensate, all of it. */
function legsOf(store: InMemoryLedgerStore, transactionId: string) {
  return store.entries.filter((entry) => entry.transactionId === transactionId);
}

function credit(input: {
  idempotencyKey: string;
  amountMinor: string;
  occurredAt?: Date;
  accountIds: { user: string; treasury: string };
  idempotencyKind?: PostLedgerTransactionInput["kind"];
}): PostLedgerTransactionInput {
  return {
    kind: input.idempotencyKind ?? "DEPOSIT_CREDITED",
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt ?? NOW,
    postings: [
      { accountId: input.accountIds.treasury, direction: "DEBIT", amountMinor: input.amountMinor },
      { accountId: input.accountIds.user, direction: "CREDIT", amountMinor: input.amountMinor },
    ],
  };
}

// ── money ────────────────────────────────────────────────────────────────────

test("an amount is an exact integer of minor units and a fractional one is refused", () => {
  assert.equal(parseMinorUnits("10500000"), BigInt(10_500_000));
  assert.equal(parseMinorUnits(BigInt(0)), BigInt(0));
  assert.equal(parseMinorUnits(12), BigInt(12));
  assert.equal(parseMinorUnits("  42  "), BigInt(42));

  // Every shape a value could arrive in that is not a whole count.
  for (const value of ["10.5", "1e6", "0x10", "1,000", "1_000", "10 5", "1.", ".5", "+10"]) {
    assert.throws(
      () => parseMinorUnits(value),
      (error: unknown) => error instanceof LedgerAmountError && error.code === "NOT_INTEGER",
      `${JSON.stringify(value)} must be refused as not an integer`,
    );
  }
  for (const value of [0.5, 10.5, 2 ** 53 + 2, Number.MAX_VALUE]) {
    assert.throws(
      () => parseMinorUnits(value),
      (error: unknown) => error instanceof LedgerAmountError && error.code === "NOT_INTEGER",
      `${value} must be refused as not a safe integer`,
    );
  }
  assert.throws(() => parseMinorUnits("-1"), (error: unknown) => error instanceof LedgerAmountError && error.code === "NEGATIVE");
  assert.throws(() => parseMinorUnits(-1), (error: unknown) => error instanceof LedgerAmountError && error.code === "NEGATIVE");
  assert.throws(() => parseMinorUnits(""), (error: unknown) => error instanceof LedgerAmountError && error.code === "EMPTY");
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, {}, null, undefined, []]) {
    assert.throws(
      () => parseMinorUnits(value),
      (error: unknown) =>
        error instanceof LedgerAmountError && (error.code === "NOT_A_NUMBER" || error.code === "EMPTY"),
      `${String(value)} must be refused as not a number`,
    );
  }
});

test("a human amount becomes minor units exactly, and the extra digit that cannot be represented is refused", () => {
  assert.equal(minorUnitsFromDecimalString("10.5", 6), "10500000");
  assert.equal(minorUnitsFromDecimalString("20", 6), "20000000");
  assert.equal(minorUnitsFromDecimalString("0.000001", 6), "1");
  assert.equal(minorUnitsFromDecimalString(".5", 6), "500000");
  assert.equal(minorUnitsFromDecimalString("1", 0), "1");
  assert.equal(decimalStringFromMinorUnits("10500000", 6), "10.5");
  assert.equal(decimalStringFromMinorUnits("1", 6), "0.000001");
  assert.equal(decimalStringFromMinorUnits("20000000", 6), "20");
  assert.equal(decimalStringFromMinorUnits("0", 6), "0");

  // Round-tripping is exact: the value that goes in is the value that comes back,
  // which is only true because nothing on the path is a floating-point number.
  for (const value of ["0", "1", "10.5", "123456.789012", "0.000001"]) {
    assert.equal(decimalStringFromMinorUnits(minorUnitsFromDecimalString(value, 6), 6), value);
  }

  // A sixth of a cent does not exist in a 6-decimal asset, and rounding it would
  // be a decision about somebody's money.
  assert.throws(
    () => minorUnitsFromDecimalString("10.0000001", 6),
    (error: unknown) => error instanceof LedgerAmountError && error.code === "NOT_INTEGER",
  );
  assert.throws(
    () => minorUnitsFromDecimalString("10.5", 0),
    (error: unknown) => error instanceof LedgerAmountError && error.code === "NOT_INTEGER",
  );
  assert.throws(
    () => minorUnitsFromDecimalString("1e6", 6),
    (error: unknown) => error instanceof LedgerAmountError && error.code === "NOT_A_NUMBER",
  );
});

// ── posting ──────────────────────────────────────────────────────────────────

test("a balanced transaction posts, with the accounts' own asset and scale on every leg", async () => {
  const store = new InMemoryLedgerStore();
  const accounts = await funded(store);

  const outcome = await postLedgerTransaction(store, credit({ idempotencyKey: "k1", amountMinor: "10500000", accountIds: accounts }));
  assert.equal(outcome.posted, true);
  assert.equal(outcome.reason, null);
  assert.equal(store.transactions.length, 1);
  assert.equal(store.entries.length, 2);
  assert.deepEqual(
    store.entries.map((entry) => [entry.asset, entry.decimals, entry.direction, entry.amountMinor, entry.sequence]),
    [
      ["USDT", 6, "DEBIT", "10500000", 1],
      ["USDT", 6, "CREDIT", "10500000", 2],
    ],
  );
  assert.equal(store.transactions[0]?.kind, "DEPOSIT_CREDITED");
});

test("an unbalanced transaction is refused before anything is written", async () => {
  const store = new InMemoryLedgerStore();
  const accounts = await funded(store);

  await assert.rejects(
    postLedgerTransaction(store, {
      kind: "DEPOSIT_CREDITED",
      idempotencyKey: "unbalanced",
      occurredAt: NOW,
      postings: [
        { accountId: accounts.treasury, direction: "DEBIT", amountMinor: "10500000" },
        { accountId: accounts.user, direction: "CREDIT", amountMinor: "10499999" },
      ],
    }),
    (error: unknown) => error instanceof LedgerPostingError && error.code === "NOT_BALANCED",
  );
  // The refusal is the point: a store with no rows is a store that was never
  // asked to hold a movement that does not add up.
  assert.equal(store.transactions.length, 0);
  assert.equal(store.entries.length, 0);
});

test("a fractional amount cannot enter the ledger at all", async () => {
  const store = new InMemoryLedgerStore();
  const accounts = await funded(store);

  await assert.rejects(
    postLedgerTransaction(store, {
      kind: "DEPOSIT_CREDITED",
      idempotencyKey: "fractional",
      occurredAt: NOW,
      postings: [
        { accountId: accounts.treasury, direction: "DEBIT", amountMinor: "10.5" },
        { accountId: accounts.user, direction: "CREDIT", amountMinor: "10.5" },
      ],
    }),
    (error: unknown) => error instanceof LedgerAmountError && error.code === "NOT_INTEGER",
  );
  assert.equal(store.transactions.length, 0);
  assert.equal(store.entries.length, 0);
});

test("the structure of a movement is checked, and each refusal names what is wrong", async () => {
  const store = new InMemoryLedgerStore();
  const accounts = await funded(store);
  const other = await ensurePlatformAccounts(store, { asset: "ETH", decimals: 18 });
  const feesOnEth = other.find((account) => account.bucket === "FEES");
  assert.ok(feesOnEth);

  const cases: { name: string; input: PostLedgerTransactionInput; code: string }[] = [
    {
      name: "a single leg",
      input: { ...credit({ idempotencyKey: "one", amountMinor: "1", accountIds: accounts }),        postings: [{ accountId: accounts.user, direction: "CREDIT", amountMinor: "1" }] },
      code: "NO_POSTINGS",
    },
    {
      name: "debits only",
      input: {
        ...credit({ idempotencyKey: "debits", amountMinor: "1", accountIds: accounts }),
        postings: [
          { accountId: accounts.treasury, direction: "DEBIT", amountMinor: "1" },
          { accountId: accounts.user, direction: "DEBIT", amountMinor: "1" },
        ],
      },
      code: "SINGLE_LEG",
    },
    {
      name: "a zero leg",
      input: {
        ...credit({ idempotencyKey: "zero", amountMinor: "1", accountIds: accounts }),
        postings: [
          { accountId: accounts.treasury, direction: "DEBIT", amountMinor: "0" },
          { accountId: accounts.user, direction: "CREDIT", amountMinor: "0" },
        ],
      },
      code: "AMOUNT_NOT_POSITIVE",
    },
    {
      name: "two assets in one movement",
      input: {
        ...credit({ idempotencyKey: "mixed", amountMinor: "1", accountIds: accounts }),
        postings: [
          { accountId: accounts.treasury, direction: "DEBIT", amountMinor: "1" },
          { accountId: feesOnEth!.id, direction: "CREDIT", amountMinor: "1" },
        ],
      },
      code: "MIXED_ASSETS",
    },
    {
      name: "no idempotency key",
      input: { ...credit({ idempotencyKey: "  ", amountMinor: "1", accountIds: accounts }) },
      code: "MISSING_IDEMPOTENCY_KEY",
    },
    {
      name: "an unknown kind",
      input: { ...credit({ idempotencyKey: "kind", amountMinor: "1", accountIds: accounts }), kind: "SOMETHING_ELSE" as never },
      code: "UNKNOWN_KIND",
    },
    {
      name: "an invalid timestamp",
      input: { ...credit({ idempotencyKey: "when", amountMinor: "1", accountIds: accounts }), occurredAt: new Date("nonsense") },
      code: "INVALID_TIMESTAMP",
    },
    {
      name: "an account that does not exist",
      input: {
        ...credit({ idempotencyKey: "ghost", amountMinor: "1", accountIds: accounts }),
        postings: [
          { accountId: "ledger-account-that-never-was", direction: "DEBIT", amountMinor: "1" },
          { accountId: accounts.user, direction: "CREDIT", amountMinor: "1" },
        ],
      },
      code: "ACCOUNT_NOT_FOUND",
    },
    {
      name: "a reversal of a transaction that does not exist",
      input: { ...credit({ idempotencyKey: "reverses", amountMinor: "1", accountIds: accounts }), reversesTransactionId: "ledger-transaction-nope" },
      code: "REVERSAL_TARGET_NOT_FOUND",
    },
  ];

  for (const scenario of cases) {
    await assert.rejects(
      postLedgerTransaction(store, scenario.input),
      (error: unknown) => error instanceof LedgerPostingError && error.code === scenario.code,
      scenario.name,
    );
  }
  // Nine refusals, and not one of them left a row behind.
  assert.equal(store.transactions.length, 0);
  assert.equal(store.entries.length, 0);
});

test("posting the same key twice posts one movement and reports the first one", async () => {
  const store = new InMemoryLedgerStore();
  const accounts = await funded(store);

  const first = await postLedgerTransaction(store, credit({ idempotencyKey: "deposit:d1:credit", amountMinor: "10500000", accountIds: accounts }));
  const second = await postLedgerTransaction(store, credit({ idempotencyKey: "deposit:d1:credit", amountMinor: "10500000", accountIds: accounts }));

  assert.equal(first.posted, true);
  assert.equal(second.posted, false);
  assert.equal(second.transactionId, first.transactionId);
  assert.equal(second.reason?.code, "ALREADY_COMPLETED");
  assert.match(second.reason?.message ?? "", /was already posted/);
  assert.equal(store.transactions.length, 1);
  assert.equal(store.entries.length, 2);
});

// ── balances ─────────────────────────────────────────────────────────────────

test("a balance is the sum of the entries on the account's own normal side, and a reversal moves it back with a new entry", async () => {
  const store = new InMemoryLedgerStore();
  const accounts = await funded(store);

  // The taxonomy decides the arithmetic: a holder's claim is credit-normal (the
  // platform owes it) and the treasury is debit-normal (an asset).
  assert.equal(bucketDefinition("AVAILABLE").normalDirection, "CREDIT");
  assert.equal(bucketDefinition("TREASURY").normalDirection, "DEBIT");

  const credited = await postLedgerTransaction(store, credit({ idempotencyKey: "credit", amountMinor: "10500000", accountIds: accounts }));
  const afterCredit = deriveBalances({ accounts: await store.listAccounts(), entries: store.entries });
  const userAfterCredit = afterCredit.find((balance) => balance.accountId === accounts.user);
  const treasuryAfterCredit = afterCredit.find((balance) => balance.accountId === accounts.treasury);
  assert.equal(userAfterCredit?.balanceMinor, BigInt(10_500_000));
  assert.equal(userAfterCredit?.decimal, "10.5");
  assert.equal(userAfterCredit?.entryCount, 1);
  assert.equal(treasuryAfterCredit?.balanceMinor, BigInt(10_500_000));

  const original = legsOf(store, credited.transactionId);
  const reversal = await postLedgerTransaction(store, {
    kind: "DEPOSIT_REVERSED",
    idempotencyKey: "credit:reversal",
    occurredAt: NOW,
    reversesTransactionId: credited.transactionId,
    postings: reversingPostings(original),
  });
  assert.equal(reversal.posted, true);

  const afterReversal = deriveBalances({ accounts: await store.listAccounts(), entries: store.entries });
  assert.equal(afterReversal.find((balance) => balance.accountId === accounts.user)?.balanceMinor, BigInt(0));
  assert.equal(afterReversal.find((balance) => balance.accountId === accounts.treasury)?.balanceMinor, BigInt(0));
  // Both entries are still there: nothing was edited and nothing was deleted.
  assert.equal(store.entries.length, 4);
  assert.equal(store.transactions.length, 2);
  assert.equal(store.transactions[1]?.reversesTransactionId, credited.transactionId);
  // And the compensation is the original with each direction flipped.
  assert.deepEqual(
    store.entriesForAccount(accounts.user).map((entry) => [entry.direction, entry.amountMinor]),
    [
      ["CREDIT", "10500000"],
      ["DEBIT", "10500000"],
    ],
  );
});

test("an account is issued once, whatever the taxonomy says about it, and the platform's counterparties come as a set", async () => {
  const store = new InMemoryLedgerStore();
  const first = await ensureUserAccount(store, { userId: USER, ...USDT });
  const second = await ensureUserAccount(store, { userId: USER, ...USDT });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.row.id, first.row.id);
  assert.equal(first.row.code, userAccountCode(USER, "USDT"));
  assert.equal(store.accounts.length, 1);

  const platform = await ensurePlatformAccounts(store, USDT);
  assert.deepEqual(platform.map((account) => account.bucket), ["TREASURY", "DEPOSITS_PENDING", "FEES"]);
  assert.deepEqual(platform.map((account) => account.code), [
    platformAccountCode("TREASURY", "USDT"),
    platformAccountCode("DEPOSITS_PENDING", "USDT"),
    platformAccountCode("FEES", "USDT"),
  ]);
  // Issuing again adds nothing: the counterparty set is a set.
  await ensurePlatformAccounts(store, USDT);
  assert.equal(store.accounts.length, 4);

  // An account whose bucket belongs to somebody else is refused rather than
  // written, because its normal side would be a guess.
  await assert.rejects(
    ensureLedgerAccount(store, { code: "user:user-1:TREASURY", ownerType: "USER", bucket: "TREASURY", asset: "USDT", decimals: 6, userId: USER }),
    /belongs to PLATFORM/,
  );
  await assert.rejects(
    ensureLedgerAccount(store, { code: "user:user-1:USDT:available", ownerType: "USER", bucket: "AVAILABLE", asset: "USDT", decimals: 6, userId: null }),
    /needs the user/,
  );
  assert.equal(store.accounts.length, 4);
});

test("a declared bucket holds nothing rather than being missing, and every declared bucket can be posted to", async () => {
  const store = new InMemoryLedgerStore();
  const accounts = await funded(store);
  const balances = deriveBalances({ accounts: await store.listAccounts(), entries: store.entries });
  // Four accounts, no movements: every one of them reports zero rather than
  // being absent, so "nothing has been posted" is a figure and not a gap.
  assert.deepEqual(
    balances
      .filter((balance) => balance.asset === "USDT")
      .map((balance) => [balance.bucket, balance.balanceMinorText, balance.entryCount])
      .sort(),
    [
      ["AVAILABLE", "0", 0],
      ["DEPOSITS_PENDING", "0", 0],
      ["FEES", "0", 0],
      ["TREASURY", "0", 0],
    ],
  );

  // Every declared bucket is a real address for money: a fee is posted to the fee
  // account and the taxonomy says which side increases it.
  const posted: LedgerPosting[] = [
    { accountId: accounts.user, direction: "DEBIT", amountMinor: "2500" },
    { accountId: accounts.fees, direction: "CREDIT", amountMinor: "2500" },
  ];
  const outcome = await postLedgerTransaction(store, { kind: "DEPOSIT_CREDITED", idempotencyKey: "fee-probe", occurredAt: NOW, postings: posted });
  assert.equal(outcome.posted, true);
  const after = deriveBalances({ accounts: await store.listAccounts(), entries: store.entries });
  assert.equal(after.find((balance) => balance.accountId === accounts.fees)?.balanceMinor, BigInt(2500));
  assert.equal(after.find((balance) => balance.accountId === accounts.fees)?.decimal, "0.0025");
});

// ── statements ───────────────────────────────────────────────────────────────

test("a statement names every movement with its counterparty, and its total is the sum of its own lines", async () => {
  const store = new InMemoryLedgerStore();
  const accounts = await funded(store);
  const credited = await postLedgerTransaction(store, credit({ idempotencyKey: "credit", amountMinor: "10500000", accountIds: accounts }));
  await postLedgerTransaction(store, {
    kind: "DEPOSIT_REVERSED",
    idempotencyKey: "credit:reversal",
    occurredAt: new Date("2026-10-16T13:00:00.000Z"),
    reversesTransactionId: credited.transactionId,
    postings: reversingPostings(legsOf(store, credited.transactionId)),
  });

  const view = await readLedgerView(store, { userId: USER, from: new Date("2026-10-16T00:00:00.000Z"), to: new Date("2026-10-16T23:59:59.999Z") });
  assert.deepEqual(
    view.statement.lines.map((line) => [line.kind, line.direction, line.amountMinor, line.counterpartyCode]),
    [
      ["DEPOSIT_CREDITED", "CREDIT", "10500000", "platform:treasury:USDT"],
      ["DEPOSIT_REVERSED", "DEBIT", "10500000", "platform:treasury:USDT"],
    ],
  );
  // Every line carries the transaction it belongs to, so it can be looked up.
  assert.ok(view.statement.lines.every((line) => line.transactionId.startsWith("ledger-transaction-")));
  assert.equal(view.statement.lines[0]?.counterpartyLabel, "USDT treasury");
  assert.equal(view.statement.lines[1]?.reversesTransactionId, credited.transactionId);

  const total = view.statement.totals[0]!;
  assert.deepEqual(
    { asset: total.asset, in: total.inMinor, out: total.outMinor, net: total.netMinor, opening: total.openingMinor, closing: total.closingMinor },
    { asset: "USDT", in: "10500000", out: "10500000", net: "0", opening: "0", closing: "0" },
  );
  // The acceptance criterion, stated as arithmetic: the total *is* the sum of the
  // lines, folded here from the lines rather than read from the total.
  const folded = view.statement.lines.reduce((running, line) => running + line.signedMinor, BigInt(0));
  assert.equal(BigInt(total.netMinor) * (folded < BigInt(0) ? -BigInt(1) : BigInt(1)), folded < BigInt(0) ? -folded : folded);
  assert.equal(folded, BigInt(0));
  // The account holder's own derived balance agrees with the statement's closing
  // figure — the same function applied to a different cut of the same entries.
  assert.equal(view.balances.find((balance) => balance.asset === "USDT")?.balanceMinor, BigInt(0));
  // And the platform's side is visible, so a counterparty can be looked up.
  assert.equal(view.platform.find((balance) => balance.bucket === "TREASURY")?.balanceMinor, BigInt(0));
});

test("a range that excludes the movements is empty, while the closing figure still reconciles", async () => {
  const store = new InMemoryLedgerStore();
  const accounts = await funded(store);
  await postLedgerTransaction(store, credit({ idempotencyKey: "credit", amountMinor: "10500000", accountIds: accounts }));

  const view = await readLedgerView(store, { userId: USER, from: new Date("2026-10-01T00:00:00.000Z"), to: new Date("2026-10-15T23:59:59.999Z") });
  assert.equal(view.statement.lines.length, 0);
  assert.equal(view.statement.totals.length, 0);
  // Out of range but not forgotten: the balance is derived from all of it.
  assert.equal(view.balances.find((balance) => balance.asset === "USDT")?.balanceMinor, BigInt(10_500_000));

  // Now with the range that opens before the movement: the opening figure is the
  // entries before it (none), the net is the movement, and the closing figure is
  // the derived balance — the three numbers a statement exists to tie together.
  const covering = await readLedgerView(store, { userId: USER, from: new Date("2026-10-01T00:00:00.000Z"), to: new Date("2026-10-16T23:59:59.999Z") });
  const total = covering.statement.totals[0]!;
  assert.deepEqual(
    { opening: total.openingMinor, net: total.netMinor, closing: total.closingMinor },
    { opening: "0", net: "10500000", closing: "10500000" },
  );
  assert.equal(BigInt(total.openingMinor) + BigInt(total.netMinor), BigInt(total.closingMinor));
});

test("the CSV export is the statement's own rows with its total on the last line", async () => {
  const store = new InMemoryLedgerStore();
  const accounts = await funded(store);
  await postLedgerTransaction(store, credit({ idempotencyKey: "credit", amountMinor: "10500000", accountIds: accounts }));

  const view = await readLedgerView(store, { userId: USER, from: new Date("2026-10-01T00:00:00.000Z"), to: new Date("2026-10-16T23:59:59.999Z") });
  const csv = statementToCsv(view.statement);
  const rows = csv.trim().split("\n");
  assert.equal(rows[0], "occurredAt,transactionId,kind,asset,amount,direction,account,counterparty,source,memo");
  assert.equal(rows.length, 3, "a header, one line per entry, and one total row");
  assert.match(
    rows[1] ?? "",
    /^2026-10-16T12:00:00\.000Z,ledger-transaction-\d+,DEPOSIT_CREDITED,USDT,10\.5,CREDIT,user:user-1:USDT:available,platform:treasury:USDT,,$/,
  );
  const totalRow = rows[2]!.split(",");
  assert.equal(totalRow[2], "TOTAL");
  assert.equal(totalRow[3], "USDT");
  // The number in the file is the number on the screen.
  assert.equal(totalRow[4], view.statement.totals[0]?.netDecimal);
  // The last cell carries the range's arithmetic. It is quoted because it holds
  // commas, which is what a CSV cell with commas in it must be.
  assert.match(rows[2] ?? "", /"in 10\.5, out 0, opening 0, closing 10\.5"$/);
});

test("the statement bare-builder refuses nothing but reports what it was given", () => {
  // `buildStatement` is pure, so a caller can ask "what would the statement be"
  // without a store; here it is handed nothing at all and says so.
  const statement = buildStatement({
    userId: USER,
    from: new Date("2026-10-16T00:00:00.000Z"),
    to: new Date("2026-10-16T23:59:59.999Z"),
    accounts: [],
    ownEntries: [],
    siblings: [],
    accountById: new Map(),
  });
  assert.deepEqual({ lines: statement.lines.length, totals: statement.totals.length, headline: statement.headline }, { lines: 0, totals: 0, headline: null });
});

// ── invariants ───────────────────────────────────────────────────────────────

test("the invariants hold on a sound ledger and are reported with what was checked", async () => {
  const store = new InMemoryLedgerStore();
  const accounts = await funded(store);
  await postLedgerTransaction(store, credit({ idempotencyKey: "credit", amountMinor: "10500000", accountIds: accounts }));
  await postLedgerTransaction(store, {
    kind: "DEPOSIT_REVERSED",
    idempotencyKey: "credit:reversal",
    occurredAt: NOW,
    reversesTransactionId: store.transactions[0]!.id,
    postings: reversingPostings(legsOf(store, store.transactions[0]!.id)),
  });

  const report = await checkLedgerInvariants(store, { now: NOW });
  assert.equal(report.ok, true);
  assert.equal(report.reason, null);
  assert.deepEqual(report.counts, { accounts: 4, transactions: 2, entries: 4 });
  assert.deepEqual(report.checks.map((check) => [check.id, check.ok]), [
    ["TRANSACTIONS_BALANCED", true],
    ["LEDGER_BALANCED", true],
    ["NO_ORPHAN_ENTRY", true],
    ["NO_OVERDRAWN_ACCOUNT", true],
  ]);
  // Ledger-wide sums, so a credit and its reversal each contribute: 10.5 moved
  // twice, in both directions, and the two sides still agree.
  assert.deepEqual(report.totals.map((total) => [total.asset, total.debitMinor, total.creditMinor, total.balanced]), [
    ["USDT", "21000000", "21000000", true],
  ]);

  const health = await readLedgerHealth(store, { now: NOW });
  assert.equal(health.status, "reachable");
  assert.match(health.detail, /4 entr\(ies\) across 2 transaction\(s\) and 4 account\(s\)/);
});

test("a corrupted entry fails the check loudly, naming the row rather than reporting a healthy book", async () => {
  const store = new InMemoryLedgerStore();
  const accounts = await funded(store);
  await postLedgerTransaction(store, credit({ idempotencyKey: "credit", amountMinor: "10500000", accountIds: accounts }));
  assert.equal((await checkLedgerInvariants(store)).ok, true);

  // Corruption the writer cannot produce: one leg of a balanced movement vanishes
  // from underneath it. This is exactly the state a check has to catch, because
  // nothing in the application would notice it on its own.
  store.corruptRemoveEntry(store.entries[0]!.id);
  const report = await checkLedgerInvariants(store, { now: NOW });
  assert.equal(report.ok, false);
  assert.deepEqual([...new Set(report.violations.map((violation) => violation.check))].sort(), ["LEDGER_BALANCED", "TRANSACTIONS_BALANCED"]);
  assert.match(report.violations[0]!.detail, /debits 0 and credits 10500000 USDT minor units|USDT has 0 debited and 10\.5 credited/);
  assert.equal(report.reason?.code, "LEDGER_UNBALANCED");
  assert.equal(report.checks.find((check) => check.id === "TRANSACTIONS_BALANCED")?.ok, false);

  const health = await readLedgerHealth(store, { now: NOW });
  assert.equal(health.status, "degraded");
  assert.equal(health.violations.length, report.violations.length);

  // And the throwing form the runner uses carries the same reason, so a broken
  // book is a *failed* run rather than an idle one.
  await assert.rejects(
    assertLedgerInvariants(store),
    (error: unknown) => error instanceof LedgerInvariantError && error.reason.code === "LEDGER_UNBALANCED",
  );
});

test("an entry that belongs to nothing is an orphan, and an overdrawn holder needs a credit line", async () => {
  const store = new InMemoryLedgerStore();
  const accounts = await funded(store);
  await postLedgerTransaction(store, credit({ idempotencyKey: "credit", amountMinor: "500000", accountIds: accounts }));

  // A row that names a transaction and an account that do not exist — inserted
  // directly, which is what a half-applied write or a hand edit would look like.
  store.entries.push({
    id: "ledger-entry-orphan",
    transactionId: "ledger-transaction-missing",
    accountId: "ledger-account-missing",
    asset: "USDT",
    direction: "DEBIT",
    amountMinor: "1",
    decimals: 6,
    sequence: 1,
    createdAt: NOW,
  });
  const orphaned = await checkLedgerInvariants(store, { now: NOW });
  assert.equal(orphaned.ok, false);
  assert.equal(orphaned.violations.filter((violation) => violation.check === "NO_ORPHAN_ENTRY").length, 2);
  assert.equal(orphaned.violations.find((violation) => violation.check === "NO_ORPHAN_ENTRY")?.transactionId, "ledger-transaction-missing");
  store.entries.pop();

  // Money leaving the account that never arrived: the holder goes negative, which
  // is a violation unless the account was explicitly given a credit line.
  await postLedgerTransaction(store, {
    kind: "DEPOSIT_REVERSED",
    idempotencyKey: "overdraw",
    occurredAt: NOW,
    postings: [
      { accountId: accounts.user, direction: "DEBIT", amountMinor: "600000" },
      { accountId: accounts.treasury, direction: "CREDIT", amountMinor: "600000" },
    ],
  });
  const overdrawn = await checkLedgerInvariants(store, { now: NOW });
  assert.equal(overdrawn.ok, false);
  assert.equal(overdrawn.violations.filter((violation) => violation.check === "NO_OVERDRAWN_ACCOUNT").length, 1);
  assert.equal(overdrawn.violations[0]?.accountCode, userAccountCode(USER, "USDT"));
  assert.match(overdrawn.violations[0]?.detail ?? "", /holds -0\.1 USDT/);

  // With an explicit credit line the same state is allowed, and the book is sound
  // again — the point of the invariant is that going negative is a decision, not
  // an accident.
  const account = store.accounts.find((candidate) => candidate.id === accounts.user)!;
  account.creditLineMinor = "1000000";
  const allowed = await checkLedgerInvariants(store, { now: NOW });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.violations.length, 0);
});

test("a stored amount that is not an integer is a loud failure rather than a rounded balance", async () => {
  const store = new InMemoryLedgerStore();
  const accounts = await funded(store);
  await postLedgerTransaction(store, credit({ idempotencyKey: "credit", amountMinor: "10500000", accountIds: accounts }));

  store.corruptEntryAmount(store.entries[0]!.id, "10.5");
  await assert.rejects(
    checkLedgerInvariants(store),
    (error: unknown) => error instanceof LedgerAmountError && error.code === "NOT_INTEGER",
  );
  assert.throws(
    () => deriveBalances({ accounts: store.accounts, entries: store.entries }),
    (error: unknown) => error instanceof LedgerAmountError,
  );
  assert.equal((await readLedgerHealth(store)).status, "unknown");
});
