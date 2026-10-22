import DecimalJS from "decimal.js";
import { prisma } from "@/lib/db";
import { runMarketIngest } from "@/lib/market-data/ingest";
import { TERMINAL_ORDER_STATUSES } from "@/lib/orders/state-machine";
import { submitOrder, type OrderProcessOutcome, type SubmitOrderInput } from "@/lib/orders/process";
import { ORDER_NOTE_PREFIX } from "@/lib/orders/origin";
import { evaluateRiskOrder, type AdjustableRiskPolicy, type RiskDecision } from "@/lib/risk-controls/policy";
import { auditRefusal, describeLimitRefusal } from "@/lib/risk-controls/enforcement";
import { getRiskPolicySettings, readStrategyKillSwitch } from "@/lib/risk-controls/settings";
import { readRiskUsageFacts } from "@/lib/risk-controls/usage";
import { runnerStore } from "@/lib/runner/claim";
import { orderVenueSummary } from "@/lib/venues/registry";
import { readBotStrategyLabel, resolveBotRunnerStrategy } from "@/lib/bot-builder/repository";
import { publishWebhookEvent, type PublishResult } from "@/lib/webhooks/dispatch";
import { STRATEGY_JOB_ID } from "./schedule";
import {
  decisionWindowStart,
  evaluateStrategyDecision,
  marketViewFromCandles,
  missedDecisionWindows,
  strategyDefinition,
  strategyIntervalMs,
  type StrategyCondition,
  type StrategyDecision,
  type StrategyDefinition,
  type StrategyHoldDecision,
  type StrategyMarketView,
  type StrategyPosition,
} from "./decide";
import {
  describeRiskRefusal,
  describeStrategyReason,
  isStrategyReasonCode,
  STRATEGY_REASON_CODES,
  STRATEGY_REASON_INFO,
  strategyCodeForOrderFailure,
  type StrategyReasonCode,
} from "./reasons";

const Decimal = DecimalJS.clone({ precision: 40 });

/**
 * The 24/7 strategy loop.
 *
 * One pass looks at every activation whose intent is RUNNING and evaluates each strategy
 * once per its own interval, on the phase-05 runner's schedule. It is deliberately the
 * only place that reads market data, asks the risk policy, submits an order and writes a
 * decision: a decision row is what "the runner did this, and here is why" means, so there
 * is exactly one writer of it.
 *
 * The two mechanisms that make a duplicate impossible are both in the data:
 *
 *  - `claimWindow` is one conditional statement on the activation row
 *    (`lastWindowStart < window`), so two concurrent invocations cannot both decide the
 *    same window. Losing the claim is a normal outcome and records nothing.
 *  - `recordDecision` is a create against `@@unique([activationId, windowStart])`, so even
 *    if a claim were somehow won twice, the second decision cannot be stored. The order
 *    itself carries a client key derived from the same window, which is the third fence:
 *    the order path replays the first submission instead of placing a second.
 *
 * A pass never gates on configuration. An incomplete setup produces a decision with a
 * reason — no credential, risk limit reached, venue unreachable — and the activation keeps
 * running so it recovers by itself when the owner fixes the cause.
 */

export type StrategyActivationRow = {
  id: string;
  userId: string;
  status: string;
  strategyId: string | null;
  startedAt: Date | null;
  lastWindowStart: Date | null;
};

export type StrategyDecisionWrite = {
  activationId: string;
  userId: string;
  strategyId: string | null;
  windowStart: Date;
  evaluatedAt: Date;
  outcome: "ORDER_PLACED" | "NO_ACTION" | "ERROR";
  reasonCode: StrategyReasonCode;
  reasonMessage: string;
  market: string | null;
  inputs: Record<string, unknown>;
  conditions: readonly StrategyCondition[];
  orderId: string | null;
};

/**
 * What the loop needs from storage.
 *
 * Narrow on purpose, for the same reason `RunnerStore` is: any implementation whose
 * `claimWindow` is atomic and whose `recordDecision` honours the unique window is a valid
 * backing store, which is what lets a test prove single-decision-per-window without a
 * database.
 */
export type StrategyRunnerStore = {
  listRunningActivations(): Promise<StrategyActivationRow[]>;
  /** Take the window for this activation, or answer that somebody else already has it. */
  claimWindow(input: { activationId: string; windowStart: Date }): Promise<boolean>;
  /** Write the decision. False when this window already has one. */
  recordDecision(decision: StrategyDecisionWrite): Promise<boolean>;
  updateActivation(input: {
    activationId: string;
    now: Date;
    outcome: "running" | "idle" | "error";
    reasonCode: StrategyReasonCode;
    reasonMessage: string;
  }): Promise<void>;
  openOrderCount(userId: string, market: string): Promise<number>;
  position(userId: string, market: string): Promise<StrategyPosition | null>;
  tradesToday(userId: string, now: number): Promise<number>;
};

export type StrategyPassDeps = {
  store?: StrategyRunnerStore;
  loadMarket?: (strategy: StrategyDefinition, asOf: Date) => Promise<StrategyMarketView | null>;
  readRiskPolicy?: () => Promise<AdjustableRiskPolicy>;
  evaluateRisk?: (input: Parameters<typeof evaluateRiskOrder>[0], policy: AdjustableRiskPolicy) => RiskDecision;
  readRouting?: () => Promise<"paper" | "testnet" | "live">;
  readVenue?: (userId: string) => Promise<{ connectedCount: number; placeableCount: number }>;
  submit?: (input: SubmitOrderInput) => Promise<OrderProcessOutcome>;
  /** The owner's switch for this activation (phase 25). */
  readStrategySwitch?: (activationId: string) => Promise<boolean>;
  /**
   * The strategy an activation names. Built-ins come from the catalog; `bot:<id>` is a
   * published bot (phase 30), and null means the bot is gone or no longer published.
   */
  resolveStrategy?: (strategyId: string | null, userId: string) => Promise<StrategyDefinition | null>;
  /** This account's usage against the owner's caps, for the evaluator's inputs. */
  readUsage?: (userId: string, market: string, policy: AdjustableRiskPolicy) => Promise<RiskUsageForOrder>;
  /**
   * Where a decision and a placed order are announced (phase 31). Defaults to the webhook
   * publisher, which writes the delivery and attempts it; a test injects a recorder so a pass
   * can be proven without a database or a receiver.
   */
  publish?: (event: {
    userId: string;
    eventType: "strategy.decision" | "trade.placed";
    payload: Record<string, unknown>;
  }) => Promise<PublishResult>;
};

/** The subset of the account's usage an order needs, so a test can supply it directly. */
export type RiskUsageForOrder = {
  openPositions: number;
  tradesInInterval: number;
  strategyOpenNotionalUsd: string;
  cooldownRemainingMinutes: number;
  venueId: string | null;
};

export type StrategyPassSummary = {
  /** Accounts whose intent is RUNNING and were claimed for this window. */
  active: number;
  /** Windows whose decision was written by this pass. */
  decided: number;
  placed: number;
  idle: number;
  error: number;
  gaps: number;
  failures: { account: string; message: string }[];
  reasons: string[];
  placement: "paper" | "testnet" | "live";
  detail: Record<string, number | string | boolean | null>;
};

// ---------------------------------------------------------------------------------------
// The Prisma store
// ---------------------------------------------------------------------------------------

const ACTIVATION_SELECT = {
  id: true,
  userId: true,
  status: true,
  strategyId: true,
  startedAt: true,
  lastWindowStart: true,
} as const;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

export function createPrismaStrategyStore(): StrategyRunnerStore {
  return {
    async listRunningActivations() {
      return prisma.strategyActivation.findMany({
        where: { status: "RUNNING" },
        select: ACTIVATION_SELECT,
        orderBy: { startedAt: "asc" },
        take: 500,
      });
    },

    async claimWindow({ activationId, windowStart }) {
      // One statement. The condition and the write are evaluated together by the
      // database, so the winner is decided by the row itself rather than by a read this
      // process did a moment earlier. The intent must still be RUNNING: a stop that lands
      // during a pass wins, and the pass cannot resurrect the activation by claiming.
      const claimed = await prisma.strategyActivation.updateMany({
        where: {
          id: activationId,
          status: "RUNNING",
          OR: [{ lastWindowStart: null }, { lastWindowStart: { lt: windowStart } }],
        },
        data: { lastWindowStart: windowStart },
      });
      return claimed.count === 1;
    },

    async recordDecision(decision) {
      try {
        await prisma.strategyDecision.create({
          data: {
            activationId: decision.activationId,
            userId: decision.userId,
            strategyId: decision.strategyId,
            windowStart: decision.windowStart,
            evaluatedAt: decision.evaluatedAt,
            outcome: decision.outcome,
            reasonCode: decision.reasonCode,
            reasonMessage: decision.reasonMessage,
            market: decision.market,
            inputsJson: JSON.stringify(decision.inputs),
            conditionsJson: JSON.stringify(decision.conditions),
            orderId: decision.orderId,
          },
        });
        return true;
      } catch (error) {
        if (isUniqueViolation(error)) return false;
        throw error;
      }
    },

    async updateActivation({ activationId, now, outcome, reasonCode, reasonMessage }) {
      await prisma.strategyActivation.updateMany({
        where: { id: activationId, status: "RUNNING" },
        data: {
          lastEvaluatedAt: now,
          lastOutcome: outcome,
          lastReasonCode: reasonCode,
          lastReasonMessage: reasonMessage,
          runCount: { increment: 1 },
        },
      });
    },

    async openOrderCount(userId, market) {
      return prisma.tradeOrder.count({
        where: { userId, market, status: { notIn: [...TERMINAL_ORDER_STATUSES] } },
      });
    },

    async position(userId, market) {
      const orders = await prisma.tradeOrder.findMany({
        where: {
          userId,
          market,
          status: { in: ["FILLED", "PARTIALLY_FILLED"] },
        },
        orderBy: { createdAt: "asc" },
        select: {
          side: true,
          filledQuantity: true,
          requestedAmount: true,
          notionalUsdCents: true,
          stopLossPrice: true,
        },
      });

      let quantity = new Decimal(0);
      let entryPrice: string | null = null;
      let stopLossPrice: string | null = null;
      for (const order of orders) {
        const filled = new Decimal(order.filledQuantity ?? "0");
        if (!filled.isFinite() || filled.lte(0)) continue;
        if (order.side === "BUY") {
          quantity = quantity.plus(filled);
          const requested = new Decimal(order.requestedAmount);
          entryPrice = requested.gt(0)
            ? new Decimal(order.notionalUsdCents).div(100).div(requested).toFixed(2)
            : entryPrice;
          stopLossPrice = order.stopLossPrice && new Decimal(order.stopLossPrice).gt(0) ? order.stopLossPrice : stopLossPrice;
        } else {
          quantity = quantity.minus(filled);
        }
      }
      if (quantity.lte(0)) return null;
      return {
        quantity: quantity.toFixed(8),
        entryPrice: entryPrice ?? "0",
        stopLossPrice,
      };
    },

    async tradesToday(userId, now) {
      return prisma.tradeOrder.count({
        where: { userId, createdAt: { gte: new Date(now - 24 * 60 * 60_000) } },
      });
    },
  };
}

let cachedStore: StrategyRunnerStore | null = null;

export function strategyRunnerStore(): StrategyRunnerStore {
  cachedStore ??= createPrismaStrategyStore();
  return cachedStore;
}

// ---------------------------------------------------------------------------------------
// The signal
// ---------------------------------------------------------------------------------------

/** How old the newest daily candle may be before a pass refreshes the series. */
export const DAILY_CANDLE_STALE_AFTER_MS = 36 * 60 * 60_000;

const CANDLE_LIMIT = 120;

async function readDailyCandles(market: string, asOf: Date) {
  const rows = await prisma.marketCandleRecord.findMany({
    where: { symbol: market, interval: "1d", closeTime: { lte: asOf } },
    orderBy: { closeTime: "desc" },
    take: CANDLE_LIMIT,
    select: { close: true, closeTime: true },
  });
  return rows.reverse();
}

/**
 * The signal for one strategy, refreshing the stored series when it is stale.
 *
 * A pass that silently evaluated day-old candles would show a current-looking RSI for a
 * market that has moved; so a series whose newest close is older than a day and a half is
 * refreshed through the same ingestion path the screener and the market-data job use, and
 * the decision's inputs record the close time that was actually used either way.
 */
async function loadDailyMarket(strategy: StrategyDefinition, asOf: Date): Promise<StrategyMarketView | null> {
  let candles = await readDailyCandles(strategy.market, asOf);
  const newest = candles.at(-1)?.closeTime?.getTime() ?? 0;
  if (!newest || asOf.getTime() - newest > DAILY_CANDLE_STALE_AFTER_MS) {
    await runMarketIngest({
      now: asOf,
      symbols: [strategy.market],
      intervals: ["1d"],
      includeNews: false,
    }).catch(() => null);
    candles = await readDailyCandles(strategy.market, asOf);
  }
  return marketViewFromCandles({ market: strategy.market, candles }, asOf);
}

// ---------------------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------------------

async function readVenueReadiness(userId: string): Promise<{ connectedCount: number; placeableCount: number }> {
  const credentials = await prisma.tradingVenueCredential
    .findMany({ where: { userId, revokedAt: null }, select: { readOnly: true } })
    .catch(() => []);
  return {
    connectedCount: credentials.length,
    placeableCount: credentials.filter((credential) => !credential.readOnly).length,
  };
}

function decisionOutcome(code: StrategyReasonCode): StrategyDecisionWrite["outcome"] {
  const kind = STRATEGY_REASON_INFO[code].kind;
  return kind === "placed" ? "ORDER_PLACED" : kind === "error" ? "ERROR" : "NO_ACTION";
}

function activationOutcome(code: StrategyReasonCode): "running" | "idle" | "error" {
  const kind = STRATEGY_REASON_INFO[code].kind;
  return kind === "placed" ? "running" : kind === "error" ? "error" : "idle";
}

function hold(
  code: StrategyHoldDecision["code"],
  message: string,
  conditions: readonly StrategyCondition[] = [],
): StrategyHoldDecision {
  return { action: "HOLD", code, message, conditions: [...conditions] };
}

/** The risk policy's view of the order this decision wants to send. */
function riskInputFor(input: {
  strategy: StrategyDefinition;
  market: StrategyMarketView;
  decision: Extract<StrategyDecision, { action: "ENTER" | "EXIT" }>;
  position: StrategyPosition | null;
  routing: "paper" | "testnet" | "live";
  killSwitchActive: boolean;
  strategyKillSwitchActive: boolean;
  tradesToday: number;
  usage: RiskUsageForOrder;
  venueId: string;
}) {
  const { strategy, market, decision, position, routing, killSwitchActive, strategyKillSwitchActive, tradesToday, usage, venueId } = input;
  const price = new Decimal(market.lastClose);
  const quantity = new Decimal(decision.order.quantity);
  const stop = new Decimal(decision.order.stopLossPrice);
  const notional = new Decimal(decision.order.notionalUsdCents).div(100);
  const maxLoss = price.minus(stop).abs().mul(quantity);
  return {
    executionMode: (routing === "live" ? "LIVE" : "PAPER") as "LIVE" | "PAPER",
    paperBotActive: true,
    symbol: strategy.market,
    allowedSymbols: [strategy.market] as readonly string[],
    venueApproved: true,
    liveArmed: routing === "live",
    killSwitchActive,
    auditAvailable: true,
    hasValidStopLoss: stop.gt(0),
    capitalUsd: strategy.budgetUsd,
    verifiedAvailableUsd: strategy.budgetUsd,
    requestedNotionalUsd: notional.toFixed(2),
    serverComputedMaxLossUsd: maxLoss.toFixed(2),
    currentOpenExposureUsd: position ? price.mul(new Decimal(position.quantity)).toFixed(2) : "0",
    // Daily loss and post-arm exposure are still not measured here (phase 25 reports the
    // facts it has rather than inventing a drawdown), so the phase-20 daily-loss halt cannot
    // fire from this loop yet; the owner's phase-25 caps below are all measured.
    dailyLossUsd: "0",
    tradesToday,
    leverage: "1",
    first24HoursAfterArm: false,
    exposureSinceArmUsd: "0",
    // Phase 25: the owner's own limits, measured for this account and this strategy.
    strategyKey: strategy.id,
    strategyOpenNotionalUsd: usage.strategyOpenNotionalUsd,
    openPositionCount: usage.openPositions,
    tradesInInterval: usage.tradesInInterval,
    venueId,
    cooldownRemainingMinutes: usage.cooldownRemainingMinutes,
    strategyKillSwitchActive,
  };
}

type SubmittedDecision = {
  outcome: "ORDER_PLACED" | "NO_ACTION" | "ERROR";
  code: StrategyReasonCode;
  message: string;
  orderId: string | null;
};

function decisionFromOrderOutcome(
  outcome: OrderProcessOutcome,
  placed: Extract<StrategyDecision, { action: "ENTER" | "EXIT" }>,
): SubmittedDecision {
  switch (outcome.kind) {
    case "submitted":
      return { outcome: "ORDER_PLACED", code: placed.code, message: placed.message, orderId: outcome.order?.id ?? null };
    case "replayed":
      return {
        outcome: "ORDER_PLACED",
        code: placed.code,
        message: `${placed.message} The order path answered with the order this window had already placed, so no second order was created.`,
        orderId: outcome.order?.id ?? null,
      };
    case "in-flight":
      return {
        outcome: "NO_ACTION",
        code: "POSITION_OPEN",
        message: outcome.reason.message,
        orderId: outcome.order?.id ?? null,
      };
    case "cancelled":
      return { outcome: "NO_ACTION", code: "ORDER_REFUSED", message: outcome.reason.message, orderId: outcome.order?.id ?? null };
    case "refused":
      return {
        outcome: "NO_ACTION",
        code: strategyCodeForOrderFailure({ code: outcome.reason.code, kind: "refused" }),
        message: outcome.reason.message,
        orderId: outcome.order?.id ?? null,
      };
    case "failed":
      return {
        outcome: "ERROR",
        code: strategyCodeForOrderFailure({ code: outcome.reason.code, kind: "failed" }),
        message: outcome.reason.message,
        orderId: outcome.order?.id ?? null,
      };
    case "unresolved":
    default:
      return {
        outcome: "ERROR",
        code: "VENUE_UNREACHABLE",
        message: outcome.reason.message,
        orderId: outcome.order?.id ?? null,
      };
  }
}

/**
 * Run one strategy pass.
 *
 * Everything it cannot know is injected, so the loop's single-decision behaviour can be
 * proven without a database or a venue. In the application every dependency is the real
 * one: the stored daily candles through ingestion, the risk policy row, the registry's
 * routing and the phase-06/20/21 order path.
 */
export async function runStrategyDecisionPass(
  now = Date.now(),
  deps: StrategyPassDeps = {},
): Promise<StrategyPassSummary> {
  const store = deps.store ?? strategyRunnerStore();
  const loadMarket = deps.loadMarket ?? loadDailyMarket;
  const readRiskPolicy = deps.readRiskPolicy ?? (() => getRiskPolicySettings());
  const readRouting = deps.readRouting ?? (async () => (await orderVenueSummary()).environment);
  const readVenue = deps.readVenue ?? readVenueReadiness;
  const submit = deps.submit ?? ((input: SubmitOrderInput) => submitOrder(input));
  const evaluateRisk = deps.evaluateRisk ?? evaluateRiskOrder;
  const readSwitch = deps.readStrategySwitch ?? (async (activationId: string) => (await readStrategyKillSwitch(activationId))?.active === true);
  const resolveStrategy = deps.resolveStrategy ?? (async (strategyId: string | null, userId: string) => {
    const builtIn = strategyDefinition(strategyId);
    if (builtIn) return builtIn;
    return resolveBotRunnerStrategy(strategyId, userId).catch(() => null);
  });
  const publish = deps.publish ?? ((event) => publishWebhookEvent(event));
  const readUsage = deps.readUsage ?? (async (userId: string, market: string, policy: AdjustableRiskPolicy) => {
    const facts = await readRiskUsageFacts(userId, { policy, market });
    return {
      openPositions: facts.openPositions,
      tradesInInterval: facts.tradesInInterval,
      strategyOpenNotionalUsd: facts.strategyOpenNotionalUsd,
      cooldownRemainingMinutes: facts.cooldownRemainingMinutes,
      venueId: facts.venueId,
    };
  });

  const rows = await store.listRunningActivations();
  const placement = await readRouting().catch(() => "paper" as const);

  const summary: StrategyPassSummary = {
    active: rows.length,
    decided: 0,
    placed: 0,
    idle: 0,
    error: 0,
    gaps: 0,
    failures: [],
    reasons: [],
    placement,
    detail: { active: rows.length, placement },
  };

  if (rows.length === 0) {
    summary.reasons.push("No account has smart trading running, so there was no decision to make.");
    return summary;
  }

  const riskPolicy = await readRiskPolicy().catch(() => null);
  const routing = placement;
  const venueByUser = new Map<string, { connectedCount: number; placeableCount: number }>();

  for (const row of rows) {
    const strategy = await resolveStrategy(row.strategyId, row.userId);
    // Without a definition the account still has an intent; the window falls back to the
    // runner's own cadence so the pass can record the disabled state once per hour rather
    // than on every invocation.
    const intervalMinutes = strategy?.decisionIntervalMinutes ?? 60;
    const fallback: StrategyDefinition = {
      id: row.strategyId ?? "unknown",
      label: "Unknown strategy",
      market: "",
      decisionIntervalMinutes: intervalMinutes,
      entryRsiBelow: "0",
      exitRsiAbove: "0",
      stopLossPercent: "0",
      budgetUsd: "0",
      detail: "",
    };
    const windowStart = decisionWindowStart(now, strategy ?? fallback);
    const windowDate = new Date(windowStart);
    // Read before the claim: the claim writes this column, and the gap is about the window
    // that came *before* this pass, not the one it just took.
    const previousWindowStart = row.lastWindowStart?.getTime() ?? null;

    try {
      const claimed = await store.claimWindow({ activationId: row.id, windowStart: windowDate });
      if (!claimed) continue;

      const record = async (input: SubmittedDecision, extra: {
        message?: string;
        market: string | null;
        inputs: Record<string, unknown>;
        conditions: readonly StrategyCondition[];
      }) => {
        const code = input.code;
        const message = describeStrategyReason(code, input.message ?? extra.message ?? null);
        const written = await store.recordDecision({
          activationId: row.id,
          userId: row.userId,
          strategyId: row.strategyId,
          windowStart: windowDate,
          evaluatedAt: new Date(now),
          outcome: decisionOutcome(code),
          reasonCode: code,
          reasonMessage: message,
          market: extra.market,
          inputs: extra.inputs,
          conditions: extra.conditions,
          orderId: input.orderId,
        });
        if (!written) return;
        await publish({
          userId: row.userId,
          eventType: "strategy.decision",
          payload: {
            activationId: row.id,
            strategyId: row.strategyId,
            outcome: input.outcome,
            code,
            message,
            market: extra.market,
            orderId: input.orderId,
            decidedAt: new Date(now).toISOString(),
          },
        }).catch(() => null);
        if (input.outcome === "ORDER_PLACED") {
          await publish({
            userId: row.userId,
            eventType: "trade.placed",
            payload: {
              activationId: row.id,
              strategyId: row.strategyId,
              orderId: input.orderId,
              market: extra.market,
              code,
              placedAt: new Date(now).toISOString(),
            },
          }).catch(() => null);
        }
        summary.decided += 1;
        if (input.outcome === "ORDER_PLACED") summary.placed += 1;
        else if (input.outcome === "ERROR") {
          summary.error += 1;
          summary.failures.push({ account: row.userId, message });
        } else {
          summary.idle += 1;
          summary.reasons.push(`${row.userId}: ${message}`);
        }
        await store.updateActivation({
          activationId: row.id,
          now: new Date(now),
          outcome: activationOutcome(code),
          reasonCode: code,
          reasonMessage: message,
        });
      };

      const intervalMs = strategyIntervalMs(strategy ?? fallback);
      const gap = missedDecisionWindows({
        lastWindowStart: previousWindowStart,
        windowStart,
        intervalMs,
      });
      if (gap) {
        const message = `${gap.count} evaluation window(s) passed without a runner invocation — a deploy, a crash or a missed schedule. The loop continued with this window's decision.`;
        const written = await store.recordDecision({
          activationId: row.id,
          userId: row.userId,
          strategyId: row.strategyId,
          windowStart: new Date(gap.rowWindowStart),
          evaluatedAt: new Date(now),
          outcome: "NO_ACTION",
          reasonCode: "RUNNER_MISSED_WINDOW",
          reasonMessage: message,
          market: strategy?.market ?? null,
          inputs: { missedWindows: gap.count, lastWindowStart: previousWindowStart ? new Date(previousWindowStart).toISOString() : null },
          conditions: [],
          orderId: null,
        });
        if (written) {
          summary.gaps += 1;
          summary.decided += 1;
          summary.idle += 1;
          summary.reasons.push(`${row.userId}: ${message}`);
        }
      }

      if (!strategy) {
        await record(
          { outcome: "NO_ACTION", code: "STRATEGY_DISABLED", message: describeStrategyReason("STRATEGY_DISABLED"), orderId: null },
          { market: null, inputs: { strategyId: row.strategyId }, conditions: [] },
        );
        continue;
      }

      const venue = venueByUser.get(row.userId) ?? (await readVenue(row.userId).catch(() => ({ connectedCount: 0, placeableCount: 0 })));
      venueByUser.set(row.userId, venue);

      const market = await loadMarket(strategy, new Date(now)).catch(() => null);
      const position = await store.position(row.userId, strategy.market).catch(() => null);
      const openOrderCount = await store.openOrderCount(row.userId, strategy.market).catch(() => 0);
      // The owner's own switch for this strategy. An unreadable switch is treated as
      // engaged: a stop that cannot be confirmed released is not a stop the loop may ignore.
      const strategySwitchActive = await readSwitch(row.id).catch(() => true);
      const venueId = routing === "paper" ? "dev-paper" : routing === "testnet" ? "binance-testnet" : "binance";

      let decision = evaluateStrategyDecision({ strategy, market, position, openOrderCount });

      if (venue.placeableCount === 0) {
        decision = hold(
          venue.connectedCount === 0 ? "CREDENTIAL_MISSING" : "INVALID_CREDENTIAL",
          venue.connectedCount === 0
            ? `No exchange key is connected for this account, so the ${strategy.label} entry was not sent. The activation stays running and will act once a key is added.`
            : "The only connected exchange key is stored as read-only, so an order could be read but not placed. The activation stays running and will act once a trade-capable key is added.",
          decision.conditions,
        );
      } else if (riskPolicy?.killSwitchActive || strategySwitchActive) {
        decision = hold(
          "RISK_LIMIT_REACHED",
          strategySwitchActive
            ? "This strategy's kill switch is engaged, so no order was sent. The activation stays running and resumes when the switch is released."
            : "The global kill switch is engaged in the risk policy, so no order was sent. The activation stays running and resumes when it is released.",
          decision.conditions,
        );
      }

      const baseInputs = {
        strategyId: strategy.id,
        market: strategy.market,
        windowStart: new Date(windowStart).toISOString(),
        routing,
        venue,
        rsi: market?.rsi ?? null,
        rsiClosedAt: market?.rsiClosedAt ?? null,
        candles: market?.candles ?? 0,
        lastClose: market?.lastClose ?? null,
        lastClosedAt: market?.lastClosedAt ?? null,
        position,
        openOrderCount,
        killSwitchActive: riskPolicy?.killSwitchActive ?? null,
        strategyKillSwitchActive: strategySwitchActive,
      };

      if (decision.action === "HOLD") {
        await record(
          { outcome: decisionOutcome(decision.code), code: decision.code, message: decision.message, orderId: null },
          { market: strategy.market, inputs: baseInputs, conditions: decision.conditions },
        );
        continue;
      }

      const tradesToday = await store.tradesToday(row.userId, now).catch(() => 0);
      // The owner's caps are measured per account; when they cannot be measured the pass
      // does not guess. "No data" is not "no limit".
      const usage = riskPolicy
        ? await readUsage(row.userId, strategy.market, riskPolicy).catch(() => null)
        : null;
      if (riskPolicy && !usage) {
        await record(
          {
            outcome: "NO_ACTION",
            code: "RISK_LIMIT_REACHED",
            message: "The risk limits could not be measured for this account, so no order was sent. The activation stays running and the next pass tries again.",
            orderId: null,
          },
          { market: strategy.market, inputs: { ...baseInputs, risk: { measured: false } }, conditions: decision.conditions },
        );
        continue;
      }

      const riskInput = riskInputFor({
        strategy,
        market: market as StrategyMarketView,
        decision,
        position,
        routing,
        killSwitchActive: riskPolicy?.killSwitchActive === true,
        strategyKillSwitchActive: strategySwitchActive,
        tradesToday,
        usage: usage ?? { openPositions: 0, tradesInInterval: 0, strategyOpenNotionalUsd: "0", cooldownRemainingMinutes: 0, venueId },
        venueId,
      });

      if (riskPolicy) {
        const riskDecision = await Promise.resolve(evaluateRisk(riskInput, riskPolicy));
        if (riskDecision.decision === "REFUSE") {
          // A refusal names the limit and the value it saw (phase 25 requirement 3) and is
          // audited as its own event, so "the runner wanted to trade and a limit stopped it"
          // is a record rather than an absence (requirement 4).
          const limits = Array.isArray(riskDecision.limits) ? riskDecision.limits : [];
          const refusal = { ...riskDecision, limits };
          const message = limits.length > 0
            ? describeLimitRefusal(refusal)
            : describeRiskRefusal(riskDecision.reasons);
          await auditRefusal({
            actorUserId: row.userId,
            source: "strategy",
            symbol: strategy.market,
            notionalUsd: riskInput.requestedNotionalUsd,
            venueId,
            decision: refusal,
          });
          await record(
            { outcome: "NO_ACTION", code: "RISK_LIMIT_REACHED", message, orderId: null },
            {
              market: strategy.market,
              inputs: {
                ...baseInputs,
                risk: {
                  decision: riskDecision.decision,
                  reasons: riskDecision.reasons,
                  limits,
                  usage: usage ?? null,
                  input: riskInput,
                },
              },
              conditions: decision.conditions,
            },
          );
          continue;
        }
      }

      const clientKey = `strategy.${row.id}.${windowStart}`;
      const outcome = await submit({
        intent: {
          userId: row.userId,
          venue: venueId,
          market: strategy.market,
          side: decision.order.side,
          orderType: "MARKET",
          quantity: decision.order.quantity,
          limitPrice: null,
          stopLossPrice: decision.order.stopLossPrice,
          notionalUsdCents: decision.order.notionalUsdCents,
          verifiedBalanceCents: decision.order.notionalUsdCents,
          clientKey,
        },
        actorUserId: row.userId,
        origin: "strategy",
        sourceNote: `${strategy.label}${ORDER_NOTE_PREFIX.strategy}${new Date(windowStart).toISOString()}: ${decision.message}`,
      });

      const submitted = decisionFromOrderOutcome(outcome, decision);
      await record(submitted, {
        market: strategy.market,
        inputs: { ...baseInputs, order: decision.order, riskInput, clientKey, orderOutcome: outcome.kind },
        conditions: decision.conditions,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The pass failed before it could record a decision.";
      summary.error += 1;
      summary.failures.push({ account: row.userId, message });
      await store
        .recordDecision({
          activationId: row.id,
          userId: row.userId,
          strategyId: row.strategyId,
          windowStart: windowDate,
          evaluatedAt: new Date(now),
          outcome: "ERROR",
          reasonCode: "ORDER_FAILED",
          reasonMessage: message,
          market: strategy?.market ?? null,
          inputs: { error: message },
          conditions: [],
          orderId: null,
        })
        .catch(() => null);
    }
  }

  summary.detail = {
    active: rows.length,
    decided: summary.decided,
    placed: summary.placed,
    idle: summary.idle,
    error: summary.error,
    gaps: summary.gaps,
    placement,
    liveExecutionEnabled: placement === "live",
    reasons: summary.reasons.join(" | ") || null,
  };

  return summary;
}

// ---------------------------------------------------------------------------------------
// What the panel reads
// ---------------------------------------------------------------------------------------

export type StrategyDecisionRecord = {
  id: string;
  windowStart: string;
  evaluatedAt: string;
  outcome: "ORDER_PLACED" | "NO_ACTION" | "ERROR";
  reason: {
    code: StrategyReasonCode;
    label: string;
    kind: "placed" | "idle" | "error";
    message: string;
    action: { label: string; href: string } | null;
  };
  market: string | null;
  orderId: string | null;
  inputs: Record<string, unknown>;
  conditions: StrategyCondition[];
};

export type StrategyDecisionFeed = {
  activationId: string | null;
  running: boolean;
  strategyId: string | null;
  strategyLabel: string | null;
  intervalMinutes: number | null;
  market: string | null;
  nextPassAt: string | null;
  runCount: number;
  lastDecision: StrategyDecisionRecord | null;
  decisions: StrategyDecisionRecord[];
  /** The whole taxonomy, so the panel can say what it can report. */
  taxonomy: { code: StrategyReasonCode; label: string; kind: "placed" | "idle" | "error"; taxonomy: boolean }[];
};

type DecisionRow = {
  id: string;
  windowStart: Date;
  evaluatedAt: Date;
  outcome: string;
  reasonCode: string;
  reasonMessage: string;
  market: string | null;
  orderId: string | null;
  inputsJson: string;
  conditionsJson: string;
};

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toDecisionRecord(row: DecisionRow): StrategyDecisionRecord {
  const code = isStrategyReasonCode(row.reasonCode) ? row.reasonCode : "ORDER_FAILED";
  const info = STRATEGY_REASON_INFO[code];
  return {
    id: row.id,
    windowStart: row.windowStart.toISOString(),
    evaluatedAt: row.evaluatedAt.toISOString(),
    outcome: row.outcome === "ORDER_PLACED" || row.outcome === "ERROR" ? row.outcome : "NO_ACTION",
    reason: {
      code,
      label: info.label,
      kind: info.kind,
      message: row.reasonMessage,
      action: info.action ?? null,
    },
    market: row.market,
    orderId: row.orderId,
    inputs: parseJson<Record<string, unknown>>(row.inputsJson, {}),
    conditions: parseJson<StrategyCondition[]>(row.conditionsJson, []),
  };
}

/**
 * The per-strategy record the owner reads: what the last pass decided, why, when the next
 * one is due, and how many passes have run. It is the answer to "is it working" without
 * opening a log, and it is read from the decisions the runner wrote rather than recomputed
 * here — a second opinion on the same facts is how two surfaces start disagreeing.
 */
export async function getStrategyDecisionFeed(userId: string, limit = 12): Promise<StrategyDecisionFeed> {
  const activation = await prisma.strategyActivation.findUnique({
    where: { userId },
    select: { id: true, status: true, strategyId: true, runCount: true },
  });
  const strategy =
    strategyDefinition(activation?.strategyId ?? null) ??
    (activation ? await resolveBotRunnerStrategy(activation.strategyId, userId).catch(() => null) : null);

  const rows = activation
    ? await prisma.strategyDecision.findMany({
        where: { activationId: activation.id },
        orderBy: { windowStart: "desc" },
        take: Math.max(1, Math.min(50, limit)),
        select: {
          id: true,
          windowStart: true,
          evaluatedAt: true,
          outcome: true,
          reasonCode: true,
          reasonMessage: true,
          market: true,
          orderId: true,
          inputsJson: true,
          conditionsJson: true,
        },
      })
    : [];

  const job = await runnerStore()
    .listJobs([STRATEGY_JOB_ID])
    .then((states) => states[0] ?? null)
    .catch(() => null);

  const decisions = rows.map(toDecisionRecord);

  return {
    activationId: activation?.id ?? null,
    running: activation?.status === "RUNNING",
    strategyId: activation?.strategyId ?? null,
    strategyLabel: strategy?.label ?? (activation ? await readBotStrategyLabel(userId, activation.strategyId).catch(() => null) : null),
    intervalMinutes: strategy?.decisionIntervalMinutes ?? null,
    market: strategy?.market ?? decisions[0]?.market ?? null,
    nextPassAt: job ? new Date(job.nextDueAt).toISOString() : null,
    runCount: activation?.runCount ?? 0,
    lastDecision: decisions[0] ?? null,
    decisions,
    taxonomy: STRATEGY_REASON_CODES.map((code) => ({
      code,
      label: STRATEGY_REASON_INFO[code].label,
      kind: STRATEGY_REASON_INFO[code].kind,
      taxonomy: STRATEGY_REASON_INFO[code].taxonomy,
    })),
  };
}
