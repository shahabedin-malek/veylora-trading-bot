import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AccessNotice } from "@/components/access-notice";
import { PermissionNotice } from "@/components/permission-notice";
import { DepthText } from "@/components/depth-text";
import { TerminalShell } from "@/components/terminal-shell";
import { checkPageAccess } from "@/lib/auth/access-gate";
import { depositStore } from "@/lib/deposits/store";
import { DepositCreditForm } from "./deposit-credit-form";
import snapshot from "@/lib/admin/project-state-summary.json";
import { getObservabilitySnapshot, type HealthStatus, type ObservabilitySnapshot } from "@/lib/observability/health";
import { networkHealthSnapshot } from "@/lib/rpc/health";
import { getNetworkRegistry } from "@/lib/rpc/networks";

const CAPABILITY = "The project data catalog needs the admin.data.read permission";

const STATUS_LABEL: Record<HealthStatus, string> = {
  reachable: "REACHABLE",
  degraded: "DEGRADED",
  unreachable: "UNREACHABLE",
  unconfigured: "NOT CONFIGURED",
  unknown: "NO EVIDENCE",
};

function ReachabilityRow({
  label,
  status,
  detail,
  variable,
}: {
  label: string;
  status: HealthStatus;
  detail: string;
  variable?: string;
}) {
  return (
    <div className={`observability-row observability-row--${status}`}>
      <div className="observability-row__head">
        <strong>{label}</strong>
        <span className="observability-row__status">{STATUS_LABEL[status]}</span>
      </div>
      <p>{detail}</p>
      {variable && <p className="observability-row__variable">Set {variable} to change this.</p>}
    </div>
  );
}

/**
 * The owner's queue for arrivals the network does not configure.
 *
 * Any token is accepted; only the configured token has a price the code can prove. A
 * transfer in anything else lands here with its symbol, amount and contract, and the
 * owner puts a USDT value on it. An unreadable queue says so rather than showing an
 * empty list, because "nothing to credit" and "could not read the table" are different
 * answers about someone's money.
 */
async function DepositsAwaitingSection() {
  const rows = await depositStore.listAwaitingValuation(50).catch(() => null);
  return (
    <section className="data-section market-history-section" aria-labelledby="awaiting-deposits-title">
      <div className="section-heading">
        <div>
          <div className="section-kicker">07 / ANY-TOKEN CREDITS</div>
          <h2 id="awaiting-deposits-title">Deposits awaiting a valuation</h2>
        </div>
        <span className="section-state">{rows === null ? "UNAVAILABLE" : `${rows.length} SHOWN`}</span>
      </div>
      {rows === null ? (
        <div className="market-chart-empty" role="status">
          <strong>The deposit queue could not be read</strong>
          <span>Nothing is credited from this page until the database answers.</span>
        </div>
      ) : rows.length === 0 ? (
        <div className="market-chart-empty" role="status">
          <strong>No arrival is waiting for a value</strong>
          <span>Transfers in the network&rsquo;s configured token are credited automatically once confirmations land.</span>
        </div>
      ) : (
        <ul className="observability-failures">
          {rows.map((row) => (
            <li key={row.id}>
              <div className="observability-failures__head">
                <strong>{row.tokenSymbol}</strong>
                <span>{row.amount}</span>
                <span>{row.network}</span>
              </div>
              <p>{row.reasonMessage ?? "This arrival is in a token this network does not configure."}</p>
              <small>
                {row.observedAt.toISOString()} · tx {row.txHash}
                {row.tokenAddress ? ` · token ${row.tokenAddress}` : ""}
              </small>
              <DepositCreditForm depositId={row.id} />
            </li>
          ))}
        </ul>
      )}
      <p className="admin-data-note">
        A credit posts the USDT value you enter to the account&rsquo;s ledger balance and writes one audit event with the
        original token, its amount and your figure. Nothing is credited automatically at an unproven price.
      </p>
    </section>
  );
}

function ReachabilitySection({ health }: { health: ObservabilitySnapshot }) {
  return (
    <section className="data-section market-history-section" aria-labelledby="observability-title">
      <div className="section-heading">
        <div>
          <div className="section-kicker">01 / REACHABILITY</div>
          <h2 id="observability-title">What is up right now</h2>
        </div>
        <span className="section-state">READ {health.readAt.slice(11, 19)} UTC</span>
      </div>
      {health.reason && (
        <div className="observability-reason" role="status">
          <span className="observability-reason__code">{health.reason.code.replaceAll("_", " ")}</span>
          <span>{health.reason.message}</span>
        </div>
      )}
      <div className="observability-grid">
        <ReachabilityRow
          label={health.database.label}
          status={health.database.status}
          detail={health.database.detail}
          {...(health.database.variable ? { variable: health.database.variable } : {})}
        />
        <ReachabilityRow
          label={health.runner.label}
          status={health.runner.status}
          detail={health.runner.detail}
          {...(health.runner.variable ? { variable: health.runner.variable } : {})}
        />
      </div>
      <p className="admin-data-note">
        Scheduled cadence {health.runner.cadence} · {health.runner.activeAlerts} active alert(s) ·{" "}
        {health.runner.alertsWithEvaluationError} alert(s) whose last check failed.
      </p>
    </section>
  );
}

/**
 * The runner heartbeat (phase 05).
 *
 * A job that did nothing is the interesting row, so the reason is rendered
 * rather than collapsed into a status: "skipped, no entry condition" and
 * "skipped, another invocation holds the lease" are different facts, and a job
 * that has never run says exactly that instead of showing blank timestamps.
 */
function RunnerSection({ runner }: { runner: ObservabilitySnapshot["runner"] }) {
  return (
    <section className="data-section market-history-section" aria-labelledby="runner-title">
      <div className="section-heading">
        <div>
          <div className="section-kicker">02 / RUNNER HEARTBEAT</div>
          <h2 id="runner-title">Scheduled jobs</h2>
        </div>
        <span className="section-state">{runner.jobs.length} JOB(S) / {runner.cadence.toUpperCase()}</span>
      </div>
      <div className="observability-grid">
        {runner.jobs.map((job) => (
          <div key={job.jobId} className={`observability-row observability-row--${job.status}`}>
            <div className="observability-row__head">
              <strong>{job.label}</strong>
              <span className="observability-row__status">{STATUS_LABEL[job.status]}</span>
            </div>
            <p>{job.detail}</p>
            <dl className="observability-row__facts">
              <div><dt>LAST SUCCESS</dt><dd>{job.lastSuccessAt ?? "NONE"}</dd></div>
              <div><dt>LAST FAILURE</dt><dd>{job.lastFailureAt ?? "NONE"}</dd></div>
              <div><dt>NEXT DUE</dt><dd>{job.nextDueAt ?? "ON THE NEXT CALL"}</dd></div>
              <div><dt>CADENCE</dt><dd>{job.cadence}</dd></div>
              <div><dt>ATTEMPTS</dt><dd>{job.attempts}</dd></div>
            </dl>
            {job.reason && (
              <p className="observability-row__variable">
                {job.reason.code.replaceAll("_", " ")} · {job.reason.message}
                {job.reason.detail ? ` ${job.reason.detail}` : ""}
              </p>
            )}
            {job.variable && <p className="observability-row__variable">Set {job.variable} to change this.</p>}
          </div>
        ))}
      </div>
      {runner.lastInvocation ? (
        <p className="admin-data-note">
          Last invocation {runner.lastInvocation.invocationId} ({runner.lastInvocation.selector}) finished{" "}
          {runner.lastInvocation.finishedAt} as {runner.lastInvocation.outcome.toUpperCase()}: {" "}
          {runner.lastInvocation.jobsRan} ran, {runner.lastInvocation.jobsSkipped} skipped, {runner.lastInvocation.jobsFailed} failed
          {runner.lastInvocation.reason ? ` — ${runner.lastInvocation.reason.message}` : "."}
        </p>
      ) : (
        <p className="admin-data-note">
          No invocation has been recorded yet. The runner is invoked by the host on its schedule, or by hand with the
          cron secret on a local database.
        </p>
      )}
    </section>
  );
}

/**
 * The ledger of record (phase 13).
 *
 * "Healthy" for a ledger means its invariants hold and nothing else, so the row
 * says how much was checked as well as what the verdict was: a green ledger with
 * no entries and a green ledger with a year of them are different facts, and a
 * reader who cannot tell them apart would be reading a status that means nothing.
 * A violation is rendered with the row that broke it.
 */
function LedgerSection({ ledger }: { ledger: ObservabilitySnapshot["ledger"] }) {
  return (
    <section className="data-section market-history-section" aria-labelledby="ledger-title">
      <div className="section-heading">
        <div>
          <div className="section-kicker">03 / LEDGER OF RECORD</div>
          <h2 id="ledger-title">Ledger invariants</h2>
        </div>
        <span className="section-state">{ledger.counts.entries} ENTR(IES)</span>
      </div>
      <div className="observability-grid">
        <div className={`observability-row observability-row--${ledger.status}`}>
          <div className="observability-row__head">
            <strong>{ledger.label}</strong>
            <span className="observability-row__status">{STATUS_LABEL[ledger.status]}</span>
          </div>
          <p>{ledger.detail}</p>
          <dl className="observability-row__facts">
            <div><dt>ACCOUNTS</dt><dd>{ledger.counts.accounts}</dd></div>
            <div><dt>TRANSACTIONS</dt><dd>{ledger.counts.transactions}</dd></div>
            <div><dt>ENTRIES</dt><dd>{ledger.counts.entries}</dd></div>
            <div><dt>CHECKED</dt><dd>{ledger.checkedAt ?? "NEVER"}</dd></div>
          </dl>
          {ledger.checks.map((check) => (
            <p key={check.id} className="observability-row__variable">
              {check.ok ? "HOLDS" : "BROKEN"} · {check.label} — {check.detail}
            </p>
          ))}
          {ledger.violations.slice(0, 5).map((violation) => (
            <p key={`${violation.check}-${violation.detail}`} className="observability-row__variable">
              {violation.check.replaceAll("_", " ")} · {violation.detail}
            </p>
          ))}
        </div>
      </div>
      {ledger.totals.length > 0 && (
        <dl className="market-source-details">
          {ledger.totals.map((total) => (
            <div key={total.asset}>
              <dt>{total.asset} DEBITS / CREDITS</dt>
              <dd>{total.debitDecimal} / {total.creditDecimal}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="admin-data-note">
        The invariant check reads the whole book rather than a sample of it, and runs on the scheduled runner as well as on this page. A violated
        invariant makes the runner&apos;s ledger job fail, so it reaches this panel through the heartbeat as well as through the check above.
      </p>
    </section>
  );
}

/**
 * The RPC registry (phase 17).
 *
 * Discovery is the environment, so the section reports what this process found
 * and why anything is unavailable — by variable name, never by value — and the
 * per-network health it has actually observed. Scope coverage (Development,
 * Preview, Production) is a separate report because the process only ever sees
 * its own environment: `pnpm networks:coverage`.
 */
function NetworksSection({
  registry,
  records,
}: {
  registry: ReturnType<typeof getNetworkRegistry>;
  records: ReturnType<typeof networkHealthSnapshot>;
}) {
  const unavailable = registry.entries.filter((entry) => entry.availability === "unavailable");
  const observed = records.filter((record) => record.requests > 0).slice(0, 12);

  return (
    <section className="data-section market-history-section" aria-labelledby="networks-title">
      <div className="section-heading">
        <div>
          <div className="section-kicker">07 / RPC REGISTRY</div>
          <h2 id="networks-title">Configured networks</h2>
        </div>
        <span className="section-state">{registry.totals.available}/{registry.totals.discovered} AVAILABLE</span>
      </div>
      <dl className="market-source-details">
        <div><dt>DISCOVERED</dt><dd>{registry.totals.discovered}</dd></div>
        <div><dt>AVAILABLE</dt><dd>{registry.totals.available}</dd></div>
        <div><dt>UNAVAILABLE</dt><dd>{registry.totals.unavailable}</dd></div>
        <div><dt>EVM</dt><dd>{registry.totals.evm}</dd></div>
        <div><dt>PORTFOLIO ALLOW-LIST</dt><dd>{registry.totals.listedForPortfolio}</dd></div>
        <div><dt>READ</dt><dd>{registry.readAt.slice(11, 19)} UTC</dd></div>
      </dl>

      {unavailable.length === 0 ? (
        <div className="market-chart-empty" role="status">
          <strong>Every configured network resolved</strong>
          <span>No variable was malformed, empty or pointing at a non-https endpoint.</span>
        </div>
      ) : (
        <ul className="observability-failures">
          {unavailable.map((entry) => (
            <li key={entry.slug}>
              <div className="observability-failures__head">
                <strong>{entry.name}</strong>
                <span>{entry.slug}</span>
                <span>{entry.problem.replaceAll("-", " ").toUpperCase()}</span>
              </div>
              <p>{entry.reason}</p>
              <small>{entry.kind.toUpperCase()} · {entry.tokenAllowlist.replaceAll("-", " ").toUpperCase()}</small>
            </li>
          ))}
        </ul>
      )}

      <div className="section-heading" style={{ marginTop: 18 }}>
        <div>
          <div className="section-kicker">PER-NETWORK HEALTH</div>
          <h3>Last success, last failure and latency</h3>
        </div>
        <span className="section-state">{observed.length} SHOWN</span>
      </div>
      {observed.length === 0 ? (
        <p className="admin-data-note">
          No RPC call has been recorded since this process started. The switcher, the portfolio reads and the proxy
          all record here; a network that has never been called says exactly that.
        </p>
      ) : (
        <div className="observability-grid">
          {observed.map((record) => (
            <div
              className={`observability-row observability-row--${record.consecutiveFailures > 0 ? "degraded" : "reachable"}`}
              key={record.slug}
            >
              <div className="observability-row__head">
                <strong>{record.slug}</strong>
                <span className="observability-row__status">{record.consecutiveFailures > 0 ? "DEGRADED" : "REACHABLE"}</span>
              </div>
              <dl className="observability-row__facts">
                <div><dt>LAST SUCCESS</dt><dd>{record.lastSuccessAt ?? "NONE"}</dd></div>
                <div><dt>LAST FAILURE</dt><dd>{record.lastFailureAt ?? "NONE"}</dd></div>
                <div><dt>LATENCY</dt><dd>{record.lastLatencyMs === null ? "—" : `${record.lastLatencyMs} MS`}</dd></div>
                <div><dt>CONSECUTIVE FAILURES</dt><dd>{record.consecutiveFailures}</dd></div>
                <div><dt>CALLS</dt><dd>{record.requests}</dd></div>
              </dl>
              {record.lastProblem && <p className="observability-row__variable">{record.lastProblem}</p>}
            </div>
          ))}
        </div>
      )}

      <p className="admin-data-note">
        A network is skipped for a bounded cooldown after three consecutive failures, so one dead chain cannot fail a
        request the others can answer. {registry.ignoredVariables.length} beacon endpoint(s) are ignored because they are
        not JSON-RPC. Per-scope coverage is reported by <code>pnpm networks:coverage</code> from the environment manifest.
      </p>
    </section>
  );
}

async function AdminDataContent() {
  await connection();

  let access: Awaited<ReturnType<typeof checkPageAccess>>;
  try {
    access = await checkPageAccess({ kind: "permission", permissionKey: "admin.data.read" });
  } catch {
    // The only thing that reaches here is infrastructure: an authorization
    // failure is returned as a status, not thrown. A database that cannot be
    // read must report *that*, not a crash and not an empty catalog, so the
    // page renders the reachability section and says why the rest is missing.
    const health = await getObservabilitySnapshot();
    return (
      <TerminalShell active="admin" adminView adminSections={["admin"]} section="DATA CATALOG">
        <section className="page-heading" aria-labelledby="admin-data-title">
          <div className="page-heading__copy">
            <div className="eyebrow">
              <span className="eyebrow-line" aria-hidden="true" />
              VEYLORA <span className="eyebrow-separator">/</span> INTERNAL DATA
            </div>
            <h1 id="admin-data-title"><DepthText text="Project data catalog" /></h1>
            <p>Administrator access could not be checked, so only reachability is reported.</p>
          </div>
          <span className="section-state">DEPENDENCY UNAVAILABLE</span>
        </section>
        <ReachabilitySection health={health} />
        <p className="admin-data-note">
          A session cannot be verified while the database is unreachable, so the catalog and the provider
          history are withheld rather than shown empty. Sign in again once the database answers.
        </p>
      </TerminalShell>
    );
  }

  if (access.status === "unconfigured") {
    return (
      <TerminalShell active="admin" adminView adminSections={["admin", "risk", "access"]} section="DATA CATALOG">
        <AccessNotice capability={CAPABILITY} reason={access.reason} />
      </TerminalShell>
    );
  }
  if (access.status === "anonymous") redirect("/login");
  if (access.status === "forbidden") {
    return (
      <TerminalShell active="admin" adminView adminSections={["admin"]} section="DATA CATALOG">
        <PermissionNotice capability={CAPABILITY} reason={access.reason} permissionKey={access.permissionKey} />
      </TerminalShell>
    );
  }
  const user = access.user;

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

  // The health snapshot reports a database it cannot read as data, so this
  // section always renders: a stopped database never produces an empty list.
  const health = await getObservabilitySnapshot();

  return (
    <TerminalShell active="admin" adminView adminSections={adminSections} section="DATA CATALOG">
      <section className="page-heading" aria-labelledby="admin-data-title">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            VEYLORA <span className="eyebrow-separator">/</span> INTERNAL DATA
          </div>
          <h1 id="admin-data-title"><DepthText text="Project data catalog" /></h1>
          <p>Redacted workspace snapshot and live reachability for administrators.</p>
        </div>
        <span className="section-state">SNAPSHOT / {snapshot.snapshotDate}</span>
      </section>

      <ReachabilitySection health={health} />

      <RunnerSection runner={health.runner} />

      <LedgerSection ledger={health.ledger} />

      <section className="data-section market-history-section" aria-labelledby="provider-health-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">04 / PROVIDERS</div>
            <h2 id="provider-health-title">Provider health</h2>
          </div>
          <span className="section-state">FROM {health.retention.retained} RECORD(S)</span>
        </div>
        <div className="observability-grid">
          {health.providers.map((provider) => (
            <div key={provider.providerId} className={`observability-row observability-row--${provider.status}`}>
              <div className="observability-row__head">
                <strong>{provider.label}</strong>
                <span className="observability-row__status">{STATUS_LABEL[provider.status]}</span>
              </div>
              <p>{provider.detail}</p>
              <dl className="observability-row__facts">
                <div><dt>LAST SUCCESS</dt><dd>{provider.lastSuccessAt ?? "NONE"}</dd></div>
                <div><dt>LAST FAILURE</dt><dd>{provider.lastFailureAt ?? "NONE"}</dd></div>
                <div><dt>FAILURES KEPT</dt><dd>{provider.failureCount} / {provider.totalCount}</dd></div>
              </dl>
            </div>
          ))}
        </div>
        <p className="admin-data-note">
          Provider call records keep the {health.retention.limit} most recent calls; the URL on every record is stored with its key redacted.
        </p>
      </section>

      <section className="data-section market-history-section" aria-labelledby="failure-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">05 / RECENT FAILURES</div>
            <h2 id="failure-title">Recent provider failures</h2>
          </div>
          <span className="section-state">{health.recentFailures.length} SHOWN</span>
        </div>
        {health.recentFailures.length === 0 ? (
          <div className="market-chart-empty" role="status">
            <strong>No provider failure recorded</strong>
            <span>Either nothing failed, or nothing has been called since the records table was created.</span>
          </div>
        ) : (
          <ul className="observability-failures">
            {health.recentFailures.map((failure) => (
              <li key={`${failure.requestId ?? "no-request"}-${failure.occurredAt}-${failure.providerId}`}>
                <div className="observability-failures__head">
                  <strong>{failure.providerId}</strong>
                  <span>{failure.code.replaceAll("_", " ")}</span>
                  <span>{failure.statusCode ?? "NO RESPONSE"}</span>
                </div>
                <p>{failure.message}</p>
                <small>
                  {failure.occurredAt} · route {failure.route ?? "NOT ATTRIBUTED"} · request {failure.requestId ?? "NOT ATTRIBUTED"}
                </small>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="data-section market-history-section" aria-labelledby="data-counts-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">06 / LOCAL PROJECT STATE</div>
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

      <DepositsAwaitingSection />

      <NetworksSection registry={getNetworkRegistry()} records={networkHealthSnapshot()} />
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
