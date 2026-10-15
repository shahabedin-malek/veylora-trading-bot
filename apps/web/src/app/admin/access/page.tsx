import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { DepthText } from "@/components/depth-text";
import { TerminalShell } from "@/components/terminal-shell";
import { TradingAccounts } from "@/components/trading-accounts";
import { AccessManagementForm } from "@/app/admin/access/access-management-form";
import { ChainGPTSettingsForm } from "@/app/admin/access/chaingpt-settings-form";
import { IntegrationSettingsForm } from "@/app/admin/access/integration-settings-form";
import { WunderTradingSettingsForm } from "@/app/admin/access/wundertrading-settings-form";
import {
  AuthenticationRequiredError,
  AuthorizationRequiredError,
  requireAdmin,
} from "@/lib/auth/session-store";
import { getAdminAccessDirectory } from "@/lib/auth/access-directory";
import { getChainGPTFeatureSettings } from "@/lib/chaingpt/settings";
import { getWunderTradingFeatureSettings } from "@/lib/wundertrading/settings";
import { getIntegrationFeatureSettings } from "@/lib/integrations/settings";
import { getIntegrationReadiness } from "@/lib/integrations/readiness";

async function AdminAccessContent() {
  await connection();
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) redirect("/login");
    if (error instanceof AuthorizationRequiredError) notFound();
    throw error;
  }

  const [directory, chainGptSettings, wunderTradingSettings, integrationSettings] = await Promise.all([
    getAdminAccessDirectory(),
    getChainGPTFeatureSettings().catch(() => null),
    getWunderTradingFeatureSettings().catch(() => null),
    getIntegrationFeatureSettings().catch(() => null),
  ]);
  return (
    <TerminalShell active="access" adminView adminSections={["admin", "risk", "access"]} section="ACCESS &amp; TEAMS">
      <section className="page-heading" aria-labelledby="access-title">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            OWNER / ADMIN <span className="eyebrow-separator">/</span> ACCESS CONTROL
          </div>
          <h1 id="access-title"><DepthText text="Roles, teams & permissions" /></h1>
          <p>Assign access only to wallets that have completed SIWE sign-in.</p>
        </div>
        <span className="section-state">OWNER ROLE PROTECTED</span>
      </section>
      <AccessManagementForm initialDirectory={directory} />
      <section className="data-section" aria-labelledby="admin-venue-credentials-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">ADMIN / EXCHANGE ACCESS</div>
            <h2 id="admin-venue-credentials-title">Administrator API keys</h2>
          </div>
          <span className="section-state">ENCRYPTED</span>
        </div>
        <p>Connect keys for your own accounts only. Keys are encrypted before storage and never shown again. Do not enter another user’s key or paste a secret into chat.</p>
        <TradingAccounts />
      </section>
      <section className="data-section" aria-labelledby="chaingpt-admin-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">ADMIN / EXTERNAL LINKS</div>
            <h2 id="chaingpt-admin-title">ChainGPT tools</h2>
          </div>
          <span className="section-state">LINKS ONLY / API OFF</span>
        </div>
        <p>Choose which hosted ChainGPT tools appear in Veylora’s public directory.</p>
        <ChainGPTSettingsForm initialSettings={chainGptSettings} />
      </section>
      <section className="data-section" aria-labelledby="wundertrading-admin-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">ADMIN / EXCHANGE FUNCTIONS</div>
            <h2 id="wundertrading-admin-title">WunderTrading</h2>
          </div>
          <span className="section-state">ADMIN CONTROLLED</span>
        </div>
        <p>Choose which WunderTrading reads and strategy actions are offered.</p>
        <WunderTradingSettingsForm initialSettings={wunderTradingSettings} />
      </section>
      <section className="data-section" aria-labelledby="integrations-admin-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">ADMIN / RUNTIME INTEGRATIONS</div>
            <h2 id="integrations-admin-title">Project readiness</h2>
          </div>
          <span className="section-state">VALUES HIDDEN</span>
        </div>
        <p>Review whether required settings are present. Secret values and public project IDs are never returned by this page.</p>
        <dl className="market-source-details">
          {getIntegrationReadiness().map((item) => (
            <div key={item.id}>
              <dt>{item.label}<small>{item.owner}</small></dt>
              <dd>{item.configured ? "READY" : "NOT CONFIGURED"}</dd>
            </div>
          ))}
        </dl>
        <IntegrationSettingsForm initialSettings={integrationSettings} />
      </section>
    </TerminalShell>
  );
}

export default function AdminAccessPage() {
  return (
    <Suspense fallback={<div className="market-chart-empty" role="status"><strong>Checking administrator access</strong></div>}>
      <AdminAccessContent />
    </Suspense>
  );
}