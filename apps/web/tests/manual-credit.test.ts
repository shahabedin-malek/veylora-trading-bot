import assert from "node:assert/strict";
import test from "node:test";
import { creditDepositAtValuation, parseValuation } from "@/lib/deposits/manual-credit";
import type { NewDepositRow } from "@/lib/deposits/store";
import { availableBalanceMinor } from "@/lib/ledger/withdrawals";
import { InMemoryDepositStore } from "./support/in-memory-deposit-store";

/**
 * The any-token credit: an arrival the network does not configure is money, but the
 * code cannot prove what it is worth. These tests hold the three rules: the owner's
 * figure is exact, the credit is a claim that cannot run twice, and the ledger
 * movement and the audit event are one transaction.
 */

const NOW = new Date("2026-10-22T12:00:00Z");
const USER_ID = "user-1";

function arrival(overrides: Partial<NewDepositRow> = {}): NewDepositRow {
  return {
    userId: USER_ID,
    depositAddressId: "address-1",
    network: "bnb-mainnet",
    chainId: 56,
    tokenSymbol: "CAKE",
    tokenAddress: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
    decimals: 18,
    amount: "2.5",
    rawAmount: "2500000000000000000",
    txHash: "0xmanual-credit",
    logIndex: 0,
    blockNumber: 41_000_000,
    blockHash: "0xblock",
    status: "AWAITING_VALUATION",
    reasonCode: "TOKEN_AWAITING_VALUATION",
    reasonMessage: "The token CAKE is not the token this deployment configures on BNB Smart Chain.",
    evidenceJson: "{}",
    origin: "WATCHER",
    observedAt: NOW,
    creditedAt: null,
    lastCheckedAt: NOW,
    revertedAt: null,
    ...overrides,
  };
}

test("a valuation is an exact USDT amount above zero", () => {
  assert.deepEqual(parseValuation("12.5"), { ok: true, minor: "12500000", display: "12.5" });
  assert.equal(parseValuation("12.123456").ok, true);
  assert.equal(parseValuation("0").ok, false);
  assert.equal(parseValuation("0.0000001").ok, false, "more precision than USDT has is refused, not rounded");
  assert.equal(parseValuation("-1").ok, false);
  assert.equal(parseValuation("").ok, false);
});

test("an arrival in another token is credited in USDT at the owner's figure, once", async () => {
  const store = new InMemoryDepositStore();
  const inserted = await store.insertDepositOnce(arrival());

  const outcome = await creditDepositAtValuation({
    store,
    depositId: inserted.row.id,
    usdAmount: "12.50",
    actorUserId: "admin-1",
    now: NOW,
  });

  assert.equal(outcome.credited, true);
  assert.equal(
    await availableBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }),
    BigInt(12_500_000),
    "the account holds the USDT value the owner named",
  );
  assert.equal(await availableBalanceMinor(store.ledger(), { userId: USER_ID, asset: "CAKE" }), BigInt(0), "no balance is invented in the token itself");

  const row = await store.findDepositById(inserted.row.id);
  assert.equal(row?.status, "CREDITED");
  assert.equal(row?.tokenSymbol, "CAKE", "the original asset is still on the row");

  const audits = store.auditsFor("DEPOSIT_CREDITED_MANUALLY");
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.payload.valuation, "12.5");
  assert.equal(audits[0]!.payload.tokenSymbol, "CAKE");
  assert.equal(audits[0]!.payload.creditedAt, NOW.toISOString());

  const replay = await creditDepositAtValuation({
    store,
    depositId: inserted.row.id,
    usdAmount: "99",
    actorUserId: "admin-1",
    now: NOW,
  });
  assert.equal(replay.credited, false, "the same arrival cannot be credited twice");
  assert.equal(
    await availableBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }),
    BigInt(12_500_000),
    "the second attempt moves nothing",
  );
});

test("an arrival that is not attributed to an account is refused rather than credited to nobody", async () => {
  const store = new InMemoryDepositStore();
  const inserted = await store.insertDepositOnce(arrival({ userId: null, status: "UNMATCHED" }));

  const outcome = await creditDepositAtValuation({
    store,
    depositId: inserted.row.id,
    usdAmount: "5",
    actorUserId: "admin-1",
    now: NOW,
  });

  assert.equal(outcome.credited, false);
  assert.match(outcome.credited === false ? outcome.error : "", /not attributed|nothing to value/i);
  assert.equal(await availableBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(0));
});
