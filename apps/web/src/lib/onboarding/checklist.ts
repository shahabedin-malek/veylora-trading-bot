/**
 * The first-run checklist, as four steps over four durable records.
 *
 * There is deliberately no checklist table. A stored checklist is a second copy
 * of the truth: it says a step is done long after the row that proves it was
 * deleted, and it says nothing when a step was done outside the page that was
 * supposed to record it. So each step is derived from the row the action itself
 * leaves behind:
 *
 *   connect a wallet  → a `WalletIdentity` for the signed-in account
 *   see a balance     → `User.lastBalanceReadAt`, written by a completed read
 *   place a paper trade → a `TradeOrder` created by the account
 *   set an alert      → a live `MarketAlert` owned by the account
 *
 * Every step names the real surface that completes it, and the builder is pure,
 * so a test can assert that a fresh account starts at 0/4, that each signal moves
 * exactly one step, and that a completed checklist reaches 4/4 with nothing left
 * over. What the *page* adds, and this module does not know about, is why a step
 * cannot be completed yet (an unconfigured balance provider, for example) — that
 * belongs next to the surface, not inside the step model.
 */
export type OnboardingStepId = "connect-wallet" | "see-balance" | "paper-trade" | "set-alert";

export type OnboardingStepDefinition = {
  id: OnboardingStepId;
  /** The short label used in the checklist and in the sidebar progress. */
  title: string;
  /** What the step asks for, in one sentence. */
  description: string;
  /** The real surface that completes it — never a placeholder page. */
  href: string;
  /** The link text, so the step is an instruction and not just a claim. */
  action: string;
};

export const ONBOARDING_STEPS: readonly OnboardingStepDefinition[] = [
  {
    id: "connect-wallet",
    title: "Connect a wallet",
    description: "Sign in by proving ownership of an EVM mainnet wallet. This step is what creates your account.",
    href: "/login",
    action: "Sign in with a wallet",
  },
  {
    id: "see-balance",
    title: "See a balance",
    description: "Read the on-chain balance of the wallet you signed in with, on the network you allow-listed.",
    href: "/#portfolio",
    action: "Open the portfolio",
  },
  {
    id: "paper-trade",
    title: "Place a paper trade",
    description: "Send an order to the development paper venue. No exchange is contacted and no real funds move.",
    href: "/trade",
    action: "Open the order ticket",
  },
  {
    id: "set-alert",
    title: "Set an alert",
    description: "Watch a market for a condition you choose, so the workspace tells you when it happens.",
    // The alerts panel's own anchor, not the audit stream's: the step must land on the
    // surface that completes it, which is the create-alert form below "Recent activity".
    href: "/#alerts",
    action: "Set a market alert",
  },
] as const;

/**
 * What the account has actually done, read from the database by the caller.
 * Everything here is an observation about rows that exist, never a setting.
 */
export type OnboardingSignals = {
  /** The wallet this account signed in with, or null when it has no live identity. */
  walletAddress: string | null;
  /** When a balance read last completed for this account, or null. */
  lastBalanceReadAt: Date | null;
  /** Paper orders this account has placed. */
  paperOrders: number;
  /** Live market alerts this account owns (soft-deleted ones do not count). */
  alerts: number;
};

export type OnboardingStep = OnboardingStepDefinition & {
  complete: boolean;
  /** The record that completes the step, or what is still missing. */
  evidence: string;
};

export type OnboardingChecklist = {
  steps: OnboardingStep[];
  completed: number;
  total: number;
  complete: boolean;
  /** The first unfinished step, or null when all four are done. */
  nextStep: OnboardingStep | null;
};

export function buildOnboardingChecklist(
  signals: OnboardingSignals,
  definitions: readonly OnboardingStepDefinition[] = ONBOARDING_STEPS,
): OnboardingChecklist {
  const steps = definitions.map((definition): OnboardingStep => {
    switch (definition.id) {
      case "connect-wallet":
        return {
          ...definition,
          complete: signals.walletAddress !== null,
          evidence: signals.walletAddress
            ? `Signed in as ${signals.walletAddress}`
            : "No wallet has signed in for this account yet.",
        };
      case "see-balance":
        return {
          ...definition,
          complete: signals.lastBalanceReadAt !== null,
          evidence: signals.lastBalanceReadAt
            ? `A balance was read on ${signals.lastBalanceReadAt.toISOString()}`
            : "No balance has been read for this wallet yet.",
        };
      case "paper-trade":
        return {
          ...definition,
          complete: signals.paperOrders > 0,
          evidence: signals.paperOrders > 0
            ? `${signals.paperOrders} paper order(s) placed`
            : "No paper order has been placed yet.",
        };
      case "set-alert":
        return {
          ...definition,
          complete: signals.alerts > 0,
          evidence: signals.alerts > 0
            ? `${signals.alerts} live alert(s) set`
            : "No live alert is set yet.",
        };
    }
  });

  const completed = steps.filter((step) => step.complete).length;
  return {
    steps,
    completed,
    total: steps.length,
    complete: completed === steps.length,
    nextStep: steps.find((step) => !step.complete) ?? null,
  };
}
