import { ensureDepositAddressesForUser } from "./addresses";
import { readDepositPolicy, type DepositPolicy } from "./policy";
import { depositStore, type DepositStore } from "./store";
import { loggerFor } from "@/lib/observability/request-context";
import type { Reason } from "@/lib/observability/reason";

/**
 * Deposit addresses are issued with the sign-in that found or created the account.
 *
 * The requirement is "each sign-in gets a deposit address per enabled network,
 * derived deterministically and stored once", and the honest reading of that is
 * *idempotent*: a sign-in asks for the rows to exist, and every sign-in after the
 * first finds them already there. `ensureDepositAddressesForUser` is the same
 * function the deposit surface calls on read, so the two orderings cannot
 * disagree — whichever runs first issues the row, and the audit event
 * `DEPOSIT_ADDRESS_ISSUED` is written exactly once per address because the row
 * insert and the audit write share a transaction.
 *
 * **It cannot fail a sign-in.** This runs after the session transaction has
 * committed, and every outcome is a return value:
 *
 *  - an unconfigured seed (`DEPOSIT_ADDRESS_MNEMONIC`) or no enabled network is a
 *    skip, with the missing variable named — a deployment with no deposits still
 *    signs people in;
 *  - a storage failure is caught, logged and reported as `failed`, because losing
 *    a sign-in over a side-effect would be a worse trade than issuing the address
 *    on the next read (the deposit panel issues on read for exactly this reason);
 *  - nothing about the address depends on this having run: it is a pure function of
 *    (seed, account id, network), so a sign-in that skips issuance still shows the
 *    same address later.
 */

export type SignInDepositIssuance = {
  /** Addresses this sign-in created. */
  issued: number;
  /** Addresses this account already had. */
  existing: number;
  /** Networks that could not be issued, each naming what is missing. */
  skipped: { network: string; reason: Reason }[];
  /** True when issuance could not be attempted at all; a sign-in is never refused for it. */
  failed: boolean;
};

const EMPTY: SignInDepositIssuance = { issued: 0, existing: 0, skipped: [], failed: false };

export async function issueDepositAddressesForSignIn(input: {
  userId: string;
  store?: DepositStore;
  policy?: DepositPolicy;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<SignInDepositIssuance> {
  try {
    const policy = input.policy ?? readDepositPolicy(input.env);
    const outcome = await ensureDepositAddressesForUser({
      userId: input.userId,
      store: input.store ?? depositStore,
      policy,
      now: input.now ?? new Date(),
    });
    return {
      issued: outcome.created.length,
      existing: outcome.existing.length,
      skipped: outcome.skipped,
      failed: false,
    };
  } catch (error) {
    // A sign-in is already complete at this point; the address is owed, not
    // required. Log the failure so it is not silent, and let the caller finish.
    loggerFor("/api/auth/verify").error("deposit address issuance failed during sign-in", {
      error,
      userId: input.userId,
    });
    return { ...EMPTY, failed: true };
  }
}
