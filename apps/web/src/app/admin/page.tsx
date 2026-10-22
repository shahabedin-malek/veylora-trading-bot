import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AccessNotice } from "@/components/access-notice";
import { AdminConsole, type SectionView } from "@/components/admin/admin-console";
import { DepthText } from "@/components/depth-text";
import { PermissionNotice } from "@/components/permission-notice";
import { TerminalShell } from "@/components/terminal-shell";
import { ADMIN_SECTIONS_CONFIG, parseAdminConsoleQuery } from "@/lib/admin/views";
import { checkPageAccess } from "@/lib/auth/access-gate";

const CAPABILITY = "The admin console needs the admin.console.read permission";

const SECTIONS: SectionView[] = ADMIN_SECTIONS_CONFIG.map((section) => ({
  id: section.id,
  label: section.label,
  description: section.description,
  columns: section.columns.map(({ key, label }) => ({ key, label })),
  defaultColumns: [...section.defaultColumns],
  filters: section.filters.map((filter) => ({
    key: filter.key,
    label: filter.label,
    kind: filter.kind,
    ...(filter.placeholder ? { placeholder: filter.placeholder } : {}),
    ...(filter.options ? { options: [...filter.options] } : {}),
  })),
}));

const ADMIN_LINKS = [
  { href: "/admin/support", label: "Support", detail: "Tickets, internal notes, saved replies and the account timeline" },
  { href: "/admin/audit", label: "Audit trail", detail: "Every event, the hash chain, exports and retention" },
  { href: "/admin/access", label: "Access & teams", detail: "Roles, permissions, venue keys and automation settings" },
  { href: "/admin/risk", label: "Risk controls", detail: "Caps, kill switches and the live-execution switch" },
  { href: "/admin/fees", label: "Fees & pricing", detail: "The insert-only fee table and its history" },
  { href: "/admin/data", label: "Data catalog", detail: "Reachability, runner heartbeats, ledger invariants and providers" },
  { href: "/admin/models", label: "AI models", detail: "Provider routing, probes and metering" },
] as const;

function readParams(params: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") result[key] = value;
    else if (Array.isArray(value) && value[0]) result[key] = value[0];
  }
  return result;
}

async function AdminConsoleContent({ params }: { params: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const access = await checkPageAccess({ kind: "permission", permissionKey: "admin.console.read" });
  if (access.status === "unconfigured") {
    return (
      <TerminalShell active="console" adminView adminSections={["console", "admin", "risk", "access"]} section="ADMIN CONSOLE">
        <AccessNotice capability={CAPABILITY} reason={access.reason} />
      </TerminalShell>
    );
  }
  if (access.status === "anonymous") redirect("/login");
  if (access.status === "forbidden") {
    return (
      <TerminalShell active="console" adminView adminSections={["console", "access"]} section="ADMIN CONSOLE">
        <PermissionNotice capability={CAPABILITY} reason={access.reason} permissionKey={access.permissionKey} />
      </TerminalShell>
    );
  }

  const parsed = parseAdminConsoleQuery(readParams(await params));
  const initial = parsed.valid
    ? { section: parsed.section.id, filters: parsed.filters, columns: parsed.columns, error: undefined }
    : { section: "users" as const, filters: {}, columns: [...SECTIONS[0]!.defaultColumns], error: parsed.error };

  return (
    <TerminalShell active="console" adminView adminSections={["console", "admin", "risk", "access"]} section="ADMIN CONSOLE">
      <section className="page-heading" aria-labelledby="admin-console-title">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            OWNER <span className="eyebrow-separator">/</span> ONE CONSOLE
          </div>
          <h1 id="admin-console-title"><DepthText text="Run the business" /></h1>
          <p>
            Users, wallets, balances, ledger, deposits, withdrawals, orders, strategies, venue keys, fees, limits,
            switches and audit — filtered, saved and drilled down. Every action states its effect before it runs and is
            written to the audit trail with actor, target and before/after values.
          </p>
        </div>
        <span className="section-state">AUDITED / OWNER AUTHORISED</span>
      </section>

      <AdminConsole
        initialColumns={initial.columns}
        initialError={initial.error}
        initialFilters={initial.filters}
        initialSection={initial.section}
        sections={SECTIONS}
      />

      <section className="data-section" aria-labelledby="admin-console-operations-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">EXISTING ADMIN SURFACES</div>
            <h2 id="admin-console-operations-title">Operational pages</h2>
          </div>
          <span className="section-state">STILL REACHABLE</span>
        </div>
        <ul className="admin-console__links">
          {ADMIN_LINKS.map((link) => (
            <li key={link.href}>
              <Link href={link.href}>
                <strong>{link.label}</strong>
                <span>{link.detail}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </TerminalShell>
  );
}

export default function AdminConsolePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense
      fallback={
        <div className="market-chart-empty" role="status">
          <strong>Checking administrator access</strong>
        </div>
      }
    >
      <AdminConsoleContent params={searchParams} />
    </Suspense>
  );
}
