import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AccessNotice } from "@/components/access-notice";
import { AuditLog } from "@/components/audit/audit-log";
import { DepthText } from "@/components/depth-text";
import { PermissionNotice } from "@/components/permission-notice";
import { TerminalShell } from "@/components/terminal-shell";
import { checkPageAccess } from "@/lib/auth/access-gate";

const CAPABILITY = "The audit trail needs the audit.read permission";

/** The owner's record of what happened, in order, with the evidence it was not edited. */
async function AuditContent() {
  await connection();
  const access = await checkPageAccess({ kind: "permission", permissionKey: "audit.read" });
  if (access.status === "unconfigured") {
    return (
      <TerminalShell active="audit" adminView adminSections={["audit", "access"]} section="AUDIT TRAIL">
        <AccessNotice capability={CAPABILITY} reason={access.reason} />
      </TerminalShell>
    );
  }
  if (access.status === "anonymous") redirect("/login");
  if (access.status === "forbidden") {
    return (
      <TerminalShell active="audit" adminView adminSections={["audit"]} section="AUDIT TRAIL">
        <PermissionNotice capability={CAPABILITY} reason={access.reason} permissionKey={access.permissionKey} />
      </TerminalShell>
    );
  }

  const manage = await checkPageAccess({ kind: "permission", permissionKey: "audit.manage" });
  const canManage = manage.status === "granted";
  const adminSections = access.user.role === "ADMIN" || access.user.role === "OWNER"
    ? (["console", "audit", "access"] as const)
    : (["audit"] as const);

  return (
    <TerminalShell active="audit" adminView adminSections={adminSections} section="AUDIT TRAIL">
      <section className="page-heading" aria-labelledby="audit-title">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            AUDIT <span className="eyebrow-separator">/</span> ONE RECORD, HASH CHAINED
          </div>
          <h1 id="audit-title"><DepthText text="The audit trail" /></h1>
          <p>
            Every sign-in, deposit, withdrawal, trade, strategy decision, credential change, limit change,
            fee change and admin action writes exactly one event here. Each event carries a hash of its
            predecessor, so a modified or missing row is detectable rather than merely unlikely. The same
            store feeds each account&apos;s timeline, which is why the support desk and this page never disagree.
          </p>
        </div>
        <span className="section-state">APPEND ONLY</span>
      </section>

      <AuditLog canManage={canManage} />
    </TerminalShell>
  );
}

export default function AuditPage() {
  return (
    <Suspense
      fallback={
        <div className="market-chart-empty" role="status">
          <strong>Checking audit access</strong>
        </div>
      }
    >
      <AuditContent />
    </Suspense>
  );
}
