import { ListChecks, LogIn } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { SessionActions } from "@/components/session-actions";
import { getCurrentUser } from "@/lib/auth/session-store";
import { getOnboardingChecklist } from "@/lib/onboarding/signals";

function TradingState() {
  return (
    <div className="trading-readiness" role="status">
      <div className="session-state">
        <span className="state-dot state-dot--amber" aria-hidden="true" />
        <span>PAPER ORDERS</span>
      </div>
      <p>Orders go to the development paper venue: no exchange is contacted and no real funds move.</p>
    </div>
  );
}

async function CurrentTradingState() {
  await connection();
  return <TradingState />;
}

export function TradingReadiness() {
  return (
    <Suspense fallback={<TradingState />}>
      <CurrentTradingState />
    </Suspense>
  );
}

async function CurrentSessionAction() {
  await connection();
  // Reading the session here is what makes a reload keep the signed-in state:
  // the cookie is httpOnly, so the server is the only place it can be resolved,
  // and it stays valid until the session's own expiry.
  const user = await getCurrentUser();
  if (!user) {
    return (
      <Link className="topbar-login" href="/login" aria-label="Sign in with an EVM wallet">
        <LogIn aria-hidden="true" size={14} strokeWidth={1.8} />
        <span>SIGN IN</span>
      </Link>
    );
  }

  return <SessionActions address={user.address} role={user.role} />;
}

/**
 * The sidebar's progress line for the first-run checklist.
 *
 * It lives here, beside `TradingReadiness`, because it is the same kind of thing:
 * one line in the sidebar's SESSION block answering "what does this session have,
 * and what does it still owe?". It is in the persistent shell because a checklist
 * nobody can find is not a checklist, and it costs two bounded counts per page for
 * a signed-in account and nothing at all for a visitor.
 */
async function CurrentOnboardingProgress() {
  await connection();
  const user = await getCurrentUser();
  if (!user) return null;

  const checklist = await getOnboardingChecklist({
    userId: user.id,
    walletAddress: user.address,
    lastBalanceReadAt: user.lastBalanceReadAt,
  });

  return (
    <Link
      className={`onboarding-progress${checklist.complete ? " is-complete" : ""}`}
      href="/onboarding"
      aria-label={`Onboarding checklist: ${checklist.completed} of ${checklist.total} steps complete`}
    >
      <ListChecks aria-hidden="true" size={14} strokeWidth={1.8} />
      <span>{checklist.complete ? "ONBOARDING 4/4" : `ONBOARDING ${checklist.completed}/${checklist.total}`}</span>
    </Link>
  );
}

export function OnboardingProgress() {
  return (
    <Suspense fallback={<span className="sidebar-version">ONBOARDING ·</span>}>
      <CurrentOnboardingProgress />
    </Suspense>
  );
}

export function SessionTopbarAction() {
  return (
    <Suspense fallback={<span className="topbar-disconnected">CHECKING SESSION</span>}>
      <CurrentSessionAction />
    </Suspense>
  );
}
