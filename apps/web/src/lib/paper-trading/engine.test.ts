import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { MarketCandle, MarketQuote } from "@/lib/market-data/provider";
import { getIntegerCentLedgerSnapshot } from "@/lib/ledger/integer-cent-ledger";
import { getPaperTradingView, runPaperCycle } from "@/lib/paper-trading/engine";
import { paperTradingStore } from "@/lib/paper-trading/store";
import type { BotConfiguration } from "@/lib/bot-builder/state-machine";

const configuration: BotConfiguration = {
  name: "Paper RSI",
  description: "Engine test",
  symbol: "BTC-USD",
  schedule: "DAILY_CLOSE",
  budgetCapUsd: "10000",
  maxTradeSizeUsd: "2500",
  stopLossPercent: "4",
  dailyLossHaltPercent: "2",
  feeBps: "10",
  slippageBps: "5",
  buyRsiBelow: "30",
  sellRsiAbove: "70",
  maxDrawdownGatePercent: "20",
  minWinRateGatePercent: "0",
  minProfitFactorGate: "0.1",
};

function quote(now: Date, bid: string, ask: string): MarketQuote {
  return {
    instrument: { id: "BTC-USD", symbol: "BTC-USD", baseAsset: "BTC", quoteAsset: "USD" },
    bid,
    ask,
    last: null,
    baseVolume24h: null,
    priceChangePercent24h: null,
    provenance: {
      providerId: "coinbase-exchange",
      providerName: "Coinbase Exchange",
      endpointOrigin: "https://api.exchange.coinbase.com",
      observedAt: new Date(now.getTime() - 1_000).toISOString(),
      fetchedAt: now.toISOString(),
      freshness: "FRESH",
      responseHash: "paper-fixture-only",
    },
  };
}

function candles(now: Date): MarketCandle[] {
  const closes = Array.from({ length: 15 }, (_, index) => String(100 + index));
  closes.push("10");
  const finalOpen = Date.parse("2026-10-14T00:00:00.000Z");
  const firstOpen = finalOpen - (closes.length - 1) * 86_400_000;
  return closes.map((close, index) => {
    const openTime = new Date(firstOpen + index * 86_400_000);
    const closeTime = new Date(openTime.getTime() + 86_400_000);
    return {
      instrument: { id: "BTC-USD", symbol: "BTC-USD", baseAsset: "BTC", quoteAsset: "USD" },
      interval: "1d",
      openTime: openTime.toISOString(),
      closeTime: closeTime.toISOString(),
      open: close,
      high: String(Number(close) + 1),
      low: String(Math.max(1, Number(close) - 1)),
      close,
      volume: "100",
      provenance: {
        providerId: "coinbase-exchange",
        providerName: "Coinbase Exchange",
        endpointOrigin: "https://api.exchange.coinbase.com",
        observedAt: closeTime.toISOString(),
        fetchedAt: now.toISOString(),
        freshness: "DELAYED",
        responseHash: "paper-fixture-only",
      },
    };
  });
}

test("paper cycle fills once from Coinbase data, accounts in cents, stops on kill", async () => {
  const paperSessionId = randomUUID();
  const now = new Date("2026-10-16T12:00:00.000Z");
  const bot = await paperTradingStore.createPaperBot(paperSessionId, configuration, now);
  await paperTradingStore.activatePaperBot(paperSessionId, bot.paperBotId, now);
  const history = candles(now);
  const freshQuote = quote(now, "100", "100.1");

  const entries = await Promise.all([
    runPaperCycle(paperSessionId, bot.paperBotId, freshQuote, history, now),
    runPaperCycle(paperSessionId, bot.paperBotId, freshQuote, history, now),
  ]);
  assert.equal(entries.filter((entry) => entry?.paperStatus === "PAPER_FILLED" && entry.paperSide === "BUY").length, 1);
  assert.equal(entries.filter((entry) => entry?.paperStatus === "PAPER_NO_ACTION").length, 1);

  let view = await getPaperTradingView(paperSessionId, bot.paperBotId);
  assert.ok(view?.paperAccountingActive);
  assert.ok(view?.paperPositionQuantity);
  assert.ok(Number.isSafeInteger(view?.paperCashBalanceCents));
  assert.ok((view?.paperFeesCents ?? 0) > 0);
  assert.ok(view?.paperAuditEvents.every((record) => record.paperDetails.includes('"paper')));
  const ledger = await getIntegerCentLedgerSnapshot(paperTradingStore, bot.paperBotId);
  assert.ok(Number.isSafeInteger(ledger.cashBalanceCents));
  assert.ok(Number.isSafeInteger(ledger.feesCents));
  assert.equal(ledger.cashBalanceCents, 1_000_000 - 250_000 - (view?.paperFeesCents ?? 0));

  const stopResult = await runPaperCycle(paperSessionId, bot.paperBotId, quote(now, "95", "95.1"), history, new Date(now.getTime() + 1_000));
  assert.equal(stopResult?.paperStatus, "PAPER_FILLED");
  assert.equal(stopResult?.paperSide, "SELL");
  assert.equal(stopResult?.paperView.paperPositionQuantity, null);
  assert.ok((stopResult?.paperView.paperPnlCents ?? 0) < 0);

  const killed = await paperTradingStore.killPaperBot(paperSessionId, bot.paperBotId, new Date(now.getTime() + 2_000));
  assert.equal(killed?.paperState, "KILLED");
  const beforeKillCheck = (await getIntegerCentLedgerSnapshot(paperTradingStore, bot.paperBotId)).cashBalanceCents;
  const afterKill = await runPaperCycle(paperSessionId, bot.paperBotId, quote(now, "80", "80.1"), history, new Date(now.getTime() + 3_000));
  assert.equal(afterKill?.paperStatus, "PAPER_BOT_NOT_ACTIVE");
  assert.equal((await getIntegerCentLedgerSnapshot(paperTradingStore, bot.paperBotId)).cashBalanceCents, beforeKillCheck);
  view = await getPaperTradingView(paperSessionId, bot.paperBotId);
  assert.equal(view?.paperState, "KILLED");
});