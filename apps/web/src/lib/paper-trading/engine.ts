import DecimalJS from "decimal.js";
import { calculateRsi } from "@/lib/market-data/indicators";
import type { MarketCandle, MarketQuote } from "@/lib/market-data/provider";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";
import { evaluateAndAuditPaperAttempt } from "@/lib/risk-controls/safety-core";
import { appendIntegerCentLedgerEntry, getIntegerCentLedgerSnapshot } from "@/lib/ledger/integer-cent-ledger";
import { paperTradingStore, usdToIntegerCents, type PaperBotRecord, type PaperBotSnapshot } from "@/lib/paper-trading/store";

const Decimal = DecimalJS.clone({ precision: 50 });
const QUOTE_MAX_AGE_MS = 30_000;

export type PaperCycleStatus =
  | "PAPER_NO_ACTION"
  | "PAPER_FILLED"
  | "PAPER_RISK_REFUSED"
  | "PAPER_DAILY_HALT"
  | "PAPER_WAITING_FOR_HISTORY"
  | "PAPER_BOT_NOT_ACTIVE";

export type PaperConfigView = {
  paperName: string;
  paperDescription: string;
  paperSymbol: string;
  paperSchedule: string;
  paperBudgetCapUsd: string;
  paperMaxTradeSizeUsd: string;
  paperStopLossPercent: string;
  paperDailyLossHaltPercent: string;
  paperFeeBps: string;
  paperSlippageBps: string;
  paperBuyRsiBelow: string;
  paperSellRsiAbove: string;
  paperMaxDrawdownGatePercent: string;
  paperMinWinRateGatePercent: string;
  paperMinProfitFactorGate: string;
};

export type PaperTradingView = {
  paperMode: "PAPER";
  paperState: PaperBotSnapshot["paperState"];
  paperBotId: string;
  paperConfig: PaperConfigView;
  paperCreatedAt: string;
  paperUpdatedAt: string;
  paperStartedAt: string | null;
  paperAccountingActive: boolean;
  paperInitialCapitalCents: number;
  paperCashBalanceCents: number | null;
  paperEquityCents: number | null;
  paperPnlCents: number | null;
  paperFeesCents: number | null;
  paperBudgetUsedCents: number | null;
  paperTradesToday: number;
  paperPositionQuantity: string | null;
  paperMarkPrice: string | null;
  paperLastCycleAt: string | null;
  paperLastProcessedCandleAt: string | null;
  paperHaltedDate: string | null;
  paperAuditEvents: Array<{
    paperAction: string;
    paperOutcome: string;
    paperOccurredAt: string;
    paperDetails: string;
  }>;
};

function paperConfigView(config: PaperBotSnapshot["paperConfig"]): PaperConfigView {
  return {
    paperName: config.name,
    paperDescription: config.description,
    paperSymbol: config.symbol,
    paperSchedule: config.schedule,
    paperBudgetCapUsd: config.budgetCapUsd,
    paperMaxTradeSizeUsd: config.maxTradeSizeUsd,
    paperStopLossPercent: config.stopLossPercent,
    paperDailyLossHaltPercent: config.dailyLossHaltPercent,
    paperFeeBps: config.feeBps,
    paperSlippageBps: config.slippageBps,
    paperBuyRsiBelow: config.buyRsiBelow,
    paperSellRsiAbove: config.sellRsiAbove,
    paperMaxDrawdownGatePercent: config.maxDrawdownGatePercent,
    paperMinWinRateGatePercent: config.minWinRateGatePercent,
    paperMinProfitFactorGate: config.minProfitFactorGate,
  };
}

export type PaperCycleResult = {
  paperMode: "PAPER";
  paperStatus: PaperCycleStatus;
  paperMessage: string;
  paperSide?: "BUY" | "SELL";
  paperFillPrice?: string;
  paperFillQuantity?: string;
  paperFeeCents?: number;
  paperSlippageBps?: string;
  paperRiskReasons?: string[];
  paperView: PaperTradingView;
};

function validDecimal(value: string | null): InstanceType<typeof Decimal> | null {
  if (value === null || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const parsed = new Decimal(value);
  return parsed.isFinite() && parsed.gt(0) ? parsed : null;
}

function floorCents(dollars: InstanceType<typeof Decimal>): number | null {
  const cents = dollars.mul(100).floor().toNumber();
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

function feeCents(notionalCents: number, feeBps: string): number | null {
  const bps = validDecimal(feeBps);
  if (!bps) return null;
  const cents = new Decimal(notionalCents).mul(bps).div(10_000).ceil().toNumber();
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

function validQuote(quote: MarketQuote, now: Date): boolean {
  const observedAt = quote.provenance.observedAt ? Date.parse(quote.provenance.observedAt) : Number.NaN;
  return quote.instrument.quoteAsset === "USD" &&
    USD_WATCHLIST.some(({ productId }) => productId === quote.instrument.id) &&
    quote.provenance.providerId === "coinbase-exchange" &&
    quote.provenance.freshness === "FRESH" &&
    Number.isFinite(observedAt) && observedAt <= now.getTime() && now.getTime() - observedAt <= QUOTE_MAX_AGE_MS &&
    validDecimal(quote.bid) !== null && validDecimal(quote.ask) !== null &&
    new Decimal(quote.ask!).gte(quote.bid!);
}

function validDailyCandles(symbol: string, candles: readonly MarketCandle[], now: Date): MarketCandle[] {
  return candles
    .filter((candle) => candle.instrument.id === symbol && candle.interval === "1d" &&
      candle.provenance.providerId === "coinbase-exchange" && Date.parse(candle.closeTime) <= now.getTime())
    .sort((left, right) => Date.parse(left.closeTime) - Date.parse(right.closeTime));
}

async function paperView(bot: PaperBotRecord, markPrice: string | null): Promise<PaperTradingView> {
  const ledger = await getIntegerCentLedgerSnapshot(paperTradingStore, bot.paperBotId);
  const paperAccountingActive = bot.paperStartedAt !== null;
  const effectiveMarkPrice = markPrice ?? bot.paperLastMarkPrice;
  const mark = validDecimal(effectiveMarkPrice);
  const positionValueCents = bot.paperPosition && mark
    ? floorCents(new Decimal(bot.paperPosition.paperQuantity).mul(mark)) ?? 0
    : 0;
  const paperEquityCents = paperAccountingActive ? ledger.cashBalanceCents + positionValueCents : null;
  const paperAuditEvents = await paperTradingStore.getPaperAudit(bot.paperSessionId, bot.paperBotId);
  return {
    paperMode: "PAPER",
    paperState: bot.paperState,
    paperBotId: bot.paperBotId,
    paperConfig: paperConfigView(bot.paperConfig),
    paperCreatedAt: bot.paperCreatedAt,
    paperUpdatedAt: bot.paperUpdatedAt,
    paperStartedAt: bot.paperStartedAt,
    paperAccountingActive,
    paperInitialCapitalCents: bot.paperInitialCapitalCents,
    paperCashBalanceCents: paperAccountingActive ? ledger.cashBalanceCents : null,
    paperEquityCents,
    paperPnlCents: paperEquityCents === null ? null : paperEquityCents - bot.paperInitialCapitalCents,
    paperFeesCents: paperAccountingActive ? ledger.feesCents : null,
    paperBudgetUsedCents: paperAccountingActive ? positionValueCents : null,
    paperTradesToday: bot.paperTradesToday,
    paperPositionQuantity: bot.paperPosition?.paperQuantity ?? null,
    paperMarkPrice: effectiveMarkPrice,
    paperLastCycleAt: bot.paperLastCycleAt,
    paperLastProcessedCandleAt: bot.paperLastProcessedCandleAt,
    paperHaltedDate: bot.paperHaltedDate,
    paperAuditEvents: paperAuditEvents.slice(-20).reverse().map((record) => ({
      paperAction: record.action,
      paperOutcome: record.outcome,
      paperOccurredAt: record.occurredAt.toISOString(),
      paperDetails: record.redactedJson,
    })),
  };
}

type FillResult = { status: PaperCycleStatus; side?: "BUY" | "SELL"; fillPrice?: string; fillQuantity?: string; feeCents?: number; slippageBps?: string; reasons?: string[] };

async function tryPaperFill(
  bot: PaperBotRecord,
  paperSessionId: string,
  quote: MarketQuote,
  now: Date,
  side: "BUY" | "SELL",
  reason: string,
  currentEquityCents: number,
  dailyLossCents: number,
): Promise<FillResult> {
  const slippageBps = bot.paperConfig.slippageBps;
  const feeRateBps = bot.paperConfig.feeBps;
  const referencePrice = validDecimal(side === "BUY" ? quote.ask : quote.bid);
  if (!referencePrice) return { status: "PAPER_NO_ACTION" };

  const slippageRate = new Decimal(slippageBps).div(10_000);
  const fillPrice = side === "BUY"
    ? referencePrice.mul(new Decimal(1).plus(slippageRate))
    : referencePrice.mul(new Decimal(1).minus(slippageRate));
  const ledger = await getIntegerCentLedgerSnapshot(paperTradingStore, bot.paperBotId);
  let paperNotionalCents: number;
  let paperQuantity: InstanceType<typeof Decimal>;
  if (side === "BUY") {
    const maxTradeCents = usdToIntegerCents(bot.paperConfig.maxTradeSizeUsd);
    if (maxTradeCents === null) return { status: "PAPER_RISK_REFUSED", reasons: ["invalid-paper-trade-size"] };
    paperNotionalCents = Math.min(maxTradeCents, ledger.cashBalanceCents);
    paperQuantity = new Decimal(paperNotionalCents).div(100).div(fillPrice);
  } else {
    const position = bot.paperPosition;
    if (!position) return { status: "PAPER_NO_ACTION" };
    paperQuantity = new Decimal(position.paperQuantity);
    paperNotionalCents = floorCents(paperQuantity.mul(fillPrice)) ?? 0;
  }
  const paperFeeCents = feeCents(paperNotionalCents, feeRateBps);
  if (paperNotionalCents <= 0 || paperFeeCents === null || paperQuantity.lte(0)) {
    return { status: "PAPER_RISK_REFUSED", reasons: ["invalid-paper-fill"] };
  }
  if (side === "BUY" && ledger.cashBalanceCents < paperNotionalCents + paperFeeCents) {
    return { status: "PAPER_RISK_REFUSED", reasons: ["paper-cash-insufficient-for-fees"] };
  }

  const paperPosition = bot.paperPosition;
  const paperPositionValueCents = paperPosition
    ? floorCents(new Decimal(paperPosition.paperQuantity).mul(validDecimal(quote.bid)!)) ?? 0
    : 0;
  const paperMaximumLossUsd = side === "BUY"
    ? new Decimal(paperNotionalCents).div(100).mul(bot.paperConfig.stopLossPercent).div(100).toFixed(2)
    : "0.01";
  const attemptId = side === "BUY"
    ? `paper:${bot.paperBotId}:${bot.paperLastProcessedCandleAt}:${side}`
    : `paper:${bot.paperBotId}:${paperPosition?.paperOpenedAt}:${side}:${reason}`;
  const decision = await evaluateAndAuditPaperAttempt(paperTradingStore, {
    executionMode: "PAPER",
    paperBotActive: bot.paperState === "PAPER",
    reducePosition: side === "SELL",
    symbol: bot.paperConfig.symbol,
    allowedSymbols: USD_WATCHLIST.map(({ productId }) => productId),
    venueApproved: false,
    liveArmed: false,
    killSwitchActive: false,
    auditAvailable: true,
    hasValidStopLoss: side === "SELL" || Number(bot.paperConfig.stopLossPercent) > 0,
    capitalUsd: new Decimal(bot.paperInitialCapitalCents).div(100).toFixed(2),
    verifiedAvailableUsd: null,
    requestedNotionalUsd: new Decimal(paperNotionalCents).div(100).toFixed(2),
    serverComputedMaxLossUsd: paperMaximumLossUsd,
    currentOpenExposureUsd: new Decimal(paperPositionValueCents).div(100).toFixed(2),
    dailyLossUsd: new Decimal(Math.max(0, dailyLossCents)).div(100).toFixed(2),
    tradesToday: bot.paperTradesToday,
    leverage: "1",
    first24HoursAfterArm: false,
    exposureSinceArmUsd: "0",
  }, {
    actorUserId: paperSessionId,
    attemptId,
    botId: bot.paperBotId,
    side,
    paperNotionalCents,
    paperFillPrice: fillPrice.toFixed(),
    paperFeeCents,
    paperSlippageBps: slippageBps,
  }, now);

  if (decision.decision !== "ALLOW") return { status: "PAPER_RISK_REFUSED", reasons: decision.reasons };

  if (side === "BUY") {
    const cashKey = `${attemptId}:paper-cash`;
    const cashEntry = await appendIntegerCentLedgerEntry(paperTradingStore, {
      idempotencyKey: cashKey,
      accountId: bot.paperBotId,
      actorUserId: paperSessionId,
      type: "CASH",
      amountCents: -(paperNotionalCents + paperFeeCents),
      occurredAt: now,
    });
    if (!cashEntry.applied) return { status: "PAPER_NO_ACTION" };
    await appendIntegerCentLedgerEntry(paperTradingStore, {
      idempotencyKey: `${attemptId}:paper-fee`,
      accountId: bot.paperBotId,
      actorUserId: paperSessionId,
      type: "FEE",
      amountCents: paperFeeCents,
      occurredAt: now,
    });
    bot.paperPosition = {
      paperQuantity: paperQuantity.toFixed(),
      paperEntryNotionalCents: paperNotionalCents,
      paperEntryFeeCents: paperFeeCents,
      paperEntryFillPrice: fillPrice.toFixed(),
      paperOpenedAt: now.toISOString(),
    };
  } else {
    const position = bot.paperPosition;
    if (!position) return { status: "PAPER_NO_ACTION" };
    const proceedsCents = paperNotionalCents;
    const netCashCents = proceedsCents - paperFeeCents;
    const realizedPnlCents = netCashCents - position.paperEntryNotionalCents - position.paperEntryFeeCents;
    const cashEntry = await appendIntegerCentLedgerEntry(paperTradingStore, {
      idempotencyKey: `${attemptId}:paper-cash`,
      accountId: bot.paperBotId,
      actorUserId: paperSessionId,
      type: "CASH",
      amountCents: netCashCents,
      occurredAt: now,
    });
    if (!cashEntry.applied) return { status: "PAPER_NO_ACTION" };
    await appendIntegerCentLedgerEntry(paperTradingStore, {
      idempotencyKey: `${attemptId}:paper-pnl`,
      accountId: bot.paperBotId,
      actorUserId: paperSessionId,
      type: "PNL",
      amountCents: realizedPnlCents,
      occurredAt: now,
    });
    await appendIntegerCentLedgerEntry(paperTradingStore, {
      idempotencyKey: `${attemptId}:paper-fee`,
      accountId: bot.paperBotId,
      actorUserId: paperSessionId,
      type: "FEE",
      amountCents: paperFeeCents,
      occurredAt: now,
    });
    bot.paperPosition = null;
  }
  bot.paperTradesToday += 1;
  bot.paperUpdatedAt = now.toISOString();
  return {
    status: "PAPER_FILLED",
    side,
    fillPrice: fillPrice.toFixed(),
    fillQuantity: paperQuantity.toFixed(),
    feeCents: paperFeeCents,
    slippageBps,
  };
}

export async function getPaperTradingView(
  paperSessionId: string,
  paperBotId: string,
  paperMarkPrice: string | null = null,
): Promise<PaperTradingView | null> {
  const bot = await paperTradingStore.withPaperBot(paperSessionId, paperBotId, async (record) => ({ ...record }));
  return bot ? paperView(bot, paperMarkPrice) : null;
}

export async function runPaperCycle(
  paperSessionId: string,
  paperBotId: string,
  quote: MarketQuote,
  sourceCandles: readonly MarketCandle[],
  now = new Date(),
): Promise<PaperCycleResult | null> {
  if (!validQuote(quote, now)) return null;
  return paperTradingStore.withPaperBot(paperSessionId, paperBotId, async (bot) => {
    const markPrice = quote.bid!;
    bot.paperLastMarkPrice = markPrice;
    const ledger = await getIntegerCentLedgerSnapshot(paperTradingStore, bot.paperBotId);
    const positionValueCents = bot.paperPosition
      ? floorCents(new Decimal(bot.paperPosition.paperQuantity).mul(markPrice)) ?? 0
      : 0;
    const paperEquityCents = ledger.cashBalanceCents + positionValueCents;
    const utcDate = now.toISOString().slice(0, 10);
    if (bot.paperDayKey !== utcDate) {
      bot.paperDayKey = utcDate;
      bot.paperDayStartEquityCents = paperEquityCents;
      bot.paperTradesToday = 0;
    }
    const dailyLossCents = Math.max(0, (bot.paperDayStartEquityCents ?? paperEquityCents) - paperEquityCents);
    const dailyLossLimitCents = new Decimal(bot.paperInitialCapitalCents)
      .mul(bot.paperConfig.dailyLossHaltPercent).div(100).floor().toNumber();
    if (dailyLossCents >= dailyLossLimitCents) bot.paperHaltedDate = utcDate;
    bot.paperLastCycleAt = now.toISOString();

    if (bot.paperState !== "PAPER" || await paperTradingStore.readBotKillSwitch(bot.paperBotId)) {
      const view = await paperView(bot, markPrice);
      return {
        paperMode: "PAPER",
        paperStatus: "PAPER_BOT_NOT_ACTIVE",
        paperMessage: "This paper bot is not active; no paper fill was produced.",
        paperView: view,
      };
    }

    const position = bot.paperPosition;
    if (position) {
      const stopPrice = new Decimal(position.paperEntryFillPrice)
        .mul(new Decimal(1).minus(new Decimal(bot.paperConfig.stopLossPercent).div(100)));
      if (new Decimal(markPrice).lte(stopPrice)) {
        const result = await tryPaperFill(bot, paperSessionId, quote, now, "SELL", "STOP_LOSS", paperEquityCents, dailyLossCents);
        const view = await paperView(bot, markPrice);
        return {
          paperMode: "PAPER",
          paperStatus: result.status,
          paperMessage: "Paper stop-loss evaluated from the fresh Coinbase bid.",
          ...(result.side ? { paperSide: result.side } : {}),
          ...(result.fillPrice ? { paperFillPrice: result.fillPrice } : {}),
          ...(result.fillQuantity ? { paperFillQuantity: result.fillQuantity } : {}),
          ...(result.feeCents !== undefined ? { paperFeeCents: result.feeCents } : {}),
          ...(result.slippageBps ? { paperSlippageBps: result.slippageBps } : {}),
          ...(result.reasons ? { paperRiskReasons: result.reasons } : {}),
          paperView: view,
        };
      }
    }

    const candles = validDailyCandles(bot.paperConfig.symbol, sourceCandles, now);
    const latest = candles.at(-1);
    if (candles.length < 16 || !latest) {
      const view = await paperView(bot, markPrice);
      return { paperMode: "PAPER", paperStatus: "PAPER_WAITING_FOR_HISTORY", paperMessage: "Waiting for 16 complete Coinbase daily candles.", paperView: view };
    }

    let result: FillResult = { status: "PAPER_NO_ACTION" };
    if (bot.paperLastProcessedCandleAt !== latest.closeTime) {
      bot.paperLastProcessedCandleAt = latest.closeTime;
      const closes = candles.map(({ close }) => Number(close));
      const previousRsi = calculateRsi(closes.slice(0, -1).slice(-100), 14);
      const currentRsi = calculateRsi(closes.slice(-100), 14);
      if (previousRsi !== null && currentRsi !== null) {
        if (!position && previousRsi > Number(bot.paperConfig.buyRsiBelow) && currentRsi <= Number(bot.paperConfig.buyRsiBelow)) {
          if (bot.paperHaltedDate === utcDate) {
            result = { status: "PAPER_DAILY_HALT" };
          } else {
            result = await tryPaperFill(bot, paperSessionId, quote, now, "BUY", "RSI_ENTRY", paperEquityCents, dailyLossCents);
          }
        } else if (position && previousRsi < Number(bot.paperConfig.sellRsiAbove) && currentRsi >= Number(bot.paperConfig.sellRsiAbove)) {
          result = await tryPaperFill(bot, paperSessionId, quote, now, "SELL", "RSI_EXIT", paperEquityCents, dailyLossCents);
        }
      }
    }
    bot.paperUpdatedAt = now.toISOString();
    const view = await paperView(bot, markPrice);
    return {
      paperMode: "PAPER",
      paperStatus: result.status,
      paperMessage: result.status === "PAPER_DAILY_HALT"
        ? "Paper daily-loss halt is active; no new paper position was opened."
        : result.status === "PAPER_FILLED"
          ? "Simulated paper fill recorded from the Coinbase top-of-book quote."
          : result.status === "PAPER_RISK_REFUSED"
            ? "Paper risk engine refused the simulated fill."
            : "No new completed-daily-candle strategy signal; no paper fill was produced.",
      ...(result.side ? { paperSide: result.side } : {}),
      ...(result.fillPrice ? { paperFillPrice: result.fillPrice } : {}),
      ...(result.fillQuantity ? { paperFillQuantity: result.fillQuantity } : {}),
      ...(result.feeCents !== undefined ? { paperFeeCents: result.feeCents } : {}),
      ...(result.slippageBps ? { paperSlippageBps: result.slippageBps } : {}),
      ...(result.reasons ? { paperRiskReasons: result.reasons } : {}),
      paperView: view,
    };
  });
}