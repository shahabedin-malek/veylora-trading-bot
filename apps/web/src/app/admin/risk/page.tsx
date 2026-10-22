import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AccessNotice } from "@/components/access-notice";
import { PermissionNotice } from "@/components/permission-notice";
import { DepthText } from "@/components/depth-text";
import { TerminalShell } from "@/components/terminal-shell";
import { RiskPolicyForm } from "@/app/admin/risk/risk-policy-form";
import { RiskSwitchPanel } from "@/app/admin/risk/risk-switch-panel";
import { checkPageAccess } from "@/lib/auth/access-gate";
import { prisma } from "@/lib/db";
import { getRiskPolicySettings } from "@/lib/risk-controls/settings";
import { getRiskUsage, isLimitTight } from "@/lib/risk-controls/usage";
import { strategyDefinition } from "@/lib/strategies/decide";

const CAPABILITY = "Risk policy management needs the risk.policy.manage permission";

/**
 * Who last moved a switch, as a person rather than a cuid.
 *
 * The switch's row stores the acting account's id, which is the stable fact; this turns it
 * into the wallet label the rest of the admin surface shows, and falls back to the id when
 * the account has no identity (or cannot be read) so the panel never claims less than it
 * knows.
 */
async function switchOperatorLabel(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const identity = await prisma.walletIdentity
    .findFirst({
      where: { userId, revokedAt: null },
      orderBy: { verifiedAt: "desc" },
      select: { addressDisplay: true },
    })
    .catch(() => null);
  return identity?.addressDisplay ?? userId;
}

async function AdminRiskContent() {
  await connection();
  const access = await checkPageAccess({ kind: "permission", permissionKey: "risk.policy.manage" });
  if (access.status === "unconfigured") {
    return (
      <TerminalShell active="risk" adminView adminSections={["admin", "risk", "access"]} section="RISK CONTROLS">
        <AccessNotice capability={CAPABILITY} reason={access.reason} />
      </TerminalShell>
    );
  }
  if (access.status === "anonymous") redirect("/login");
  if (access.status === "forbidden") {
    return (
      <TerminalShell active="risk" adminView adminSections={["risk"]} section="RISK CONTROLS">
        <PermissionNotice capability={CAPABILITY} reason={access.reason} permissionKey={access.permissionKey} />
      </TerminalShell>
    );
  }
  const user = access.user;

  const settings = await getRiskPolicySettings().catch(() => null);
  // Usage is this account's, against the site-wide caps: the number an owner needs is their
  // own exposure, and the panel says which account it is describing.
  const usage = settings ? await getRiskUsage(user.id, settings).catch(() => null) : null;
  const liveBy = await switchOperatorLabel(settings?.liveExecutionChangedByUserId ?? null);
  const killBy = await switchOperatorLabel(settings?.killSwitchChangedByUserId ?? null);
  const strategyBy = await switchOperatorLabel(usage?.strategy.changedBy ?? null);
  const strategyLabel = usage?.strategy.strategyId
    ? strategyDefinition(usage.strategy.strategyId)?.label ?? usage.strategy.strategyId
    : null;
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
        <span className="section-state">
          {settings ? (settings.liveExecutionEnabled ? "LIVE ORDERS ON" : "LIVE ORDERS OFF") : "POLICY UNAVAILABLE"}
        </span>
      </section>

      <section className="data-section market-history-section" aria-labelledby="risk-switches-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">01 / KILL SWITCHES</div>
            <h2 id="risk-switches-title">Stop everything, or stop one strategy</h2>
          </div>
          <span className="section-state">{settings?.killSwitchActive ? "GLOBAL SWITCH ENGAGED" : "IMMEDIATE · AUDITED"}</span>
        </div>
        {settings && usage ? (
          <RiskSwitchPanel
            globalSwitch={{ active: settings.killSwitchActive, changedAt: settings.killSwitchChangedAt, changedBy: killBy }}
            strategySwitch={{
              activationId: usage.strategy.activationId,
              active: usage.strategy.switchActive,
              changedAt: usage.strategy.changedAt,
              changedBy: strategyBy,
            }}
            strategyLabel={strategyLabel}
            effect={usage.evaluation}
          />
        ) : (
          <p className="policy-disclaimer" role="status">
            The switches could not be read from the database, so their state is unknown here. The evaluator refuses
            every intent while the policy row is unreadable, which is the safe direction.
          </p>
        )}
      </section>

      <section className="data-section market-history-section" aria-labelledby="risk-usage-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">02 / USAGE AGAINST EACH CAP</div>
            <h2 id="risk-usage-title">What this account has used</h2>
          </div>
          <span className="section-state">{usage ? `READ ${usage.now.toISOString()}` : "UNAVAILABLE"}</span>
        </div>
        {usage ? (
          <>
            <table className="risk-usage-table">
              <caption>
                Live figures from this account&apos;s orders, compared with the caps above. Zero means unlimited, and is
                shown as Unlimited rather than as a zero to beat.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Limit</th>
                  <th scope="col">Cap</th>
                  <th scope="col">Used</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {usage.rows.map((row) => (
                  <tr className={isLimitTight(row) ? "risk-usage-row--tight" : undefined} key={`${row.field}-${row.label}`}>
                    <th scope="row">{row.label}</th>
                    <td>{row.capLabel}</td>
                    <td>{row.used ?? "—"}</td>
                    <td>{row.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="policy-note">
              A refusal names one of these limits, the value it saw and the cap it broke, and is written to the audit
              trail as its own event — a limit never turns an order into a silent skip.
            </p>
          </>
        ) : (
          <p className="policy-disclaimer" role="status">
            Usage could not be measured, so it is shown as unavailable rather than as zero. The order path does not
            treat an unmeasured limit as an absent one.
          </p>
        )}
      </section>

      <section className="data-section market-history-section" aria-labelledby="risk-settings-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">03 / RISK POLICY SETTINGS</div>
            <h2 id="risk-settings-title">Admin caps and allow-list</h2>
          </div>
          <span className="section-state">AUDITED ON SAVE</span>
        </div>
        {settings ? (
          <RiskPolicyForm
            initialSettings={{
              ...settings,
              approvedSymbols: [...settings.approvedSymbols],
              allowedVenues: [...settings.allowedVenues],
            }}
            liveChange={{ by: liveBy, at: settings.liveExecutionChangedAt }}
            effectiveFrom={settings.limitsEffectiveFrom}
          />
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
