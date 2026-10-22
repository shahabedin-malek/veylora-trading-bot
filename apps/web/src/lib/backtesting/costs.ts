import { DEFAULT_TRADING_COSTS, type EffectiveFeeSchedule } from "@/lib/fees/table";

/**
 * What one fill costs, and where the number came from.
 *
 * A backtest that applies costs silently is a backtest that lies, so the assumptions are a
 * value the engine carries and the result prints. They come from the phase-16 fee table —
 * the same version the withdrawal path and the pricing page read — which is what makes
 * "change the fee in /admin/fees, re-run, the result changes" one lookup rather than two
 * settings screens.
 *
 * The model is deliberately plain and stated in full:
 *
 *  - **fee** is charged per side on the traded notional;
 *  - **spread** and **slippage** are adverse per side, so a buy fills above the reference
 *    close and a sell below it by their sum;
 *  - **funding** is charged per day on the position's notional, and only when the position
 *    is leveraged — a 1x spot position borrows nothing, so there is nothing to fund.
 */

export type BacktestCosts = {
  feeBps: string;
  spreadBps: string;
  slippageBps: string;
  fundingBpsPerDay: string;
  source: "owner-fee-table" | "defaults";
  scheduleId: string | null;
  /** When the fee version started applying, ISO-8601, or null for the build defaults. */
  appliedFrom: string | null;
};

const BPS = /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/;

export function costsFromFeeSchedule(schedule: EffectiveFeeSchedule): BacktestCosts {
  return {
    feeBps: schedule.tradingFeeBps,
    spreadBps: schedule.spreadBps,
    slippageBps: schedule.slippageBps,
    fundingBpsPerDay: schedule.fundingBpsPerDay,
    source: schedule.source === "owner-schedule" ? "owner-fee-table" : "defaults",
    scheduleId: schedule.id,
    appliedFrom: schedule.appliedFrom,
  };
}

/** The build's own defaults, for a caller that has no schedule (tests, tooling). */
export function defaultBacktestCosts(): BacktestCosts {
  return {
    feeBps: DEFAULT_TRADING_COSTS.tradingFeeBps,
    spreadBps: DEFAULT_TRADING_COSTS.spreadBps,
    slippageBps: DEFAULT_TRADING_COSTS.slippageBps,
    fundingBpsPerDay: DEFAULT_TRADING_COSTS.fundingBpsPerDay,
    source: "defaults",
    scheduleId: null,
    appliedFrom: null,
  };
}

export type CostValidation = { valid: true; costs: BacktestCosts } | { valid: false; error: string };

/** Optional overrides for a what-if run. Absent fields keep the table's values. */
export function validateCostOverrides(value: unknown, base: BacktestCosts): CostValidation {
  if (value === undefined || value === null) return { valid: true, costs: base };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, error: "Cost assumptions must be an object of basis-point values." };
  }
  const record = value as Record<string, unknown>;
  const fields = [
    ["feeBps", "fee"],
    ["spreadBps", "spread"],
    ["slippageBps", "slippage"],
    ["fundingBpsPerDay", "funding"],
  ] as const;
  const unsupported = Object.keys(record).filter((key) => !fields.some(([field]) => field === key));
  if (unsupported.length > 0) {
    return { valid: false, error: `Cost assumptions cannot carry ${unsupported.join(", ")}.` };
  }
  const costs: BacktestCosts = { ...base, source: "defaults", scheduleId: null, appliedFrom: null };
  for (const [key, label] of fields) {
    const raw = record[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string" || !BPS.test(raw.trim()) || Number(raw) > 10_000) {
      return { valid: false, error: `The ${label} assumption must be basis points from 0 to 10,000.` };
    }
    costs[key] = raw.trim();
  }
  return { valid: true, costs };
}

export function totalAdverseBps(costs: Pick<BacktestCosts, "spreadBps" | "slippageBps">): number {
  return (Number(costs.spreadBps) + Number(costs.slippageBps)) / 10_000;
}

export function feeRate(costs: Pick<BacktestCosts, "feeBps">): number {
  return Number(costs.feeBps) / 10_000;
}

export function fundingRate(costs: Pick<BacktestCosts, "fundingBpsPerDay">): number {
  return Number(costs.fundingBpsPerDay) / 10_000;
}

/**
 * The assumptions, as lines the result and the panel print.
 *
 * `leverage` is needed because funding only exists for a leveraged position; a run at 1x
 * says so rather than leaving the reader to wonder whether funding was quietly applied.
 */
export function describeCosts(costs: BacktestCosts, options: { leverage: number }): string[] {
  const provenance =
    costs.source === "owner-fee-table"
      ? `from the fee table version in force${costs.appliedFrom ? ` since ${costs.appliedFrom}` : ""}`
      : "from this build's default assumptions (no fee version is stored)";
  const lines = [
    `Fee ${costs.feeBps} bps per side ${provenance}.`,
    `Spread ${costs.spreadBps} bps and slippage ${costs.slippageBps} bps are applied against the position on both entry and exit.`,
  ];
  if (options.leverage > 1) {
    lines.push(
      Number(costs.fundingBpsPerDay) > 0
        ? `Funding ${costs.fundingBpsPerDay} bps per day is charged on the position's notional for every day it is held, because leverage is ${options.leverage}x.`
        : `No funding is charged: leverage is ${options.leverage}x and the configured funding rate is 0 bps per day.`,
    );
  } else {
    lines.push("No funding is charged: the position is 1x, so nothing is borrowed.");
  }
  lines.push("These are modelling assumptions, not charges: no order or ledger entry is debited by a backtest.");
  return lines;
}
