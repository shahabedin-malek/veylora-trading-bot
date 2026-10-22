import DecimalJS from "decimal.js";
import { prisma } from "@/lib/db";
import {
  evaluateRiskOrder,
  RISK_POLICY_VERSION,
  type AdjustableRiskPolicy,
  type RiskDecision,
  type RiskOrderInput,
} from "@/lib/risk-controls/policy";
import { auditCreate } from "@/lib/audit/record";

const Decimal = DecimalJS.clone({ precision: 100 });
const SINGLETON_ID = "global";

/**
 * The phase-25 limits, as one list.
 *
 * The panel, the validation and the audit all walk this list rather than naming fields
 * three times: a limit that is added here appears in the editor, is validated on save and
 * gets its own audit row on change, which is what requirement 1 asks of *each* of them.
 */
export const RISK_LIMIT_FIELDS = [
  { field: "maxOrderNotionalUsd", label: "Max notional per order", unit: "USD", kind: "decimal" },
  { field: "maxStrategyNotionalUsd", label: "Max notional per strategy", unit: "USD", kind: "decimal" },
  { field: "maxOpenPositions", label: "Max open positions", unit: "orders", kind: "integer" },
  { field: "maxTradesPerInterval", label: "Max trades per interval", unit: "orders", kind: "integer" },
  { field: "tradeIntervalMinutes", label: "Trade-cap interval", unit: "minutes", kind: "integer" },
  { field: "cooldownMinutes", label: "Cooldown after a halt", unit: "minutes", kind: "integer" },
  { field: "allowedVenues", label: "Allowed venues", unit: "venue ids", kind: "list" },
] as const;

export type RiskLimitField = (typeof RISK_LIMIT_FIELDS)[number]["field"];

export type RiskPolicyUpdate = AdjustableRiskPolicy & {
  killSwitchActive: boolean;
  /**
   * The owner's real-money switch (phase 22). Off by default, stored as data beside the
   * limits rather than in the environment, and the only thing that makes a live venue
   * selectable. It is deliberately not part of {@link AdjustableRiskPolicy}: the
   * evaluator's job is to describe limits, this is a statement about money, and keeping
   * them apart stops one being mistaken for the other.
   */
  liveExecutionEnabled: boolean;
};

/** The switch plus who last changed it, for the panel and the audit surface. */
export type RiskPolicySettings = RiskPolicyUpdate & {
  liveExecutionChangedByUserId: string | null;
  liveExecutionChangedAt: string | null;
  /** When each phase-25 limit last took effect, `{field: iso}` (requirement 1). */
  limitsEffectiveFrom: Record<string, string>;
  /** The post-halt cooldown, as an instant, or null when none is running. */
  cooldownUntil: string | null;
  killSwitchChangedByUserId: string | null;
  killSwitchChangedAt: string | null;
};

export type LiveExecutionSetting = {
  enabled: boolean;
  changedByUserId: string | null;
  changedAt: string | null;
};

export type RiskPolicyValidation =
  | { valid: true; value: RiskPolicyUpdate }
  | { valid: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decimalAtLeast(value: unknown, minimum: string): value is string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return false;
  const parsed = new Decimal(value);
  return parsed.isFinite() && parsed.greaterThanOrEqualTo(minimum);
}

// Ratios are validated for form only (a plain positive decimal). How tight the owner
// sets them is configuration, not something this module decides: the admin panel is
// the control, the evaluator is the enforcement, and every change is audited.
function positiveDecimal(value: unknown): value is string {
  return decimalAtLeast(value, "0") && new Decimal(value).greaterThan(0);
}

function integerIn(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

const VENUE_ID = /^[a-z0-9][a-z0-9._-]{1,40}$/;

export function validateRiskPolicyUpdate(value: unknown): RiskPolicyValidation {
  if (!isRecord(value)) return { valid: false, error: "Risk settings must be an object." };

  const allowedKeys = new Set([
    "maxRiskPerTradePercent",
    "maxOpenExposurePercent",
    "dailyLossHaltPercent",
    "maxTradesPerDay",
    "defaultMaxLeverage",
    "minimumVerifiedBalanceUsd",
    "first24HourExposureUsd",
    "approvedSymbols",
    "killSwitchActive",
    "liveExecutionEnabled",
    ...RISK_LIMIT_FIELDS.map((limit) => limit.field),
    // Read-only facts the GET answers with. They are accepted so a page can round-trip what
    // it read — a save that rejected the server's own fields would make every panel edit
    // fail — and they are never written from the body: the audit row and the effective-from
    // map are the server's to author.
    "limitsEffectiveFrom",
    "cooldownUntil",
    "killSwitchChangedByUserId",
    "killSwitchChangedAt",
    "liveExecutionChangedByUserId",
    "liveExecutionChangedAt",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return { valid: false, error: "One or more submitted fields are unsupported." };
  }

  if (!positiveDecimal(value.maxRiskPerTradePercent)) {
    return { valid: false, error: "Per-trade risk must be a positive percentage of configured capital." };
  }
  if (!positiveDecimal(value.maxOpenExposurePercent)) {
    return { valid: false, error: "Open exposure must be a positive percentage of configured capital." };
  }
  if (!positiveDecimal(value.dailyLossHaltPercent)) {
    return { valid: false, error: "Daily-loss halt must be a positive percentage of configured capital." };
  }
  if (typeof value.maxTradesPerDay !== "number" || !Number.isSafeInteger(value.maxTradesPerDay) || value.maxTradesPerDay < 1) {
    return { valid: false, error: "Trades per day must be a whole number of at least 1." };
  }
  if (!positiveDecimal(value.defaultMaxLeverage)) {
    return { valid: false, error: "Leverage must be a positive multiplier." };
  }
  if (!decimalAtLeast(value.minimumVerifiedBalanceUsd, "0")) {
    return { valid: false, error: "Minimum verified balance must be a non-negative USD amount." };
  }
  if (!decimalAtLeast(value.first24HourExposureUsd, "0")) {
    return { valid: false, error: "First-day exposure must be a non-negative USD amount." };
  }
  if (!Array.isArray(value.approvedSymbols) || value.approvedSymbols.length > 100) {
    return { valid: false, error: "Approved symbols must be a list of at most 100 product IDs." };
  }
  if (value.approvedSymbols.some((symbol) => typeof symbol !== "string" || !/^[A-Z0-9]+-[A-Z0-9]+$/.test(symbol))) {
    return { valid: false, error: "Symbols must use uppercase BASE-QUOTE product IDs." };
  }
  if (new Set(value.approvedSymbols).size !== value.approvedSymbols.length) {
    return { valid: false, error: "Approved symbols must be unique." };
  }
  if (typeof value.killSwitchActive !== "boolean") {
    return { valid: false, error: "Kill-switch state must be a boolean." };
  }
  // Required rather than defaulted: a save that omits the live switch would turn real-money
  // execution off from a page that never showed it, which is the owner's decision to make,
  // not a client's to make by accident.
  if (typeof value.liveExecutionEnabled !== "boolean") {
    return { valid: false, error: "Live execution must be stated as on or off." };
  }
  if (!decimalAtLeast(value.maxOrderNotionalUsd, "0")) {
    return { valid: false, error: "Max notional per order must be a non-negative USD amount (0 means unlimited)." };
  }
  if (!decimalAtLeast(value.maxStrategyNotionalUsd, "0")) {
    return { valid: false, error: "Max notional per strategy must be a non-negative USD amount (0 means unlimited)." };
  }
  if (!integerIn(value.maxOpenPositions, 0, 1_000)) {
    return { valid: false, error: "Max open positions must be a whole number between 0 and 1000 (0 means unlimited)." };
  }
  if (!integerIn(value.maxTradesPerInterval, 0, 10_000)) {
    return { valid: false, error: "Max trades per interval must be a whole number between 0 and 10000 (0 means unlimited)." };
  }
  if (!integerIn(value.tradeIntervalMinutes, 1, 1_440)) {
    return { valid: false, error: "The trade-cap interval must be between 1 and 1440 minutes." };
  }
  if (!integerIn(value.cooldownMinutes, 0, 1_440)) {
    return { valid: false, error: "The cooldown must be between 0 and 1440 minutes (0 means no cooldown)." };
  }
  if (!Array.isArray(value.allowedVenues) || value.allowedVenues.length > 20) {
    return { valid: false, error: "Allowed venues must be a list of at most 20 venue ids." };
  }
  if (value.allowedVenues.some((venue) => typeof venue !== "string" || !VENUE_ID.test(venue))) {
    return { valid: false, error: "Allowed venues must be lowercase venue ids, for example binance-testnet." };
  }
  if (new Set(value.allowedVenues).size !== value.allowedVenues.length) {
    return { valid: false, error: "Allowed venues must be unique." };
  }

  return {
    valid: true,
    value: {
      maxRiskPerTradePercent: value.maxRiskPerTradePercent,
      maxOpenExposurePercent: value.maxOpenExposurePercent,
      dailyLossHaltPercent: value.dailyLossHaltPercent,
      maxTradesPerDay: value.maxTradesPerDay,
      defaultMaxLeverage: value.defaultMaxLeverage,
      minimumVerifiedBalanceUsd: value.minimumVerifiedBalanceUsd,
      first24HourExposureUsd: value.first24HourExposureUsd,
      approvedSymbols: value.approvedSymbols,
      killSwitchActive: value.killSwitchActive,
      liveExecutionEnabled: value.liveExecutionEnabled,
      maxOrderNotionalUsd: value.maxOrderNotionalUsd,
      maxStrategyNotionalUsd: value.maxStrategyNotionalUsd,
      maxOpenPositions: value.maxOpenPositions,
      maxTradesPerInterval: value.maxTradesPerInterval,
      tradeIntervalMinutes: value.tradeIntervalMinutes,
      cooldownMinutes: value.cooldownMinutes,
      allowedVenues: value.allowedVenues,
    },
  };
}

function decodeSymbols(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string" && /^[A-Z0-9]+-[A-Z0-9]+$/.test(item))
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function decodeStringList(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string" && VENUE_ID.test(item)) ? parsed : [];
  } catch {
    return [];
  }
}

function decodeTimestampMap(value: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, at]) => typeof at === "string" && !Number.isNaN(Date.parse(at))),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function getRiskPolicySettings(): Promise<RiskPolicySettings> {
  const row = await prisma.riskPolicySettings.findUnique({ where: { id: SINGLETON_ID } });
  if (!row) throw new Error("Risk policy settings are not configured.");
  const candidate = {
    maxRiskPerTradePercent: row.maxRiskPerTradePercent,
    maxOpenExposurePercent: row.maxOpenExposurePercent,
    dailyLossHaltPercent: row.dailyLossHaltPercent,
    maxTradesPerDay: row.maxTradesPerDay,
    defaultMaxLeverage: row.defaultMaxLeverage,
    minimumVerifiedBalanceUsd: row.minimumVerifiedBalanceUsd,
    first24HourExposureUsd: row.first24HourExposureUsd,
    approvedSymbols: decodeSymbols(row.approvedSymbolsJson),
    killSwitchActive: row.killSwitchActive,
    liveExecutionEnabled: row.liveExecutionEnabled,
    maxOrderNotionalUsd: row.maxOrderNotionalUsd,
    maxStrategyNotionalUsd: row.maxStrategyNotionalUsd,
    maxOpenPositions: row.maxOpenPositions,
    maxTradesPerInterval: row.maxTradesPerInterval,
    tradeIntervalMinutes: row.tradeIntervalMinutes,
    cooldownMinutes: row.cooldownMinutes,
    allowedVenues: decodeStringList(row.allowedVenuesJson),
  };
  const validation = validateRiskPolicyUpdate(candidate);
  if (!validation.valid) throw new Error("Stored risk policy failed validation.");
  return {
    ...validation.value,
    liveExecutionChangedByUserId: row.liveExecutionChangedByUserId,
    liveExecutionChangedAt: row.liveExecutionChangedAt ? row.liveExecutionChangedAt.toISOString() : null,
    limitsEffectiveFrom: decodeTimestampMap(row.limitsEffectiveFromJson),
    cooldownUntil: row.cooldownUntil ? row.cooldownUntil.toISOString() : null,
    killSwitchChangedByUserId: row.killSwitchChangedByUserId,
    killSwitchChangedAt: row.killSwitchChangedAt ? row.killSwitchChangedAt.toISOString() : null,
  };
}

/**
 * The live switch alone, for callers that only route on it.
 *
 * The order path asks this rather than the whole policy for two reasons: a missing settings
 * row is not a reason to refuse an order that the paper venue can hold, so an absent row
 * reads as off (the safe direction, and the documented default); and the rest of the policy
 * is none of routing's business. A database that cannot be reached still throws, and the
 * caller turns that into a refusal.
 */
export async function getLiveExecutionSetting(): Promise<LiveExecutionSetting> {
  const row = await prisma.riskPolicySettings.findUnique({
    where: { id: SINGLETON_ID },
    select: {
      liveExecutionEnabled: true,
      liveExecutionChangedByUserId: true,
      liveExecutionChangedAt: true,
    },
  });
  return {
    enabled: row?.liveExecutionEnabled === true,
    changedByUserId: row?.liveExecutionChangedByUserId ?? null,
    changedAt: row?.liveExecutionChangedAt ? row.liveExecutionChangedAt.toISOString() : null,
  };
}

/** Numeric form of a limit, for comparing two saves of the same field. */
function limitValue(policy: Partial<AdjustableRiskPolicy>, field: RiskLimitField): string {
  const value = policy[field];
  if (Array.isArray(value)) return JSON.stringify([...value].sort());
  if (value === undefined || value === null) return "0";
  return String(value);
}

export async function saveRiskPolicySettings(settings: RiskPolicyUpdate, actorUserId: string): Promise<RiskPolicySettings> {
  const validation = validateRiskPolicyUpdate(settings);
  if (!validation.valid) throw new Error("Risk policy update failed validation.");
  const safeSettings = validation.value;

  return prisma.$transaction(async (transaction) => {
    const before = await transaction.riskPolicySettings.findUnique({ where: { id: SINGLETON_ID } });
    const now = new Date();
    const switchFlipped = (before?.liveExecutionEnabled ?? false) !== safeSettings.liveExecutionEnabled;
    const killFlipped = (before?.killSwitchActive ?? false) !== safeSettings.killSwitchActive;

    // Requirement 1: each limit carries the moment it took effect. Only the limits that
    // actually moved get a new timestamp and their own audit row, so the trail answers
    // "when did *this* cap change?" rather than "when was the page last saved?".
    const effectiveFrom = before ? decodeTimestampMap(before.limitsEffectiveFromJson) : {};
    // The stored row keeps the lists as JSON, so the comparison decodes them first: without
    // this, every save would report "allowedVenues changed from 0" and write an audit row
    // for a value nobody touched.
    const beforePolicy: Partial<AdjustableRiskPolicy> | null = before
      ? {
          ...before,
          approvedSymbols: decodeSymbols(before.approvedSymbolsJson),
          allowedVenues: decodeStringList(before.allowedVenuesJson),
        }
      : null;
    const changedLimits = RISK_LIMIT_FIELDS.filter(
      (limit) => beforePolicy !== null && limitValue(beforePolicy, limit.field) !== limitValue(safeSettings, limit.field),
    );
    for (const limit of changedLimits) effectiveFrom[limit.field] = now.toISOString();

    // Releasing the global switch is a halt ending, and the cooldown begins at that moment
    // (requirement 1's cooldown). Engaging it starts nothing: the switch itself is the stop.
    const releasingKill = (before?.killSwitchActive ?? false) && !safeSettings.killSwitchActive;
    // A cooldown of 0 minutes clears the clock as well as not starting one, so the setting
    // and the row cannot disagree: zero refuses nothing.
    const cooldownUntil = safeSettings.cooldownMinutes === 0
      ? null
      : releasingKill
        ? new Date(now.getTime() + safeSettings.cooldownMinutes * 60_000)
        : undefined;

    const data = {
      maxRiskPerTradePercent: safeSettings.maxRiskPerTradePercent,
      maxOpenExposurePercent: safeSettings.maxOpenExposurePercent,
      dailyLossHaltPercent: safeSettings.dailyLossHaltPercent,
      maxTradesPerDay: safeSettings.maxTradesPerDay,
      defaultMaxLeverage: safeSettings.defaultMaxLeverage,
      minimumVerifiedBalanceUsd: safeSettings.minimumVerifiedBalanceUsd,
      first24HourExposureUsd: safeSettings.first24HourExposureUsd,
      approvedSymbolsJson: JSON.stringify(safeSettings.approvedSymbols),
      killSwitchActive: safeSettings.killSwitchActive,
      liveExecutionEnabled: safeSettings.liveExecutionEnabled,
      maxOrderNotionalUsd: safeSettings.maxOrderNotionalUsd,
      maxStrategyNotionalUsd: safeSettings.maxStrategyNotionalUsd,
      maxOpenPositions: safeSettings.maxOpenPositions,
      maxTradesPerInterval: safeSettings.maxTradesPerInterval,
      tradeIntervalMinutes: safeSettings.tradeIntervalMinutes,
      cooldownMinutes: safeSettings.cooldownMinutes,
      allowedVenuesJson: JSON.stringify(safeSettings.allowedVenues),
      limitsEffectiveFromJson: JSON.stringify(effectiveFrom),
      ...(cooldownUntil === undefined ? {} : { cooldownUntil }),
      // Who and when are recorded only when the switch actually moves, so they mean "the
      // last person who changed this", not "the last person who saved the page".
      ...(switchFlipped ? { liveExecutionChangedByUserId: actorUserId, liveExecutionChangedAt: now } : {}),
      ...(killFlipped ? { killSwitchChangedByUserId: actorUserId, killSwitchChangedAt: now } : {}),
      updatedByUserId: actorUserId,
    };
    const saved = await transaction.riskPolicySettings.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...data },
      update: data,
    });
    await auditCreate(transaction, {
      data: {
        actorUserId,
        action: "RISK_POLICY_UPDATED",
        objectType: "RiskPolicySettings",
        objectId: SINGLETON_ID,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({
          policyVersion: RISK_POLICY_VERSION,
          before: before
            ? { ...before, approvedSymbols: decodeSymbols(before.approvedSymbolsJson), allowedVenues: decodeStringList(before.allowedVenuesJson) }
            : null,
          after: safeSettings,
        }),
      },
    });
    for (const limit of changedLimits) {
      await auditCreate(transaction, {
        data: {
          actorUserId,
          action: "RISK_LIMIT_CHANGED",
          objectType: "RiskPolicySettings",
          objectId: `${SINGLETON_ID}:${limit.field}`,
          outcome: "SUCCESS",
          redactedJson: JSON.stringify({
            limit: limit.field,
            label: limit.label,
            from: beforePolicy ? limitValue(beforePolicy, limit.field) : null,
            to: limitValue(safeSettings, limit.field),
            effectiveFrom: now.toISOString(),
          }),
        },
      });
    }
    if (killFlipped) {
      await auditCreate(transaction, {
        data: {
          actorUserId,
          action: safeSettings.killSwitchActive ? "KILL_SWITCH_ENGAGED" : "KILL_SWITCH_RELEASED",
          objectType: "RiskPolicySettings",
          objectId: `${SINGLETON_ID}:killSwitchActive`,
          outcome: "SUCCESS",
          redactedJson: JSON.stringify({
            switch: "killSwitchActive",
            scope: "global",
            from: before?.killSwitchActive ?? false,
            to: safeSettings.killSwitchActive,
            changedAt: now.toISOString(),
            cooldownUntil: saved.cooldownUntil ? saved.cooldownUntil.toISOString() : null,
          }),
        },
      });
    }
    if (switchFlipped) {
      await auditCreate(transaction, {
        data: {
          actorUserId,
          action: safeSettings.liveExecutionEnabled ? "LIVE_EXECUTION_ENABLED" : "LIVE_EXECUTION_DISABLED",
          objectType: "RiskPolicySettings",
          objectId: SINGLETON_ID,
          outcome: "SUCCESS",
          redactedJson: JSON.stringify({
            switch: "liveExecutionEnabled",
            from: before?.liveExecutionEnabled ?? false,
            to: safeSettings.liveExecutionEnabled,
            changedAt: now.toISOString(),
          }),
        },
      });
    }
    return {
      maxRiskPerTradePercent: saved.maxRiskPerTradePercent,
      maxOpenExposurePercent: saved.maxOpenExposurePercent,
      dailyLossHaltPercent: saved.dailyLossHaltPercent,
      maxTradesPerDay: saved.maxTradesPerDay,
      defaultMaxLeverage: saved.defaultMaxLeverage,
      minimumVerifiedBalanceUsd: saved.minimumVerifiedBalanceUsd,
      first24HourExposureUsd: saved.first24HourExposureUsd,
      approvedSymbols: decodeSymbols(saved.approvedSymbolsJson),
      killSwitchActive: saved.killSwitchActive,
      liveExecutionEnabled: saved.liveExecutionEnabled,
      maxOrderNotionalUsd: saved.maxOrderNotionalUsd,
      maxStrategyNotionalUsd: saved.maxStrategyNotionalUsd,
      maxOpenPositions: saved.maxOpenPositions,
      maxTradesPerInterval: saved.maxTradesPerInterval,
      tradeIntervalMinutes: saved.tradeIntervalMinutes,
      cooldownMinutes: saved.cooldownMinutes,
      allowedVenues: decodeStringList(saved.allowedVenuesJson),
      liveExecutionChangedByUserId: saved.liveExecutionChangedByUserId,
      liveExecutionChangedAt: saved.liveExecutionChangedAt ? saved.liveExecutionChangedAt.toISOString() : null,
      limitsEffectiveFrom: decodeTimestampMap(saved.limitsEffectiveFromJson),
      cooldownUntil: saved.cooldownUntil ? saved.cooldownUntil.toISOString() : null,
      killSwitchChangedByUserId: saved.killSwitchChangedByUserId,
      killSwitchChangedAt: saved.killSwitchChangedAt ? saved.killSwitchChangedAt.toISOString() : null,
    };
  });
}

/**
 * Start the post-halt cooldown, if the owner set one.
 *
 * Called where a halt is observed — a daily-loss refusal on either surface. It is
 * idempotent in the direction that matters: a cooldown already running is extended only if
 * the new instant is later, never shortened by a second halt.
 */
export async function startCooldown(input: { actorUserId: string | null; reason: string; now?: Date }): Promise<string | null> {
  const now = input.now ?? new Date();
  const row = await prisma.riskPolicySettings.findUnique({
    where: { id: SINGLETON_ID },
    select: { cooldownMinutes: true, cooldownUntil: true },
  });
  if (!row || row.cooldownMinutes <= 0) return row?.cooldownUntil?.toISOString() ?? null;
  const until = new Date(now.getTime() + row.cooldownMinutes * 60_000);
  if (row.cooldownUntil && row.cooldownUntil.getTime() >= until.getTime()) return row.cooldownUntil.toISOString();
  const saved = await prisma.$transaction(async (transaction) => {
    const updated = await transaction.riskPolicySettings.update({
      where: { id: SINGLETON_ID },
      data: { cooldownUntil: until },
    });
    await auditCreate(transaction, {
      data: {
        actorUserId: input.actorUserId,
        action: "RISK_COOLDOWN_STARTED",
        objectType: "RiskPolicySettings",
        objectId: `${SINGLETON_ID}:cooldownMinutes`,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({
          reason: input.reason,
          cooldownMinutes: row.cooldownMinutes,
          cooldownUntil: until.toISOString(),
        }),
      },
    });
    return updated;
  });
  return saved.cooldownUntil ? saved.cooldownUntil.toISOString() : null;
}

/** Minutes left of the post-halt cooldown, rounded up; 0 when none is running. */
export function cooldownRemainingMinutes(cooldownUntil: string | null, now: number = Date.now()): number {
  if (!cooldownUntil) return 0;
  const until = Date.parse(cooldownUntil);
  if (Number.isNaN(until)) return 0;
  return Math.max(0, Math.ceil((until - now) / 60_000));
}

// ---------------------------------------------------------------------------------------
// The per-strategy kill switch
// ---------------------------------------------------------------------------------------

export type StrategySwitchState = {
  activationId: string;
  active: boolean;
  reason: string | null;
  changedByUserId: string | null;
  changedAt: string | null;
};

export async function readStrategyKillSwitch(activationId: string | null): Promise<StrategySwitchState | null> {
  if (!activationId) return null;
  const row = await prisma.strategyKillSwitch.findUnique({ where: { activationId } });
  if (!row) {
    return { activationId, active: false, reason: null, changedByUserId: null, changedAt: null };
  }
  return {
    activationId: row.activationId,
    active: row.active,
    reason: row.reason,
    changedByUserId: row.changedByUserId,
    changedAt: row.changedAt.toISOString(),
  };
}

/**
 * Turn one strategy's switch on or off, and record who did it.
 *
 * Both directions are allowed and both are audited — requirement 2 asks for a toggle, and
 * the phase forbids a switch the owner cannot turn back off. The strategy it belongs to is
 * looked up from the activation rather than trusted from the request, so a switch cannot be
 * attached to somebody else's strategy by naming it.
 */
export async function setStrategyKillSwitch(input: {
  activationId: string;
  active: boolean;
  actorUserId: string;
  reason?: string | null;
  now?: Date;
}): Promise<StrategySwitchState> {
  const now = input.now ?? new Date();
  const activation = await prisma.strategyActivation.findUnique({
    where: { id: input.activationId },
    select: { id: true, userId: true, strategyId: true },
  });
  if (!activation) throw new Error("No strategy activation has that id.");

  const saved = await prisma.$transaction(async (transaction) => {
    const before = await transaction.strategyKillSwitch.findUnique({ where: { activationId: input.activationId } });
    const row = await transaction.strategyKillSwitch.upsert({
      where: { activationId: input.activationId },
      create: {
        activationId: input.activationId,
        active: input.active,
        reason: input.reason ?? null,
        changedByUserId: input.actorUserId,
        changedAt: now,
      },
      update: {
        active: input.active,
        reason: input.reason ?? null,
        changedByUserId: input.actorUserId,
        changedAt: now,
      },
    });
    await auditCreate(transaction, {
      data: {
        actorUserId: input.actorUserId,
        action: input.active ? "KILL_SWITCH_ENGAGED" : "KILL_SWITCH_RELEASED",
        objectType: "StrategyKillSwitch",
        objectId: `${input.activationId}:strategyId=${activation.strategyId ?? "none"}:owner=${activation.userId}`,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({
          switch: "strategyKillSwitch",
          scope: "strategy",
          activationId: input.activationId,
          strategyId: activation.strategyId,
          from: before?.active ?? false,
          to: input.active,
          changedAt: now.toISOString(),
          reason: input.reason ?? null,
        }),
      },
    });
    return row;
  });

  return {
    activationId: saved.activationId,
    active: saved.active,
    reason: saved.reason,
    changedByUserId: saved.changedByUserId,
    changedAt: saved.changedAt.toISOString(),
  };
}

export async function evaluateCurrentRiskOrder(input: RiskOrderInput): Promise<RiskDecision> {
  return evaluateRiskOrder(input, await getRiskPolicySettings());
}
