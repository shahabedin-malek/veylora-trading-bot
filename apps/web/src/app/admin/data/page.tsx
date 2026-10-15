import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { DepthText } from "@/components/depth-text";
import { TerminalShell } from "@/components/terminal-shell";
import {
  AuthenticationRequiredError,
  AuthorizationRequiredError,
  requireSitePermission,
} from "@/lib/auth/session-store";
import snapshot from "@/lib/admin/project-state-summary.json";

async function AdminDataContent() {
  let user;
  try {
    user = await requireSitePermission("admin.data.read");
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) redirect("/login");
    if (error instanceof AuthorizationRequiredError) notFound();
    throw error;
  }

  const rows = [
    { label: "SOURCE RECORDS", count: snapshot.counts.dataSources },
    { label: "RSS FEED RECORDS", count: snapshot.counts.rssFeeds },
    { label: "TASK RECORDS", count: snapshot.counts.tasks },
    { label: "CHECKPOINT RECORDS", count: snapshot.counts.checkpoints },
    { label: "DECISION RECORDS", count: snapshot.counts.decisions },
  ];
  const adminSections = user.role === "ADMIN" || user.role === "OWNER"
    ? ["admin", "risk", "access"] as const
    : ["admin"] as const;

  return (
    <TerminalShell active="admin" adminView adminSections={adminSections} section="DATA CATALOG">
      <section className="page-heading" aria-labelledby="admin-data-title">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            VEYLORA <span className="eyebrow-separator">/</span> INTERNAL DATA
          </div>
          <h1 id="admin-data-title"><DepthText text="Project data catalog" /></h1>
          <p>Redacted workspace snapshot for administrators.</p>
        </div>
        <span className="section-state">SNAPSHOT / {snapshot.snapshotDate}</span>
      </section>

      <section className="data-section market-history-section" aria-labelledby="data-counts-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">01 / LOCAL PROJECT STATE</div>
            <h2 id="data-counts-title">Aggregate record counts</h2>
          </div>
          <span className="section-state">COUNTS ONLY</span>
        </div>
        <dl className="market-source-details">
          {rows.map(({ label, count }) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{count.toLocaleString("en-US")}</dd>
            </div>
          ))}
        </dl>
        <p className="admin-data-note">
          File paths, task descriptions and API-key registry details are excluded.
        </p>
      </section>
    </TerminalShell>
  );
}

export default function AdminDataPage() {
  return (
    <Suspense fallback={<div className="market-chart-empty" role="status"><strong>Checking administrator access</strong></div>}>
      <AdminDataContent />
    </Suspense>
  );
}