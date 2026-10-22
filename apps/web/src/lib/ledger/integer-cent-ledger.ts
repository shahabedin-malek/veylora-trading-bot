import { reason, type Reason } from "@/lib/observability/reason";

/**
 * Money, exactly.
 *
 * Two ledgers live in this file and they are different things.
 *
 * The first is the **paper ledger** (phase 03): `IntegerCentLedgerEntry`, one
 * entry per movement, added up into the cash/P&L/fees a paper bot reports. It is
 * an accounting convenience for the simulated venue and nothing else reads it.
 *
 * The second is the **ledger of record** (phase 13), and everything below the
 * money helpers is it: double-entry transactions whose debits and credits add up
 * in the asset's smallest unit, with every amount an exact integer that no step of
 * the path may round. That is why amounts are `MinorUnits` (a string of digits)
 * and every operation in the arithmetic below runs on `bigint`:
 *
 *   - a JS `number` is a double, so `0.1 + 0.2` is a real bug waiting in a
 *     balance, and a 6-decimal token amount would be silently rounded past
 *     2^53 minor units;
 *   - `@prisma/client`'s `Int` is 32 bits wide, and the SQLite development
 *     schema cannot represent `BigInt`, so the *column* is text;
 *   - reading that text back is therefore a parse, and the parse is where a
 *     fractional value has to be refused rather than truncated. {@link parseMinorUnits}
 *     is that door, and it is the only one: nothing else in this file builds a
 *     `bigint` out of an untrusted value.
 *
 * A refusal here is a typed error ({@link LedgerAmountError}) rather than a
 * generic one, because the caller has to be able to tell the owner *which* value
 * was wrong and *how* — "an amount of 10.5 USDT cannot be posted" is an answer,
 * and "invalid input" is not.
 */

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

// ─────────────────────────────────────────────────────────────────────────────
// Minor units: the only arithmetic a balance is allowed to be made of.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An exact, non-negative integer count of an asset's smallest unit.
 *
 * Stored and passed as a string of digits: `"10500000"` is 10.5 USDT. There is no
 * decimal point in the type, which is the point — a value that cannot be written
 * as this cannot be ledger money.
 */
export type MinorUnits = string;

/** What a value can be wrong about. Each one is a different sentence to the owner. */
export const LEDGER_AMOUNT_CODES = ["EMPTY", "NOT_INTEGER", "NEGATIVE", "NOT_A_NUMBER"] as const;
export type LedgerAmountCode = (typeof LEDGER_AMOUNT_CODES)[number];

const AMOUNT_MESSAGES: Record<LedgerAmountCode, string> = {
  EMPTY: "The amount is empty.",
  NOT_INTEGER: "The amount is not a whole number of the asset's smallest unit.",
  NEGATIVE: "The amount is negative; the direction of a movement says which way it goes, not its sign.",
  NOT_A_NUMBER: "The amount is not a number at all.",
};

/**
 * The one refusal a fractional amount meets on its way into a ledger.
 *
 * The `code` is what a caller branches on and what a test asserts; `input` is the
 * value as it arrived, kept so the message can name it without the caller having
 * to reconstruct it.
 */
export class LedgerAmountError extends Error {
  readonly code: LedgerAmountCode;
  readonly input: string;

  constructor(input: string, code: LedgerAmountCode, detail?: string) {
    super(`${AMOUNT_MESSAGES[code]}${detail ? ` ${detail}` : ""} Received ${JSON.stringify(input)}.`);
    this.name = "LedgerAmountError";
    this.code = code;
    this.input = input;
  }
}

const DIGITS = /^[0-9]+$/;

/**
 * Read a value as an exact count of minor units, or refuse it.
 *
 * Strings are the shape an amount is stored and transported in, and they are
 * validated against `^[0-9]+$` — so `"10.5"`, `"1e6"`, `"0x10"`, `"10,5"`, `""`
 * and `" 12 "` are all refusals rather than parses, and a leading `-` is refused
 * as NEGATIVE rather than being allowed to flip a movement's direction. Numbers
 * are accepted only when they are safe integers (`0.5`, `NaN`, `Infinity` and
 * `2**53` are not), and bigints are accepted as themselves. Nothing is rounded
 * and nothing is coerced through a float on the way in.
 */
export function parseMinorUnits(input: unknown): bigint {
  if (typeof input === "bigint") {
    if (input < BigInt(0)) throw new LedgerAmountError(input.toString(), "NEGATIVE");
    return input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new LedgerAmountError(String(input), "NOT_A_NUMBER");
    if (!Number.isSafeInteger(input)) {
      throw new LedgerAmountError(
        String(input),
        "NOT_INTEGER",
        "Only safe integers can be minor units; pass the exact value as a string.",
      );
    }
    if (input < 0) throw new LedgerAmountError(String(input), "NEGATIVE");
    return BigInt(input);
  }
  if (typeof input !== "string") {
    throw new LedgerAmountError(String(input), "NOT_A_NUMBER");
  }
  const value = input.trim();
  if (value.length === 0) throw new LedgerAmountError(input, "EMPTY");
  if (!DIGITS.test(value)) {
    throw new LedgerAmountError(input, value.startsWith("-") ? "NEGATIVE" : "NOT_INTEGER");
  }
  return BigInt(value);
}

/** The same value said the way it is stored: digits, no grouping, no exponent. */
export function formatMinorUnits(value: bigint): MinorUnits {
  if (value < BigInt(0)) throw new LedgerAmountError(value.toString(), "NEGATIVE");
  return value.toString();
}

/** Add exact minor units. The only sum the money path uses. */
export function sumMinorUnits(values: Iterable<bigint>): bigint {
  let total = BigInt(0);
  for (const value of values) total += value;
  return total;
}

/**
 * Turn the human amount a transfer was for into minor units, exactly.
 *
 * `"10.5"` with 6 decimals is `"10500000"`: the digits are moved, never multiplied
 * by a float. A value with more decimal places than the asset has is refused
 * rather than rounded, because rounding someone's money is a decision this code
 * has no business making — and a value in exponent form (`"1e6"`) is refused too,
 * since it is exactly the kind of input a float would have produced.
 */
export function minorUnitsFromDecimalString(amount: string, decimals: number): MinorUnits {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new LedgerAmountError(String(decimals), "NOT_INTEGER", `${decimals} is not a usable decimal count (0–36).`);
  }
  const value = typeof amount === "string" ? amount.trim() : "";
  if (value.length === 0) throw new LedgerAmountError(String(amount), "EMPTY");
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(value);
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) {
    throw new LedgerAmountError(value, "NOT_A_NUMBER");
  }
  const [, sign, whole = "", fraction = ""] = match;
  if (sign === "-") throw new LedgerAmountError(value, "NEGATIVE");
  if (fraction.length > decimals) {
    throw new LedgerAmountError(
      value,
      "NOT_INTEGER",
      `${whole || "0"}.${fraction} has ${fraction.length} decimal places and this asset has ${decimals}.`,
    );
  }
  const scaled = `${whole || "0"}${fraction.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return scaled;
}

/** The human amount a count of minor units is, for a surface that has to show it. */
export function decimalStringFromMinorUnits(value: MinorUnits, decimals: number): string {
  const digits = parseMinorUnits(value).toString();
  if (decimals === 0) return digits;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

// ─────────────────────────────────────────────────────────────────────────────
// The double-entry transaction: what it is, and what makes it refusable.
// ─────────────────────────────────────────────────────────────────────────────

export const MONEY_DIRECTIONS = ["DEBIT", "CREDIT"] as const;
export type MoneyDirection = (typeof MONEY_DIRECTIONS)[number];

export function isMoneyDirection(value: unknown): value is MoneyDirection {
  return typeof value === "string" && (MONEY_DIRECTIONS as readonly string[]).includes(value);
}

/** The other side of the same movement — what a reversal is written in terms of. */
export function oppositeDirection(direction: MoneyDirection): MoneyDirection {
  return direction === "DEBIT" ? "CREDIT" : "DEBIT";
}

/**
 * The kinds of movement this build can post.
 *
 * A closed set, checked on the way in: a transaction kind is what a statement,
 * an invariant and an audit read, so a typo in it is a lie rather than a string.
 * Phase 14 adds the withdrawal trio below rather than inventing a parallel enum,
 * and the kinds here are the whole set this build posts.
 *
 * The three withdrawal kinds are deliberately three and not one: reserving,
 * releasing and settling are three different facts about the owner's money, and a
 * single "withdrawal" kind would leave a statement, an audit and an invariant check
 * unable to tell "this amount is held" from "this amount left".
 *
 * `PERFORMANCE_FEE` is phase 16's own kind rather than a use of
 * `WITHDRAWAL_SETTLED`: a strategy result paying the platform is not a transfer to
 * a wallet, and a statement that could not tell the two apart would report a fee as
 * money leaving the account to an address that does not exist. It is debited from
 * the owner's `AVAILABLE` account and credited to `FEES` in one balanced movement,
 * and its reversal is the same kind referencing the original.
 */
export const LEDGER_TRANSACTION_KINDS = [
  "DEPOSIT_CREDITED",
  "DEPOSIT_REVERSED",
  "WITHDRAWAL_RESERVED",
  "WITHDRAWAL_RELEASED",
  "WITHDRAWAL_SETTLED",
  "PERFORMANCE_FEE",
  /**
   * A balanced correction written from the admin console (phase 34). It is a
   * movement of its own rather than a reuse of `DEPOSIT_CREDITED`: a statement
   * that called a manual correction a deposit would report chain money that
   * never arrived, and the audit row names the operator who wrote it.
   */
  "ADMIN_CORRECTION",
] as const;
export type LedgerTransactionKind = (typeof LEDGER_TRANSACTION_KINDS)[number];

export function isLedgerTransactionKind(value: unknown): value is LedgerTransactionKind {
  return typeof value === "string" && (LEDGER_TRANSACTION_KINDS as readonly string[]).includes(value);
}

/** Why a transaction could not be posted. Each code is a different refusal. */
export const LEDGER_POSTING_CODES = [
  "NO_POSTINGS",
  "SINGLE_LEG",
  "AMOUNT_NOT_POSITIVE",
  "MIXED_ASSETS",
  "NOT_BALANCED",
  "UNKNOWN_KIND",
  "MISSING_IDEMPOTENCY_KEY",
  "INVALID_TIMESTAMP",
  "ACCOUNT_NOT_FOUND",
  "REVERSAL_TARGET_NOT_FOUND",
] as const;
export type LedgerPostingCode = (typeof LEDGER_POSTING_CODES)[number];

const POSTING_MESSAGES: Record<LedgerPostingCode, string> = {
  NO_POSTINGS: "A transaction needs at least two postings.",
  SINGLE_LEG: "A transaction needs at least one debit and one credit.",
  AMOUNT_NOT_POSITIVE: "Every posting must be for more than zero.",
  MIXED_ASSETS: "A transaction moves one asset; post two transactions instead of mixing assets in one.",
  NOT_BALANCED: "The transaction's debits and credits do not add up in the asset's minor units.",
  UNKNOWN_KIND: "The transaction kind is not one this build posts.",
  MISSING_IDEMPOTENCY_KEY: "A transaction needs an idempotency key so posting it twice is impossible.",
  INVALID_TIMESTAMP: "The transaction's timestamp is not a date.",
  ACCOUNT_NOT_FOUND: "A posting names an account that does not exist.",
  REVERSAL_TARGET_NOT_FOUND: "A reversal names a transaction that does not exist.",
};

/**
 * The refusal an unbalanced (or otherwise unpostable) transaction meets.
 *
 * It carries the numbers, not just a verdict: a `NOT_BALANCED` refusal says what
 * the two sides were, because "your debits and credits do not match" without them
 * is not something an owner or an operator can act on.
 */
export class LedgerPostingError extends Error {
  readonly code: LedgerPostingCode;
  readonly detail?: string;

  constructor(code: LedgerPostingCode, detail?: string) {
    super(`${POSTING_MESSAGES[code]}${detail ? ` ${detail}` : ""}`);
    this.name = "LedgerPostingError";
    this.code = code;
    if (detail) this.detail = detail;
  }
}

export type LedgerAccountRow = {
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

export type LedgerTransactionRow = {
  id: string;
  kind: string;
  idempotencyKey: string;
  actorUserId: string | null;
  sourceType: string | null;
  sourceId: string | null;
  memo: string | null;
  occurredAt: Date;
  createdAt: Date;
  reversesTransactionId: string | null;
};

export type LedgerEntryRow = {
  id: string;
  transactionId: string;
  accountId: string;
  asset: string;
  direction: MoneyDirection;
  amountMinor: MinorUnits;
  decimals: number;
  sequence: number;
  createdAt: Date;
};

/** One leg, as the caller states it: which account, which way, how much. */
export type LedgerPosting = {
  accountId: string;
  direction: MoneyDirection;
  amountMinor: MinorUnits | bigint;
};

export type NewLedgerTransactionInput = {
  transaction: Omit<LedgerTransactionRow, "id" | "createdAt">;
  entries: Omit<LedgerEntryRow, "id" | "transactionId" | "createdAt">[];
};

export type InsertedLedgerTransaction = {
  created: boolean;
  row: LedgerTransactionRow;
  entryIds: string[];
};

/**
 * The persistence the writer needs, and nothing more.
 *
 * Deliberately three methods: the writer resolves the accounts it posts to, asks
 * whether this transaction already exists, and inserts it in one step. The insert
 * is the atomic unit — a transaction row is never observable without its entries
 * — which is what makes "balanced" a property of the stored data and not only of
 * the code that wrote it.
 */
export interface LedgerTransactionStore {
  findAccountById(id: string): Promise<LedgerAccountRow | null>;
  findTransactionByIdempotencyKey(key: string): Promise<LedgerTransactionRow | null>;
  findTransactionById(id: string): Promise<LedgerTransactionRow | null>;
  insertTransactionOnce(input: NewLedgerTransactionInput): Promise<InsertedLedgerTransaction>;
}

export type PostLedgerTransactionInput = {
  kind: LedgerTransactionKind;
  idempotencyKey: string;
  occurredAt: Date;
  postings: readonly LedgerPosting[];
  actorUserId?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  memo?: string | null;
  reversesTransactionId?: string | null;
};

export type PostLedgerTransactionOutcome =
  | { posted: true; transactionId: string; entryIds: string[]; reason: null }
  | { posted: false; transactionId: string; entryIds: string[]; reason: Reason };

/**
 * Post one balanced movement, exactly once.
 *
 * The order of operations is the correctness argument:
 *
 *   1. **Look up every account** the postings name. A name that does not resolve
 *      is refused (`ACCOUNT_NOT_FOUND`) before anything is written, and the
 *      accounts' own `asset`/`decimals` are what the entries record — so an entry
 *      cannot claim to be in a different asset from the account it sits on.
 *   2. **Balance it.** Amounts are parsed as exact minor units (a fractional one
 *      throws {@link LedgerAmountError}), the transaction must name exactly one
 *      asset, every leg must be positive, and the debits must equal the credits.
 *      Nothing has been written at this point.
 *   3. **Check the key.** A transaction with this idempotency key already exists,
 *      so its original result is returned and nothing is posted — the same
 *      `ALREADY_COMPLETED` answer every other exactly-once path in this app gives.
 *   4. **Insert once.** The store writes the transaction and its entries together
 *      and reports whether it won the race; losing it means another runner posted
 *      the same key in between, which is the same answer as step 3.
 *
 * The caller is expected to hold the idempotency key stable for the thing being
 * posted (`deposit:<id>:credit`), not to mint a new one per attempt: the key *is*
 * the claim.
 */
export async function postLedgerTransaction(
  store: LedgerTransactionStore,
  input: PostLedgerTransactionInput,
): Promise<PostLedgerTransactionOutcome> {
  const resolved = await resolvePostings(store, input);
  if (input.reversesTransactionId) {
    const target = await store.findTransactionById(input.reversesTransactionId);
    if (!target) throw new LedgerPostingError("REVERSAL_TARGET_NOT_FOUND", `No transaction ${input.reversesTransactionId}.`);
  }

  const existing = await store.findTransactionByIdempotencyKey(input.idempotencyKey);
  if (existing) {
    return {
      posted: false,
      transactionId: existing.id,
      entryIds: [],
      reason: reason("ALREADY_COMPLETED", {
        message: `A ${existing.kind} transaction for ${input.idempotencyKey} was already posted at ${existing.occurredAt.toISOString()}, so this one was not posted again.`,
        detail: existing.id,
      }),
    };
  }

  const inserted = await store.insertTransactionOnce({
    transaction: {
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      actorUserId: input.actorUserId ?? null,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      memo: input.memo ?? null,
      occurredAt: input.occurredAt,
      reversesTransactionId: input.reversesTransactionId ?? null,
    },
    entries: resolved,
  });

  if (!inserted.created) {
    return {
      posted: false,
      transactionId: inserted.row.id,
      entryIds: inserted.entryIds,
      reason: reason("ALREADY_COMPLETED", {
        message: `A ${inserted.row.kind} transaction for ${input.idempotencyKey} was posted by another run, so this one was not posted again.`,
        detail: inserted.row.id,
      }),
    };
  }

  return { posted: true, transactionId: inserted.row.id, entryIds: inserted.entryIds, reason: null };
}

/**
 * Validate a transaction and resolve its legs into stored entries.
 *
 * Exported because the validation is worth testing on its own — it is the whole
 * of "a balanced transaction is accepted and an unbalanced one is rejected" —
 * and because a caller that wants to know whether a movement *would* post can ask
 * without writing anything.
 */
export async function resolvePostings(
  store: LedgerTransactionStore,
  input: PostLedgerTransactionInput,
): Promise<Omit<LedgerEntryRow, "id" | "transactionId" | "createdAt">[]> {
  if (!input.idempotencyKey.trim()) throw new LedgerPostingError("MISSING_IDEMPOTENCY_KEY");
  if (!isLedgerTransactionKind(input.kind)) throw new LedgerPostingError("UNKNOWN_KIND", `Received ${JSON.stringify(input.kind)}.`);
  if (!(input.occurredAt instanceof Date) || !Number.isFinite(input.occurredAt.getTime())) {
    throw new LedgerPostingError("INVALID_TIMESTAMP");
  }
  if (input.postings.length < 2) throw new LedgerPostingError("NO_POSTINGS");

  const resolved: Omit<LedgerEntryRow, "id" | "transactionId" | "createdAt">[] = [];
  const debits: bigint[] = [];
  const credits: bigint[] = [];
  let asset: string | null = null;
  let decimals: number | null = null;

  for (const [index, posting] of input.postings.entries()) {
    if (!isMoneyDirection(posting.direction)) {
      throw new LedgerPostingError("SINGLE_LEG", `Posting ${index + 1} has no direction.`);
    }
    // Parsed before anything else touches it: this is where a fractional amount
    // stops, and it stops as a LedgerAmountError naming the offending value.
    const amount = parseMinorUnits(posting.amountMinor);
    if (amount === BigInt(0)) {
      throw new LedgerPostingError("AMOUNT_NOT_POSITIVE", `Posting ${index + 1} is for zero.`);
    }
    const account = await store.findAccountById(posting.accountId);
    if (!account) throw new LedgerPostingError("ACCOUNT_NOT_FOUND", `No ledger account ${posting.accountId}.`);

    if (asset === null) {
      asset = account.asset;
      decimals = account.decimals;
    } else if (asset !== account.asset) {
      throw new LedgerPostingError("MIXED_ASSETS", `${asset} and ${account.asset} were posted in one transaction.`);
    }

    (posting.direction === "DEBIT" ? debits : credits).push(amount);
    resolved.push({
      accountId: account.id,
      asset: account.asset,
      direction: posting.direction,
      amountMinor: formatMinorUnits(amount),
      decimals: account.decimals,
      sequence: index + 1,
    });
  }

  if (debits.length === 0 || credits.length === 0) throw new LedgerPostingError("SINGLE_LEG");

  const debitTotal = sumMinorUnits(debits);
  const creditTotal = sumMinorUnits(credits);
  if (debitTotal !== creditTotal) {
    throw new LedgerPostingError(
      "NOT_BALANCED",
      `Debits are ${debitTotal.toString()} and credits are ${creditTotal.toString()} ${asset} minor units.`,
    );
  }
  if (decimals === null) throw new LedgerPostingError("NO_POSTINGS");

  return resolved;
}

/**
 * A reversal, written as the compensating transaction it is.
 *
 * The reversed legs are the originals with each direction flipped, in the same
 * order and for the same amounts, so the pair sums to zero on every account it
 * touched. It is a *new* transaction that references the old one — which is the
 * only way a posted entry is ever undone here.
 */
export function reversingPostings(
  entries: readonly Pick<LedgerEntryRow, "accountId" | "direction" | "amountMinor">[],
): LedgerPosting[] {
  return entries.map((entry) => ({
    accountId: entry.accountId,
    direction: oppositeDirection(entry.direction),
    amountMinor: entry.amountMinor,
  }));
}
