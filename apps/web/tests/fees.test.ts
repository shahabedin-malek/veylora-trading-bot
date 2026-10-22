import assert from "node:assert/strict";
import test from "node:test";
import { postDepositCredit } from "@/lib/deposits/credit";
import {
  chargePerformanceFee,
  performanceFeeMinor,
  platformFeeBalanceMinor,
  reversePerformanceFee,
} from "@/lib/fees/apply";
import { formatFeeAmount, quoteWithdrawal } from "@/lib/fees/amounts";
import {
  defaultFeeSchedule,
  feeScheduleFromRow,
  pricingRows,
  validateFeeScheduleUpdate,
  withdrawalFeeFor,
  type EffectiveFeeSchedule,
  type FeeScheduleValues,
} from "@/lib/fees/table";
import { overviewToCsv, parseHistoryCsv, type AccountOverview } from "@/lib/portfolio/pnl";
import { buildAssistantPaperPerformance } from "@/lib/portfolio/paper-performance";
import { readWithdrawalPolicy, type WithdrawalPolicy } from "@/lib/withdrawals/policy";
import { requestWithdrawal } from "@/lib/withdrawals/request";
import { applyFeeSchedule, readPricedWithdrawalPolicy } from "@/lib/withdrawals/settings";
import { InMemoryLedgerStore } from "./support/in-memory-ledger-store";
import { InMemoryWithdrawalStore } from "./support/in-memory-withdrawal-store";

/**
 * Phase 16, graded on the four things its acceptance criteria name:
 *
 *  1. A profitable result produces a fee and a losing result produces none — and the fee
 *     is a *ledger entry* against the platform's own fee account, naming the result that
 *     earned it, not a number computed into a screen.
 *  2. The pricing page and the withdrawal path read one table. This test asserts the
 *     shared lookup rather than two renderers that agree today: the row the page shows
 *     is the value `applyFeeSchedule` hands the request path.
 *  3. Zero is a configuration: it renders as `no fee`, not as a blank or a missing field.
 *  4. A fee at or above the amount is refused before anything is reserved, with the two
 *     numbers in the sentence.
 *
 * The fee schedule is stated literally in each test, and the ledger is the in-memory book
 * the other money phases use, so every claim is about rows written rather than about a
 * database being reachable.
 */

const USER_ID = "user-fees";
const NOW = new Date("2026-10-17T12:00:00.000Z");
const USDT = { asset: "USDT", decimals: 6 };

const RPC_ENV = {
  NODE_ENV: "test",
  DEPOSIT_ADDRESS_MNEMONIC: "test test test test test test test test test test test junk",
  DEPOSIT_ENABLED_NETWORKS: "ethereum-mainnet",
  DEPOSIT_CONFIRMATIONS_ETHEREUM_MAINNET: "2",
  DEPOSIT_TOKEN_ADDRESS_ETHEREUM_MAINNET: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  DEPOSIT_TOKEN_DECIMALS_ETHEREUM_MAINNET: "6",
  DEPOSIT_TOKEN_SYMBOL_ETHEREUM_MAINNET: "USDT",
  ALCHEMY_ETHEREUM_MAINNET_RPC_URL: "https://eth-mainnet.g.alchemy.com/v2/test-key",
  WITHDRAWAL_HOT_WALLET_MNEMONIC: "test test test test test test test test test test test junk",
  WITHDRAWAL_NEW_ADDRESS_WINDOW_MINUTES: "0",
  WITHDRAWAL_FEE_USDT: "0",
} as NodeJS.ProcessEnv;

function effectiveSchedule(overrides: Partial<FeeScheduleValues> = {}): EffectiveFeeSchedule {
  return {
    ...defaultFeeSchedule(new Date("2026-01-01T00:00:00.000Z").toISOString()),
    id: "fee-version-1",
    source: "owner-schedule",
    appliedFrom: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    ...overrides,
  };
}

/** Credit the account through the real deposit credit, so the balance is a real book. */
async function fund(ledger: InMemoryLedgerStore, amountMinor: string): Promise<void> {
  const { posted } = await postDepositCredit(ledger, {
    depositId: `fund-${Math.random().toString(36).slice(2, 10)}`,
    userId: USER_ID,
    asset: USDT.asset,
    decimals: USDT.decimals,
    amountMinor,
    occurredAt: NOW,
    network: "ethereum-mainnet",
    txHash: "0xfunding",
    logIndex: 0,
  });
  assert.equal(posted, true, "the funding movement must post");
}

function policyFor(): WithdrawalPolicy {
  return readWithdrawalPolicy(RPC_ENV);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Profit yes, loss no.
// ─────────────────────────────────────────────────────────────────────────────

test("a performance fee is a percentage of a profit and nothing at all on a loss", () => {
  const twenty = { performanceFeePercent: "20" };
  assert.equal(performanceFeeMinor(twenty, BigInt(5_000_000)), BigInt(1_000_000), "20% of 5 USDT is 1 USDT");
  assert.equal(
    performanceFeeMinor({ performanceFeePercent: "12.5" }, BigInt(1_000_000)),
    BigInt(125_000),
    "a fractional percentage is exact basis points, not a rounded float",
  );
  assert.equal(performanceFeeMinor(twenty, BigInt(-500_000)), BigInt(0), "a loss pays nothing");
  assert.equal(performanceFeeMinor(twenty, BigInt(0)), BigInt(0), "a flat result pays nothing");
  assert.equal(performanceFeeMinor({ performanceFeePercent: "0" }, BigInt(5_000_000)), BigInt(0), "zero percent pays nothing");
  assert.equal(performanceFeeMinor({ performanceFeePercent: "100" }, BigInt(7)), BigInt(7));
  assert.equal(performanceFeeMinor({ performanceFeePercent: "50" }, BigInt(7)), BigInt(3), "the fraction is floored, never overcharged");
});

test("a profitable result posts a fee entry against the platform's fee account, naming the result", async () => {
  const ledger = new InMemoryLedgerStore();
  await fund(ledger, "10000000"); // 10 USDT available

  const charged = await chargePerformanceFee(ledger, { performanceFeePercent: "20" }, {
    userId: USER_ID,
    asset: USDT.asset,
    decimals: USDT.decimals,
    resultId: "result-profitable",
    profitMinor: "5000000", // 5 USDT profit
    occurredAt: NOW,
    label: "momentum-v1",
  });

  assert.equal(charged.charged, true);
  assert.equal(charged.feeMinor, "1000000", "20% of a 5 USDT profit is 1 USDT");
  assert.equal(charged.feeDecimal, "1");
  assert.equal(await platformFeeBalanceMinor(ledger, USDT), BigInt(1_000_000), "the fee account holds the fee");

  const feeTransaction = ledger.transactions.find((transaction) => transaction.id === charged.transactionId);
  assert.ok(feeTransaction);
  assert.equal(feeTransaction.kind, "PERFORMANCE_FEE");
  assert.equal(feeTransaction.sourceType, "StrategyResult");
  assert.equal(feeTransaction.sourceId, "result-profitable", "every fee entry links to the action that earned it");

  // The owner paid exactly the fee, and the platform kept exactly it.
  const ownerAccounts = await ledger.listAccountsForUser(USER_ID);
  const available = ownerAccounts.find((account) => account.bucket === "AVAILABLE");
  assert.ok(available);
  const ownerEntriesForAccount = ledger.entriesForAccount(available.id);
  const ownerNet = ownerEntriesForAccount.reduce(
    (total, entry) => total + (entry.direction === "CREDIT" ? BigInt(entry.amountMinor) : -BigInt(entry.amountMinor)),
    BigInt(0),
  );
  assert.equal(ownerNet, BigInt(9_000_000), "10 USDT credited minus the 1 USDT fee");

  // Posting the same result again cannot charge twice.
  const replay = await chargePerformanceFee(ledger, { performanceFeePercent: "20" }, {
    userId: USER_ID,
    asset: USDT.asset,
    decimals: USDT.decimals,
    resultId: "result-profitable",
    profitMinor: "5000000",
    occurredAt: NOW,
  });
  assert.equal(replay.charged, false);
  assert.equal(replay.reason?.code, "ALREADY_COMPLETED");
  assert.equal(await platformFeeBalanceMinor(ledger, USDT), BigInt(1_000_000), "the replay wrote nothing");
});

test("a losing result produces no fee entry at all", async () => {
  const ledger = new InMemoryLedgerStore();
  await fund(ledger, "10000000");

  const charged = await chargePerformanceFee(ledger, { performanceFeePercent: "20" }, {
    userId: USER_ID,
    asset: USDT.asset,
    decimals: USDT.decimals,
    resultId: "result-losing",
    profitMinor: "-2500000",
    occurredAt: NOW,
  });

  assert.equal(charged.charged, false);
  assert.equal(charged.feeMinor, "0");
  assert.equal(charged.reason, null, "a loss is not a refusal; there is simply no fee");
  assert.equal(ledger.transactions.length, 1, "only the funding movement exists");
  assert.equal(await platformFeeBalanceMinor(ledger, USDT), BigInt(0));
});

test("a fee is reversible by a compensating entry that references the original", async () => {
  const ledger = new InMemoryLedgerStore();
  await fund(ledger, "10000000");
  const charged = await chargePerformanceFee(ledger, { performanceFeePercent: "20" }, {
    userId: USER_ID,
    asset: USDT.asset,
    decimals: USDT.decimals,
    resultId: "result-reversible",
    profitMinor: "5000000",
    occurredAt: NOW,
  });
  assert.equal(charged.charged, true);

  const reversed = await reversePerformanceFee(ledger, {
    resultId: "result-reversible",
    originalTransactionId: charged.transactionId!,
    occurredAt: new Date(NOW.getTime() + 60_000),
  });
  assert.equal(reversed.reversed, true);
  const reversal = ledger.transactions.find((transaction) => transaction.id === reversed.transactionId);
  assert.equal(reversal?.reversesTransactionId, charged.transactionId);
  assert.equal(await platformFeeBalanceMinor(ledger, USDT), BigInt(0), "the fee account is whole again");

  const twice = await reversePerformanceFee(ledger, {
    resultId: "result-reversible",
    originalTransactionId: charged.transactionId!,
    occurredAt: new Date(NOW.getTime() + 120_000),
  });
  assert.equal(twice.reversed, false);
  assert.equal(twice.reason?.code, "ALREADY_COMPLETED");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. One table: the page and the code.
// ─────────────────────────────────────────────────────────────────────────────

test("the pricing rows and the withdrawal policy read the same fee table, value for value", async () => {
  const schedule = effectiveSchedule({
    withdrawalFees: { USDT: "0.5" },
    networkCosts: { USDT: "0.25" },
    performanceFeePercent: "20",
  });
  const policy = policyFor();
  const priced = await readPricedWithdrawalPolicy({
    env: RPC_ENV,
    readSettings: async () => null,
    readSchedule: async () => schedule,
  });

  const rows = pricingRows(schedule, { assets: ["USDT", "DAI"], decimals: { USDT: 6, DAI: 18 } });
  const usdt = rows.find((row) => row.asset === "USDT");
  assert.ok(usdt);
  assert.equal(usdt.fee, withdrawalFeeFor(schedule, "USDT"));
  assert.equal(usdt.fee, priced.feeByAsset.USDT, "the page's fee is the number the request path charges");
  assert.equal(usdt.networkCost, priced.networkCostByAsset.USDT);
  assert.equal(priced.feeSource, "owner-schedule");
  assert.equal(usdt.feeLabel, "0.5 USDT");
  assert.equal(usdt.example?.arriving, "0.5", "one unit minus the fee is what arrives");

  const dai = rows.find((row) => row.asset === "DAI");
  assert.ok(dai);
  assert.equal(dai.fee, "0", "an asset the table does not name is free, not charged the last asset's fee");
  assert.equal(dai.feeLabel, "no fee");

  // The deployment's environment fee is not a second source: once a version is in force,
  // the table replaces it for every asset the withdrawal path knows.
  assert.equal(policy.feeByAsset.USDT, "0", "the raw deployment policy is untouched");
});

test("a deployment with no stored version charges nothing and says so", () => {
  const schedule = defaultFeeSchedule();
  assert.equal(schedule.source, "defaults");
  assert.equal(withdrawalFeeFor(schedule, "USDT"), "0");
  assert.equal(formatFeeAmount(schedule.withdrawalFees.USDT ?? "0", "USDT"), "no fee");
  assert.equal(schedule.performanceFeePercent, "0");

  const rows = pricingRows(schedule, { assets: ["USDT"], decimals: { USDT: 6 } });
  assert.equal(rows[0]?.feeLabel, "no fee");
  assert.equal(rows[0]?.example?.arriving, "1", "a free withdrawal arrives whole");
});

test("zero is a stored value and renders as free, not as a missing figure", () => {
  assert.equal(formatFeeAmount("0", "USDT"), "no fee");
  assert.equal(formatFeeAmount("0.000000", "USDT"), "no fee");
  assert.equal(formatFeeAmount("1", "USDT"), "1 USDT");

  const quote = quoteWithdrawal({ amount: "20", fee: "0", networkCost: "0", asset: "USDT", decimals: 6 });
  assert.equal(quote.valid, true);
  if (quote.valid) {
    assert.equal(quote.quote.feeLabel, "no fee");
    assert.equal(quote.quote.networkCostLabel, "no fee");
    assert.equal(quote.quote.arriving, "20", "no fee means the whole amount arrives");
  }
});

test("the quote discloses the network cost without deducting it", () => {
  const quote = quoteWithdrawal({ amount: "20", fee: "1", networkCost: "0.5", asset: "USDT", decimals: 6 });
  assert.equal(quote.valid, true);
  if (quote.valid) {
    assert.equal(quote.quote.fee, "1");
    assert.equal(quote.quote.networkCost, "0.5");
    assert.equal(quote.quote.arriving, "19", "only the platform fee is deducted");
    assert.equal(quote.quote.arrivingMinor, "19000000");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Validation: what the admin page may save.
// ─────────────────────────────────────────────────────────────────────────────

test("the fee table validates percentages, amounts, effective-from and exactly one default tier", () => {
  const valid = validateFeeScheduleUpdate({
    effectiveFrom: "2026-10-17T12:00:00.000Z",
    withdrawalFees: { USDT: "1" },
    networkCosts: { USDT: "0.5" },
    performanceFeePercent: "20",
    tiers: [
      { key: "STANDARD", label: "Standard", maxBots: 10, maxVenueConnections: 5, isDefault: true },
      { key: "PRO", label: "Pro", maxBots: 50, maxVenueConnections: 20, isDefault: false },
    ],
  });
  assert.equal(valid.valid, true);
  if (valid.valid) {
    assert.equal(valid.value.withdrawalFees.USDT, "1");
    assert.equal(valid.value.tiers.length, 2);
    assert.equal(valid.value.effectiveFrom, "2026-10-17T12:00:00.000Z");
  }

  const zero = validateFeeScheduleUpdate({
    effectiveFrom: "2026-10-17T12:00:00.000Z",
    withdrawalFees: { USDT: "0" },
    performanceFeePercent: "0",
    tiers: [{ key: "STANDARD", label: "Standard", maxBots: 0, maxVenueConnections: 0, isDefault: true }],
  });
  assert.equal(zero.valid, true, "zero is a valid configuration");

  const refusals: unknown[] = [
    { effectiveFrom: "not a date", performanceFeePercent: "20" },
    { effectiveFrom: "2026-10-17T12:00:00.000Z", withdrawalFees: { USDT: "-1" }, performanceFeePercent: "20" },
    { effectiveFrom: "2026-10-17T12:00:00.000Z", withdrawalFees: { USDT: "0.1234567890123456789" }, performanceFeePercent: "20" },
    { effectiveFrom: "2026-10-17T12:00:00.000Z", performanceFeePercent: "101" },
    { effectiveFrom: "2026-10-17T12:00:00.000Z", performanceFeePercent: "-5" },
    {
      effectiveFrom: "2026-10-17T12:00:00.000Z",
      performanceFeePercent: "20",
      tiers: [
        { key: "A", label: "A", maxBots: 1, maxVenueConnections: 1, isDefault: false },
        { key: "B", label: "B", maxBots: 1, maxVenueConnections: 1, isDefault: false },
      ],
    },
    {
      effectiveFrom: "2026-10-17T12:00:00.000Z",
      performanceFeePercent: "20",
      tiers: [
        { key: "A", label: "A", maxBots: 1, maxVenueConnections: 1, isDefault: true },
        { key: "A", label: "Again", maxBots: 1, maxVenueConnections: 1, isDefault: false },
      ],
    },
    { effectiveFrom: "2026-10-17T12:00:00.000Z", performanceFeePercent: "20", unsupported: true },
  ];
  for (const candidate of refusals) {
    assert.equal(validateFeeScheduleUpdate(candidate).valid, false, `must refuse ${JSON.stringify(candidate)}`);
  }
});

test("a stored row that no longer validates is a hard error, not a silent zero", () => {
  const row = {
    id: "row-1",
    effectiveFrom: new Date("2026-10-17T12:00:00.000Z"),
    withdrawalFeesJson: '{"USDT":"1"}',
    networkCostsJson: "{}",
    performanceFeePercent: "20",
    tradingFeeBps: "10",
    spreadBps: "2",
    slippageBps: "5",
    fundingBpsPerDay: "0",
    tiersJson: JSON.stringify([{ key: "STANDARD", label: "Standard", maxBots: 10, maxVenueConnections: 5, isDefault: true }]),
    createdAt: new Date("2026-10-17T12:00:00.000Z"),
  };
  const parsed = feeScheduleFromRow(row);
  assert.equal(parsed.withdrawalFees.USDT, "1");
  assert.throws(
    () => feeScheduleFromRow({ ...row, performanceFeePercent: "not-a-percent" }),
    /failed validation/,
    "an unreadable stored fee must not be treated as free",
  );
});

test("the account export carries the period's fees without disturbing its reconciliation", () => {
  const overview = {
    readAt: NOW.toISOString(),
    userId: USER_ID,
    range: { from: "2026-09-17T00:00:00.000Z", to: "2026-10-17T23:59:59.999Z" },
    filter: { asset: null, types: [], hash: null },
    balances: [],
    positions: [],
    pnl: { realisedUsd: "0", unrealisedUsd: "0", netUsd: "0", pricedMarkets: 0, unpricedMarkets: [], sources: [] },
    summary: {
      from: "2026-09-17T00:00:00.000Z",
      to: "2026-10-17T23:59:59.999Z",
      assets: [
        {
          asset: "USDT",
          decimals: 6,
          inflowMinor: "0",
          inflow: "0",
          outflowMinor: "0",
          outflow: "0",
          withdrawalFeesMinor: "1000000",
          withdrawalFees: "1",
          performanceFeesMinor: "500000",
          performanceFees: "0.5",
          feesMinor: "1500000",
          fees: "1.5",
          netMinor: "0",
          net: "0",
          deposits: 0,
          withdrawals: 1,
        },
      ],
      trading: { realisedUsd: "0", filledOrders: 0, markets: [] },
      sources: [],
    },
    history: [],
    totals: [],
    statementTotals: [],
    ledgerBalances: [],
    // The fee block is appended after the assistant's paper block, so the export needs
    // both to say what the file contains. An account with no assistant order still
    // carries the block with its zeroes, rather than a section that is absent.
    paperPerformance: buildAssistantPaperPerformance({
      assistantOrders: [],
      paperOrders: [],
      marks: [],
      now: NOW,
    }),
    sources: [],
    notes: [],
  } as unknown as AccountOverview;

  const csv = overviewToCsv(overview);
  assert.match(csv, /# PERIOD FEES/);
  assert.match(csv, /USDT,1,0\.5,1\.5,1500000/, "the fee report states withdrawal, performance and total");

  // The history portion still reconciles: the fee block is not a row and is not summed.
  const reimported = parseHistoryCsv(csv);
  assert.equal(reimported.rows, 0);
  assert.deepEqual(reimported.totals, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The withdrawal path applies the table, and refuses a fee that eats the amount.
// ─────────────────────────────────────────────────────────────────────────────

test("a withdrawal is priced by the table, and a fee at or above the amount is refused before anything is held", async () => {
  const store = new InMemoryWithdrawalStore();
  await postDepositCredit(store.ledger(), {
    depositId: "deposit-withdrawal-fee",
    userId: "user-withdraw-fee",
    asset: "USDT",
    decimals: 6,
    amountMinor: "20000000",
    occurredAt: NOW,
    network: "ethereum-mainnet",
    txHash: "0xfee",
    logIndex: 0,
  });

  const priced = await readPricedWithdrawalPolicy({
    env: RPC_ENV,
    readSettings: async () => null,
    readSchedule: async () => effectiveSchedule({ withdrawalFees: { USDT: "1" }, networkCosts: { USDT: "0.5" } }),
  });
  assert.equal(priced.feeByAsset.USDT, "1", "the charge is the table's number");

  const accepted = await requestWithdrawal({
    store,
    policy: priced,
    userId: "user-withdraw-fee",
    network: "ethereum-mainnet",
    destination: "0x9f2c7b1a4e5d6f7089aabbccddeeff0011223344",
    amount: "20",
    idempotencyKey: "fee-ok",
    now: NOW,
  });
  assert.equal(accepted.refused, false);
  assert.equal(accepted.withdrawal?.feeMinor, "1000000", "1 USDT is deducted from 20 USDT");
  assert.equal(accepted.withdrawal?.netMinor, "19000000");

  // The failure case: a fee larger than the amount leaves nothing to send.
  const tooHigh = await readPricedWithdrawalPolicy({
    env: RPC_ENV,
    readSettings: async () => null,
    readSchedule: async () => effectiveSchedule({ withdrawalFees: { USDT: "25" } }),
  });
  const refused = await requestWithdrawal({
    store,
    policy: tooHigh,
    userId: "user-withdraw-fee",
    network: "ethereum-mainnet",
    destination: "0x1111222233334444555566667777888899990000",
    amount: "20",
    idempotencyKey: "fee-too-high",
    now: NOW,
  });
  assert.equal(refused.refused, true);
  assert.equal(refused.withdrawal, null, "no row was created");
  assert.equal(refused.reason?.code, "INVALID_AMOUNT");
  assert.match(refused.reason?.message ?? "", /leaves nothing of 20 USDT to send/);
  assert.equal(store.rows.length, 1, "only the accepted withdrawal exists");

  // The accepted amount is still exactly what was held, and the refused one held nothing.
  const balances = await store.ledger().listAccountsForUser("user-withdraw-fee");
  const available = balances.find((account) => account.bucket === "AVAILABLE");
  assert.ok(available);
  const net = (await store.ledger().listEntriesForAccounts([available.id])).reduce(
    (total, { entry }) => total + (entry.direction === "CREDIT" ? BigInt(entry.amountMinor) : -BigInt(entry.amountMinor)),
    BigInt(0),
  );
  assert.equal(net, BigInt(0), "20 credited, 20 reserved by the accepted request, nothing held by the refused one");
});

test("the fee overlay leaves the policy untouched when the table cannot be read", () => {
  const policy = policyFor();
  assert.equal(applyFeeSchedule(policy, null), policy, "a failed read is not a reason to invent a price");

  const overlaid = applyFeeSchedule(policy, effectiveSchedule({ withdrawalFees: { USDT: "2" } }));
  assert.equal(overlaid.feeByAsset.USDT, "2");
  assert.equal(overlaid.feeSource, "owner-schedule");
  assert.equal(overlaid.newAddressWindowMinutes, policy.newAddressWindowMinutes, "pricing never moves the hold window");
});
