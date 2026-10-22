import type { BotConfiguration } from "@/lib/bot-builder/state-machine";
import { getIntegerCentLedgerSnapshot, type LedgerSnapshot } from "@/lib/ledger/integer-cent-ledger";
import { isDevelopmentMode, type EnvironmentLike } from "@/lib/dev-mode/mode";
import { paperTradingStore, type InMemoryPaperTradingStore } from "@/lib/paper-trading/store";

/**
 * Development seed for the PAPER strategy store.
 *
 * Strategy lifecycle state (draft, paper, stopped) is not a database table — a
 * PAPER bot lives in the process-local store, keyed by a per-session id. So the
 * "strategies in every lifecycle state" half of the phase seed happens here, at
 * boot, instead of in `prisma/seed.ts`.
 *
 * The session id is fixed and the seed runs once per process, so a restarted dev
 * server lands on the same state rather than a second set of strategies.
 * Development only: `seedDevPaperSession` returns immediately in any other mode,
 * and `instrumentation.ts` never calls it there.
 */
export const DEV_PAPER_SESSION_ID = "00000000-0000-4000-8000-000000000000";

/** Fixed clock so a reseed produces the same timestamps. */
const SEEDED_AT = new Date("2026-01-01T00:00:00.000Z");

const FINANCED_STRATEGY_NAME = "dev-paper-rsi-recovery";

/** The funded strategy's opening capital, from its `budgetCapUsd` of 25000. */
export const DEV_PAPER_INITIAL_CAPITAL_CENTS = 2_500_000;

type DevStrategy = {
  name: string;
  /** Lifecycle state the strategy is left in: DRAFT (draft), PAPER (paper), KILLED (stopped). */
  state: "DRAFT" | "PAPER" | "KILLED";
  config: BotConfiguration;
};

function configuration(name: string, description: string, symbol: string): BotConfiguration {
  return {
    name,
    description,
    symbol,
    schedule: "DAILY_CLOSE",
    budgetCapUsd: "25000",
    maxTradeSizeUsd: "200",
    stopLossPercent: "20",
    dailyLossHaltPercent: "2",
    feeBps: "10",
    slippageBps: "5",
    buyRsiBelow: "30",
    sellRsiAbove: "70",
    maxDrawdownGatePercent: "20",
    minWinRateGatePercent: "40",
    minProfitFactorGate: "1.2",
  };
}

const DEV_STRATEGIES: readonly DevStrategy[] = [
  {
    name: "dev-draft-rsi-breakout",
    state: "DRAFT",
    config: configuration(
      "dev-draft-rsi-breakout",
      "Local draft strategy. Never started; exists so the builder has a draft to show.",
      "BTC-USD",
    ),
  },
  {
    name: FINANCED_STRATEGY_NAME,
    state: "PAPER",
    config: configuration(
      FINANCED_STRATEGY_NAME,
      "Local funded paper strategy. Opening balance and three paper transactions are seeded.",
      "ETH-USD",
    ),
  },
  {
    name: "dev-stopped-rsi-fade",
    state: "KILLED",
    config: configuration(
      "dev-stopped-rsi-fade",
      "Local stopped strategy. Kill switch engaged, so it stays out of the paper cycle.",
      "SOL-USD",
    ),
  },
];

/**
 * Three closed paper round trips.
 *
 * Each transaction is written the way the paper engine writes one — a CASH
 * movement per leg plus its FEE, with the realized P&L on the sell leg. That
 * shape is the point: `paperPnlCents` is displayed as `equity − initial capital`,
 * so P&L that does not move cash would leave the page showing a loss (or a flat
 * $0.00) next to fees the account supposedly paid. These three close flat, so
 * cash, equity, P&L and fees all agree with the entries behind them.
 */
const DEV_PAPER_TRANSACTIONS = [
  { key: "trade-0001", buyCents: 50_000, sellCents: 52_500, feeCents: 500, pnlCents: 2_500 },
  { key: "trade-0002", buyCents: 30_000, sellCents: 28_200, feeCents: 300, pnlCents: -1_800 },
  { key: "trade-0003", buyCents: 20_000, sellCents: 20_400, feeCents: 200, pnlCents: 400 },
] as const;

export type DevPaperSeedResult = {
  seeded: boolean;
  sessionId: string;
  strategies: { name: string; state: string }[];
  ledgerEntries: number;
  snapshot: LedgerSnapshot | null;
};

export async function seedDevPaperSession(
  store: InMemoryPaperTradingStore = paperTradingStore,
  environment: EnvironmentLike = process.env,
): Promise<DevPaperSeedResult> {
  const idle: DevPaperSeedResult = {
    seeded: false,
    sessionId: DEV_PAPER_SESSION_ID,
    strategies: [],
    ledgerEntries: 0,
    snapshot: null,
  };
  if (!isDevelopmentMode(environment)) return idle;

  const existing = await store.listPaperBots(DEV_PAPER_SESSION_ID);
  if (existing.length > 0) {
    return {
      ...idle,
      strategies: existing.map((bot) => ({ name: bot.paperConfig.name, state: bot.paperState })),
    };
  }

  let fundedAccountId: string | null = null;
  for (const strategy of DEV_STRATEGIES) {
    const bot = await store.createPaperBot(DEV_PAPER_SESSION_ID, strategy.config, SEEDED_AT);
    if (strategy.state === "PAPER") {
      // Activation books the opening CASH entry, so this account starts funded.
      await store.activatePaperBot(DEV_PAPER_SESSION_ID, bot.paperBotId, SEEDED_AT);
      fundedAccountId = bot.paperBotId;
    } else if (strategy.state === "KILLED") {
      await store.killPaperBot(DEV_PAPER_SESSION_ID, bot.paperBotId, SEEDED_AT);
    }
  }

  if (fundedAccountId) {
    for (const transaction of DEV_PAPER_TRANSACTIONS) {
      const legs = [
        { suffix: "buy-cash", type: "CASH" as const, amountCents: -transaction.buyCents },
        { suffix: "buy-fee", type: "FEE" as const, amountCents: transaction.feeCents },
        { suffix: "sell-cash", type: "CASH" as const, amountCents: transaction.sellCents },
        { suffix: "sell-fee", type: "FEE" as const, amountCents: transaction.feeCents },
        { suffix: "pnl", type: "PNL" as const, amountCents: transaction.pnlCents },
      ];
      for (const leg of legs) {
        const applied = await store.appendLedgerEntry({
          idempotencyKey: `dev-seed:${transaction.key}:${leg.suffix}`,
          accountId: fundedAccountId,
          actorUserId: DEV_PAPER_SESSION_ID,
          type: leg.type,
          amountCents: leg.amountCents,
          occurredAt: SEEDED_AT,
        });
        if (!applied.applied) {
          throw new Error(
            `The development paper seed tried to write ${transaction.key}/${leg.suffix} twice. ` +
              "The ledger keys are supposed to be unique per fresh account.",
          );
        }
      }
    }
  }

  const strategies = (await store.listPaperBots(DEV_PAPER_SESSION_ID)).map((bot) => ({
    name: bot.paperConfig.name,
    state: bot.paperState,
  }));
  const snapshot = fundedAccountId ? await getIntegerCentLedgerSnapshot(store, fundedAccountId) : null;
  const ledgerEntries = fundedAccountId ? (await store.listLedgerEntries(fundedAccountId)).length : 0;

  return { seeded: true, sessionId: DEV_PAPER_SESSION_ID, strategies, ledgerEntries, snapshot };
}
