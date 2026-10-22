import { prisma } from "@/lib/db";
import { buildOnboardingChecklist, type OnboardingChecklist, type OnboardingSignals } from "@/lib/onboarding/checklist";

/**
 * The two facts the signed-in user's own row already carries, plus the two that
 * have to be counted.
 *
 * The wallet address and the last balance read both come from the session the
 * caller has already resolved, so this reads nothing extra for them: the
 * checklist costs two bounded counts, and nothing else. Counting rather than
 * loading keeps the sidebar progress affordable on every page — the alternative
 * would be fetching orders and alerts on each request just to ask whether there
 * is more than one of them.
 */
export async function readOnboardingSignals(input: {
  userId: string;
  walletAddress: string | null;
  lastBalanceReadAt: Date | null;
}): Promise<OnboardingSignals> {
  const [paperOrders, alerts] = await Promise.all([
    prisma.tradeOrder.count({ where: { userId: input.userId } }),
    prisma.marketAlert.count({ where: { userId: input.userId, deletedAt: null } }),
  ]);

  return {
    walletAddress: input.walletAddress,
    lastBalanceReadAt: input.lastBalanceReadAt,
    paperOrders,
    alerts,
  };
}

/**
 * Record that a balance was read for this account.
 *
 * Written only when a read actually produced a balance, so the checklist's
 * second step cannot be satisfied by a call that answered "the provider is not
 * configured" — the step is "see a balance", and there was no balance to see.
 *
 * Best-effort on purpose: this is an observation *about* the read, and a request
 * that successfully showed someone their balance must not fail because the note
 * could not be written. The next successful read writes it again.
 */
export async function recordBalanceRead(userId: string, at: Date = new Date()): Promise<void> {
  try {
    await prisma.user.update({ where: { id: userId }, data: { lastBalanceReadAt: at } });
  } catch {
    // Nothing to report and nothing to retry here; the column stays as it was.
  }
}

/** The checklist for one account, derived from what it has actually done. */
export async function getOnboardingChecklist(input: {
  userId: string;
  walletAddress: string | null;
  lastBalanceReadAt: Date | null;
}): Promise<OnboardingChecklist> {
  return buildOnboardingChecklist(await readOnboardingSignals(input));
}
