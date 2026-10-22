import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AccessNotice } from "@/components/access-notice";
import { DepthText } from "@/components/depth-text";
import { PermissionNotice } from "@/components/permission-notice";
import { SupportDesk } from "@/components/support/support-desk";
import { TerminalShell } from "@/components/terminal-shell";
import { checkPageAccess } from "@/lib/auth/access-gate";

const CAPABILITY = "The support desk needs the crm.support.read permission";

/** The support desk, behind the same shell and the same permission refusal as the rest of admin. */
async function SupportContent() {
  await connection();
  const access = await checkPageAccess({ kind: "permission", permissionKey: "crm.support.read" });
  if (access.status === "unconfigured") {
    return (
      <TerminalShell active="support" adminView adminSections={["console", "support", "access"]} section="SUPPORT">
        <AccessNotice capability={CAPABILITY} reason={access.reason} />
      </TerminalShell>
    );
  }
  if (access.status === "anonymous") redirect("/login");
  if (access.status === "forbidden") {
    return (
      <TerminalShell active="support" adminView adminSections={["support"]} section="SUPPORT">
        <PermissionNotice capability={CAPABILITY} reason={access.reason} permissionKey={access.permissionKey} />
      </TerminalShell>
    );
  }

  const operatorLabel = access.user.address ?? access.user.id;

  return (
    <TerminalShell active="support" adminView adminSections={["console", "support", "access"]} section="SUPPORT">
      <section className="page-heading" aria-labelledby="support-title">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            SUPPORT <span className="eyebrow-separator">/</span> ONE ACCOUNT, EVERY FACT
          </div>
          <h1 id="support-title"><DepthText text="Support that knows the account" /></h1>
          <p>
            Conversations, internal notes and the full event history behind them — sign-ins, deposits,
            withdrawals, trades, strategy decisions, alert deliveries, admin actions and support messages —
            each linked to its record. A note is internal in the data model, not only on screen, and an
            export carries the thread with every credential redacted.
          </p>
        </div>
        <span className="section-state">AUDITED STATUS CHANGES</span>
      </section>

      <SupportDesk operatorLabel={operatorLabel} />
    </TerminalShell>
  );
}

export default function SupportPage() {
  return (
    <Suspense
      fallback={
        <div className="market-chart-empty" role="status">
          <strong>Checking support access</strong>
        </div>
      }
    >
      <SupportContent />
    </Suspense>
  );
}
