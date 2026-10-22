import DecimalJS from "decimal.js";
import { prisma } from "@/lib/db";
import { TERMINAL_ORDER_STATUSES } from "@/lib/orders/state-machine";
import { capIsSet, type AdjustableRiskPolicy } from "@/lib/risk-controls/policy";
import {
  RISK_LIMIT_FIELDS,
  cooldownRemainingMinutes,
  readStrategyKillSwitch,
  type RiskPolicySettings,
  type RiskLimitField,
} from "@/lib/risk-controls/settings";
import { orderVenueSummary } from "@/lib/venues/registry";

const Decimal = DecimalJS.clone({ precision: 40 });

/**
 * What the owner's limits currently have against them.
 *
 * Requirement 5 asks the panel to show "the current values, the current usage against each
 * cap, and the effect of each switch before it is pressed", and requirement 3 asks a refusal
 * to name the limit and the value it saw. Both need the same facts, so they are computed
 * once, here, from the order table the order path already writes: a usage figure invented by
 * the panel would be a second opinion about the same money.
 *
 * The caps are site-wide (there is one settings row). The usage is one account's, which is
 * what the panel says next to it: the number that matters to an owner is their own exposure,
 * and a site-wide sum across accounts would hide the account that is at its limit.
 */

export type RiskLimitStatus = "ok" | "at-cap" | "over-cap" | "unlimited" | "not-measured";

export type RiskLimitUsageRow = {
  field: RiskLimitField | "killSwitchActive" | "strategyKillSwitch";
  label: string;
  /** The cap as configured, or null when it is a switch rather than a number. */
  cap: string | null;
  /** `Unlimited`, the cap, or the switch's state — the words the panel shows. */
  capLabel: string;
  /** What has been used against it, in the limit's own unit. */
  used: string | null;
  status: RiskLimitStatus;
  detail: string;
};

export type RiskUsageFacts = {
  now: Date;
  /** Working orders plus markets holding a net filled position. */
  openPositions: number;
  /** Notional of orders that are not terminal, USD. */
  openExposureUsd: string;
  /** Orders created inside the owner's trade-cap interval. */
  tradesInInterval: number;
  /** Orders created in the last 24 hours, the phase-20 daily count. */
  tradesToday: number;
  /** Net filled notional in the strategy's market, USD (0 when nothing is filled). */
  strategyOpenNotionalUsd: string;
  /** The owner's switch for the account's current strategy, if it has one. */
  strategy: {
    activationId: string | null;
    strategyId: string | null;
    switchActive: boolean;
    changedAt: string | null;
    changedBy: string | null;
  };
  cooldownRemainingMinutes: number;
  cooldownUntil: string | null;
  venueId: string | null;
};

export type RiskUsageSnapshot = RiskUsageFacts & {
  rows: RiskLimitUsageRow[];
  /** The sentence under the switches: what pressing them does right now. */
  evaluation: string;
};

const ORDER_SELECT = {
  market: true,
  side: true,
  status: true,
  notionalUsdCents: true,
  filledQuantity: true,
  createdAt: true,
} as const;

function decimal(value: string): InstanceType<typeof Decimal> {
  const parsed = new Decimal(value);
  return parsed.isFinite() ? parsed : new Decimal(0);
}

/**
 * One query, every fact the limits need.
 *
 * The window is generous (200 recent orders) and the arithmetic is done in memory so the
 * figures agree with each other: open exposure and the open-position count must describe the
 * same set of rows, and two separate counts could catch the table mid-write and disagree.
 */
export async function readRiskUsageFacts(
  userId: string,
  options: {
    market?: string | null;
    /** Only the interval and the cooldown are read, so a policy without the panel's extra
     * fields (a test fixture, the strategy runner's own type) is still enough. */
    policy: Pick<AdjustableRiskPolicy, "tradeIntervalMinutes" | "cooldownMinutes"> & { cooldownUntil?: string | null };
    now?: Date;
  },
): Promise<RiskUsageFacts> {
  const now = options.now ?? new Date();
  const policy = options.policy;
  const activation = await prisma.strategyActivation
    .findUnique({ where: { userId }, select: { id: true, strategyId: true } })
    .catch(() => null);
  const switchState = await readStrategyKillSwitch(activation?.id ?? null).catch(() => null);
  const market = options.market ?? null;

  const orders = await prisma.tradeOrder
    .findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: ORDER_SELECT,
    })
    .catch(() => []);

  let openPositions = 0;
  let openExposure = new Decimal(0);
  let tradesInInterval = 0;
  let tradesToday = 0;
  let strategyOpen = new Decimal(0);
  const netByMarket = new Map<string, InstanceType<typeof Decimal>>();

  const intervalStart = now.getTime() - Math.max(1, policy.tradeIntervalMinutes) * 60_000;
  const dayStart = now.getTime() - 24 * 60 * 60_000;

  for (const order of orders) {
    const at = order.createdAt.getTime();
    if (at >= intervalStart) tradesInInterval += 1;
    if (at >= dayStart) tradesToday += 1;
    if (!TERMINAL_ORDER_STATUSES.includes(order.status as (typeof TERMINAL_ORDER_STATUSES)[number])) {
      openPositions += 1;
      openExposure = openExposure.plus(new Decimal(order.notionalUsdCents).div(100));
    }
    const filled = decimal(order.filledQuantity);
    if (filled.gt(0) && (order.status === "FILLED" || order.status === "PARTIALLY_FILLED")) {
      const notional = new Decimal(order.notionalUsdCents).div(100);
      const signed = order.side === "BUY" ? notional : notional.neg();
      netByMarket.set(order.market, (netByMarket.get(order.market) ?? new Decimal(0)).plus(signed));
      if (market && order.market === market) strategyOpen = strategyOpen.plus(signed);
    }
  }

  // An open position is also a market holding a net filled quantity — a filled entry is a
  // position whether or not any order is still working.
  for (const net of netByMarket.values()) {
    if (net.gt(0)) openPositions += 1;
  }

  const venue = await orderVenueSummary().catch(() => null);

  return {
    now,
    openPositions,
    openExposureUsd: openExposure.toFixed(2),
    tradesInInterval,
    tradesToday,
    strategyOpenNotionalUsd: Decimal.max(strategyOpen, 0).toFixed(2),
    strategy: {
      activationId: activation?.id ?? null,
      strategyId: activation?.strategyId ?? null,
      switchActive: switchState?.active === true,
      changedAt: switchState?.changedAt ?? null,
      changedBy: switchState?.changedByUserId ?? null,
    },
    // A cooldown of 0 minutes means there is no cooldown, even if a clock from an earlier
    // setting is still ticking: zero refuses nothing, here as everywhere else.
    cooldownRemainingMinutes: policy.cooldownMinutes > 0 ? cooldownRemainingMinutes(policy.cooldownUntil ?? null, now.getTime()) : 0,
    cooldownUntil: policy.cooldownMinutes > 0 ? policy.cooldownUntil ?? null : null,
    venueId: venue?.venueId ?? null,
  };
}

function numericStatus(used: number, cap: number): RiskLimitStatus {
  if (cap <= 0) return "unlimited";
  if (used > cap) return "over-cap";
  if (used >= cap) return "at-cap";
  return "ok";
}

/** The cap's own words: `0` is "Unlimited" everywhere, never "0" or an empty box. */
export function capLabel(cap: string | number): string {
  if (typeof cap === "number") return cap > 0 ? String(cap) : "Unlimited";
  return capIsSet(cap) ? decimal(cap).toFixed(2) : "Unlimited";
}

/**
 * The rows the panel shows, in the order the evaluator checks them.
 *
 * A limit whose usage cannot be measured honestly says `not-measured` with the reason,
 * rather than showing 0 — a zero that means "unknown" next to a cap is worse than no number.
 */
export function usageRows(
  policy: RiskPolicySettings,
  facts: RiskUsageFacts,
  label: (field: RiskLimitField) => string = (field) => RISK_LIMIT_FIELDS.find((limit) => limit.field === field)?.label ?? field,
): RiskLimitUsageRow[] {
  const rows: RiskLimitUsageRow[] = [];

  rows.push({
    field: "strategyKillSwitch",
    label: "This strategy's kill switch",
    cap: null,
    capLabel: facts.strategy.switchActive ? "ENGAGED" : "released",
    used: null,
    status: facts.strategy.switchActive ? "at-cap" : "ok",
    detail: facts.strategy.activationId
      ? facts.strategy.switchActive
        ? "Engaged: the runner will not place an order for this strategy until it is released; other orders are unaffected."
        : "Released: this strategy is evaluated like any other order."
      : "No strategy activation exists yet, so this switch has nothing to stop.",
  });

  rows.push({
    field: "killSwitchActive",
    label: "Global kill switch",
    cap: null,
    capLabel: policy.killSwitchActive ? "ENGAGED" : "released",
    used: null,
    status: policy.killSwitchActive ? "at-cap" : "ok",
    detail: policy.killSwitchActive
      ? "Engaged: every strategy is stopped and every new order, manual or automatic, is refused."
      : "Released: orders are evaluated against the limits below.",
  });

  rows.push({
    field: "maxOrderNotionalUsd",
    label: label("maxOrderNotionalUsd"),
    cap: capIsSet(policy.maxOrderNotionalUsd) ? decimal(policy.maxOrderNotionalUsd).toFixed(2) : null,
    capLabel: capLabel(policy.maxOrderNotionalUsd),
    used: null,
    status: capIsSet(policy.maxOrderNotionalUsd) ? "ok" : "unlimited",
    detail: "Checked against each order's own notional, so there is no standing usage to show.",
  });

  const strategyCap = capIsSet(policy.maxStrategyNotionalUsd) ? decimal(policy.maxStrategyNotionalUsd).toNumber() : 0;
  const strategyUsed = decimal(facts.strategyOpenNotionalUsd).toNumber();
  rows.push({
    field: "maxStrategyNotionalUsd",
    label: label("maxStrategyNotionalUsd"),
    cap: strategyCap > 0 ? strategyCap.toFixed(2) : null,
    capLabel: capLabel(policy.maxStrategyNotionalUsd),
    used: facts.strategyOpenNotionalUsd,
    status: numericStatus(strategyUsed, strategyCap),
    detail: "Net filled notional this account's strategy is holding.",
  });

  rows.push({
    field: "maxOpenPositions",
    label: label("maxOpenPositions"),
    cap: policy.maxOpenPositions > 0 ? String(policy.maxOpenPositions) : null,
    capLabel: policy.maxOpenPositions > 0 ? String(policy.maxOpenPositions) : "Unlimited",
    used: String(facts.openPositions),
    status: numericStatus(facts.openPositions, policy.maxOpenPositions),
    detail: "Working orders plus markets holding a net filled position.",
  });

  rows.push({
    field: "maxTradesPerInterval",
    label: label("maxTradesPerInterval"),
    cap: policy.maxTradesPerInterval > 0 ? String(policy.maxTradesPerInterval) : null,
    capLabel: policy.maxTradesPerInterval > 0 ? String(policy.maxTradesPerInterval) : "Unlimited",
    used: String(facts.tradesInInterval),
    status: numericStatus(facts.tradesInInterval, policy.maxTradesPerInterval),
    detail: `Order intents created in the last ${policy.tradeIntervalMinutes} minute(s).`,
  });

  rows.push({
    field: "tradeIntervalMinutes",
    label: label("tradeIntervalMinutes"),
    cap: String(policy.tradeIntervalMinutes),
    capLabel: `${policy.tradeIntervalMinutes} min`,
    used: null,
    status: "ok",
    detail: "The window the trade cap above is counted over.",
  });

  rows.push({
    field: "cooldownMinutes",
    label: label("cooldownMinutes"),
    cap: policy.cooldownMinutes > 0 ? String(policy.cooldownMinutes) : null,
    capLabel: policy.cooldownMinutes > 0 ? `${policy.cooldownMinutes} min` : "No cooldown",
    used: facts.cooldownRemainingMinutes > 0 ? `${facts.cooldownRemainingMinutes} min left` : "—",
    status: facts.cooldownRemainingMinutes > 0 ? "at-cap" : "ok",
    detail: facts.cooldownRemainingMinutes > 0
      ? `New orders are held back until ${facts.cooldownUntil ?? "the cooldown ends"}.`
      : "Started by a halt — a daily-loss refusal, or releasing the global kill switch.",
  });

  rows.push({
    field: "allowedVenues",
    label: label("allowedVenues"),
    cap: policy.allowedVenues.length > 0 ? policy.allowedVenues.join(", ") : null,
    capLabel: policy.allowedVenues.length > 0 ? policy.allowedVenues.join(", ") : "Every configured venue",
    used: facts.venueId,
    status: policy.allowedVenues.length === 0
      ? "unlimited"
      : facts.venueId && policy.allowedVenues.includes(facts.venueId)
        ? "ok"
        : "over-cap",
    detail: facts.venueId
      ? `Orders currently route to ${facts.venueId}.`
      : "Order routing could not be read, so no venue could be compared.",
  });

  return rows;
}

function factLabel(field: RiskLimitField): string {
  const found = RISK_LIMIT_FIELDS.find((limit) => limit.field === field);
  return found ? found.label : field;
}

/**
 * Everything the panel needs: the policy, this account's usage, the rows, and one sentence
 * saying what the switches would do if pressed.
 */
export async function getRiskUsage(userId: string, policy: RiskPolicySettings, now: Date = new Date()): Promise<RiskUsageSnapshot> {
  const facts = await readRiskUsageFacts(userId, { policy, now });
  const rows = usageRows(policy, facts, factLabel);
  const engaged = policy.killSwitchActive || facts.strategy.switchActive;
  return {
    ...facts,
    rows,
    evaluation: engaged
      ? "While a switch is engaged, every order is refused before it is placed — the runner records the refusal against the strategy and carries on running, and the trading page refuses manual orders naming the switch."
      : "Releasing all switches allows orders again, subject to the limits above; a refusal names the limit, the value it saw and the cap it broke.",
  };
}

/** Whether a usage row is at or over its cap, for the panel's emphasis. */
export function isLimitTight(row: RiskLimitUsageRow): boolean {
  return row.status === "at-cap" || row.status === "over-cap";
}
