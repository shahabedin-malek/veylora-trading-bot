import assert from "node:assert/strict";
import test from "node:test";
import {
  creditDeposit,
  depositAmountMinor,
  depositCreditIdempotencyKey,
  depositReversalIdempotencyKey,
  reverseDepositForUser,
} from "@/lib/deposits/credit";
import { readDepositPolicy, type DepositNetworkPolicy } from "@/lib/deposits/policy";
import type { NewDepositRow } from "@/lib/deposits/store";
import { checkLedgerInvariants } from "@/lib/ledger/invariants";
import { readLedgerView } from "@/lib/ledger/statements";
import { InMemoryDepositStore } from "./support/in-memory-deposit-store";

/**
 * The seam between phase 12 and phase 13: what a credited deposit *posts*.
 *
 * Phase 12 owns the arrival — reading the chain, waiting for confirmations,
 * claiming the row. Phase 13 owns the book. These tests are about the join, and
 * the claims they make are the ones a reader should be able to check:
 *
 *  1. A credit becomes one balanced movement (treasury debited, the account
 *     credited) *in the same transaction as the claim*, so a credited deposit
 *     always has a movement that explains it.
 *  2. Replaying the credit posts nothing twice — the idempotency key is the
 *     deposit's own.
 *  3. A transfer whose two amounts disagree is refused on the row, not credited,
 *     and does not stop the transfers behind it.
 *  4. A reversal is a compensating movement that references the original, and the
 *     balance returns to zero with both movements still visible.
 *
 * The chain is not stubbed here: the arrival is written straight into the store in
 * the shape the watcher writes it, because `deposits-watcher.test.ts` already
 * covers the read from chain to row. What is under test is what the row becomes.
 */

const MNEMONIC = "test test test test test test test test test test test junk";
const USDT_MAINNET = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const USER_ID = "user-1";
const NOW = new Date("2026-10-16T12:00:00.000Z");
const RPC_ENV = { NODE_ENV: "test", ALCHEMY_ETHEREUM_MAINNET_RPC_URL: "https://eth-mainnet.g.alchemy.com/v2/test-key" } as NodeJS.ProcessEnv;

function policyFor(env: Record<string, string> = {}) {
  return readDepositPolicy({
    DEPOSIT_ADDRESS_MNEMONIC: MNEMONIC,
    DEPOSIT_ENABLED_NETWORKS: "ethereum-mainnet",
    DEPOSIT_CONFIRMATIONS_ETHEREUM_MAINNET: "2",
    ...RPC_ENV,
    ...env,
  });
}

function networkOf(policy: ReturnType<typeof policyFor>): DepositNetworkPolicy {
  const network = policy.networks.find((candidate) => candidate.slug === "ethereum-mainnet");
  assert.ok(network, "ethereum-mainnet must be in the policy");
  return network!;
}

/** A pending transfer, exactly as the watcher records one. */
function pendingRow(overrides: Partial<NewDepositRow> = {}): NewDepositRow {
  return {
    userId: USER_ID,
    depositAddressId: "address-1",
    network: "ethereum-mainnet",
    chainId: 1,
    tokenSymbol: "USDT",
    tokenAddress: USDT_MAINNET,
    decimals: 6,
    amount: "10.5",
    rawAmount: "10500000",
    txHash: "0xtransfer1",
    logIndex: 0,
    blockNumber: 99,
    blockHash: "0xblock99",
    status: "PENDING",
    reasonCode: null,
    reasonMessage: null,
    evidenceJson: "{}",
    origin: "WATCHER",
    observedAt: NOW,
    creditedAt: null,
    lastCheckedAt: null,
    revertedAt: null,
    ...overrides,
  };
}

function auditPayloadFor(store: InMemoryDepositStore, action: string) {
  return store.auditsFor(action)[0]?.payload ?? {};
}

test("a deposit becomes a balanced movement when it reaches the confirmation depth, and not before", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor();
  const network = networkOf(policy);
  const inserted = await store.insertDepositOnce(pendingRow());
  const row = inserted.row;

  // One confirmation short: not money, and nothing posted.
  const early = await creditDeposit({ store, policy: network, row, confirmations: 1, now: NOW });
  assert.deepEqual({ credited: early.credited, refused: early.refusal, posted: store.ledgerRows.transactions.length }, { credited: false, refused: null, posted: 0 });
  assert.equal(store.deposits[0]?.status, "PENDING");

  const credited = await creditDeposit({ store, policy: network, row, confirmations: 2, now: NOW });
  assert.equal(credited.credited, true);
  assert.equal(credited.refusal, null);
  assert.equal(store.deposits[0]?.status, "CREDITED");

  // One movement, two legs, and the accounts the credit needed were issued with it.
  assert.equal(store.ledgerRows.transactions.length, 1);
  assert.equal(store.ledgerRows.entries.length, 2);
  assert.equal(store.ledgerRows.transactions[0]?.idempotencyKey, depositCreditIdempotencyKey(row.id));
  const legs = store.ledgerRows.entries.map((entry) => {
    const account = store.ledgerRows.accounts.find((candidate) => candidate.id === entry.accountId);
    return [account?.code, entry.direction, entry.amountMinor, entry.asset, entry.decimals];
  });
  assert.deepEqual(legs, [
    ["platform:treasury:USDT", "DEBIT", "10500000", "USDT", 6],
    [`user:${USER_ID}:USDT:available`, "CREDIT", "10500000", "USDT", 6],
  ]);

  // The audit trail ties the credit to the movement it became.
  assert.equal(auditPayloadFor(store, "DEPOSIT_CREDITED").ledgerTransactionId, store.ledgerRows.transactions[0]?.id);
  assert.equal(auditPayloadFor(store, "DEPOSIT_CREDITED").amountMinor, "10500000");

  // The book the credit wrote is sound, and the balance is the amount credited.
  const report = await checkLedgerInvariants(store.ledgerRows, { now: NOW });
  assert.equal(report.ok, true);
  const view = await readLedgerView(store.ledgerRows, { userId: USER_ID, from: new Date("2026-10-01T00:00:00.000Z"), to: NOW });
  assert.equal(view.balances.find((balance) => balance.asset === "USDT")?.decimal, "10.5");
  assert.equal(view.platform.find((balance) => balance.bucket === "TREASURY")?.decimal, "10.5");
  assert.equal(view.statement.lines[0]?.counterpartyCode, "platform:treasury:USDT");
});

test("crediting the same deposit twice posts one movement", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor();
  const network = networkOf(policy);
  const row = (await store.insertDepositOnce(pendingRow())).row;

  const first = await creditDeposit({ store, policy: network, row, confirmations: 5, now: NOW });
  const second = await creditDeposit({ store, policy: network, row, confirmations: 5, now: NOW });

  assert.equal(first.credited, true);
  // The claim is the gate: the row is already out of PENDING, so the second run
  // finds nothing to claim and posts nothing.
  assert.equal(second.credited, false);
  assert.equal(store.ledgerRows.transactions.length, 1);
  assert.equal(store.ledgerRows.entries.length, 2);
  assert.equal(store.auditsFor("DEPOSIT_CREDITED").length, 1);
  const report = await checkLedgerInvariants(store.ledgerRows, { now: NOW });
  assert.equal(report.ok, true);
});

test("a transfer whose two amounts disagree is refused on the row, and the transfer behind it still credits", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor();
  const network = networkOf(policy);

  // 10.5 USDT at 6 decimals is 10500000, not 10500001.
  const broken = (await store.insertDepositOnce(pendingRow({ rawAmount: "10500001" }))).row;
  const refused = await creditDeposit({ store, policy: network, row: broken, confirmations: 2, now: NOW });
  assert.equal(refused.credited, false);
  assert.equal(refused.refusal?.code, "LEDGER_POSTING_REFUSED");
  assert.match(refused.refusal?.message ?? "", /10500000 minor units of USDT, and its raw amount is 10500001/);

  // Nothing was credited, nothing was posted, and the row says why it was not.
  const stored = store.deposits.find((deposit) => deposit.id === broken.id)!;
  assert.equal(stored.status, "PENDING");
  assert.equal(stored.reasonCode, "LEDGER_POSTING_REFUSED");
  assert.equal(store.ledgerRows.transactions.length, 0);
  const refusalAudit = store.auditsFor("DEPOSIT_CREDIT_REFUSED");
  assert.equal(refusalAudit.length, 1);
  // Written as a refusal, because no money moved.
  assert.equal(refusalAudit[0]?.outcome, "REFUSED");
  assert.equal(refusalAudit[0]?.objectId, broken.id);

  // The refusal is per row: the next transfer credits normally, which is what
  // keeps one corrupt row from stopping money behind it.
  const good = (await store.insertDepositOnce(pendingRow({ txHash: "0xtransfer2", logIndex: 1 }))).row;
  const credited = await creditDeposit({ store, policy: network, row: good, confirmations: 2, now: NOW });
  assert.equal(credited.credited, true);
  assert.equal(store.ledgerRows.transactions.length, 1);
  assert.equal((await checkLedgerInvariants(store.ledgerRows)).ok, true);
});

test("an amount that cannot be read exactly is named as such, both above and inside the writer", async () => {
  // A seventh decimal place does not exist in a 6-decimal token, and the refusal
  // says which value and why rather than rounding it.
  assert.throws(
    () => depositAmountMinor({ amount: "10.0000001", rawAmount: "100000001", decimals: 6, tokenSymbol: "USDT" }),
    /cannot be read as an exact amount of USDT at 6 decimals \(NOT_INTEGER\)/,
  );
  // The consistency check is not a formality: it agrees only when both fields
  // describe the same integer.
  assert.equal(depositAmountMinor({ amount: "10.5", rawAmount: "10500000", decimals: 6, tokenSymbol: "USDT" }), "10500000");
  assert.equal(depositAmountMinor({ amount: "1", rawAmount: "1", decimals: 0, tokenSymbol: "ETH" }), "1");
});

test("a deposit that was never attributed to an account is not credited to one", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor();
  const network = networkOf(policy);
  const row = (await store.insertDepositOnce(pendingRow({ userId: null, depositAddressId: null, status: "UNMATCHED" }))).row;

  const outcome = await creditDeposit({ store, policy: network, row, confirmations: 9, now: NOW });
  assert.equal(outcome.credited, false);
  assert.equal(outcome.refusal?.code, "UNKNOWN_RECIPIENT");
  assert.equal(store.ledgerRows.transactions.length, 0);
});

test("reversing a deposit compensates it: the balance returns to zero with both movements still on the statement", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor();
  const network = networkOf(policy);
  const row = (await store.insertDepositOnce(pendingRow())).row;
  await creditDeposit({ store, policy: network, row, confirmations: 2, now: NOW });

  const reversed = await reverseDepositForUser({
    userId: USER_ID,
    depositId: row.id,
    store,
    now: new Date("2026-10-16T13:00:00.000Z"),
    memo: "the transfer was corrected on chain",
  });
  assert.equal(reversed.reversed, true);
  assert.ok(reversed.transactionId);

  const reversal = store.ledgerRows.transactions.find((transaction) => transaction.id === reversed.transactionId);
  assert.equal(reversal?.kind, "DEPOSIT_REVERSED");
  assert.equal(reversal?.idempotencyKey, depositReversalIdempotencyKey(row.id));
  assert.equal(reversal?.reversesTransactionId, store.ledgerRows.transactions[0]?.id);
  // Nothing was edited: four legs, two transactions, and the pair sums to zero.
  assert.equal(store.ledgerRows.entries.length, 4);
  const view = await readLedgerView(store.ledgerRows, { userId: USER_ID, from: new Date("2026-10-01T00:00:00.000Z"), to: new Date("2026-10-16T23:59:59.999Z") });
  assert.equal(view.balances.find((balance) => balance.asset === "USDT")?.decimal, "0");
  assert.equal(view.platform.find((balance) => balance.bucket === "TREASURY")?.decimal, "0");
  assert.deepEqual(
    view.statement.lines.map((line) => [line.kind, line.direction, line.amountMinor]),
    [
      ["DEPOSIT_CREDITED", "CREDIT", "10500000"],
      ["DEPOSIT_REVERSED", "DEBIT", "10500000"],
    ],
  );
  assert.equal(view.statement.totals[0]?.netMinor, "0");
  assert.equal(view.statement.totals[0]?.openingMinor, "0");
  assert.equal(view.statement.totals[0]?.closingMinor, "0");
  // And the book is still sound after the compensation.
  assert.equal((await checkLedgerInvariants(store.ledgerRows, { now: NOW })).ok, true);
  assert.equal(store.auditsFor("DEPOSIT_REVERSED").length, 1);
  assert.equal(auditPayloadFor(store, "DEPOSIT_REVERSED").reversesTransactionKey, depositCreditIdempotencyKey(row.id));
});

test("a reversal is refused when there is nothing to reverse, when it already happened, and when the deposit is not yours", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor();
  const network = networkOf(policy);
  const creditedRow = (await store.insertDepositOnce(pendingRow())).row;
  await creditDeposit({ store, policy: network, row: creditedRow, confirmations: 2, now: NOW });

  // Twice is once too many: the second reversal would compensate a compensation
  // and mint a negative balance out of a bookkeeping mistake.
  const first = await reverseDepositForUser({ userId: USER_ID, depositId: creditedRow.id, store, now: NOW });
  const second = await reverseDepositForUser({ userId: USER_ID, depositId: creditedRow.id, store, now: NOW });
  assert.equal(first.reversed, true);
  assert.equal(second.reversed, false);
  assert.equal(second.reason?.code, "ALREADY_COMPLETED");
  assert.equal(store.ledgerRows.transactions.length, 2);
  assert.equal(store.auditsFor("DEPOSIT_REVERSAL_REFUSED").length, 1);

  // A deposit that never reached a credit has nothing to compensate.
  const neverCredited = (await store.insertDepositOnce(pendingRow({ txHash: "0xtransfer2", logIndex: 1 }))).row;
  const nothingToDo = await reverseDepositForUser({ userId: USER_ID, depositId: neverCredited.id, store, now: NOW });
  assert.equal(nothingToDo.reversed, false);
  assert.equal(nothingToDo.reason?.code, "NO_ENTRY_CONDITION");
  assert.match(nothingToDo.reason?.message ?? "", /was never credited/);

  // And the id in a request is not an authorization: another account cannot see
  // this deposit, so it cannot reverse it.
  const stranger = await reverseDepositForUser({ userId: "user-2", depositId: creditedRow.id, store, now: NOW });
  assert.equal(stranger.reversed, false);
  assert.equal(stranger.deposit, null);
  assert.equal(stranger.reason?.code, "NOT_PERMITTED");
  // Two movements: the credit and its one reversal. The refusals wrote none.
  assert.equal(store.ledgerRows.transactions.length, 2);
});
