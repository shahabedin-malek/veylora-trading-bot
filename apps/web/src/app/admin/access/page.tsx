import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AccessNotice } from "@/components/access-notice";
import { PermissionNotice } from "@/components/permission-notice";
import { DepthText } from "@/components/depth-text";
import { TerminalShell } from "@/components/terminal-shell";
import { TradingAccounts } from "@/components/trading-accounts";
import { AccessManagementForm } from "@/app/admin/access/access-management-form";
import { ApiAccessPanel } from "@/app/admin/access/api-access-panel";
import { ChainGPTSettingsForm } from "@/app/admin/access/chaingpt-settings-form";
import { IntegrationSettingsForm } from "@/app/admin/access/integration-settings-form";
import { NotificationSettingsForm } from "@/app/admin/access/notification-settings-form";
import { SignalSettingsPanel } from "@/app/admin/access/signal-settings-panel";
import { SecurityPanel } from "@/app/admin/access/security-panel";
import { WithdrawalSettingsForm } from "@/app/admin/access/withdrawal-settings-form";
import { WunderTradingSettingsForm } from "@/app/admin/access/wundertrading-settings-form";
import { checkPageAccess } from "@/lib/auth/access-gate";
import { getAdminAccessDirectory } from "@/lib/auth/access-directory";
import { getChainGPTFeatureSettings } from "@/lib/chaingpt/settings";
import { getWunderTradingFeatureSettings } from "@/lib/wundertrading/settings";
import { getIntegrationFeatureSettings } from "@/lib/integrations/settings";
import { getNotificationSettings, notificationChannelViews } from "@/lib/notifications/settings";
import { getIntegrationReadiness } from "@/lib/integrations/readiness";
import { getActivationDirectory } from "@/lib/strategies/activation";
import { readWithdrawalPolicy } from "@/lib/withdrawals/policy";
import { getWithdrawalOwnerSettings, withdrawalSettingsView } from "@/lib/withdrawals/settings";

const CAPABILITY = "Roles, teams and permissions need the ADMIN or OWNER role";

async function AdminAccessContent() {
  await connection();
  const access = await checkPageAccess({ kind: "admin" });
  if (access.status === "unconfigured") {
    return (
      <TerminalShell active="access" adminView adminSections={["admin", "risk", "access"]} section="ACCESS &amp; TEAMS">
        <AccessNotice capability={CAPABILITY} reason={access.reason} />
      </TerminalShell>
    );
  }
  if (access.status === "anonymous") redirect("/login");
  if (access.status === "forbidden") {
    return (
      <TerminalShell active="access" adminView adminSections={["access"]} section="ACCESS &amp; TEAMS">
        <PermissionNotice capability={CAPABILITY} reason={access.reason} permissionKey={access.permissionKey} />
      </TerminalShell>
    );
  }

  const [directory, chainGptSettings, wunderTradingSettings, integrationSettings, withdrawalSettings, notificationSettings] = await Promise.all([
    getAdminAccessDirectory({ id: access.user.id, role: access.user.role }),
    getChainGPTFeatureSettings().catch(() => null),
    getWunderTradingFeatureSettings().catch(() => null),
    getIntegrationFeatureSettings().catch(() => null),
    getWithdrawalOwnerSettings()
      .then((stored) => withdrawalSettingsView(readWithdrawalPolicy(), stored))
      .catch(() => null),
    getNotificationSettings().catch(() => null),
  ]);

  // The phase-23 requirement is that a start or stop "appears in the admin console per
  // account". This reads the same recorded state the owner's panel reads, for every account
  // the viewer's directory already exposes, and includes the accounts that never started —
  // "not started" is an answer, not an omission.
  const activationDirectory = await getActivationDirectory(directory.users.map((user) => user.id)).catch(() => null);
  const accountByUserId = new Map(directory.users.map((user) => [user.id, user]));

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
      <section className="data-section" aria-labelledby="admin-automation-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">ADMIN / AUTOMATION</div>
            <h2 id="admin-automation-title">Smart trading per account</h2>
          </div>
          <span className="section-state">AUDITED PER CHANGE</span>
        </div>
        <p>
          Each account&apos;s activation is its own row, and every start and stop writes an audit event naming the
          actor, the time and the reason. The state and the last pass are what the runner recorded, not a second
          opinion computed here.
        </p>
        {activationDirectory ? (
          <div className="market-history-table-wrap">
            <table className="market-history-table">
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Role</th>
                  <th scope="col">State</th>
                  <th scope="col">Last change</th>
                  <th scope="col">Last pass</th>
                  <th scope="col">Passes</th>
                </tr>
              </thead>
              <tbody>
                {activationDirectory.map((entry) => {
                  const account = accountByUserId.get(entry.userId);
                  return (
                    <tr key={entry.userId}>
                      <td>{account?.address ?? entry.userId}</td>
                      <td>{account?.role ?? "—"}</td>
                      <td>
                        {entry.stateLabel}
                        {entry.reason ? ` — ${entry.reason.code.replaceAll("_", " ").toLowerCase()}` : ""}
                      </td>
                      <td>
                        {entry.lastChangedAt
                          ? `${entry.lastChangedAt}${entry.lastChangedBy ? ` by ${entry.lastChangedBy}` : ""}`
                          : "Never changed"}
                      </td>
                      <td>{entry.lastEvaluatedAt ?? "No pass recorded"}</td>
                      <td>{entry.runCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="policy-disclaimer" role="status">
            Activation rows could not be read from the database, so this table is not shown rather than shown empty.
          </p>
        )}
      </section>
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
      <section className="data-section" aria-labelledby="admin-signals-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">ADMIN / AUTOMATION IN AND OUT</div>
            <h2 id="admin-signals-title">Signals and webhooks</h2>
          </div>
          <span className="section-state">SIGNED BOTH WAYS</span>
        </div>
        <p>
          Inbound signals are signed over the raw body and acted on once per signal id, with the replay window you set
          per token. Outbound webhooks are signed per endpoint, retried on a bounded backoff and marked unhealthy after
          three consecutive failures. Secrets are shown once at creation and never returned again.
        </p>
        <SignalSettingsPanel />
      </section>
      <section className="data-section" aria-labelledby="admin-api-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">ADMIN / EXTERNAL ACCESS</div>
            <h2 id="admin-api-title">Public API and MCP</h2>
          </div>
          <span className="section-state">READ BY DEFAULT</span>
        </div>
        <p>
          Issue scoped keys for other software and a dedicated account for an agent. Keys are hashed, shown once and
          revoked on the next request. Trade scope places paper orders only in that agent account; an order above its
          approval threshold becomes a pending record with an expiry, visible below and at <code>/docs/api</code>.
        </p>
        <ApiAccessPanel />
      </section>
      <section className="data-section" aria-labelledby="admin-security-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">ADMIN / ACCOUNT SECURITY</div>
            <h2 id="admin-security-title">Two-factor and sessions</h2>
          </div>
          <span className="section-state">OWNER CONTROLLED</span>
        </div>
        <p>
          Enrol an authenticator, choose which scopes demand a code, and end any device&rsquo;s session. Every scope is off
          until you turn it on, every requirement is data you can change, and each change is written to the audit trail.
        </p>
        <SecurityPanel />
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
      <section className="data-section" aria-labelledby="withdrawal-admin-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">ADMIN / WITHDRAWALS</div>
            <h2 id="withdrawal-admin-title">Withdrawal new-address window</h2>
          </div>
          <span className="section-state">OWNER CONTROLLED</span>
        </div>
        <p>How long a first withdrawal to an address this account has never used waits before it is queued. Zero holds nothing.</p>
        <WithdrawalSettingsForm initialSettings={withdrawalSettings} />
      </section>
      <section className="data-section" aria-labelledby="notifications-admin-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">ADMIN / ALERT DELIVERY</div>
            <h2 id="notifications-admin-title">Notification channels</h2>
          </div>
          <span className="section-state">INDEPENDENT SWITCHES</span>
        </div>
        <p>
          Each channel is switched on its own. A channel that is on without its credentials names the variable it
          needs, and the other channels keep delivering. Quiet hours queue alerts instead of dropping them.
        </p>
        <NotificationSettingsForm
          initialChannels={notificationSettings ? notificationChannelViews(notificationSettings) : []}
          initialSettings={notificationSettings}
        />
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