import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AccessNotice } from "@/components/access-notice";
import { PermissionNotice } from "@/components/permission-notice";
import { DepthText } from "@/components/depth-text";
import { TerminalShell } from "@/components/terminal-shell";
import { ModelRoutingForm } from "@/app/admin/models/model-routing-form";
import { ProbePanel } from "@/app/admin/models/probe-panel";
import { checkPageAccess } from "@/lib/auth/access-gate";
import { describeProviders } from "@/lib/ai/provider";
import { AI_FEATURES, describeAiRoutes, getAiRoutingSettings } from "@/lib/ai/router";
import { formatMicros, readAiUsageReport } from "@/lib/ai/meter";

const CAPABILITY = "AI model routing needs the ADMIN or OWNER role";

function reportPeriod(now = new Date()) {
  return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: now };
}

function shortCost(micros: number | null, currency: string, rate: number): string {
  return micros === null ? "unpriced" : formatMicros(micros, currency, rate);
}

async function AdminModelsContent() {
  await connection();
  const access = await checkPageAccess({ kind: "admin" });
  if (access.status === "unconfigured") {
    return (
      <TerminalShell active="models" adminView adminSections={["admin", "models"]} section="AI MODELS">
        <AccessNotice capability={CAPABILITY} reason={access.reason} />
      </TerminalShell>
    );
  }
  if (access.status === "anonymous") redirect("/login");
  if (access.status === "forbidden") {
    return (
      <TerminalShell active="models" adminView adminSections={["models"]} section="AI MODELS">
        <PermissionNotice capability={CAPABILITY} reason={access.reason} permissionKey={access.permissionKey} />
      </TerminalShell>
    );
  }

  const settings = await getAiRoutingSettings();
  const routes = await describeAiRoutes(settings);
  const providers = describeProviders();
  const period = reportPeriod();
  const usage = await readAiUsageReport({
    from: period.from,
    to: period.to,
    currency: settings.currency,
    usdPerCurrencyUnit: settings.usdPerCurrencyUnit,
    monthlyBudgetUsd: settings.monthlyBudgetUsd,
  });
  const rate = Number(settings.usdPerCurrencyUnit) || 1;
  const adminSections = access.user.role === "ADMIN" || access.user.role === "OWNER"
    ? ["admin", "models", "access"] as const
    : ["models"] as const;

  return (
    <TerminalShell active="models" adminView adminSections={adminSections} section="AI MODELS">
      <section className="page-heading" aria-labelledby="models-title">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            ADMIN <span className="eyebrow-separator">/</span> ROUTING &amp; METERING
          </div>
          <h1 id="models-title"><DepthText text="AI models" /></h1>
          <p>
            Which provider answers each feature, in order, and what the month has cost. A route change applies to
            the next request; keys are named here and never shown.
          </p>
        </div>
        <span className="section-state">{usage ? `${usage.totals.requests} REQUEST(S) THIS MONTH` : "USAGE UNAVAILABLE"}</span>
      </section>

      <section className="data-section market-history-section" aria-labelledby="models-route-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">01 / ROUTE ORDER</div>
            <h2 id="models-route-title">Primary, then fallbacks</h2>
          </div>
          <span className="section-state">APPLIES WITHOUT A REDEPLOY</span>
        </div>
        <ModelRoutingForm initialSettings={settings} providers={providers} />
      </section>

      <section className="data-section market-history-section" aria-labelledby="models-provider-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">02 / PROVIDERS</div>
            <h2 id="models-provider-title">Declared capabilities and keys</h2>
          </div>
          <span className="section-state">{providers.filter((provider) => provider.configured).length}/{providers.length} READY</span>
        </div>
        <div className="market-history-table-wrap">
          <table className="market-history-table">
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Capabilities</th>
                <th scope="col">Key variable</th>
                <th scope="col">Configured</th>
                <th scope="col">Cost model</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((provider) => (
                <tr key={provider.id}>
                  <td>{provider.name}</td>
                  <td>{provider.capabilities.join(" · ")}</td>
                  <td>{provider.keyEnv ?? "keyless"}</td>
                  <td>{provider.configured ? "yes" : "not set"}</td>
                  <td>
                    {provider.cost.unit === "tokens"
                      ? `$${((provider.cost.inputMicrosPerMillion ?? 0) / 1_000_000).toFixed(2)} in / $${((provider.cost.outputMicrosPerMillion ?? 0) / 1_000_000).toFixed(2)} out per Mtok`
                      : provider.cost.microsPerRequest === null
                        ? "unpriced"
                        : provider.cost.microsPerRequest === 0
                          ? "free at this tier"
                          : `$${(provider.cost.microsPerRequest / 1_000_000).toFixed(6)} per request`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="admin-data-note">
          A missing key is reported as the variable to set. Capabilities are checked before every call, so a provider
          that cannot serve a feature is skipped rather than asked.
        </p>
      </section>

      <section className="data-section market-history-section" aria-labelledby="models-effect-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">03 / IN EFFECT NOW</div>
            <h2 id="models-effect-title">What a request would actually use</h2>
          </div>
          <span className="section-state">READ FROM ADMIN DATA</span>
        </div>
        <div className="policy-grid">
          {routes.map((route) => (
            <div key={route.feature}>
              <dt>{route.feature}</dt>
              <dd>
                {route.targets.length > 0
                  ? route.targets.map((target) => (target.model ? `${target.providerId}:${target.model}` : target.providerId)).join(" → ")
                  : `none — ${route.missingKeys.length > 0 ? `set ${route.missingKeys.join(" and ")}` : "no capable provider"}`}
              </dd>
              {route.skipped.length > 0 && (
                <dd className="ai-route-skipped">
                  Skipped: {route.skipped.map((entry) => `${entry.providerId} (${entry.reason})`).join("; ")}
                </dd>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="data-section market-history-section" aria-labelledby="models-usage-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">04 / THIS MONTH&apos;S SPEND</div>
            <h2 id="models-usage-title">Per request, per feature, per account</h2>
          </div>
          <span className="section-state">{usage ? usage.period.from.slice(0, 10) + " → " + usage.period.to.slice(0, 10) : "UNAVAILABLE"}</span>
        </div>

        {!usage ? (
          <p className="policy-disclaimer" role="status">
            The request records could not be read. This period&apos;s spend is unknown, not zero.
          </p>
        ) : (
          <>
            <dl className="policy-grid">
              <div>
                <dt>Total</dt>
                <dd>{usage.totals.costDisplay}</dd>
              </div>
              <div>
                <dt>Requests</dt>
                <dd>{usage.totals.requests}</dd>
              </div>
              <div>
                <dt>Fallbacks used</dt>
                <dd>{usage.totals.requestsFallback}</dd>
              </div>
              <div>
                <dt>Priced / unpriced</dt>
                <dd>{usage.totals.pricedRequests} / {usage.totals.unpricedRequests}</dd>
              </div>
              <div>
                <dt>Budget signal</dt>
                <dd>
                  {usage.budget.monthlyBudgetUsd === null
                    ? "no budget set"
                    : usage.budget.overBudget
                      ? `over ${usage.budget.monthlyBudgetUsd} USD — reported, not enforced`
                      : `${usage.budget.monthlyBudgetUsd} USD, within`}
                </dd>
              </div>
              <div>
                <dt>Rows read</dt>
                <dd>{usage.rowCount}</dd>
              </div>
            </dl>

            <h3 className="ai-usage-heading">By feature</h3>
            <div className="market-history-table-wrap">
              <table className="market-history-table">
                <thead>
                  <tr>
                    <th scope="col">Feature</th>
                    <th scope="col">Requests</th>
                    <th scope="col">Failed</th>
                    <th scope="col">After fallback</th>
                    <th scope="col">Tokens in / out</th>
                    <th scope="col">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.byFeature.length === 0 ? (
                    <tr><td colSpan={6}>No request has been recorded in this period.</td></tr>
                  ) : usage.byFeature.map((entry) => (
                    <tr key={entry.key}>
                      <td>{entry.key}</td>
                      <td>{entry.requests}</td>
                      <td>{entry.failed}</td>
                      <td>{entry.requestsFallback}</td>
                      <td>{entry.inputTokens} / {entry.outputTokens}</td>
                      <td>{shortCost(entry.costMicrosUsd, usage.currency, rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="ai-usage-heading">By account</h3>
            <div className="market-history-table-wrap">
              <table className="market-history-table">
                <thead>
                  <tr>
                    <th scope="col">Account</th>
                    <th scope="col">Requests</th>
                    <th scope="col">Units</th>
                    <th scope="col">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.byUser.length === 0 ? (
                    <tr><td colSpan={4}>No request has been recorded in this period.</td></tr>
                  ) : usage.byUser.map((entry) => (
                    <tr key={entry.key}>
                      <td>{entry.key}</td>
                      <td>{entry.requests}</td>
                      <td>{entry.units}</td>
                      <td>{shortCost(entry.costMicrosUsd, usage.currency, rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="ai-usage-heading">Provider health</h3>
            <div className="market-history-table-wrap">
              <table className="market-history-table">
                <thead>
                  <tr>
                    <th scope="col">Provider</th>
                    <th scope="col">Success / failure</th>
                    <th scope="col">Failure rate</th>
                    <th scope="col">Avg latency</th>
                    <th scope="col">Last success</th>
                    <th scope="col">Last failure</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.health.length === 0 ? (
                    <tr><td colSpan={6}>No provider has been called in this period.</td></tr>
                  ) : usage.health.map((provider) => (
                    <tr key={provider.providerId}>
                      <td>{provider.providerId}</td>
                      <td>{provider.successes} / {provider.failures}</td>
                      <td>{`${(provider.failureRate * 100).toFixed(1)}%`}</td>
                      <td>{provider.averageLatencyMs === null ? "—" : `${provider.averageLatencyMs} ms`}</td>
                      <td>{provider.lastSuccessAt?.replace("T", " ").slice(0, 19) ?? "never"}</td>
                      <td>{provider.lastFailureAt?.replace("T", " ").slice(0, 19) ?? "never"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="admin-data-note">{usage.budget.note}</p>
          </>
        )}
      </section>

      <section className="data-section market-history-section" aria-labelledby="models-features-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">05 / PROBE</div>
            <h2 id="models-features-title">Ask the route a question</h2>
          </div>
          <span className="section-state">{AI_FEATURES.length} ROUTE(S)</span>
        </div>
        <p className="admin-data-note">
          Each feature reads its route on every request, so a saved change is in effect immediately. A request that
          cannot be served names the environment variable that would fix it. The probe uses the admin-probe route and
          reports which target answered, what it fell back from, and what each attempt cost.
        </p>
        <ProbePanel />
      </section>
    </TerminalShell>
  );
}

export default function AdminModelsPage() {
  return (
    <Suspense fallback={<div className="page-loading">Loading AI model settings…</div>}>
      <AdminModelsContent />
    </Suspense>
  );
}
