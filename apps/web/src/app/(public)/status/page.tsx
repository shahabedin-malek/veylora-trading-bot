import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { getObservabilitySnapshot, type HealthStatus, type Reachability } from "@/lib/observability/health";
import { OPERATOR_CONTACT } from "@/lib/public/site";

/**
 * The public status page.
 *
 * It renders the phase-04 health snapshot and the runner's heartbeats, and nothing else. The
 * important design decision is what it *leaves out*: the snapshot's `detail`, `reason`,
 * `lastSafeMessage` and `recentFailures` fields carry provider prose that can name an endpoint,
 * and a public page is not the place for that. A visitor gets the state, the time it was read and
 * the jobs that ran; the owner's console at `/admin/data` carries the diagnostics.
 *
 * It is a server component reading the snapshot directly rather than a public API route: there is
 * no JSON to scrape, no unauthenticated endpoint to rate-limit, and the page cannot disagree with
 * the data it rendered.
 */

export const metadata: Metadata = {
  title: "Status",
  description: "What this deployment is reporting right now: database, ledger, withdrawals, the order runner and its jobs.",
};

export const instant = false;

type Row = {
  name: string;
  note?: string;
  status: HealthStatus;
  time?: string | null;
};

const STATUS_WORDING: Record<HealthStatus, string> = {
  reachable: "Operational",
  degraded: "Degraded",
  unreachable: "Unavailable",
  unconfigured: "Not configured",
  unknown: "Unknown",
};

function toRow(component: Reachability, time?: string | null): Row {
  return { name: component.label, status: component.status, time: time ?? null };
}

function summarise(rows: readonly Row[]): { headline: string; note: string } {
  if (rows.some((row) => row.status === "unreachable")) {
    return {
      headline: "A core service is unavailable",
      note: "One of the services below is not answering. Balances and orders may be unreadable until it returns.",
    };
  }
  if (rows.some((row) => row.status === "degraded")) {
    return {
      headline: "Some services are degraded",
      note: "The deployment is answering, and at least one component reports a problem. Reads may be partial.",
    };
  }
  if (rows.some((row) => row.status === "unknown")) {
    return {
      headline: "Some services could not be checked",
      note: "At least one component did not report, so nothing is asserted about it here.",
    };
  }
  // "Unconfigured" is an answer, but it is not a healthy one: the component does nothing until its
  // variable is set. Saying "all core services reporting" over an unconfigured runner would be the
  // exact claim this page exists to avoid, so it gets its own headline.
  if (rows.some((row) => row.status === "unconfigured")) {
    return {
      headline: "Core services reporting, some parts not configured",
      note: "The deployment answers. At least one component below is switched off because its configuration is missing, so it is not doing its job — and this page will not call that healthy.",
    };
  }
  return {
    headline: "All core services reporting",
    note: "Every service below answered when this page was read, and none of them reported a problem. Markets and venues are not guaranteed by that.",
  };
}

function formatTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  // Fixed and unambiguous: this page is read from anywhere, so no locale-dependent ordering.
  return parsed.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export default async function StatusPage() {
  await connection();

  let snapshot: Awaited<ReturnType<typeof getObservabilitySnapshot>> | null = null;
  let failure: string | null = null;
  try {
    snapshot = await getObservabilitySnapshot();
  } catch {
    failure = "The health snapshot could not be read at all, which is itself the status: treat the deployment as unavailable.";
  }

  if (!snapshot) {
    return (
      <div className="public-prose">
        <p className="eyebrow">STATUS</p>
        <h1>Status unavailable</h1>
        <p role="status">{failure}</p>
        <p>
          The owner sees the same failure in their console. If this persists, reach them through{" "}
          {OPERATOR_CONTACT}.
        </p>
      </div>
    );
  }

  const core: Row[] = [
    toRow(snapshot.database, snapshot.readAt),
    toRow(snapshot.ledger, snapshot.ledger.checkedAt ?? snapshot.readAt),
    toRow(snapshot.withdrawals, snapshot.readAt),
    {
      name: snapshot.runner.label,
      note: snapshot.runner.cadence,
      status: snapshot.runner.status,
      time: snapshot.runner.lastInvocation?.finishedAt ?? snapshot.readAt,
    },
  ];

  const summary = summarise(core);
  const jobs: Row[] = snapshot.runner.jobs.map((job) => ({
    name: job.label,
    note: `${job.cadence}${job.runningNow ? " · running now" : ""}`,
    status: job.status,
    time: job.lastRanAt,
  }));
  const providers: Row[] = snapshot.providers.map((provider) => ({
    name: provider.label,
    status: provider.status,
    time: provider.lastSuccessAt ?? provider.lastCallAt,
  }));

  const unreachable = core.some((row) => row.status === "unreachable");

  return (
    <>
      <div className="public-prose">
        <p className="eyebrow">STATUS</p>
        <h1>What this deployment is reporting</h1>
        <p>
          Read from the same health snapshot the owner&apos;s console uses, at the moment this page was
          requested. It shows state, not diagnostics: provider prose and endpoint names stay in the
          console, because this page is public.
        </p>
      </div>

      <div className="status-summary" role="status" aria-live="polite">
        <div>
          <strong>
            <span
              className={`status-dot status-dot--${unreachable ? "unreachable" : core.some((row) => row.status === "degraded") ? "degraded" : "reachable"}`}
              aria-hidden="true"
            />{" "}
            {summary.headline}
          </strong>
          <small>{summary.note}</small>
        </div>
        <small>Read {formatTime(snapshot.readAt)}</small>
      </div>

      <section className="status-section" aria-labelledby="status-core">
        <h2 id="status-core">Core services</h2>
        <div className="status-rows">
          {core.map((row) => (
            <div className="status-row" key={row.name}>
              <span className="status-row__name">
                {row.name}
                {row.note ? <small>{row.note}</small> : null}
              </span>
              <span className="status-row__state">
                <span className={`status-dot status-dot--${row.status}`} aria-hidden="true" />
                {STATUS_WORDING[row.status]}
              </span>
              <span className="status-row__time">{formatTime(row.time) ?? "no reading"}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="status-section" aria-labelledby="status-jobs">
        <h2 id="status-jobs">Scheduled jobs</h2>
        <div className="status-rows">
          {jobs.map((row) => (
            <div className="status-row" key={row.name}>
              <span className="status-row__name">
                {row.name}
                {row.note ? <small>{row.note}</small> : null}
              </span>
              <span className="status-row__state">
                <span className={`status-dot status-dot--${row.status}`} aria-hidden="true" />
                {STATUS_WORDING[row.status]}
              </span>
              <span className="status-row__time">{formatTime(row.time) ?? "not run yet"}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="status-section" aria-labelledby="status-providers">
        <h2 id="status-providers">Data and integration providers</h2>
        <p className="policy-disclaimer">
          A provider marked <strong>Not configured</strong> is switched off or has no credential in this
          deployment; it is not an outage, and the surfaces that use it say so rather than showing an
          empty result.
        </p>
        <div className="status-rows">
          {providers.map((row) => (
            <div className="status-row" key={row.name}>
              <span className="status-row__name">{row.name}</span>
              <span className="status-row__state">
                <span className={`status-dot status-dot--${row.status}`} aria-hidden="true" />
                {STATUS_WORDING[row.status]}
              </span>
              <span className="status-row__time">{formatTime(row.time) ?? "no call recorded"}</span>
            </div>
          ))}
        </div>
      </section>

      <p className="policy-disclaimer">
        A status of <strong>Operational</strong> means the component answered when read; it is not an
        uptime guarantee and it says nothing about the venues that execute orders. If something looks
        wrong, reach {OPERATOR_CONTACT}. The <Link href="/risk">risk disclosure</Link> explains what
        can go wrong beyond this page.
      </p>
    </>
  );
}
