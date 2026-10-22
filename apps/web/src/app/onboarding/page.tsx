import { ArrowUpRight, CircleCheck, CircleDashed } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AccessNotice } from "@/components/access-notice";
import { DepthText } from "@/components/depth-text";
import { TerminalShell } from "@/components/terminal-shell";
import { checkPageAccess } from "@/lib/auth/access-gate";
import { isAlchemyEvmMainnetConfigured } from "@/lib/portfolio/ethereum";
import { getOnboardingChecklist } from "@/lib/onboarding/signals";

const CAPABILITY = "The onboarding checklist needs a signed-in wallet";

/**
 * The first-run checklist: four steps, each linking to the surface that completes
 * it.
 *
 * Everything here is derived from what the account has actually done (see
 * `src/lib/onboarding/checklist.ts`) — there is no checkbox that can be ticked
 * without the row behind it existing. The page's one added sentence is the reason
 * a step cannot be completed yet: when the balance provider is not configured,
 * the second step says so and names the variable, instead of sending someone to a
 * surface that will answer "not connected" and leaving them to guess.
 */
async function OnboardingContent() {
  await connection();
  const access = await checkPageAccess({ kind: "user" });
  if (access.status === "unconfigured") {
    return (
      <TerminalShell active="onboarding" section="ONBOARDING">
        <AccessNotice capability={CAPABILITY} reason={access.reason} />
      </TerminalShell>
    );
  }
  if (access.status === "anonymous") redirect("/login");
  if (access.status === "forbidden") notFound();

  const user = access.user;
  const checklist = await getOnboardingChecklist({
    userId: user.id,
    walletAddress: user.address,
    lastBalanceReadAt: user.lastBalanceReadAt,
  });
  const balanceReadConfigured = isAlchemyEvmMainnetConfigured();
  const balanceStep = checklist.steps.find((step) => step.id === "see-balance");

  return (
    <TerminalShell active="onboarding" section="ONBOARDING">
      <section className="page-heading" aria-labelledby="onboarding-title">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            FIRST RUN <span className="eyebrow-separator">/</span> FOUR STEPS
          </div>
          <h1 id="onboarding-title"><DepthText text="Getting started" /></h1>
          <p>
            Four things to do with a new account, in the order that makes sense. Each one links to the surface
            that completes it, and each one is marked done by the record the action leaves behind — not by a box
            anybody can tick.
          </p>
        </div>
        <span className="section-state">{checklist.completed} / {checklist.total} COMPLETE</span>
      </section>

      <section className="data-section market-history-section" aria-labelledby="onboarding-steps-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">01 / CHECKLIST</div>
            <h2 id="onboarding-steps-title">What is left</h2>
          </div>
          <span className="section-state">{checklist.complete ? "NOTHING LEFT" : `NEXT: ${checklist.nextStep?.title.toUpperCase()}`}</span>
        </div>
        <ol className="onboarding-steps">
          {checklist.steps.map((step, index) => (
            <li className={`onboarding-step${step.complete ? " is-complete" : ""}`} key={step.id}>
              <div className="onboarding-step__marker" aria-hidden="true">
                {step.complete
                  ? <CircleCheck size={20} strokeWidth={1.8} />
                  : <CircleDashed size={20} strokeWidth={1.8} />}
              </div>
              <div className="onboarding-step__body">
                <div className="onboarding-step__head">
                  <strong>{index + 1}. {step.title}</strong>
                  <span className="onboarding-step__state">{step.complete ? "DONE" : "OPEN"}</span>
                </div>
                <p>{step.description}</p>
                <small>{step.evidence}</small>
                {step.id === "see-balance" && !step.complete && !balanceReadConfigured && (
                  <small className="onboarding-step__blocker">
                    ALCHEMY_API_KEY (or a per-network ALCHEMY_&lt;NETWORK&gt;_RPC_URL) is not configured, so this
                    deployment cannot read a balance yet. The step stays open rather than being ticked for a
                    surface that answers &ldquo;not connected&rdquo;.
                  </small>
                )}
                <Link className="onboarding-step__link" href={step.href}>
                  {step.action}
                  <ArrowUpRight aria-hidden="true" size={14} />
                </Link>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="data-section market-history-section" aria-labelledby="onboarding-account-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">02 / THIS ACCOUNT</div>
            <h2 id="onboarding-account-title">What the checklist reads</h2>
          </div>
          <span className="section-state">{user.role}</span>
        </div>
        <dl className="market-source-details">
          <div>
            <dt>WALLET <small>the identity this session proved</small></dt>
            <dd>{user.address ?? "NONE"}</dd>
          </div>
          <div>
            <dt>SIGNED IN AS <small>{user.accountType === "CONTRACT" ? "contract account (EIP-1271)" : "key-based account"}</small></dt>
            <dd>{user.role}</dd>
          </div>
          <div>
            <dt>LAST SIGN-IN <small>refreshed by every sign-in</small></dt>
            <dd>{user.lastSeenAt ? `${user.lastSeenAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : "NOT RECORDED"}</dd>
          </div>
          <div>
            <dt>BALANCE READ <small>set when a balance was actually shown</small></dt>
            <dd>{balanceStep?.complete ? user.lastBalanceReadAt?.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "NEVER"}</dd>
          </div>
        </dl>
        <p className="admin-data-note">
          A step is complete when its record exists: a wallet identity, a completed balance read, a paper order,
          or a live alert. Deleting the row behind a step reopens that step, which is the honest behaviour for a
          checklist derived from the database instead of stored beside it.
        </p>
      </section>
    </TerminalShell>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense fallback={<div className="market-chart-empty" role="status"><strong>Reading your checklist</strong></div>}>
      <OnboardingContent />
    </Suspense>
  );
}
