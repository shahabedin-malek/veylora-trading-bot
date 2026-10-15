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