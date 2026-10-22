import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { FeeScheduleForm } from "@/app/admin/fees/fee-schedule-form";
import { AccessNotice } from "@/components/access-notice";
import { PermissionNotice } from "@/components/permission-notice";
import { DepthText } from "@/components/depth-text";
import { TerminalShell } from "@/components/terminal-shell";
import { checkPageAccess } from "@/lib/auth/access-gate";
import { feeSchedulePayload } from "@/lib/fees/admin";
import { readFeeScheduleView } from "@/lib/fees/table";

const CAPABILITY = "The fee table needs the fees.manage permission";

async function AdminFeesContent() {
  await connection();
  const access = await checkPageAccess({ kind: "permission", permissionKey: "fees.manage" });
  if (access.status === "unconfigured") {
    return (
      <TerminalShell active="fees" adminView adminSections={["admin", "fees", "risk", "access"]} section="FEES AND PRICING">
        <AccessNotice capability={CAPABILITY} reason={access.reason} />
      </TerminalShell>
    );
  }
  if (access.status === "anonymous") redirect("/login");
  if (access.status === "forbidden") {
    return (
      <TerminalShell active="fees" adminView adminSections={["fees"]} section="FEES AND PRICING">
        <PermissionNotice capability={CAPABILITY} reason={access.reason} permissionKey={access.permissionKey} />
      </TerminalShell>
    );
  }
  const user = access.user;

  const view = await readFeeScheduleView()
    .then(feeSchedulePayload)
    .catch(() => null);
  const adminSections = user.role === "ADMIN" || user.role === "OWNER"
    ? (["admin", "fees", "risk", "access"] as const)
    : (["fees"] as const);

  return (
    <TerminalShell active="fees" adminView adminSections={adminSections} section="FEES AND PRICING">
      <section className="page-heading" aria-labelledby="fees-admin-title">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            ADMIN <span className="eyebrow-separator">/</span> ONE PRICE LIST
          </div>
          <h1 id="fees-admin-title"><DepthText text="Fees and pricing" /></h1>
          <p>
            One table decides what a withdrawal costs, what a profitable result pays and what each tier
            includes. The withdrawal path and <a href="/pricing">/pricing</a> read the same rows, so a save
            changes both with nothing else to update.
          </p>
        </div>
        <span className="section-state">AUDITED ON SAVE</span>
      </section>

      <section className="data-section market-history-section" aria-labelledby="fee-table-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">01 / FEE TABLE</div>
            <h2 id="fee-table-title">Versions, fees and caps</h2>
          </div>
          <span className="section-state">
            {view?.inForce.source === "owner-schedule" ? "STORED VERSION IN FORCE" : "FREE DEFAULTS IN FORCE"}
          </span>
        </div>
        {view ? (
          <FeeScheduleForm initial={view} />
        ) : (
          <p className="policy-disclaimer" role="status">
            The fee table could not be read, so nothing is asserted about prices. Withdrawals fall back to the
            deployment&apos;s own fee values and <a href="/pricing">/pricing</a> says the table is unavailable
            rather than showing a price.
          </p>
        )}
      </section>

      {view && view.pending.length > 0 && (
        <section className="data-section" aria-labelledby="fee-pending-title">
          <div className="section-heading">
            <div>
              <div className="section-kicker">02 / STAGED VERSIONS</div>
              <h2 id="fee-pending-title">Dated in the future</h2>
            </div>
            <span className="section-state">NOT YET APPLIED</span>
          </div>
          <ul className="fee-history-list">
            {view.pending.map((entry) => (
              <li key={entry.id}>
                <strong>{new Date(entry.effectiveFrom).toLocaleString()}</strong> — performance{" "}
                {entry.performanceFeePercent}% · {Object.keys(entry.withdrawalFees).length} asset fee(s) ·{" "}
                {entry.tiers.length} tier(s)
              </li>
            ))}
          </ul>
        </section>
      )}

      {view && view.history.length > 0 && (
        <section className="data-section" aria-labelledby="fee-history-title">
          <div className="section-heading">
            <div>
              <div className="section-kicker">03 / AUDIT HISTORY</div>
              <h2 id="fee-history-title">Every stored version</h2>
            </div>
            <span className="section-state">NEVER EDITED</span>
          </div>
          <ul className="fee-history-list">
            {view.history.map((entry) => (
              <li key={entry.id}>
                <strong>{new Date(entry.effectiveFrom).toLocaleString()}</strong> —{" "}
                {entry.inForce ? "in force" : "staged"} · performance {entry.performanceFeePercent}% · written{" "}
                {new Date(entry.createdAt).toLocaleString()}
              </li>
            ))}
          </ul>
        </section>
      )}
    </TerminalShell>
  );
}

export default function AdminFeesPage() {
  return (
    <Suspense
      fallback={
        <div className="market-chart-empty" role="status">
          <strong>Checking administrator access</strong>
        </div>
      }
    >
      <AdminFeesContent />
    </Suspense>
  );
}
