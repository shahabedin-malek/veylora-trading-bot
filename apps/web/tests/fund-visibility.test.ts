import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAccountOverview,
  overviewToCsv,
  overviewToJson,
  parseHistoryCsv,
  type AccountOverview,
  type FilledOrderLike,
  type HistoryFilter,
  type HistoryType,
  type MarkPrice,
} from "@/lib/portfolio/pnl";
import { buildAssistantPaperPerformance } from "@/lib/portfolio/paper-performance";
import { importExternalHoldings, type ExternalCredential, type ExternalImportDeps } from "@/lib/portfolio/external";
import { importWunderTradingReadOnly } from "@/lib/wundertrading/client";
import { decideCredentialUse } from "@/lib/trading/read-only-credentials";
import type {
  LedgerAccountRow,
  LedgerEntryRow,
  LedgerTransactionRow,
  MoneyDirection,
} from "@/lib/ledger/integer-cent-ledger";

/**
 * The four things this phase promises, asserted on rows stated literally.
 *
 * There is no database, no network and no clock in any of this: an overview is built
 * from rows a test wrote, so the arithmetic — "the totals are the ledger sums for the
 * filter", "a re-imported export reconciles", "a mark that was not read is absent
 * rather than estimated" — is checked against the numbers themselves rather than
 * against a running system that happened to agree.
 */

// ── the rows ─────────────────────────────────────────────────────────────────

const DECIMALS = 6;

function accountRow(input: {
  id: string;
  bucket: string;
  ownerType: "USER" | "PLATFORM";
  asset?: string;
}): LedgerAccountRow {
  const asset = input.asset ?? "USDT";
  return {
    id: input.id,
    code:
      input.ownerType === "USER"
        ? `user:u1:${asset}:${input.bucket === "AVAILABLE" ? "available" : "withdrawal-reserved"}`
        : `platform:${input.bucket === "TREASURY" ? "treasury" : "fees"}:${asset}`,
    ownerType: input.ownerType,
    bucket: input.bucket,
    asset,
    decimals: DECIMALS,
    userId: input.ownerType === "USER" ? "u1" : null,
    creditLineMinor: null,
    createdAt: new Date("2026-09-30T00:00:00.000Z"),
  };
}

const AVAILABLE = accountRow({ id: "acct-available", bucket: "AVAILABLE", ownerType: "USER" });
const RESERVED = accountRow({ id: "acct-reserved", bucket: "WITHDRAWALS_RESERVED", ownerType: "USER" });
const TREASURY = accountRow({ id: "acct-treasury", bucket: "TREASURY", ownerType: "PLATFORM" });
const FEES = accountRow({ id: "acct-fees", bucket: "FEES", ownerType: "PLATFORM" });
const ACCOUNTS = [AVAILABLE, RESERVED, TREASURY, FEES];

function transactionRow(input: {
  id: string;
  kind: string;
  key: string;
  occurredAt: string;
  sourceId?: string;
}): LedgerTransactionRow {
  return {
    id: input.id,
    kind: input.kind,
    idempotencyKey: input.key,
    actorUserId: "u1",
    sourceType: input.sourceId ? "deposit" : null,
    sourceId: input.sourceId ?? null,
    memo: null,
    occurredAt: new Date(input.occurredAt),
    createdAt: new Date(input.occurredAt),
    reversesTransactionId: null,
  };
}

function entryRow(input: {
  id: string;
  transactionId: string;
  accountId: string;
  direction: MoneyDirection;
  amountMinor: string;
  sequence: number;
  at: string;
}): LedgerEntryRow {
  return {
    id: input.id,
    transactionId: input.transactionId,
    accountId: input.accountId,
    asset: "USDT",
    direction: input.direction,
    amountMinor: input.amountMinor,
    decimals: DECIMALS,
    sequence: input.sequence,
    createdAt: new Date(input.at),
  };
}

const CREDIT_DEPOSIT = transactionRow({
  id: "tx-deposit",
  kind: "DEPOSIT_CREDITED",
  key: "deposit:d1:credit",
  occurredAt: "2026-10-02T10:00:00.000Z",
  sourceId: "0xdeposithash",
});
const RESERVE_WITHDRAWAL = transactionRow({
  id: "tx-reserve",
  kind: "WITHDRAWAL_RESERVED",
  key: "withdrawal:w1:reserve",
  occurredAt: "2026-10-03T10:00:00.000Z",
});
const SETTLE_WITHDRAWAL = transactionRow({
  id: "tx-settle",
  kind: "WITHDRAWAL_SETTLED",
  key: "withdrawal:w1:settle",
  occurredAt: "2026-10-04T10:00:00.000Z",
  sourceId: "0xwithdrawhash",
});

const ENTRIES: LedgerEntryRow[] = [
  // 20 USDT in from a credited deposit: the platform holds it, the account is owed it.
  entryRow({ id: "e1", transactionId: "tx-deposit", accountId: TREASURY.id, direction: "DEBIT", amountMinor: "20000000", sequence: 1, at: "2026-10-02T10:00:00.000Z" }),
  entryRow({ id: "e2", transactionId: "tx-deposit", accountId: AVAILABLE.id, direction: "CREDIT", amountMinor: "20000000", sequence: 2, at: "2026-10-02T10:00:00.000Z" }),
  // 5 USDT held for a withdrawal: still owed, no longer spendable.
  entryRow({ id: "e3", transactionId: "tx-reserve", accountId: AVAILABLE.id, direction: "DEBIT", amountMinor: "5000000", sequence: 1, at: "2026-10-03T10:00:00.000Z" }),
  entryRow({ id: "e4", transactionId: "tx-reserve", accountId: RESERVED.id, direction: "CREDIT", amountMinor: "5000000", sequence: 2, at: "2026-10-03T10:00:00.000Z" }),
  // And settled: 4.5 went to the chain, 0.5 stayed with the platform as the fee.
  entryRow({ id: "e5", transactionId: "tx-settle", accountId: RESERVED.id, direction: "DEBIT", amountMinor: "5000000", sequence: 1, at: "2026-10-04T10:00:00.000Z" }),
  entryRow({ id: "e6", transactionId: "tx-settle", accountId: TREASURY.id, direction: "CREDIT", amountMinor: "4500000", sequence: 2, at: "2026-10-04T10:00:00.000Z" }),
  entryRow({ id: "e7", transactionId: "tx-settle", accountId: FEES.id, direction: "CREDIT", amountMinor: "500000", sequence: 3, at: "2026-10-04T10:00:00.000Z" }),
];

const OWN_ACCOUNT_IDS = new Set([AVAILABLE.id, RESERVED.id]);
const OWN_ENTRIES = ENTRIES.filter((entry) => OWN_ACCOUNT_IDS.has(entry.accountId)).map((entry) => ({
  entry,
  transaction: [CREDIT_DEPOSIT, RESERVE_WITHDRAWAL, SETTLE_WITHDRAWAL].find((tx) => tx.id === entry.transactionId)!,
}));

const ACCOUNT_BY_ID = new Map(
  ACCOUNTS.map((account) => [account.id, { id: account.id, code: account.code, bucket: account.bucket, asset: account.asset, ownerType: account.ownerType }]),
);

const WHOLE_BOOK: HistoryFilter = {
  from: new Date("2026-09-01T00:00:00.000Z"),
  to: new Date("2026-10-31T23:59:59.999Z"),
  asset: null,
  types: [],
  hash: null,
};

function overview(overrides: Partial<Parameters<typeof buildAccountOverview>[0]> = {}): AccountOverview {
  return buildAccountOverview({
    userId: "u1",
    now: new Date("2026-10-17T12:00:00.000Z"),
    accounts: ACCOUNTS,
    ownEntries: OWN_ENTRIES,
    siblings: ENTRIES,
    accountById: ACCOUNT_BY_ID,
    deposits: [],
    withdrawals: [],
    orders: [],
    marks: [],
    filter: WHOLE_BOOK,
    paperPerformance: buildAssistantPaperPerformance({
      assistantOrders: [],
      paperOrders: [],
      marks: [],
      now: new Date("2026-10-17T12:00:00.000Z"),
    }),
    ...overrides,
  });
}

function minorSum(rows: readonly { asset: string; amountMinor: string }[], asset: string): bigint {
  return rows
    .filter((row) => row.asset === asset)
    .reduce((total, row) => total + BigInt(row.amountMinor), BigInt(0));
}

// ── 1. the screen totals are the ledger sums ─────────────────────────────────

test("the balances are the entries added up, per account and per asset", () => {
  const built = overview();

  assert.deepEqual(
    built.balances.map((balance) => ({ asset: balance.asset, total: balance.total, available: balance.available, held: balance.held })),
    [{ asset: "USDT", total: "15", available: "15", held: "0" }],
  );
  // The provenance: the figure is the sum of two named accounts, and the hold is
  // reported as the account it was written to rather than as a column.
  const usdt = built.balances[0]!;
  assert.deepEqual(
    usdt.accounts.map((account) => [account.bucket, account.balance]),
    [["AVAILABLE", "15"], ["WITHDRAWALS_RESERVED", "0"]],
  );
});

test("the totals for the selected filter are the sum of the rows the filter shows", () => {
  const built = overview();
  const ledgerRows = built.history.filter((row) => row.category === "LEDGER");

  for (const total of built.totals) {
    assert.equal(total.netMinor, minorSum(ledgerRows, total.asset).toString(), `${total.asset} net`);
    assert.equal(BigInt(total.inMinor) - BigInt(total.outMinor), BigInt(total.netMinor), `${total.asset} in − out`);
  }
  assert.equal(built.totals[0]!.netMinor, "15000000");
});

test("a filtered view's totals follow the filter rather than the whole book", () => {
  const built = overview({
    filter: { ...WHOLE_BOOK, types: ["DEPOSIT_CREDITED"] as HistoryType[] },
  });

  assert.equal(built.history.length, 1);
  assert.equal(built.history[0]!.type, "DEPOSIT_CREDITED");
  assert.equal(built.totals[0]!.netMinor, "20000000");
  assert.equal(built.totals[0]!.lineCount, 1);
  // The statement's own closing figure is the whole book's, and it is carried beside
  // the filtered reduction so the two can be compared rather than trusted: the filter
  // shows one movement, the book closes at fifteen.
  assert.equal(built.totals[0]!.statementClosingMinor, "15000000");
});

test("the statement's closing figure and the derived balance are the same number", () => {
  const built = overview();
  const statementTotal = built.statementTotals.find((total) => total.asset === "USDT");
  assert.ok(statementTotal);

  // Opening plus net equals closing — the statement's own identity.
  assert.equal(
    BigInt(statementTotal.openingMinor) + BigInt(statementTotal.netMinor),
    BigInt(statementTotal.closingMinor),
  );
  // And that closing figure is the derived balance, from a different reduction
  // (`deriveBalances`) over the same rows.
  assert.equal(statementTotal.closingMinor, "15000000");
  assert.equal(built.totals[0]!.balanceMinor, statementTotal.closingMinor);
});

test("the period report's inflow and outflow are the ledger's own movements", () => {
  const built = overview();
  const usdt = built.summary.assets.find((asset) => asset.asset === "USDT");
  assert.ok(usdt);

  // One credited deposit in, one settlement out; the reservation and the release are
  // the same money moving inside the book and are not counted again.
  assert.equal(usdt.inflowMinor, "20000000");
  assert.equal(usdt.outflowMinor, "5000000");
  assert.equal(usdt.netMinor, "15000000");
  assert.equal(usdt.deposits, 1);
  assert.equal(usdt.withdrawals, 1);
});

// ── 2. the export reconciles by re-import ────────────────────────────────────

test("an export re-imported by the parser reconciles to the same totals", () => {
  const built = overview();
  const csv = overviewToCsv(built);
  const parsed = parseHistoryCsv(csv);

  assert.equal(parsed.rows, built.history.length);
  assert.deepEqual(
    parsed.summed,
    built.totals.map((total) => ({ asset: total.asset, netMinor: total.netMinor })),
    "the file's rows must add up to the screen's totals",
  );
  assert.deepEqual(
    parsed.totals,
    built.totals.map((total) => ({ asset: total.asset, netMinor: total.netMinor })),
    "the file's own TOTAL rows must carry the same figures",
  );

  // The JSON export carries the identical figure, so a script reading either file
  // reconciles against the same number.
  const json = JSON.parse(overviewToJson(built)) as { totals: { asset: string; netMinor: string }[] };
  assert.deepEqual(json.totals.map((total) => ({ asset: total.asset, netMinor: total.netMinor })), parsed.summed);

  // The assistant's paper block is a section of the same file, and the history parser
  // must not read it as history rows: the section starts with `#`, which is where the
  // parser stops. Without that, a paper result would be added to the ledger's totals.
  assert.match(csv, /# ASSISTANT PAPER PERFORMANCE/);
  assert.match(csv, /# ASSISTANT PAPER TOTAL/);
});

test("the assistant's paper block is in both exports and leaves the history reconciliation alone", () => {
  const paperOrders = [
    {
      id: "a-buy",
      venue: "dev-paper",
      market: "BTC-USD",
      side: "BUY" as const,
      status: "FILLED",
      requestedQuantity: "2",
      filledQuantity: "2",
      notionalUsdCents: 20_000,
      occurredAt: new Date("2026-10-10T09:00:00.000Z"),
      orderType: "MARKET",
      origin: "assistant" as const,
    },
    {
      id: "a-sell",
      venue: "dev-paper",
      market: "BTC-USD",
      side: "SELL" as const,
      status: "FILLED",
      requestedQuantity: "2",
      filledQuantity: "2",
      notionalUsdCents: 26_000,
      occurredAt: new Date("2026-10-11T09:00:00.000Z"),
      orderType: "MARKET",
      origin: "assistant" as const,
    },
  ];
  const paperPerformance = buildAssistantPaperPerformance({
    assistantOrders: paperOrders,
    paperOrders,
    marks: [],
    now: new Date("2026-10-17T12:00:00.000Z"),
  });
  const built = overview({ paperPerformance });
  const csv = overviewToCsv(built);

  // The block is its own section, and its figures are the ones the screen shows.
  assert.match(csv, /# ASSISTANT PAPER PERFORMANCE/);
  assert.match(csv, /a-sell/);
  assert.match(csv, /# ASSISTANT PAPER TOTAL/);
  // The history parser stops at the section marker, so the block cannot be summed as
  // history rows and the file still reconciles to the screen's totals.
  assert.equal(parseHistoryCsv(csv).rows, built.history.length);

  const json = JSON.parse(overviewToJson(built)) as {
    paperPerformance: { summary: { realisedUsd: string; orders: number; filledOrders: number } };
  };
  assert.equal(json.paperPerformance.summary.realisedUsd, "60");
  assert.equal(json.paperPerformance.summary.orders, 2);
  assert.equal(json.paperPerformance.summary.filledOrders, 2);
  assert.equal(json.paperPerformance.summary.realisedUsd, built.paperPerformance.summary.realisedUsd);
});

test("an entry that moved no money cannot read as an outflow, on screen or in the file", () => {
  const built = overview({
    deposits: [
      { id: "d-pending", network: "ethereum", asset: "USDT", decimals: 6, amount: "3", txHash: "0xpending", status: "PENDING", observedAt: new Date("2026-10-05T10:00:00.000Z"), creditedAt: null },
      { id: "d-credited", network: "ethereum", asset: "USDT", decimals: 6, amount: "20", txHash: "0xdeposithash", status: "CREDITED", observedAt: new Date("2026-10-02T10:00:00.000Z"), creditedAt: new Date("2026-10-02T10:05:00.000Z") },
    ],
    withdrawals: [
      { id: "w1", network: "ethereum", asset: "USDT", decimals: 6, amountMinor: "5000000", feeMinor: "500000", netMinor: "4500000", status: "CANCELLED", txHash: null, cancelTxHash: null, createdAt: new Date("2026-10-06T10:00:00.000Z"), confirmedAt: null, destinationDisplay: "0xabc" },
    ],
  });

  // The arrival and the attempt are both listed — the history is complete — and
  // neither carries a signed figure, so the totals are the ledger's alone.
  // Oldest first, and the arrival that a credit answers is listed beside the credit
  // itself: both halves of the same transfer, sharing its hash.
  const categories = built.history.map((row) => row.category);
  assert.deepEqual(categories, ["DEPOSIT", "LEDGER", "LEDGER", "LEDGER", "LEDGER", "DEPOSIT", "WITHDRAWAL"]);
  const evidence = built.history.filter((row) => row.category !== "LEDGER");
  assert.deepEqual(evidence.map((row) => row.amountMinor), ["0", "0", "0"]);
  assert.match(evidence[0]!.detail, /20 USDT arrival on ethereum · CREDITED/);
  assert.match(evidence[2]!.detail, /5 USDT → 0xabc on ethereum · CANCELLED · fee 0\.5/);

  const parsed = parseHistoryCsv(overviewToCsv(built));
  assert.deepEqual(parsed.summed, [{ asset: "USDT", netMinor: "15000000" }]);
});

test("the hash search finds both halves of a credited deposit", () => {
  const built = overview({
    deposits: [
      { id: "d-credited", network: "ethereum", asset: "USDT", decimals: 6, amount: "20", txHash: "0xDepositHash", status: "CREDITED", observedAt: new Date("2026-10-02T10:00:00.000Z"), creditedAt: new Date("2026-10-02T10:05:00.000Z") },
    ],
    filter: { ...WHOLE_BOOK, hash: "0xdeposit" },
  });

  assert.deepEqual(
    built.history.map((row) => row.category),
    ["DEPOSIT", "LEDGER"],
  );
  assert.deepEqual(
    built.history.map((row) => row.txHash?.toLowerCase()),
    ["0xdeposithash", "0xdeposithash"],
  );
});

// ── 3. positions, cost basis and the marks ───────────────────────────────────

const FILLS: FilledOrderLike[] = [
  { id: "o1", venue: "dev-paper", market: "BTC-USD", side: "BUY", status: "FILLED", requestedQuantity: "1", filledQuantity: "1", notionalUsdCents: 5_000_000, occurredAt: new Date("2026-10-05T10:00:00.000Z") },
  { id: "o2", venue: "dev-paper", market: "BTC-USD", side: "SELL", status: "FILLED", requestedQuantity: "0.5", filledQuantity: "0.5", notionalUsdCents: 3_000_000, occurredAt: new Date("2026-10-06T10:00:00.000Z") },
];

const MARK: MarkPrice = {
  market: "BTC-USD",
  price: "70000",
  source: "Coinbase public market data · https://api.exchange.coinbase.com",
  asOf: "2026-10-17T11:59:00.000Z",
  freshness: "FRESH",
};

test("a position is costed at the order's own stated price and marked at a named reading", () => {
  const built = overview({ orders: FILLS, marks: [MARK] });
  const position = built.positions[0]!;

  assert.equal(built.positions.length, 1);
  assert.equal(position.market, "BTC-USD");
  assert.equal(position.quantity, "0.5");
  assert.equal(position.averageCostUsd, "50000");
  assert.equal(position.costBasisUsd, "25000");
  assert.equal(position.realisedPnlUsd, "5000");
  assert.equal(position.markPriceUsd, "70000");
  assert.equal(position.marketValueUsd, "35000");
  assert.equal(position.unrealisedPnlUsd, "10000");
  assert.equal(position.markAsOf, MARK.asOf);
  assert.equal(position.markFreshness, "FRESH");
  assert.equal(built.pnl.realisedUsd, "5000");
  assert.equal(built.pnl.unrealisedUsd, "10000");
  assert.equal(built.pnl.netUsd, "15000");
  assert.equal(built.summary.trading.realisedUsd, "5000");
  assert.equal(built.summary.trading.filledOrders, 2);
});

test("a market with no mark reports an absent figure rather than an estimate", () => {
  const built = overview({ orders: FILLS, marks: [] });
  const position = built.positions[0]!;

  assert.equal(position.markPriceUsd, null);
  assert.equal(position.marketValueUsd, null);
  assert.equal(position.unrealisedPnlUsd, null);
  assert.match(position.note ?? "", /absent rather than estimated/);
  // The realised figure is a fact about fills that happened, so it survives an
  // unreadable price feed; the unrealised one does not, and the summary says so.
  assert.equal(position.realisedPnlUsd, "5000");
  assert.equal(built.pnl.realisedUsd, "5000");
  assert.equal(built.pnl.unrealisedUsd, null);
  assert.equal(built.pnl.netUsd, null);
  assert.deepEqual(built.pnl.unpricedMarkets, ["BTC-USD"]);
});

// ── 4. a read-only key cannot trade, and an external balance stays external ──

test("a read-only key is refused for trading by name, and an absent one is absent", () => {
  const refused = decideCredentialUse({ id: "c1", venue: "binance", label: "Binance read", readOnly: true });
  assert.equal(refused.kind, "refused");
  if (refused.kind !== "refused") return;
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "READ_ONLY_CREDENTIAL");
  assert.match(refused.body.error, /"Binance read" is stored as read-only, so it cannot be used to place an order/);
  assert.match(refused.body.error, /connect a key created for trading/);

  const missing = decideCredentialUse(null);
  assert.equal(missing.kind, "refused");
  if (missing.kind !== "refused") return;
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, undefined);

  const allowed = decideCredentialUse({ id: "c2", venue: "kraken", label: "Kraken trade", readOnly: false });
  assert.equal(allowed.kind, "allowed");
});

function credential(overrides: Partial<ExternalCredential> = {}): ExternalCredential {
  return {
    id: "c1",
    venue: "binance",
    label: "Binance read",
    readOnly: true,
    ciphertext: "ciphertext",
    iv: "iv",
    authTag: "tag",
    ...overrides,
  };
}

/** The decryptor these tests use: the ciphertext is never opened, only passed through. */
const PASSTHROUGH_DECRYPT = (() => ({
  apiKey: "test-key",
  apiSecret: "test-secret",
  readOnly: true,
})) as unknown as NonNullable<ExternalImportDeps["decrypt"]>;

test("the import path reads read-labelled keys, skips trade-capable ones by name", async () => {
  const imported = await importExternalHoldings({
    credentials: [credential(), credential({ id: "c2", venue: "kraken", label: "Kraken trade", readOnly: false })],
    deps: {
      decrypt: PASSTHROUGH_DECRYPT,
      readBalances: async () => [{ asset: "BTC", available: "0.1", total: "0.2" }],
    },
  });

  assert.equal(imported.spendable, false);
  assert.equal(imported.sources.length, 1);
  assert.equal(imported.sources[0]!.status, "imported");
  assert.deepEqual(imported.sources[0]!.balances, [{ asset: "BTC", available: "0.1", total: "0.2" }]);
  assert.equal(imported.skipped.length, 1);
  assert.equal(imported.skipped[0]!.credentialId, "c2");
  assert.match(imported.skipped[0]!.reason, /stored as trade-capable, and the import path uses read-labelled keys only/);
});

test("an imported balance never appears in the platform's balances", async () => {
  const built = overview();
  const imported = await importExternalHoldings({
    credentials: [credential()],
    deps: {
      decrypt: PASSTHROUGH_DECRYPT,
      readBalances: async () => [{ asset: "BTC", available: "0.1", total: "0.2" }],
    },
  });

  // The platform's balances are the ledger's, and the ledger has no BTC account.
  assert.deepEqual(built.balances.map((balance) => balance.asset), ["USDT"]);
  // The import's own shape carries no field a spendable figure could be assigned to,
  // and it says so in the type as well as here.
  assert.equal(imported.spendable, false);
  assert.equal(Object.hasOwn(imported, "balances"), false);
  assert.deepEqual(
    imported.sources.flatMap((source) => source.balances.map((balance) => balance.asset)),
    ["BTC"],
  );
});

test("an unreadable venue is reported as unread, not as a zero balance", async () => {
  const imported = await importExternalHoldings({
    credentials: [credential()],
    deps: {
      decrypt: PASSTHROUGH_DECRYPT,
      readBalances: async () => {
        throw new Error("The venue refused the read.");
      },
    },
  });

  assert.equal(imported.sources[0]!.status, "failed");
  assert.deepEqual(imported.sources[0]!.balances, []);
  assert.equal(imported.sources[0]!.reason, "The venue refused the read.");
  assert.match(imported.sources[0]!.note, /reported as unread, not as a zero balance/);
});

test("a WunderTrading read-only key is carried through as its own payload, not as a balance", async () => {
  const note = "Read from WunderTrading's strategy:read endpoints. Its payload is not interpreted.";
  const imported = await importExternalHoldings({
    credentials: [credential({ venue: "wundertrading", label: "WT read" })],
    deps: {
      decrypt: PASSTHROUGH_DECRYPT,
      readWundertrading: async () => ({
        endpoints: ["/open_api/strategies/live", "/open_api/strategies/history"],
        live: { items: [] },
        history: { items: [] },
        note,
      }),
    },
  });

  assert.equal(imported.sources[0]!.status, "imported");
  // No balance and no trade is invented from a payload whose fields this build has
  // not been shown; the payload travels as it arrived, under the endpoints that
  // produced it, with the venue layer's own sentence for the reader.
  assert.deepEqual(imported.sources[0]!.balances, []);
  assert.deepEqual(imported.sources[0]!.trades, []);
  assert.equal(imported.sources[0]!.note, note);
  assert.deepEqual(imported.sources[0]!.raw, {
    endpoints: ["/open_api/strategies/live", "/open_api/strategies/history"],
    live: { items: [] },
    history: { items: [] },
  });
});

test("the WunderTrading read-only import calls the two read endpoints and says it is uninterpreted", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return new Response(JSON.stringify({ items: [{ id: "strategy-1" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const imported = await importWunderTradingReadOnly({ apiKey: "test-key", apiSecret: "test-secret" });
    assert.deepEqual(imported.endpoints, ["/open_api/strategies/live", "/open_api/strategies/history"]);
    assert.deepEqual(imported.live, { items: [{ id: "strategy-1" }] });
    assert.deepEqual(imported.history, { items: [{ id: "strategy-1" }] });
    assert.deepEqual(requested, [
      "https://wundertrading.com/open_api/strategies/live?page=1&limit=100",
      "https://wundertrading.com/open_api/strategies/history?page=1&limit=100",
    ]);
    assert.match(imported.note, /not interpreted/);
    assert.match(imported.note, /strategy:read endpoints/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── the filter's own refusals ────────────────────────────────────────────────

test("a filter that cannot be read is refused by name", async () => {
  const { parseHistoryFilter } = await import("@/lib/portfolio/pnl");
  const now = new Date("2026-10-17T12:00:00.000Z");

  const backwards = parseHistoryFilter({ from: "2026-10-17", to: "2026-10-01", asset: null, type: null, hash: null }, now);
  assert.equal(backwards.valid, false);
  if (backwards.valid) return;
  assert.match(backwards.error, /is after its end/);

  const unknownType = parseHistoryFilter({ from: null, to: null, asset: null, type: "DEPOSIT,WHATEVER", hash: null }, now);
  assert.equal(unknownType.valid, false);
  if (unknownType.valid) return;
  assert.match(unknownType.error, /Unknown history type: WHATEVER/);

  const shortHash = parseHistoryFilter({ from: null, to: null, asset: null, type: null, hash: "0xab" }, now);
  assert.equal(shortHash.valid, false);

  const ok = parseHistoryFilter({ from: "2026-10-17", to: "2026-10-17", asset: "usdt", type: "DEPOSIT", hash: "0xABCDEF" }, now);
  assert.equal(ok.valid, true);
  if (!ok.valid) return;
  // A date with no time covers the whole day it names, so "filter to today" includes
  // everything that happened today.
  assert.equal(ok.filter.from.toISOString(), "2026-10-17T00:00:00.000Z");
  assert.equal(ok.filter.to.toISOString(), "2026-10-17T23:59:59.999Z");
  assert.equal(ok.filter.asset, "USDT");
  assert.equal(ok.filter.hash, "0xabcdef");
  assert.deepEqual(ok.filter.types, ["DEPOSIT"]);
});
