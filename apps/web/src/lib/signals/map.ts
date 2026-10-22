import DecimalJS from "decimal.js";
import type { RiskOrderInput } from "@/lib/risk-controls/policy";
import { isSupportedSignalMarket } from "./verify";

/**
 * A verified signal, turned into exactly one order intent — or refused by name (phase 31).
 *
 * This module is pure and deliberately narrow. It does not read the database, place anything
 * or decide whether an account may trade at all; it takes the facts it needs (the strategy, the
 * owner's caps, the open position, the price) and answers two things: what the signal means as
 * an order, and — when it means nothing — which bound refused it and what values the bound saw.
 *
 * The vocabulary is the phase requirement: enter, exit, adjust.
 *
 *  - **enter** opens or adds a position. Its size is `sizeUsd`, or, when the signal carries no
 *    size, whatever remains of the strategy's own declared budget. The signal cannot invent a
 *    size larger than the owner's per-order cap, the strategy's budget or the strategy's open
 *    notional cap.
 *  - **exit** closes the stored position, in full by default or by `sizeUsd` for a partial.
 *    It refuses rather than flips: a signal that asks to sell more than is held is a mistake,
 *    and reversing a position because a webhook said so is not this build's behaviour.
 *  - **adjust** takes a signed `sizeUsd`: positive adds (same checks as enter), negative
 *    reduces (same checks as exit).
 *
 * Every refusal carries `bound` (the exact field) and a sentence with the observed and allowed
 * values, because "rejected" is not an answer an operator can act on.
 */

const Decimal = DecimalJS.clone({ precision: 40 });

export const SIGNAL_ACTIONS = ["enter", "exit", "adjust"] as const;
export type SignalAction = (typeof SIGNAL_ACTIONS)[number];

export type SignalRefusalCode =
  | "SIGNAL_INVALID"
  | "ACTION_UNSUPPORTED"
  | "STRATEGY_NOT_FOUND"
  | "STRATEGY_NOT_RUNNING"
  | "KILL_SWITCH_ENGAGED"
  | "MARKET_NOT_SUPPORTED"
  | "MARKET_NOT_APPROVED"
  | "STRATEGY_MARKET_MISMATCH"
  | "PRICE_UNAVAILABLE"
  | "STOP_LOSS_MISSING"
  | "SIGNAL_SIZE_INVALID"
  | "MAX_ORDER_NOTIONAL"
  | "STRATEGY_BUDGET"
  | "STRATEGY_POSITION_CAP"
  | "NO_OPEN_POSITION"
  | "EXIT_EXCEEDS_POSITION";

export type SignalRefusal = {
  ok: false;
  code: SignalRefusalCode;
  bound: string;
  message: string;
  status: 400 | 409 | 422;
};

export type SignalIntent = {
  side: "BUY" | "SELL";
  orderType: "MARKET";
  quantity: string;
  notionalUsd: string;
  notionalUsdCents: number;
  stopLossPrice: string;
  reduceOnly: boolean;
  /** The order this signal becomes, in one sentence for the log and the proof record. */
  narrative: string;
};

export type SignalMapping = { ok: true; intent: SignalIntent } | SignalRefusal;

export type SignalBounds = {
  strategy: {
    id: string;
    label: string;
    market: string;
    budgetUsd: string;
    stopLossPercent: string;
  } | null;
  /** Whether the account's activation is RUNNING for this strategy right now. */
  strategyRunning: boolean;
  position: { quantity: string; notionalUsd: string } | null;
  strategyOpenNotionalUsd: string;
  /** The last stored close for the market, as a decimal string. */
  price: string;
  policy: {
    approvedSymbols: readonly string[];
    maxOrderNotionalUsd: string;
    maxStrategyNotionalUsd: string;
    killSwitchActive: boolean;
  };
};

export type SignalRequest = {
  action: unknown;
  market: unknown;
  sizeUsd?: unknown;
};

function refusal(
  code: SignalRefusalCode,
  bound: string,
  message: string,
  status: 422 | 400 = 422,
): SignalRefusal {
  return { ok: false, code, bound, message, status };
}

function decimal(value: unknown): DecimalJS | null {
  if (typeof value === "number" && Number.isFinite(value)) return new Decimal(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) return null;
  const parsed = new Decimal(trimmed);
  return parsed.isFinite() ? parsed : null;
}

/** `"0"` (or an absent value) is the owner's "unlimited", and is not a bound to enforce. */
function cap(value: string): DecimalJS | null {
  const parsed = decimal(value);
  return parsed && parsed.gt(0) ? parsed : null;
}

function money(value: DecimalJS): string {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function wholeCents(value: DecimalJS): number {
  return value.mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

function isAction(value: unknown): value is SignalAction {
  return typeof value === "string" && (SIGNAL_ACTIONS as readonly string[]).includes(value);
}

/**
 * Map a signal to one order intent.
 *
 * The order of the checks is the order of the questions an operator would ask: is there a
 * strategy, is it running, is trading stopped, is the action one we know, is the market one we
 * can reach, and only then how big. A size that is too large for any bound is refused with the
 * first bound it breaches, named.
 */
export function mapSignal(request: SignalRequest, bounds: SignalBounds): SignalMapping {
  const { strategy, policy } = bounds;
  if (!strategy) {
    return refusal("STRATEGY_NOT_FOUND", "strategyId", "The signal does not name a strategy this account owns.");
  }
  if (!bounds.strategyRunning) {
    return refusal(
      "STRATEGY_NOT_RUNNING",
      "activation.status",
      `${strategy.label} is not running, so the signal was not turned into an order. Start the strategy first; a signal cannot start trading on its own.`,
    );
  }
  if (policy.killSwitchActive) {
    return refusal(
      "KILL_SWITCH_ENGAGED",
      "policy.killSwitchActive",
      "The global kill switch is engaged in the risk policy, so the signal was recorded and refused.",
    );
  }
  if (!isAction(request.action)) {
    return refusal(
      "ACTION_UNSUPPORTED",
      "action",
      `The signal action must be one of ${SIGNAL_ACTIONS.join(", ")}; "${String(request.action)}" is not.`,
    );
  }
  if (typeof request.market !== "string" || !request.market.trim()) {
    return refusal("SIGNAL_INVALID", "market", "The signal does not name a market.", 400);
  }
  const market = request.market.trim().toUpperCase();
  if (!isSupportedSignalMarket(market)) {
    return refusal(
      "MARKET_NOT_SUPPORTED",
      "market",
      `${market} is not one of the Coinbase USD markets this build trades.`,
    );
  }
  if (policy.approvedSymbols.length > 0 && !policy.approvedSymbols.includes(market)) {
    return refusal(
      "MARKET_NOT_APPROVED",
      "policy.approvedSymbols",
      `${market} is not in the owner's approved symbols (${policy.approvedSymbols.join(", ")}).`,
    );
  }
  if (strategy.market !== market) {
    return refusal(
      "STRATEGY_MARKET_MISMATCH",
      "strategy.market",
      `${strategy.label} trades ${strategy.market}; the signal named ${market}.`,
    );
  }

  const price = decimal(bounds.price);
  if (!price || !price.gt(0)) {
    return refusal(
      "PRICE_UNAVAILABLE",
      "price",
      `No usable price was available for ${market}, so a size could not be converted into an order.`,
    );
  }

  const budget = decimal(strategy.budgetUsd) ?? new Decimal(0);
  const openNotional = decimal(bounds.strategyOpenNotionalUsd) ?? new Decimal(0);
  const positionQuantity = bounds.position ? decimal(bounds.position.quantity) : null;
  const positionNotional = bounds.position ? decimal(bounds.position.notionalUsd) : null;
  const hasPosition = Boolean(positionQuantity && positionQuantity.gt(0));

  const rawSize = request.sizeUsd === undefined || request.sizeUsd === null || request.sizeUsd === ""
    ? null
    : decimal(request.sizeUsd);
  if (rawSize === null && request.sizeUsd !== undefined && request.sizeUsd !== null && request.sizeUsd !== "") {
    return refusal("SIGNAL_SIZE_INVALID", "sizeUsd", "sizeUsd must be a decimal number of US dollars.", 400);
  }
  if (rawSize && rawSize.abs().gt(1_000_000_000)) {
    return refusal("SIGNAL_SIZE_INVALID", "sizeUsd", "sizeUsd is larger than this build will consider.");
  }

  const isReduce = request.action === "exit" || (request.action === "adjust" && rawSize !== null && rawSize.lt(0));

  if (isReduce) {
    if (!hasPosition || !positionQuantity || !positionNotional) {
      return refusal(
        "NO_OPEN_POSITION",
        "position.quantity",
        `${strategy.label} holds no ${market} position to reduce, so the signal was not sent.`,
      );
    }
    const requested = rawSize ? rawSize.abs() : positionNotional;
    if (requested.gt(positionNotional.plus(new Decimal("0.01")))) {
      return refusal(
        "EXIT_EXCEEDS_POSITION",
        "position.notionalUsd",
        `The signal asked to reduce ${money(requested)} USD but the open position is ${money(positionNotional)} USD; this build does not flip a position on a signal.`,
      );
    }
    const quantity = Decimal.min(positionQuantity, requested.div(price)).toDecimalPlaces(8, Decimal.ROUND_DOWN);
    if (!quantity.gt(0)) {
      return refusal(
        "SIGNAL_SIZE_INVALID",
        "sizeUsd",
        `The requested reduction is smaller than one base unit of ${market} at ${money(price)} USD.`,
      );
    }
    const notional = quantity.mul(price);
    return {
      ok: true,
      intent: {
        side: "SELL",
        orderType: "MARKET",
        quantity: quantity.toFixed(),
        notionalUsd: money(notional),
        notionalUsdCents: wholeCents(notional),
        stopLossPrice: "0",
        reduceOnly: true,
        narrative: `Reduce ${money(notional)} USD of the ${money(positionNotional)} USD ${market} position (${quantity.toFixed()} ${market.split("-")[0]}).`,
      },
    };
  }

  // Enter, or the adding half of an adjustment.
  if (rawSize && rawSize.lte(0)) {
    return refusal(
      "SIGNAL_SIZE_INVALID",
      "sizeUsd",
      "An enter signal needs a positive sizeUsd, or no size to use the strategy's remaining budget.",
    );
  }

  const perOrderCap = cap(policy.maxOrderNotionalUsd);
  const strategyCap = cap(policy.maxStrategyNotionalUsd);
  const remainingBudget = budget.minus(openNotional);
  const candidate = rawSize
    ? rawSize
    : Decimal.min(
        ...[
          remainingBudget,
          ...(perOrderCap ? [perOrderCap] : []),
          ...(strategyCap ? [strategyCap.minus(openNotional)] : []),
        ],
      );
  const size = rawSize ?? candidate;

  if (!size || !size.gt(0)) {
    return refusal(
      "STRATEGY_BUDGET",
      "strategy.budgetUsd",
      `${strategy.label}'s budget of ${money(budget)} USD is fully committed by ${money(openNotional)} USD of open notional, so there is nothing left to enter with.`,
    );
  }
  if (perOrderCap && size.gt(perOrderCap)) {
    return refusal(
      "MAX_ORDER_NOTIONAL",
      "policy.maxOrderNotionalUsd",
      `The signal size ${money(size)} USD is above the owner's per-order cap of ${money(perOrderCap)} USD.`,
    );
  }
  if (size.gt(remainingBudget)) {
    return refusal(
      "STRATEGY_BUDGET",
      "strategy.budgetUsd",
      `The signal size ${money(size)} USD plus ${money(openNotional)} USD already open exceeds ${strategy.label}'s budget of ${money(budget)} USD.`,
    );
  }
  if (strategyCap && openNotional.plus(size).gt(strategyCap)) {
    return refusal(
      "STRATEGY_POSITION_CAP",
      "policy.maxStrategyNotionalUsd",
      `The signal would take ${strategy.label} to ${money(openNotional.plus(size))} USD open, above the owner's strategy cap of ${money(strategyCap)} USD.`,
    );
  }

  const stopPercent = decimal(strategy.stopLossPercent);
  if (!stopPercent || !stopPercent.gt(0)) {
    return refusal(
      "STOP_LOSS_MISSING",
      "strategy.stopLossPercent",
      `${strategy.label} has no stop-loss percentage, and this build will not open a position without one.`,
    );
  }
  const quantity = size.div(price).toDecimalPlaces(8, Decimal.ROUND_DOWN);
  if (!quantity.gt(0)) {
    return refusal(
      "SIGNAL_SIZE_INVALID",
      "sizeUsd",
      `The signal size is smaller than one base unit of ${market} at ${money(price)} USD.`,
    );
  }
  const stopLossPrice = price.mul(new Decimal(1).minus(stopPercent.div(100))).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (!stopLossPrice.gt(0)) {
    return refusal(
      "STOP_LOSS_MISSING",
      "strategy.stopLossPercent",
      `A ${stopPercent.toFixed()}% stop on ${money(price)} USD gives no positive stop price.`,
    );
  }
  const notional = quantity.mul(price);
  return {
    ok: true,
    intent: {
      side: "BUY",
      orderType: "MARKET",
      quantity: quantity.toFixed(),
      notionalUsd: money(notional),
      notionalUsdCents: wholeCents(notional),
      stopLossPrice: stopLossPrice.toFixed(2),
      reduceOnly: false,
      narrative: `Enter ${money(notional)} USD of ${market} (${quantity.toFixed()} ${market.split("-")[0]}) with a stop at ${stopLossPrice.toFixed(2)} USD.`,
    },
  };
}

export type SignalRiskFacts = {
  routing: "paper" | "testnet" | "live";
  venueId: string;
  tradesToday: number;
  openPositions: number;
  tradesInInterval: number;
  cooldownRemainingMinutes: number;
  killSwitchActive: boolean;
  strategyKillSwitchActive: boolean;
};

/**
 * The risk policy's view of a mapped signal.
 *
 * A signal is not a privileged path: it is measured by the same phase-25 limits as a strategy
 * decision, using the strategy's budget as capital and its declared stop as the bound. The
 * route evaluates this with `evaluateRiskOrder`, so an order the owner's caps refuse is refused
 * here too — and recorded with the limit that refused it.
 */
export function signalRiskInput(input: {
  mapping: SignalIntent;
  bounds: SignalBounds & { strategy: NonNullable<SignalBounds["strategy"]> };
  facts: SignalRiskFacts;
}): RiskOrderInput {
  const { mapping, bounds, facts } = input;
  const price = decimal(bounds.price) ?? new Decimal(0);
  const quantity = decimal(mapping.quantity) ?? new Decimal(0);
  const stop = decimal(mapping.stopLossPrice) ?? new Decimal(0);
  const notional = decimal(mapping.notionalUsd) ?? new Decimal(0);
  const positionNotional = bounds.position ? decimal(bounds.position.notionalUsd) ?? new Decimal(0) : new Decimal(0);
  const budget = decimal(bounds.strategy.budgetUsd) ?? new Decimal(0);

  return {
    executionMode: facts.routing === "live" ? "LIVE" : "PAPER",
    paperBotActive: true,
    reducePosition: mapping.reduceOnly,
    symbol: bounds.strategy.market,
    allowedSymbols: bounds.policy.approvedSymbols.length > 0 ? bounds.policy.approvedSymbols : [bounds.strategy.market],
    venueApproved: true,
    liveArmed: facts.routing === "live",
    killSwitchActive: facts.killSwitchActive,
    auditAvailable: true,
    hasValidStopLoss: stop.gt(0) || mapping.reduceOnly,
    capitalUsd: budget.toFixed(2),
    verifiedAvailableUsd: budget.toFixed(2),
    requestedNotionalUsd: notional.toFixed(2),
    serverComputedMaxLossUsd: stop.gt(0) ? price.minus(stop).abs().mul(quantity).toFixed(2) : "0",
    currentOpenExposureUsd: positionNotional.toFixed(2),
    // Daily loss and post-arm exposure are not measured by this path (phase 25 reports the
    // facts it has), so those two limits cannot fire from a signal; every measured cap is
    // evaluated below.
    dailyLossUsd: "0",
    tradesToday: facts.tradesToday,
    leverage: "1",
    first24HoursAfterArm: false,
    exposureSinceArmUsd: "0",
    strategyKey: bounds.strategy.id,
    strategyOpenNotionalUsd: bounds.strategyOpenNotionalUsd,
    openPositionCount: facts.openPositions,
    tradesInInterval: facts.tradesInInterval,
    venueId: facts.venueId,
    cooldownRemainingMinutes: facts.cooldownRemainingMinutes,
    strategyKillSwitchActive: facts.strategyKillSwitchActive,
  };
}
