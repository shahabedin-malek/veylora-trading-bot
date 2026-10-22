import type { LedgerAccountRow, MinorUnits, MoneyDirection } from "./integer-cent-ledger";
import { parseMinorUnits } from "./integer-cent-ledger";

/**
 * What an account in the ledger of record *is*: the taxonomy, and the two
 * questions everything else asks of it — how an account is named, and which side
 * of a movement increases it.
 *
 * The taxonomy is data, not branches. Every account is one of four buckets, each
 * bucket belongs to exactly one owner type and has exactly one normal side, and
 * the code below derives names from that rather than hard-coding strings at the
 * call sites:
 *
 *   AVAILABLE           a user's claim on the platform (CREDIT-normal: the platform
 *                       owes the account, so a credit increases it)
 *   WITHDRAWALS_RESERVED  a user's claim that is held against a withdrawal in
 *                       flight (CREDIT-normal), so it is still owed and no longer
 *                       spendable — see the note below
 *   TREASURY            money the platform holds from the outside world
 *                       (DEBIT-normal: an asset, increased by a debit)
 *   DEPOSITS_PENDING    receipts the platform has recorded and does not yet owe to
 *                       an account (CREDIT-normal)
 *   FEES                revenue the platform has kept (CREDIT-normal)
 *
 * **Why the hold is its own bucket and not a column.** A withdrawal has to make
 * the amount unspendable the instant it is requested, while leaving it *owed* —
 * the platform still has the owner's money, it has just promised it away. The two
 * facts are exactly the two figures this ledger derives, so they are two accounts:
 * the reservation debits `AVAILABLE` and credits `WITHDRAWALS_RESERVED`, and the
 * owner's total claim across both accounts is unchanged while the spendable one
 * falls. A `pendingWithdrawalMinor` column on a balance row could not do that —
 * there is no balance row, and a second place money is subtracted is a second
 * place to get it wrong. It is also what makes "two requests cannot spend the same
 * balance" an arithmetic fact rather than a check: the second request reads the
 * already-reduced available balance.
 *
 * Why this matters beyond tidiness: "no negative user balance" and "each movement
 * has a counterparty" are statements about *which accounts exist and which way
 * they move*, and a second, parallel idea of that in a route or a component is
 * how a ledger ends up with a balance nothing can reproduce.
 *
 * Phase 13 posts to `AVAILABLE` and `TREASURY`: a credited deposit debits the
 * treasury (the platform holds the funds) and credits the account (it owes them).
 * Phase 14 adds `WITHDRAWALS_RESERVED` and writes `FEES` — a confirmed withdrawal
 * debits the hold, credits the treasury by the amount actually sent and credits
 * `FEES` by the platform's cut, in one balanced movement, so a fee cannot be kept
 * without the transfer that earned it. `DEPOSITS_PENDING` is still declared and not
 * yet written: it is where a receipt goes when it has to be held without being owed
 * to an account, which is the reorg-reconciliation work phase 13's proof names as
 * outstanding. Every bucket is declared before the first movement that needs it,
 * because a bucket added mid-phase is a schema change and a migration rather than a
 * line in this file. The invariant check reports every account, so a bucket that
 * holds nothing reads as "declared, holds nothing" rather than as an account that
 * went missing.
 */

export const LEDGER_OWNER_TYPES = ["USER", "PLATFORM"] as const;
export type LedgerOwnerType = (typeof LEDGER_OWNER_TYPES)[number];

export const LEDGER_BUCKETS = ["AVAILABLE", "WITHDRAWALS_RESERVED", "TREASURY", "DEPOSITS_PENDING", "FEES"] as const;
export type LedgerBucket = (typeof LEDGER_BUCKETS)[number];

export type BucketDefinition = {
  bucket: LedgerBucket;
  ownerType: LedgerOwnerType;
  /** The side of a movement that increases this account. */
  normalDirection: MoneyDirection;
  /**
   * The bucket's slug inside an account code. Written out rather than derived from
   * `label`, so an account's code is a stable identity and not a rendering choice:
   * relabelling a bucket must never rename an account that already exists.
   */
  code: string;
  /** What the account is, for a label on a statement. */
  label: string;
  /** One sentence the balance surface can print under the figure. */
  description: string;
};

export const BUCKET_DEFINITIONS: readonly BucketDefinition[] = [
  {
    bucket: "AVAILABLE",
    ownerType: "USER",
    normalDirection: "CREDIT",
    code: "available",
    label: "available",
    description: "What this account holds: credited deposits the platform owes it.",
  },
  {
    bucket: "WITHDRAWALS_RESERVED",
    ownerType: "USER",
    normalDirection: "CREDIT",
    code: "withdrawal-reserved",
    label: "withdrawal reserved",
    description: "Still owed to the account, and held against a withdrawal in flight so it cannot be spent twice.",
  },
  {
    bucket: "TREASURY",
    ownerType: "PLATFORM",
    normalDirection: "DEBIT",
    code: "treasury",
    label: "treasury",
    description: "The funds the platform holds from the outside world.",
  },
  {
    bucket: "DEPOSITS_PENDING",
    ownerType: "PLATFORM",
    normalDirection: "CREDIT",
    code: "deposits-pending",
    label: "deposits pending",
    description: "Receipts the platform has recorded and does not yet owe to an account.",
  },
  {
    bucket: "FEES",
    ownerType: "PLATFORM",
    normalDirection: "CREDIT",
    code: "fees",
    label: "fees",
    description: "Revenue the platform has kept.",
  },
];

export function isLedgerBucket(value: unknown): value is LedgerBucket {
  return typeof value === "string" && (LEDGER_BUCKETS as readonly string[]).includes(value);
}

export function isLedgerOwnerType(value: unknown): value is LedgerOwnerType {
  return typeof value === "string" && (LEDGER_OWNER_TYPES as readonly string[]).includes(value);
}

export function bucketDefinition(bucket: LedgerBucket): BucketDefinition {
  const found = BUCKET_DEFINITIONS.find((candidate) => candidate.bucket === bucket);
  if (!found) throw new Error(`Ledger bucket ${bucket} has no definition.`);
  return found;
}

/**
 * An account this build cannot read is a hard error, not a row to guess about —
 * the same rule the deposit store applies to a status it does not know. An
 * account whose bucket is unrecognised would have an unknown normal side, and
 * every balance derived from it would be wrong in a way no surface could show.
 */
export function requireBucket(value: string): LedgerBucket {
  if (!isLedgerBucket(value)) throw new Error(`Stored ledger bucket ${JSON.stringify(value)} is not one this build understands.`);
  return value;
}

export function requireOwnerType(value: string): LedgerOwnerType {
  if (!isLedgerOwnerType(value)) throw new Error(`Stored ledger owner type ${JSON.stringify(value)} is not one this build understands.`);
  return value;
}

/** The code of a user-owned account: `user:<id>:<asset>:<bucket>`. */
export function userBucketAccountCode(userId: string, asset: string, bucket: LedgerBucket): string {
  const definition = bucketDefinition(bucket);
  if (definition.ownerType !== "USER") throw new Error(`${bucket} does not belong to an account holder.`);
  return `user:${userId}:${asset}:${definition.code}`;
}

/** The code of the account that holds one account's spendable one asset. */
export function userAccountCode(userId: string, asset: string): string {
  return userBucketAccountCode(userId, asset, "AVAILABLE");
}

/** The code of a platform account, e.g. `platform:treasury:USDT`. */
export function platformAccountCode(bucket: LedgerBucket, asset: string): string {
  const definition = bucketDefinition(bucket);
  if (definition.ownerType !== "PLATFORM") throw new Error(`${bucket} is not a platform bucket.`);
  return `platform:${definition.code}:${asset}`;
}

/**
 * Where the other side of a movement lands, for every platform bucket.
 *
 * The asset is all a code needs; the scale is carried on the account row itself
 * when it is issued, so a rendered entry never has to consult the token registry
 * for a number it already has.
 */
export function platformAccountsFor(asset: string): { code: string; bucket: LedgerBucket }[] {
  return BUCKET_DEFINITIONS.filter((definition) => definition.ownerType === "PLATFORM").map((definition) => ({
    code: platformAccountCode(definition.bucket, asset),
    bucket: definition.bucket,
  }));
}

/** Does this account belong to an account holder rather than to the platform? */
export function isUserOwned(account: Pick<LedgerAccountRow, "ownerType">): boolean {
  return account.ownerType === "USER";
}

export function normalDirectionOf(account: Pick<LedgerAccountRow, "bucket">): MoneyDirection {
  return bucketDefinition(requireBucket(account.bucket)).normalDirection;
}

/** `USDT available`, `USDT treasury` — for a list where the asset is not obvious. */
export function describeAccount(account: Pick<LedgerAccountRow, "bucket" | "asset">): string {
  return `${account.asset} ${bucketDefinition(requireBucket(account.bucket)).label}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Derivation: a balance is the sum of the entries, and nothing else.
// ─────────────────────────────────────────────────────────────────────────────

export type AccountBalance = {
  accountId: string;
  code: string;
  ownerType: LedgerOwnerType;
  bucket: LedgerBucket;
  asset: string;
  decimals: number;
  userId: string | null;
  /** On the account's own normal side, exact. Negative is an overdraft. */
  balanceMinor: bigint;
  /**
   * The same figure as digits, signed.
   *
   * Signed because a balance can legitimately be negative — an overdraft is the
   * state the overdraft invariant exists to judge — and a *rendering* helper that
   * refuses a negative value is the wrong place to discover that. The magnitudes
   * a movement is made of stay unsigned; a balance is a position.
   */
  balanceMinorText: string;
  /** The figure a person reads, at the asset's scale. */
  decimal: string;
  entryCount: number;
  label: string;
  /** The account's explicit permission to go negative, when it has one. */
  creditLineMinor: bigint | null;
};

/**
 * Sum the entries of each account into its balance.
 *
 * One function, one arithmetic: every surface — the balance panel, a statement's
 * closing figure, the invariant check, the health signal — reads the balance from
 * here, so there is no second place a balance could be computed differently. Every
 * amount is parsed with {@link parseMinorUnits} on the way in, which means a row
 * that somehow held a fractional amount is a loud failure rather than a rounded
 * balance.
 */
export function deriveBalances(input: {
  accounts: readonly LedgerAccountRow[];
  entries: readonly { accountId: string; direction: MoneyDirection; amountMinor: MinorUnits }[];
}): AccountBalance[] {
  const accumulator = createBalanceAccumulator(input.accounts);
  for (const entry of input.entries) accumulator.add(entry);
  return accumulator.balances();
}

export type AccountEntryTotals = { debits: bigint; credits: bigint; count: number };

export type BalanceAccumulator = {
  add(entry: { accountId: string; direction: MoneyDirection; amountMinor: MinorUnits }): void;
  /** Add a sum the database already computed, for a read that never held the rows. */
  addTotals(accountId: string, totals: AccountEntryTotals): void;
  totals(): ReadonlyMap<string, AccountEntryTotals>;
  balances(): AccountBalance[];
};

/**
 * Turn per-account debit/credit sums into balances.
 *
 * The one place a sum becomes a position: the accumulator feeds it row by row,
 * and a database aggregate feeds it the same totals without the rows. Because the
 * normal side is applied here and nowhere else, the two reads cannot disagree
 * about what a balance is — which is the property the streamed and the aggregated
 * path both need.
 */
export function balancesFromTotals(
  accounts: readonly LedgerAccountRow[],
  totals: ReadonlyMap<string, AccountEntryTotals>,
): AccountBalance[] {
  return accounts.map((account) => {
    const ownerType = requireOwnerType(account.ownerType);
    const bucket = requireBucket(account.bucket);
    const movement = totals.get(account.id) ?? { debits: BigInt(0), credits: BigInt(0), count: 0 };
    const normal = bucketDefinition(bucket).normalDirection;
    const balanceMinor = normal === "DEBIT" ? movement.debits - movement.credits : movement.credits - movement.debits;
    return {
      accountId: account.id,
      code: account.code,
      ownerType,
      bucket,
      asset: account.asset,
      decimals: account.decimals,
      userId: account.userId,
      balanceMinor,
      balanceMinorText: balanceMinor.toString(),
      decimal: decimalOf(balanceMinor, account.decimals),
      entryCount: movement.count,
      label: describeAccount(account),
      creditLineMinor: account.creditLineMinor === null ? null : parseMinorUnits(account.creditLineMinor),
    };
  });
}

/**
 * The same arithmetic as {@link deriveBalances}, fed one entry at a time.
 *
 * A ledger that grows cannot be read as one array without holding every entry in
 * memory, and a balance is a fold — so the fold is exposed as the accumulator and
 * `deriveBalances` becomes its convenience wrapper over a slice. One arithmetic,
 * two entry points: a streamed read and an array read cannot disagree about what a
 * movement does to a balance.
 */
export function createBalanceAccumulator(accounts: readonly LedgerAccountRow[]): BalanceAccumulator {
  const movements = new Map<string, AccountEntryTotals>();
  return {
    add(entry) {
      const movement = movements.get(entry.accountId) ?? { debits: BigInt(0), credits: BigInt(0), count: 0 };
      const amount = parseMinorUnits(entry.amountMinor);
      if (entry.direction === "DEBIT") movement.debits += amount;
      else movement.credits += amount;
      movement.count += 1;
      movements.set(entry.accountId, movement);
    },
    addTotals(accountId, totals) {
      const movement = movements.get(accountId) ?? { debits: BigInt(0), credits: BigInt(0), count: 0 };
      movements.set(accountId, {
        debits: movement.debits + totals.debits,
        credits: movement.credits + totals.credits,
        count: movement.count + totals.count,
      });
    },
    totals() {
      return movements;
    },
    balances() {
      return balancesFromTotals(accounts, movements);
    },
  };
}

/** A signed figure at the asset's scale, for a surface that has to show negatives. */
export function decimalOf(value: bigint, decimals: number): string {
  const negative = value < BigInt(0);
  const digits = (negative ? -value : value).toString();
  if (decimals === 0) return negative ? `-${digits}` : digits;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  const rendered = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${rendered}` : rendered;
}

/** The user's own accounts, in a stable order, for a surface that lists them. */
export function userBalances(balances: readonly AccountBalance[]): AccountBalance[] {
  return balances
    .filter((balance) => balance.ownerType === "USER")
    .sort((left, right) => left.asset.localeCompare(right.asset) || left.bucket.localeCompare(right.bucket));
}

/** The platform's own accounts, which is what a statement's counterparties are. */
export function platformBalances(balances: readonly AccountBalance[]): AccountBalance[] {
  return balances
    .filter((balance) => balance.ownerType === "PLATFORM")
    .sort((left, right) => left.asset.localeCompare(right.asset) || left.code.localeCompare(right.code));
}

// ─────────────────────────────────────────────────────────────────────────────
// Issuance: the accounts a posting names have to exist before it names them.
// ─────────────────────────────────────────────────────────────────────────────

export type NewLedgerAccount = {
  code: string;
  ownerType: LedgerOwnerType;
  bucket: LedgerBucket;
  asset: string;
  decimals: number;
  userId: string | null;
  creditLineMinor?: string | null;
};

export interface LedgerAccountStore {
  findAccountByCode(code: string): Promise<LedgerAccountRow | null>;
  insertAccountOnce(account: NewLedgerAccount): Promise<{ created: boolean; row: LedgerAccountRow }>;
  listAccountsForUser(userId: string): Promise<LedgerAccountRow[]>;
  listAccounts(): Promise<LedgerAccountRow[]>;
}

/**
 * Ensure an account exists, and return it either way.
 *
 * Issuance is idempotent by construction: the code is unique, the insert reports
 * whether it created the row, and a second caller — a retry, a second runner, two
 * requests at once — gets the row that is already there. The account it hands back
 * is always the stored one, so an account that was created with a different
 * `decimals` than the caller expected cannot be silently relabelled: the stored
 * row wins, and the caller posts at the stored scale.
 */
export async function ensureLedgerAccount(
  store: LedgerAccountStore,
  account: NewLedgerAccount,
): Promise<{ created: boolean; row: LedgerAccountRow }> {
  const definition = bucketDefinition(account.bucket);
  if (definition.ownerType !== account.ownerType) {
    throw new Error(`${account.bucket} belongs to ${definition.ownerType}, not ${account.ownerType}.`);
  }
  if (definition.ownerType === "USER" && !account.userId) {
    throw new Error("A user-owned ledger account needs the user it belongs to.");
  }
  if (definition.ownerType === "PLATFORM" && account.userId) {
    throw new Error("A platform-owned ledger account does not belong to a user.");
  }
  if (!Number.isInteger(account.decimals) || account.decimals < 0 || account.decimals > 36) {
    throw new Error(`${account.decimals} is not a usable decimal count for ${account.asset}.`);
  }
  const existing = await store.findAccountByCode(account.code);
  if (existing) return { created: false, row: existing };
  return store.insertAccountOnce(account);
}

/**
 * The account that holds one user's one asset, issued on first use.
 *
 * A user account is created the first time something is posted to it, which is
 * the moment it can matter: a balance panel asks for the accounts of an account
 * holder and gets them whether or not a movement has ever landed, because
 * "you hold nothing yet" and "you have no account" are different sentences and
 * the first is the honest one.
 */
export async function ensureUserAccount(
  store: LedgerAccountStore,
  input: { userId: string; asset: string; decimals: number },
): Promise<{ created: boolean; row: LedgerAccountRow }> {
  return ensureUserBucketAccount(store, { ...input, bucket: "AVAILABLE" });
}

/**
 * The same issuance for any bucket an account holder owns.
 *
 * One function rather than one per bucket, so the hold account is created by the
 * same rules as the spendable one — same idempotency, same "the stored row wins"
 * — and a new user-owned bucket needs a line in {@link BUCKET_DEFINITIONS} rather
 * than another issuance path.
 */
export async function ensureUserBucketAccount(
  store: LedgerAccountStore,
  input: { userId: string; asset: string; decimals: number; bucket: LedgerBucket },
): Promise<{ created: boolean; row: LedgerAccountRow }> {
  return ensureLedgerAccount(store, {
    code: userBucketAccountCode(input.userId, input.asset, input.bucket),
    ownerType: "USER",
    bucket: input.bucket,
    asset: input.asset,
    decimals: input.decimals,
    userId: input.userId,
  });
}

/** Issue the platform accounts (treasury, deposits pending, fees) for one asset. */
export async function ensurePlatformAccounts(
  store: LedgerAccountStore,
  input: { asset: string; decimals: number },
): Promise<LedgerAccountRow[]> {
  const rows: LedgerAccountRow[] = [];
  for (const account of platformAccountsFor(input.asset)) {
    const ensured = await ensureLedgerAccount(store, {
      code: account.code,
      ownerType: "PLATFORM",
      bucket: account.bucket,
      asset: input.asset,
      decimals: input.decimals,
      userId: null,
    });
    rows.push(ensured.row);
  }
  return rows;
}

/**
 * The account a deposit's credit is posted against, on the platform's side.
 *
 * `TREASURY` is the right counterparty and not a placeholder: the chain's funds
 * are held by the platform, so a credited deposit is an increase in what the
 * platform holds *and* an increase in what it owes the account. Two accounts, two
 * sides, one balanced movement — and the treasury figure is then a real number
 * that can be reconciled against the custody addresses by a later phase.
 */
export function treasuryBucket(): LedgerBucket {
  return "TREASURY";
}

/** The bucket a reversed credit's counterparty goes to: held, not owed to anyone. */
export function reversalCounterpartyBucket(): LedgerBucket {
  return "DEPOSITS_PENDING";
}

/**
 * The bucket an amount in flight to a wallet sits in: still owed, not spendable.
 *
 * Named by a function rather than written as a string at the withdrawal call sites
 * for the same reason {@link treasuryBucket} is: the reservation, the release and
 * the settlement all have to agree about *which* account holds the money, and three
 * literal strings are three chances to disagree.
 */
export function withdrawalHoldBucket(): LedgerBucket {
  return "WITHDRAWALS_RESERVED";
}

/** The bucket the platform's own revenue sits in, which a fee credits. */
export function feeBucket(): LedgerBucket {
  return "FEES";
}
