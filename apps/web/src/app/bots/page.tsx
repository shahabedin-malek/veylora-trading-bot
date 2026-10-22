import { connection } from "next/server";
import { redirect } from "next/navigation";
import { AccessNotice } from "@/components/access-notice";
import { BotBuilderPanel } from "@/components/bot-builder-panel";
import { DepthText } from "@/components/depth-text";
import { ManagedBotsPanel } from "@/components/managed-bots-panel";
import { TerminalShell } from "@/components/terminal-shell";
import { checkPageAccess } from "@/lib/auth/access-gate";

export const instant = false;

const CAPABILITY = "Managed bots need a signed-in account";

/**
 * The bot builder (phase 30).
 *
 * Two surfaces on one page, deliberately in this order: the managed bots at the top are
 * what the runner executes, and the paper lab below is where a strategy is studied before
 * it is saved. A published bot appears here with its state and on `/trade` in the phase-23
 * strategy list, so "published" means startable rather than merely stored.
 */
export default async function BotsPage() {
  await connection();
  const access = await checkPageAccess({ kind: "user" });
  if (access.status === "unconfigured") {
    return (
      <TerminalShell active="bots" section="BOT BUILDER">
        <AccessNotice capability={CAPABILITY} reason={access.reason} />
      </TerminalShell>
    );
  }
  if (access.status !== "granted") redirect("/login");

  return (
    <TerminalShell active="bots" section="BOT BUILDER">
      <section className="page-heading" aria-labelledby="bots-page-title">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />STRATEGY LAB <span className="eyebrow-separator">/</span> NO-CODE BUILDER
          </div>
          <h1 id="bots-page-title"><DepthText text="Bot builder" /></h1>
          <p>
            Build a strategy, save it, and publish it to the runner without editing a config file. Publishing validates
            the rules against the same schema the runner executes; a published bot appears in the trade page&apos;s
            strategy list and is started there.
          </p>
        </div>
        <span className="section-state">PUBLISH · START · AUDIT</span>
      </section>

      <section className="data-section" aria-labelledby="managed-bots-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">01 / MANAGED BOTS</div>
            <h2 id="managed-bots-title">Strategies the runner can execute</h2>
          </div>
          <span className="section-state">DRAFT → PUBLISHED</span>
        </div>
        <p className="trading-security-note">
          A draft is stored but never scheduled. Publishing snapshots the rules into a strategy version and makes the bot
          startable; deleting one stops it being scheduled immediately while its decisions and trades stay readable.
          Every create, publish, share, start, stop and delete is written to the audit trail. Bot caps are admin data,
          so a limit is stated with its usage rather than hidden behind a disabled control.
        </p>
        <ManagedBotsPanel />
      </section>

      <section className="data-section" aria-labelledby="paper-lab-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">02 / PAPER LAB</div>
            <h2 id="paper-lab-title">Backtest before you publish</h2>
          </div>
          <span className="section-state">PAPER ONLY</span>
        </div>
        <p className="trading-security-note">
          Configure, backtest, and monitor paper RSI strategies at Coinbase public prices. Paper accounting runs
          server-side; nothing in this lab places a live order.
        </p>
        <BotBuilderPanel />
      </section>
    </TerminalShell>
  );
}
