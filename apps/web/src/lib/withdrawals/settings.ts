import { prisma } from "@/lib/db";
import {
  networkCostFor,
  readEffectiveFeeSchedule,
  withdrawalFeeFor,
  type EffectiveFeeSchedule,
} from "@/lib/fees/table";
import { readWithdrawalPolicy, type WithdrawalPolicy } from "./policy";
import { auditCreate } from "@/lib/audit/record";

/**
 * The owner's own withdrawal window, as admin data.
 *
 * Phase 14 put the new-address control in the environment, which made it *configuration*
 * but not something the owner could change without a redeploy. This module is the small
 * piece that makes it what the phase asked for: one stored number, edited on the admin
 * page, that decides how long a first withdrawal to an address this account has never
 * used waits before it is queued.
 *
 * Three properties are what make it safe to have a stored number at all:
 *
 *  1. **It is the only hold this product has.** The table holds one column, there is no
 *     approval flag beside it, and nothing here can stop a withdrawal the owner asked for.
 *     A withdrawal that is not a first send to an unseen address is never held, whatever
 *     this number is.
 *  2. **Zero is a complete answer.** It holds nothing, and it is stored and read as a
 *     value rather than treated as "unset", so an owner who wants no hold gets no hold.
 *  3. **A stored row always beats the environment.** `WITHDRAWAL_NEW_ADDRESS_WINDOW_MINUTES`
 *     remains the fallback for a deployment whose row has never been written — that is what
 *     it means — and the read reports which of the two is in force.
 *
 * The window is read where a withdrawal is *requested*, which is the only place it can
 * change an outcome: a row that is already held carries its own `holdUntil`, so editing
 * this number never moves a withdrawal that is already waiting.
 */

/** The singleton row's id, the same shape every other settings table in this app uses. */
export const WITHDRAWAL_SETTINGS_ID = "global";

/**
 * The longest window this build will store: a week.
 *
 * Not a judgement about the right number — that is the owner's — but a bound on a value
 * that can hold someone's own money, so a mistyped digit cannot park a withdrawal for a
 * decade. A request that outlives its own expiry is released either way, which is the
 * second reason the bound is generous rather than tight.
 */
import { MAX_NEW_ADDRESS_WINDOW_MINUTES } from "@/lib/withdrawals/limits";

export { MAX_NEW_ADDRESS_WINDOW_MINUTES };

export type WithdrawalOwnerSettings = {
  /** Minutes a first send to an address this account has never used waits. Zero holds nothing. */
  newAddressWindowMinutes: number;
  /**
   * The owner's stop switch for outbound money. Optional in this shape so a caller that
   * only edits the window cannot silently unpause a paused deployment: an absent value
   * means "leave it as it is" everywhere it is read.
   */
  paused?: boolean;
};

export type WithdrawalSettingsValidation =
  | { valid: true; value: WithdrawalOwnerSettings }
  | { valid: false; error: string };

export type StoredWithdrawalSettings = WithdrawalOwnerSettings & {
  updatedAt: Date | null;
  pausedChangedAt?: Date | null;
};

/** What the admin page reads: the number in force, where it came from, and both candidates. */
export type WithdrawalSettingsView = WithdrawalOwnerSettings & {
  /** The owner's stop switch in force. Optional above, always present in a view. */
  paused: boolean;
  /** When the switch last moved, or null when it never has. */
  pausedChangedAt: string | null;
  source: WithdrawalPolicy["newAddressWindowSource"];
  /** The value a deployment with no stored row would use. */
  deploymentDefaultMinutes: number;
  /** Whether a row exists at all. False means the deployment default is in force. */
  stored: boolean;
  updatedAt: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateWithdrawalOwnerSettings(value: unknown): WithdrawalSettingsValidation {
  if (!isRecord(value)) return { valid: false, error: "Withdrawal settings must be an object." };
  if (Object.keys(value).some((key) => key !== "newAddressWindowMinutes")) {
    return { valid: false, error: "One or more withdrawal settings are unsupported." };
  }

  const minutes = value.newAddressWindowMinutes;
  if (typeof minutes !== "number" || !Number.isSafeInteger(minutes) || minutes < 0) {
    return { valid: false, error: "The new-address window must be a whole number of minutes, 0 or more." };
  }
  if (minutes > MAX_NEW_ADDRESS_WINDOW_MINUTES) {
    return {
      valid: false,
      error: `The new-address window cannot be longer than ${MAX_NEW_ADDRESS_WINDOW_MINUTES} minutes (7 days).`,
    };
  }
  return { valid: true, value: { newAddressWindowMinutes: minutes } };
}

/**
 * The stored row, or null when the owner has never set one.
 *
 * Null and zero are different answers and are kept apart everywhere: null means "no row,
 * use the deployment default", and zero means "the owner asked for no hold".
 */
export async function getWithdrawalOwnerSettings(): Promise<StoredWithdrawalSettings | null> {
  const row = await prisma.withdrawalSettings.findUnique({ where: { id: WITHDRAWAL_SETTINGS_ID } });
  if (!row) return null;
  const validation = validateWithdrawalOwnerSettings({ newAddressWindowMinutes: row.newAddressWindowMinutes });
  if (!validation.valid) throw new Error("Stored withdrawal settings failed validation.");
  return { ...validation.value, paused: row.paused, pausedChangedAt: row.pausedChangedAt, updatedAt: row.updatedAt };
}

/** Save the owner's window and audit the change, before and after, in one transaction. */
export async function saveWithdrawalOwnerSettings(
  settings: WithdrawalOwnerSettings,
  actorUserId: string,
): Promise<StoredWithdrawalSettings> {
  const validation = validateWithdrawalOwnerSettings(settings);
  if (!validation.valid) throw new Error("Withdrawal settings failed validation.");
  const safeSettings = validation.value;

  return prisma.$transaction(async (transaction) => {
    const before = await transaction.withdrawalSettings.findUnique({ where: { id: WITHDRAWAL_SETTINGS_ID } });
    const saved = await transaction.withdrawalSettings.upsert({
      where: { id: WITHDRAWAL_SETTINGS_ID },
      create: { id: WITHDRAWAL_SETTINGS_ID, ...safeSettings, updatedByUserId: actorUserId },
      update: { ...safeSettings, updatedByUserId: actorUserId },
    });

    await auditCreate(transaction, {
      data: {
        actorUserId,
        action: "WITHDRAWAL_SETTINGS_UPDATED",
        objectType: "WithdrawalSettings",
        objectId: WITHDRAWAL_SETTINGS_ID,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({
          before: before ? { newAddressWindowMinutes: before.newAddressWindowMinutes } : null,
          after: safeSettings,
        }),
      },
    });

    return { ...safeSettings, updatedAt: saved.updatedAt };
  });
}

/**
 * The policy a withdrawal is actually requested under: the deployment's own values, with the
 * owner's stored window on top when there is one.
 *
 * `readSettings` is a parameter so the overlay can be exercised without a database — the join
 * between the stored number and the request path is the part worth testing, and it is the part
 * a database would otherwise hide.
 */
export async function readEffectiveWithdrawalPolicy(
  env: NodeJS.ProcessEnv = process.env,
  readSettings: () => Promise<WithdrawalOwnerSettings | null> = getWithdrawalOwnerSettings,
): Promise<WithdrawalPolicy> {
  const policy = readWithdrawalPolicy(env);
  // A settings read that fails must not refuse a withdrawal or invent a window: the deployment's
  // own value is a complete answer, and it is the one the owner configured at deploy time.
  const stored = await readSettings().catch(() => null);
  return applyOwnerWindow(policy, stored);
}

/** The overlay itself, pure: a stored window replaces the deployment's and is labelled as such. */
export function applyOwnerWindow(
  policy: WithdrawalPolicy,
  stored: WithdrawalOwnerSettings | null,
): WithdrawalPolicy {
  if (!stored) return policy;
  return {
    ...policy,
    newAddressWindowMinutes: stored.newAddressWindowMinutes,
    newAddressWindowSource: "owner-setting",
    withdrawalsPaused: stored.paused ?? false,
  };
}

/**
 * Flip the owner's stop switch and audit it in the same transaction.
 *
 * This is deliberately not part of the window save: a request that edits the hold
 * length must never be able to change whether outbound money is running. The row is
 * created when it does not exist yet, carrying the deployment's own window so a
 * deployment that has never saved a setting keeps the hold it was configured with.
 */
export async function setWithdrawalsPaused(
  paused: boolean,
  actorUserId: string,
): Promise<StoredWithdrawalSettings> {
  return prisma.$transaction(async (transaction) => {
    const before = await transaction.withdrawalSettings.findUnique({ where: { id: WITHDRAWAL_SETTINGS_ID } });
    const stored = await transaction.withdrawalSettings.upsert({
      where: { id: WITHDRAWAL_SETTINGS_ID },
      create: {
        id: WITHDRAWAL_SETTINGS_ID,
        newAddressWindowMinutes: readWithdrawalPolicy().newAddressWindowMinutes,
        paused,
        pausedChangedByUserId: actorUserId,
        pausedChangedAt: new Date(),
        updatedByUserId: actorUserId,
      },
      update: {
        paused,
        pausedChangedByUserId: actorUserId,
        pausedChangedAt: new Date(),
        updatedByUserId: actorUserId,
      },
    });

    await auditCreate(transaction, {
      data: {
        actorUserId,
        action: paused ? "WITHDRAWALS_PAUSED" : "WITHDRAWALS_RESUMED",
        objectType: "WithdrawalSettings",
        objectId: WITHDRAWAL_SETTINGS_ID,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({ before: before?.paused ?? false, after: paused }),
      },
    });

    return {
      newAddressWindowMinutes: stored.newAddressWindowMinutes,
      paused: stored.paused,
      updatedAt: stored.updatedAt,
    };
  });
}

/**
 * The policy a withdrawal is actually *priced* under: the window overlay above, then
 * phase 16's fee table on top of it.
 *
 * Two reads rather than one because they answer different questions and fail
 * differently. The window is the owner's own control and a missing row is the
 * deployment's value; the fee table is the price list, and a missing row is "free". A
 * failure to read the table is not allowed to invent a price, so it leaves the
 * deployment values in place and says so through `feeSource` — and the surfaces that
 * quote a price read this function, never the raw policy.
 */
export type PricedWithdrawalPolicyInput = {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  readSettings?: () => Promise<WithdrawalOwnerSettings | null>;
  /** Injected in tests; production reads the stored schedule. */
  readSchedule?: () => Promise<EffectiveFeeSchedule>;
};

export async function readPricedWithdrawalPolicy(
  input: PricedWithdrawalPolicyInput = {},
): Promise<WithdrawalPolicy> {
  const policy = await readEffectiveWithdrawalPolicy(input.env, input.readSettings);
  const schedule = await (input.readSchedule ?? (() => readEffectiveFeeSchedule({ now: input.now })))().catch(() => null);
  return applyFeeSchedule(policy, schedule);
}

/**
 * The overlay itself, pure: the table's fee and network cost replace the deployment's
 * for every asset the withdrawal policy knows about.
 *
 * Replacement rather than a merge is deliberate. An asset the table does not name is
 * free, so a deployment that has written one fee row cannot keep charging an old
 * environment value the owner can no longer see on `/pricing`. When the table cannot
 * be read at all, `schedule` is null and the policy is returned untouched — which is
 * the only case in which the environment values are still in force.
 */
export function applyFeeSchedule(
  policy: WithdrawalPolicy,
  schedule: EffectiveFeeSchedule | null,
): WithdrawalPolicy {
  if (!schedule) return policy;
  const feeByAsset: Record<string, string> = { ...policy.feeByAsset };
  const networkCostByAsset: Record<string, string> = { ...policy.networkCostByAsset };
  for (const asset of Object.keys(feeByAsset)) {
    feeByAsset[asset] = withdrawalFeeFor(schedule, asset);
    networkCostByAsset[asset] = networkCostFor(schedule, asset);
  }
  return {
    ...policy,
    feeByAsset,
    networkCostByAsset,
    feeSource: schedule.source === "owner-schedule" ? "owner-schedule" : "free-defaults",
  };
}

/** What the admin page and `GET /api/admin/withdrawals` show. */
export function withdrawalSettingsView(
  policy: WithdrawalPolicy,
  stored: StoredWithdrawalSettings | null,
): WithdrawalSettingsView {
  const effective = applyOwnerWindow(policy, stored);
  return {
    newAddressWindowMinutes: effective.newAddressWindowMinutes,
    paused: effective.withdrawalsPaused,
    pausedChangedAt: stored?.pausedChangedAt ? stored.pausedChangedAt.toISOString() : null,
    source: effective.newAddressWindowSource,
    deploymentDefaultMinutes: policy.newAddressWindowMinutes,
    stored: stored !== null,
    updatedAt: stored?.updatedAt ? stored.updatedAt.toISOString() : null,
  };
}
