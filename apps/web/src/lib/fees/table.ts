import { prisma } from "@/lib/db";
import {
  formatFeeAmount,
  isDecimalAmount,
  percentToBasisPoints,
  quoteWithdrawal,
  type WithdrawalQuote,
} from "./amounts";
import { auditCreate } from "@/lib/audit/record";

/**
 * The fee table: what the platform charges, as versions the owner edits.
 *
 * **One table, read by every surface that quotes a price.** The withdrawal request
 * prices a fee through {@link withdrawalFeeFor}, the withdrawal panel prints what
 * {@link withdrawalFeeFor} returned, the pricing page renders {@link pricingRows}, and
 * the admin page edits the row all three read. There is no second list of fees for the
 * page, which is the only way "the page and the code can never disagree" is a property
 * of the code rather than a promise to keep them in step.
 *
 * **Versions, not mutations.** A save inserts a row with an `effectiveFrom`; nothing is
 * updated or deleted. So a schedule change can be dated in the future and staged, the
 * past keeps the price that was actually charged, and the audit event a save writes
 * points at rows that still hold the values it compared. Reading "the schedule in
 * force" is therefore a query, not a stored flag.
 *
 * **Zero is a configuration, not an absence.** A deployment with no row charges
 * nothing, and every amount renders through {@link formatFeeAmount}, which says
 * `no fee`. The alternative — treating zero as "unset" and falling back to some other
 * number — is how a free tier silently becomes a paid one.
 *
 * **The network cost is disclosed, not deducted.** `networkCosts` is what a transfer
 * costs the platform in gas; the owner is shown it beside the fee and the arriving
 * amount, and the quote subtracts only the fee. Charging it as well would be a second
 * price for one withdrawal, which the phase forbids.
 *
 * What this module deliberately does not decide: which percentage is *right*, or
 * whether a fee is affordable for a given account. Those are the owner's number and the
 * withdrawal path's answer; this module holds configuration and refuses values it
 * cannot read.
 */

/** The most tier rows the table will hold. A price list, not a catalogue. */
export const MAX_FEE_TIERS = 8;

/** The longest a tier label may be, so the pricing page cannot be broken by one. */
const MAX_TIER_LABEL_LENGTH = 40;

export type FeeTier = {
  /** Stable identifier the page and a later plan assignment name. */
  key: string;
  label: string;
  maxBots: number;
  maxVenueConnections: number;
  /** Exactly one tier is the one every account is on until plans are assigned. */
  isDefault: boolean;
};

export type FeeScheduleValues = {
  /** When this version starts applying, ISO-8601. */
  effectiveFrom: string;
  /** Platform fee per asset, e.g. `{ "USDT": "1" }`. Absent means free. */
  withdrawalFees: Record<string, string>;
  /** What the chain costs us per asset. Disclosed, never deducted from the owner. */
  networkCosts: Record<string, string>;
  /** Percentage of a profitable result only. `0` means no fee. */
  performanceFeePercent: string;
  /**
   * Phase 28: what a backtest assumes each fill costs. These are modelling inputs rather
   * than charges — no ledger entry reads them — but they are stored on the same versioned
   * row as the fees so "the backtest priced this at the owner's fee" is one lookup. All
   * four are basis points and zero is a complete configuration.
   */
  tradingFeeBps: string;
  spreadBps: string;
  slippageBps: string;
  fundingBpsPerDay: string;
  tiers: FeeTier[];
};

export type EffectiveFeeSchedule = FeeScheduleValues & {
  /** The stored row's id, or null when no version is in force. */
  id: string | null;
  /** Where the numbers came from: a stored version, or this build's free defaults. */
  source: "owner-schedule" | "defaults";
  /** The moment the version took effect; null for the defaults, which always applied. */
  appliedFrom: string | null;
  /** When the row was written, for the page's own provenance line. */
  createdAt: string | null;
};

export type FeeScheduleHistoryEntry = FeeScheduleValues & {
  id: string;
  createdAt: string;
  /** True once `effectiveFrom` has passed; false for a staged version. */
  inForce: boolean;
};

export type FeeScheduleView = {
  /** The version in force right now, or the free defaults. */
  inForce: EffectiveFeeSchedule;
  /** Versions dated in the future, soonest first. Staged, not applied. */
  pending: FeeScheduleHistoryEntry[];
  /** Every stored version, newest first, bounded. */
  history: FeeScheduleHistoryEntry[];
  readAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The tier every account starts on.
 *
 * Bot caps are enforced by the bot builder (phase 30); venue-connection caps are
 * enforced by the credential path today. Both are values the owner can edit, and a
 * tier with a cap of zero is a supported configuration that refuses the first one.
 */
export const DEFAULT_TRADING_COSTS = {
  tradingFeeBps: "10",
  spreadBps: "2",
  slippageBps: "5",
  fundingBpsPerDay: "0",
} as const;

export const DEFAULT_FEE_TIERS: readonly FeeTier[] = [
  { key: "STANDARD", label: "Standard", maxBots: 10, maxVenueConnections: 5, isDefault: true },
];

/** The schedule a deployment with no stored version charges: nothing, for everyone. */
export function defaultFeeSchedule(effectiveFrom: string | null = null): EffectiveFeeSchedule {
  return {
    id: null,
    source: "defaults",
    appliedFrom: effectiveFrom,
    createdAt: null,
    effectiveFrom: effectiveFrom ?? new Date(0).toISOString(),
    withdrawalFees: {},
    networkCosts: {},
    performanceFeePercent: "0",
    ...DEFAULT_TRADING_COSTS,
    tiers: DEFAULT_FEE_TIERS.map((tier) => ({ ...tier })),
  };
}

/**
 * The withdrawal fee for one asset, from the table and nowhere else.
 *
 * The policy overlay, the panel and the pricing page all call this, so a number on the
 * page and a number taken out of a withdrawal are one lookup. An asset the table does
 * not name is free — not "unset" — which is what makes a new asset free by default
 * instead of accidentally charged the last asset's fee.
 */
export function withdrawalFeeFor(schedule: Pick<FeeScheduleValues, "withdrawalFees">, asset: string): string {
  return schedule.withdrawalFees[asset.trim().toUpperCase()] ?? "0";
}

/** The network cost for one asset, from the table. Absent means nothing to disclose. */
export function networkCostFor(schedule: Pick<FeeScheduleValues, "networkCosts">, asset: string): string {
  return schedule.networkCosts[asset.trim().toUpperCase()] ?? "0";
}

/**
 * The percentage a profitable result pays, as basis points.
 *
 * Basis points because a fee is money: `12.5%` is exactly 1250 and nothing is rounded
 * on the way into the computation. `null` means the stored value is unreadable, which
 * the validator refuses and the read treats as a hard error rather than as zero.
 */
export function performanceFeeBasisPoints(schedule: Pick<FeeScheduleValues, "performanceFeePercent">): bigint | null {
  return percentToBasisPoints(schedule.performanceFeePercent);
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation: what the owner may save.
// ─────────────────────────────────────────────────────────────────────────────

export type FeeScheduleValidation =
  | { valid: true; value: FeeScheduleValues }
  | { valid: false; error: string };

const ASSET_KEY = /^[A-Z0-9]{2,12}$/;
const TIER_KEY = /^[A-Z][A-Z0-9_-]{1,23}$/;

function validateAmountMap(value: unknown, field: string): { valid: true; value: Record<string, string> } | { valid: false; error: string } {
  if (value === undefined) return { valid: true, value: {} };
  if (!isRecord(value)) return { valid: false, error: `${field} must be an object of asset → amount.` };
  const result: Record<string, string> = {};
  for (const [rawAsset, rawAmount] of Object.entries(value)) {
    const asset = rawAsset.trim().toUpperCase();
    if (!ASSET_KEY.test(asset)) {
      return { valid: false, error: `${JSON.stringify(rawAsset)} is not an asset symbol this table can key a fee by.` };
    }
    if (typeof rawAmount !== "string" || rawAmount.trim() === "" || !isDecimalAmount(rawAmount)) {
      return { valid: false, error: `The ${asset} amount must be a decimal string, for example 1 or 0.5.` };
    }
    // Nine decimal places is already more than any asset this build registers, and the
    // bound keeps a mistyped value from being stored as a number nothing can parse.
    if (rawAmount.trim().split(".")[1]?.length > 18) {
      return { valid: false, error: `The ${asset} amount carries more than 18 decimal places.` };
    }
    result[asset] = rawAmount.trim();
  }
  return { valid: true, value: result };
}

function validateTiers(value: unknown): { valid: true; value: FeeTier[] } | { valid: false; error: string } {
  if (value === undefined) return { valid: true, value: DEFAULT_FEE_TIERS.map((tier) => ({ ...tier })) };
  if (!Array.isArray(value) || value.length === 0) {
    return { valid: false, error: "The table needs at least one tier." };
  }
  if (value.length > MAX_FEE_TIERS) {
    return { valid: false, error: `The table holds at most ${MAX_FEE_TIERS} tiers.` };
  }

  const tiers: FeeTier[] = [];
  for (const [index, candidate] of value.entries()) {
    if (!isRecord(candidate)) return { valid: false, error: `Tier ${index + 1} must be an object.` };
    const key = typeof candidate.key === "string" ? candidate.key.trim().toUpperCase() : "";
    if (!TIER_KEY.test(key)) {
      return { valid: false, error: `Tier ${index + 1} needs an uppercase key of 2–24 letters, digits, dashes or underscores.` };
    }
    const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
    if (label.length === 0 || label.length > MAX_TIER_LABEL_LENGTH) {
      return { valid: false, error: `Tier ${key} needs a label of 1–${MAX_TIER_LABEL_LENGTH} characters.` };
    }
    const maxBots = candidate.maxBots;
    if (typeof maxBots !== "number" || !Number.isSafeInteger(maxBots) || maxBots < 0 || maxBots > 1_000) {
      return { valid: false, error: `Tier ${key}'s bot cap must be a whole number from 0 to 1000.` };
    }
    const maxVenueConnections = candidate.maxVenueConnections;
    if (
      typeof maxVenueConnections !== "number" ||
      !Number.isSafeInteger(maxVenueConnections) ||
      maxVenueConnections < 0 ||
      maxVenueConnections > 100
    ) {
      return { valid: false, error: `Tier ${key}'s venue-connection cap must be a whole number from 0 to 100.` };
    }
    if (typeof candidate.isDefault !== "boolean") {
      return { valid: false, error: `Tier ${key} must say whether it is the default tier.` };
    }
    tiers.push({ key, label, maxBots, maxVenueConnections, isDefault: candidate.isDefault });
  }

  if (new Set(tiers.map((tier) => tier.key)).size !== tiers.length) {
    return { valid: false, error: "Tier keys must be unique." };
  }
  const defaults = tiers.filter((tier) => tier.isDefault);
  if (defaults.length !== 1) {
    return { valid: false, error: "Exactly one tier must be the default every account starts on." };
  }
  return { valid: true, value: tiers };
}

/**
 * Validate one save. Unknown fields are refused rather than dropped: a form that posts
 * a field this build does not store has a bug, and silently discarding it would make
 * the owner believe a value was saved.
 */
export function validateFeeScheduleUpdate(value: unknown): FeeScheduleValidation {
  if (!isRecord(value)) return { valid: false, error: "The fee table must be an object." };

  const allowedKeys = new Set([
    "effectiveFrom",
    "withdrawalFees",
    "networkCosts",
    "performanceFeePercent",
    "tradingFeeBps",
    "spreadBps",
    "slippageBps",
    "fundingBpsPerDay",
    "tiers",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return { valid: false, error: "One or more submitted fields are unsupported." };
  }

  const effectiveRaw = typeof value.effectiveFrom === "string" ? value.effectiveFrom.trim() : "";
  const effectiveDate = new Date(effectiveRaw);
  if (!effectiveRaw || Number.isNaN(effectiveDate.getTime())) {
    return { valid: false, error: "An effective-from time is required, as an ISO-8601 date and time." };
  }

  const withdrawalFees = validateAmountMap(value.withdrawalFees, "withdrawalFees");
  if (!withdrawalFees.valid) return withdrawalFees;
  const networkCosts = validateAmountMap(value.networkCosts, "networkCosts");
  if (!networkCosts.valid) return networkCosts;

  const percent = typeof value.performanceFeePercent === "string" ? value.performanceFeePercent.trim() : "";
  if (!isDecimalAmount(percent) || percentToBasisPoints(percent) === null) {
    return { valid: false, error: "The performance fee must be a percentage between 0 and 100, for example 20 or 12.5." };
  }
  if ((percentToBasisPoints(percent) ?? BigInt(0)) > BigInt(10_000)) {
    return { valid: false, error: "The performance fee cannot exceed 100% of a profitable result." };
  }

  const costFields = [
    ["tradingFeeBps", "The trading fee"],
    ["spreadBps", "The spread"],
    ["slippageBps", "The slippage"],
    ["fundingBpsPerDay", "The daily funding"],
  ] as const;
  const costs: Record<(typeof costFields)[number][0], string> = { ...DEFAULT_TRADING_COSTS };
  for (const [key, label] of costFields) {
    const raw = value[key];
    if (raw === undefined) continue;
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (!isDecimalAmount(trimmed) || Number(trimmed) > 10_000) {
      return {
        valid: false,
        error: `${label} must be basis points between 0 and 10,000, for example 10 for 0.10% per side.`,
      };
    }
    costs[key] = trimmed;
  }

  const tiers = validateTiers(value.tiers);
  if (!tiers.valid) return tiers;

  return {
    valid: true,
    value: {
      effectiveFrom: effectiveDate.toISOString(),
      withdrawalFees: withdrawalFees.value,
      networkCosts: networkCosts.value,
      performanceFeePercent: percent,
      ...costs,
      tiers: tiers.value,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage: versions read by time, written by insert.
// ─────────────────────────────────────────────────────────────────────────────

export type FeeScheduleRow = {
  id: string;
  effectiveFrom: Date;
  withdrawalFeesJson: string;
  networkCostsJson: string;
  performanceFeePercent: string;
  tradingFeeBps: string;
  spreadBps: string;
  slippageBps: string;
  fundingBpsPerDay: string;
  tiersJson: string;
  createdAt: Date;
};

function decodeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * One stored row as values, strictly.
 *
 * A row this build cannot read is a hard error rather than a zero: a stored fee that
 * parses as free would silently stop charging, and a pricing page that rendered it
 * would publish a price the withdrawal path does not honour. The validator is the same
 * one a save uses, so a row can only exist in a shape this build would accept.
 */
export function feeScheduleFromRow(row: FeeScheduleRow): FeeScheduleValues {
  const validation = validateFeeScheduleUpdate({
    effectiveFrom: row.effectiveFrom.toISOString(),
    withdrawalFees: decodeJson(row.withdrawalFeesJson),
    networkCosts: decodeJson(row.networkCostsJson),
    performanceFeePercent: row.performanceFeePercent,
    tradingFeeBps: row.tradingFeeBps,
    spreadBps: row.spreadBps,
    slippageBps: row.slippageBps,
    fundingBpsPerDay: row.fundingBpsPerDay,
    tiers: decodeJson(row.tiersJson),
  });
  if (!validation.valid) throw new Error(`Stored fee schedule ${row.id} failed validation: ${validation.error}`);
  return validation.value;
}

/**
 * The version in force at `now`.
 *
 * Ties on `effectiveFrom` are broken by `createdAt` and then id, so two versions saved
 * for the same moment resolve to the one written last rather than to whichever the
 * database happened to return first. A read failure throws: the caller decides whether
 * a deployment can still quote a price without the table (the withdrawal policy falls
 * back to its deployment values; the pricing page says the table is unavailable).
 */
export async function readEffectiveFeeSchedule(input: { now?: Date } = {}): Promise<EffectiveFeeSchedule> {
  const now = input.now ?? new Date();
  const row = await prisma.feeSchedule.findFirst({
    where: { effectiveFrom: { lte: now } },
    orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });
  if (!row) return defaultFeeSchedule(null);
  const values = feeScheduleFromRow(row);
  return {
    ...values,
    id: row.id,
    source: "owner-schedule",
    appliedFrom: row.effectiveFrom.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Everything the admin page shows: what is in force, what is staged, and the history. */
export async function readFeeScheduleView(input: { now?: Date } = {}): Promise<FeeScheduleView> {
  const now = input.now ?? new Date();
  const rows = await prisma.feeSchedule.findMany({
    orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    take: 50,
  });
  const history = rows.map((row) => {
    const values = feeScheduleFromRow(row);
    return {
      ...values,
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      inForce: row.effectiveFrom.getTime() <= now.getTime(),
    };
  });
  const inForce = history.find((entry) => entry.inForce);
  return {
    inForce: inForce
      ? {
          ...inForce,
          source: "owner-schedule",
          appliedFrom: inForce.effectiveFrom,
        }
      : defaultFeeSchedule(null),
    pending: history.filter((entry) => !entry.inForce).reverse(),
    history,
    readAt: now.toISOString(),
  };
}

/**
 * Save a new version and audit it, before and after, in one transaction.
 *
 * Insert-only is what makes the audit honest: the "before" the event records is still
 * readable as the row it named, and the "after" is a row that will still say the same
 * thing when someone checks the trail next month.
 */
export async function saveFeeSchedule(values: FeeScheduleValues, actorUserId: string): Promise<FeeScheduleView> {
  const validation = validateFeeScheduleUpdate(values);
  if (!validation.valid) throw new Error("Fee table update failed validation.");
  const safe = validation.value;

  await prisma.$transaction(async (transaction) => {
    const before = await transaction.feeSchedule.findFirst({
      where: { effectiveFrom: { lte: new Date() } },
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
    });
    const saved = await transaction.feeSchedule.create({
      data: {
        effectiveFrom: new Date(safe.effectiveFrom),
        withdrawalFeesJson: JSON.stringify(safe.withdrawalFees),
        networkCostsJson: JSON.stringify(safe.networkCosts),
        performanceFeePercent: safe.performanceFeePercent,
        tradingFeeBps: safe.tradingFeeBps,
        spreadBps: safe.spreadBps,
        slippageBps: safe.slippageBps,
        fundingBpsPerDay: safe.fundingBpsPerDay,
        tiersJson: JSON.stringify(safe.tiers),
        createdByUserId: actorUserId,
      },
    });
    await auditCreate(transaction, {
      data: {
        actorUserId,
        action: "FEE_SCHEDULE_UPDATED",
        objectType: "FeeSchedule",
        objectId: saved.id,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({
          effectiveFrom: safe.effectiveFrom,
          before: before ? feeScheduleFromRow(before) : null,
          after: safe,
        }),
      },
    });
  });

  return readFeeScheduleView();
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation: the pricing page and the withdrawal panel render these.
// ─────────────────────────────────────────────────────────────────────────────

export type PricingRow = {
  asset: string;
  /** The fee as configured, exact. */
  fee: string;
  /** The fee in words — `no fee` when it is zero. */
  feeLabel: string;
  networkCost: string;
  networkCostLabel: string;
  /** A worked example: what arrives from a withdrawal of one whole unit. */
  example: WithdrawalQuote | null;
};

/**
 * The withdrawal prices the pricing page renders, one row per asset.
 *
 * Built by the same {@link withdrawalFeeFor}/{@link networkCostFor} the withdrawal path
 * uses, so "the page renders from the same table the code uses" is a shared function
 * call and not two renderers that agree today. `null` in `example` means the asset's
 * one-unit example cannot be priced (a fee at or above one unit), which the page states
 * rather than hiding.
 */
export function pricingRows(
  schedule: Pick<FeeScheduleValues, "withdrawalFees" | "networkCosts">,
  input: { assets: readonly string[]; decimals: Readonly<Record<string, number>> },
): PricingRow[] {
  return [...new Set(input.assets.map((asset) => asset.toUpperCase()))]
    .sort()
    .map((asset) => {
      const fee = withdrawalFeeFor(schedule, asset);
      const networkCost = networkCostFor(schedule, asset);
      const decimals = input.decimals[asset] ?? 0;
      const example = quoteForPricing(asset, decimals, fee, networkCost);
      return {
        asset,
        fee,
        feeLabel: formatFeeAmount(fee, asset),
        networkCost,
        networkCostLabel: formatFeeAmount(networkCost, asset),
        example,
      };
    });
}

function quoteForPricing(asset: string, decimals: number, fee: string, networkCost: string): WithdrawalQuote | null {
  // One whole unit is the unit a price list is quoted in, and it exists at every scale.
  const outcome = quoteWithdrawal({ amount: "1", fee, networkCost, asset, decimals });
  return outcome.valid ? outcome.quote : null;
}
