import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { DepthText } from "@/components/depth-text";
import { TerminalShell } from "@/components/terminal-shell";
import { RiskPolicyForm } from "@/app/admin/risk/risk-policy-form";
import {
  AuthenticationRequiredError,
  AuthorizationRequiredError,
  requireSitePermission,
} from "@/lib/auth/session-store";
import { getRiskPolicySettings } from "@/lib/risk-controls/settings";

async function AdminRiskContent() {
  await connection();
  let user;
  try {
    user = await requireSitePermission("risk.policy.manage");
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) redirect("/login");
    if (error instanceof AuthorizationRequiredError) notFound();
    throw error;
  }

  const settings = await getRiskPolicySettings().catch(() => null);
  const adminSections = user.role === "ADMIN" || user.role === "OWNER"
    ? ["admin", "risk", "access"] as const
    : ["risk"] as const;
  return (
    <TerminalShell active="risk" adminView adminSections={adminSections} section="RISK CONTROLS">
      <section className="page-heading" aria-labelledby="risk-admin-title">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            ADMIN <span className="eyebrow-separator">/</span> FAIL-CLOSED POLICY
          </div>
          <h1 id="risk-admin-title"><DepthText text="Risk controls" /></h1>
          <p>Admin limits apply globally. They can tighten the approved defaults, not relax them.</p>
        </div>
        <span className="section-state">ORDER ROUTE OFF</span>
      </section>

      <section className="data-section market-history-section" aria-labelledby="risk-settings-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">01 / RISK POLICY SETTINGS</div>
            <h2 id="risk-settings-title">Admin caps and allow-list</h2>
          </div>
          <span className="section-state">AUDITED ON SAVE</span>
        </div>
        {settings ? (
          <RiskPolicyForm initialSettings={{ ...settings, approvedSymbols: [...settings.approvedSymbols] }} />
        ) : (
          <p className="policy-disclaimer" role="status">
            Risk policy could not be loaded from the database. The order evaluator has no configured limits until the settings row loads, and refuses every intent in the meantime.
          </p>
        )}
      </section>
    </TerminalShell>
  );
}

export default function AdminRiskPage() {
  return (
    <Suspense fallback={<div className="market-chart-empty" role="status"><strong>Checking administrator access</strong></div>}>
      <AdminRiskContent />
    </Suspense>
  );
}