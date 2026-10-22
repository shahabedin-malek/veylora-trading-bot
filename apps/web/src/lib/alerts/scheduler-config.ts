export const DEFAULT_MARKET_ALERT_INTERVAL_MINUTES = 1_440;
export const MARKET_ALERT_CRON_SCHEDULE = "0 0 * * *";
export const MARKET_ALERT_CRON_INTERVAL_MINUTES = 1_440;
export const SUPPORTED_MARKET_ALERT_INTERVALS = [1, 5, 15, 30, 60, 1_440, 2_880, 10_080] as const;

export function getMarketAlertIntervalMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env.MARKET_ALERT_EVALUATION_INTERVAL_MINUTES?.trim();
  if (!configured || !/^\d+$/.test(configured)) return DEFAULT_MARKET_ALERT_INTERVAL_MINUTES;
  const minutes = Number(configured);
  return SUPPORTED_MARKET_ALERT_INTERVALS.includes(minutes as (typeof SUPPORTED_MARKET_ALERT_INTERVALS)[number])
    ? minutes
    : DEFAULT_MARKET_ALERT_INTERVAL_MINUTES;
}

export function formatMarketAlertInterval(minutes: number): string {
  if (minutes === 10_080) return "7 days";
  if (minutes === 2_880) return "48 hours";
  if (minutes === 1_440) return "24 hours";
  if (minutes === 60) return "1 hour";
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

export function getEffectiveMarketAlertIntervalMinutes(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(MARKET_ALERT_CRON_INTERVAL_MINUTES, getMarketAlertIntervalMinutes(env));
}

/**
 * What the host actually delivers, and the one schedule this app asks it for.
 *
 * Measured against Vercel's own documentation (2026-10), because a cadence is a
 * promise and this one has a ceiling:
 *
 *  - **Once per day is the floor on the entry plan.** "Hobby accounts are
 *    limited to cron jobs that run once per day. Cron expressions that would run
 *    more frequently will fail during deployment."
 *  - **Per minute is the paid-plan floor**, and its timing precision is
 *    "Per-minute", against the entry plan's "Per-hour (±59 min)".
 *  - **Delivery is best effort.** "Most invocations run as scheduled, but
 *    occasional transient network errors can prevent a request from reaching your
 *    function", and when that happens "your function does not execute, and no
 *    runtime log is created for that scheduled run". "Vercel will not retry an
 *    invocation if a cron job fails."
 *  - **A run can be delivered twice.** "Cron delivery can also occasionally
 *    invoke the same scheduled run more than once."
 *  - **A deployment does not interrupt a running invocation.** "Creating a new
 *    deployment will not interrupt your running cron jobs; they will continue
 *    until they finish."
 *  - **A request may run for 300 seconds** on the entry plan (300 default/300
 *    max), and up to 800 seconds on the paid plan.
 *
 * Source: https://vercel.com/docs/cron-jobs/usage-and-pricing,
 * https://vercel.com/docs/cron-jobs/manage-cron-jobs,
 * https://vercel.com/docs/functions/configuring-functions/duration
 *
 * So this build schedules **one daily invocation** and lets the runner decide
 * what is due, which is exactly what `vercel.json` asks for. A sub-daily job
 * interval is supported by the runner but cannot be delivered by this schedule,
 * which is why `getEffectiveMarketAlertIntervalMinutes` clamps to a day: the
 * owner's configured interval is honoured, and no cadence faster than the host
 * can deliver is ever promised. On a paid plan the owner can tighten the schedule
 * in `vercel.json` to `*\/5 * * * *` and the per-job intervals take effect as
 * written; nothing else has to change.
 */
export const RUNNER_CRON_PATH = "/api/cron/all";
export const RUNNER_CRON_SCHEDULE = MARKET_ALERT_CRON_SCHEDULE;
export const RUNNER_CRON_INTERVAL_MINUTES = MARKET_ALERT_CRON_INTERVAL_MINUTES;

/** The cadence the host delivers today, in words. */
export function formatRunnerCadence(): string {
  return formatMarketAlertInterval(RUNNER_CRON_INTERVAL_MINUTES);
}