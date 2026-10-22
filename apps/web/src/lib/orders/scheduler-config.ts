import { formatMarketAlertInterval, RUNNER_CRON_INTERVAL_MINUTES } from "@/lib/alerts/scheduler-config";

/**
 * How often reconciliation claims it is due.
 *
 * Unlike the alert evaluation — whose cadence is the owner's configured
 * evaluation interval, clamped to what the host can deliver — reconciliation
 * wants *every* invocation it can get: an order that is wrong is wrong until a
 * pass fixes it, and a pass that runs early costs one lookup. So the interval
 * below is only the shortest gap at which this job says "due"; the host's own
 * delivered cadence is the real ceiling, and today that is one invocation a day
 * (`RUNNER_CRON_SCHEDULE` in `src/lib/alerts/scheduler-config.ts`, with the
 * measured Vercel limits behind it). On a paid plan the schedule in
 * `vercel.json` can be tightened to `*\/5 * * * *` and this interval takes effect
 * as written, with nothing else to change.
 */
export const DEFAULT_ORDER_RECONCILE_INTERVAL_MINUTES = 5;

/** What the owner may set `ORDER_RECONCILE_INTERVAL_MINUTES` to. */
export const SUPPORTED_ORDER_RECONCILE_INTERVALS = [1, 5, 15, 30, 60, 360, 1_440] as const;

export function getOrderReconcileIntervalMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env.ORDER_RECONCILE_INTERVAL_MINUTES?.trim();
  if (!configured || !/^\d+$/.test(configured)) return DEFAULT_ORDER_RECONCILE_INTERVAL_MINUTES;
  const minutes = Number(configured);
  return SUPPORTED_ORDER_RECONCILE_INTERVALS.includes(minutes as (typeof SUPPORTED_ORDER_RECONCILE_INTERVALS)[number])
    ? minutes
    : DEFAULT_ORDER_RECONCILE_INTERVAL_MINUTES;
}

export function formatOrderReconcileInterval(minutes: number): string {
  return formatMarketAlertInterval(minutes);
}

/** The gap the owner's configuration produces, and the cadence the host delivers. */
export function describeOrderReconcileCadence(env: NodeJS.ProcessEnv = process.env): string {
  const interval = getOrderReconcileIntervalMinutes(env);
  const host = formatMarketAlertInterval(RUNNER_CRON_INTERVAL_MINUTES);
  return interval >= RUNNER_CRON_INTERVAL_MINUTES
    ? `Every ${formatOrderReconcileInterval(interval)}.`
    : `As often as the host calls the runner (currently every ${host}); it will not claim due-ness more than once every ${formatOrderReconcileInterval(interval)}.`;
}
