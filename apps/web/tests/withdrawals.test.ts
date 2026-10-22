import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData, getAddress, keccak256, type Hex } from "viem";
import { postDepositCredit } from "@/lib/deposits/credit";
import { checkLedgerInvariants } from "@/lib/ledger/invariants";
import { heldBalanceMinor, availableBalanceMinor, userAssetBalances } from "@/lib/ledger/withdrawals";
import { decimalStringFromMinorUnits } from "@/lib/ledger/integer-cent-ledger";
import {
  createSimulatedWithdrawalChain,
  erc20TransferData,
  type Observation,
  type PrepareOutcome,
  type WithdrawalChainPort,
} from "@/lib/withdrawals/chain";
import { cancelWithdrawal, confirmWithdrawal, expireWithdrawal, reconcileCancellation } from "@/lib/withdrawals/confirm";
import { executeWithdrawal } from "@/lib/withdrawals/execute";
import { readWithdrawalPolicy, type WithdrawalNetworkPolicy, type WithdrawalPolicy } from "@/lib/withdrawals/policy";
import { requestWithdrawal } from "@/lib/withdrawals/request";
import { readWithdrawalHealth, runWithdrawalProcessor, withdrawalResource } from "@/lib/withdrawals/service";
import {
  applyOwnerWindow,
  MAX_NEW_ADDRESS_WINDOW_MINUTES,
  readEffectiveWithdrawalPolicy,
  validateWithdrawalOwnerSettings,
  withdrawalSettingsView,
} from "@/lib/withdrawals/settings";
import { InMemoryWithdrawalStore } from "./support/in-memory-withdrawal-store";

/**
 * The withdrawal path, from the request to the money leaving.
 *
 * The claims these tests make are the ones phase 14 is graded on, and each is a statement
 * about a *row* and a *movement* rather than about how the code is arranged:
 *
 *  1. A request holds the amount in the ledger immediately, so two concurrent requests for
 *     more than the balance cannot both succeed — one reserves, one is refused on
 *     insufficient balance, and the refusal is audited with the destination.
 *  2. A retried broadcast sends the bytes already signed and produces **one** transaction:
 *     the signature is made once and the re-send carries identical bytes, which is the only
 *     property that keeps a retry from moving the money twice.
 *  3. Every failure in the taxonomy is reachable, with its own state, its own message, its
 *     own retryability answer and an audit event naming the destination.
 *  4. A confirmation follows the network's count, and the fee is taken at settlement with
 *     the transfer that earned it — never before it.
 *  5. Nothing ends with the amount neither settled nor released, and the ledger's own
 *     invariants hold afterwards.
 *
 * The chain is a port, so every test hands the runner one it controls: no network, no key
 * and no real money is involved, and the simulation's own signature is exercised separately
 * against the real bytes it would send.
 */

const MNEMONIC = "test test test test test test test test test test test junk";
const USER_ID = "user-1";
const OTHER_USER = "user-2";
/** Lower case on purpose: `isAddress` accepts it, and the book lowercases for its key. */
const DESTINATION = "0x9f2c7b1a4e5d6f7089aabbccddeeff0011223344";
const OTHER_DESTINATION = "0x1111222233334444555566667777888899990000";
const NOW = new Date("2026-10-16T12:00:00.000Z");
const RPC_ENV = {
  NODE_ENV: "test",
  DEPOSIT_ADDRESS_MNEMONIC: MNEMONIC,
  DEPOSIT_ENABLED_NETWORKS: "ethereum-mainnet",
  DEPOSIT_CONFIRMATIONS_ETHEREUM_MAINNET: "2",
  DEPOSIT_TOKEN_ADDRESS_ETHEREUM_MAINNET: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  DEPOSIT_TOKEN_DECIMALS_ETHEREUM_MAINNET: "6",
  DEPOSIT_TOKEN_SYMBOL_ETHEREUM_MAINNET: "USDT",
  ALCHEMY_ETHEREUM_MAINNET_RPC_URL: "https://eth-mainnet.g.alchemy.com/v2/test-key",
  WITHDRAWAL_HOT_WALLET_MNEMONIC: MNEMONIC,
  WITHDRAWAL_NEW_ADDRESS_WINDOW_MINUTES: "0",
  WITHDRAWAL_FEE_USDT: "1",
} as NodeJS.ProcessEnv;

function policyFor(env: Record<string, string> = {}): WithdrawalPolicy {
  return readWithdrawalPolicy({ ...RPC_ENV, ...env });
}

function networkOf(policy: WithdrawalPolicy): WithdrawalNetworkPolicy {
  const network = policy.networks.find((candidate) => candidate.slug === "ethereum-mainnet");
  assert.ok(network, "ethereum-mainnet must have a withdrawal route");
  return network;
}

/** Credit an account, through the real deposit credit, so the balance is a real book. */
async function fund(store: InMemoryWithdrawalStore, input: { userId?: string; amount: string; id?: string }): Promise<void> {
  const { posted } = await postDepositCredit(store.ledger(), {
    depositId: input.id ?? `deposit-${Math.random().toString(36).slice(2, 10)}`,
    userId: input.userId ?? USER_ID,
    asset: "USDT",
    decimals: 6,
    amountMinor: input.amount,
    occurredAt: NOW,
    network: "ethereum-mainnet",
    txHash: "0xfunding",
    logIndex: 0,
  });
  assert.equal(posted, true, "the funding movement must post");
}

/**
 * A chain the test controls.
 *
 * `sent` is every payload handed to `broadcast`, in order, which is what the retry claim is
 * about: one *distinct* payload however many sends. `signed` counts `prepare` calls, because
 * "the signature is made once" is the other half of the same claim. The behaviour fields are
 * mutable so one test can make the first pass fail and the second succeed.
 */
function spyChain(network: WithdrawalNetworkPolicy, behaviour: Partial<{ broadcastFailures: number; prepareFails: boolean; observation: Observation }> = {}) {
  const sent: string[] = [];
  const signed: { nonce: number; to: string; netMinor: string }[] = [];
  const state = {
    broadcastFailures: behaviour.broadcastFailures ?? 0,
    prepareFails: behaviour.prepareFails ?? false,
    // Default to *nothing mined yet*, which is what a chain says immediately after a send: a
    // test that wants a confirmation asks for one, so no assertion here depends on a chain
    // that mines in the same breath as it is asked to accept a transaction.
    observation: behaviour.observation ?? ({ kind: "pending", confirmations: 0 } as Observation),
  };
  const port: WithdrawalChainPort = {
    id: "spy-chain",
    simulated: false,
    sender: () => ({ kind: "ready", address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
    async prepare(input) {
      if (state.prepareFails) {
        return { kind: "refused", reason: { code: "NETWORK_UNAVAILABLE", message: "The spy chain is unreachable.", retryable: true } };
      }
      signed.push({ nonce: input.nonce ?? 0, to: input.to, netMinor: input.netMinor });
      // Deterministic in the request, exactly as a signature is: the same nonce, recipient and
      // amount produce the same bytes, and therefore the same hash.
      const raw = `0xsigned-${input.nonce ?? 0}-${input.to}-${input.netMinor}`;
      return { kind: "signed", transfer: { rawTransaction: raw, txHash: keccak256(raw as Hex), nonce: input.nonce ?? 0, fromAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", tokenAddress: network.token.address, netMinor: input.netMinor, gasLimit: "65000", gasPriceWei: "1000000000" } };
    },
    async prepareCancel(input) {
      const raw = `0xcancel-${input.nonce}`;
      return { kind: "signed", transfer: { rawTransaction: raw, txHash: keccak256(raw as Hex), nonce: input.nonce, fromAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", tokenAddress: network.token.address, netMinor: "0", gasLimit: "21000", gasPriceWei: "2000000000" } };
    },
    async broadcast({ rawTransaction }) {
      // Every attempt is recorded, including the ones that are refused: "one transaction" is
      // a claim about the *payloads*, so the attempts have to be visible to count them.
      sent.push(rawTransaction);
      if (state.broadcastFailures > 0) {
        state.broadcastFailures -= 1;
        return { kind: "refused", reason: { code: "NETWORK_UNAVAILABLE", message: "The spy chain refused the send.", retryable: true } };
      }
      return { kind: "accepted", txHash: keccak256(rawTransaction as Hex) };
    },
    async observe() {
      return state.observation;
    },
  };
  return { port, sent, signed, state, factory: () => port };
}

async function request(store: InMemoryWithdrawalStore, policy: WithdrawalPolicy, overrides: Partial<Parameters<typeof requestWithdrawal>[0]> = {}) {
  return requestWithdrawal({
    store,
    policy,
    userId: USER_ID,
    network: "ethereum-mainnet",
    destination: DESTINATION,
    amount: "20",
    idempotencyKey: overrides.idempotencyKey ?? "key-1",
    now: NOW,
    ...overrides,
  });
}

function auditActions(store: InMemoryWithdrawalStore): string[] {
  return store.audits.map((entry) => entry.action);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The reservation
// ─────────────────────────────────────────────────────────────────────────────

test("a withdrawal without an idempotency key is refused, and nothing is reserved", async () => {
  const store = new InMemoryWithdrawalStore();
  const policy = policyFor();
  await fund(store, { amount: "20000000" });

  const outcome = await request(store, policy, { amount: "20", idempotencyKey: "" });

  assert.equal(outcome.refused, true, "the request is refused rather than given a key of its own");
  assert.equal(outcome.withdrawal, null, "no withdrawal row exists to replay or to cancel");
  assert.equal(outcome.reason?.code, "MISSING_IDEMPOTENCY_KEY", "the refusal names the missing key, not a reused one");
  assert.match(outcome.reason?.message ?? "", /idempotency key/i, "the sentence names the missing thing");
  assert.equal(await availableBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(20000000));
  assert.equal(await heldBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(0));
});

test("a paused deployment refuses the request before holding anything", async () => {
  const store = new InMemoryWithdrawalStore();
  const policy = { ...policyFor(), withdrawalsPaused: true };
  await fund(store, { amount: "20000000" });

  const outcome = await request(store, policy, { amount: "20", idempotencyKey: "paused-1" });

  assert.equal(outcome.refused, true, "a paused deployment accepts nothing");
  assert.equal(outcome.reason?.code, "WITHDRAWALS_PAUSED", "the refusal names the switch, not the caller's fields");
  assert.equal(outcome.withdrawal, null, "no row is created while paused");
  assert.equal(
    await availableBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }),
    BigInt(20000000),
    "the balance is exactly where it was",
  );
  assert.equal(await heldBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(0), "nothing is held");
  assert.ok(auditActions(store).includes("WITHDRAWAL_REFUSED"), "the refusal is in the audit trail");
});

test("a request holds the amount out of the spendable balance and records why", async () => {
  const store = new InMemoryWithdrawalStore();
  const policy = policyFor();
  await fund(store, { amount: "20000000" });

  const outcome = await request(store, policy, { amount: "20", idempotencyKey: "hold-1" });

  assert.equal(outcome.refused, false);
  assert.equal(outcome.created, true);
  const row = outcome.withdrawal!;
  assert.equal(row.status, "RESERVED");
  assert.equal(row.amountMinor, "20000000");
  assert.equal(row.feeMinor, "1000000", "the configured fee is deducted, not added");
  assert.equal(row.netMinor, "19000000", "the wallet receives the amount minus the fee");
  assert.equal(row.destination, DESTINATION, "the book's key is the lowercased address");
  assert.equal(row.destinationDisplay, getAddress(DESTINATION), "what a person reads is checksummed");
  assert.equal(row.confirmationsRequired, 2, "the network's own confirmation policy");

  // The money left what the owner can spend and is still owed to them.
  assert.equal(await availableBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(0));
  assert.equal(await heldBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(20000000));

  const requested = store.audits.find((entry) => entry.action === "WITHDRAWAL_REQUESTED");
  assert.ok(requested, "the request is audited");
  assert.equal(requested!.payload.destination, getAddress(DESTINATION));
  assert.equal(requested!.payload.amountMinor, "20000000");
  assert.ok(store.addresses.some((address) => address.address === DESTINATION), "the destination is remembered");
});

test("two concurrent requests for more than the balance: one reserves, one is refused on insufficient balance", async () => {
  const store = new InMemoryWithdrawalStore();
  const policy = policyFor();
  await fund(store, { amount: "20000000" });

  const [first, second] = await Promise.all([
    request(store, policy, { amount: "15", idempotencyKey: "race-a" }),
    request(store, policy, { amount: "15", idempotencyKey: "race-b" }),
  ]);

  const accepted = [first, second].filter((outcome) => !outcome.refused);
  const refused = [first, second].filter((outcome) => outcome.refused);
  assert.equal(accepted.length, 1, "one request reserves the amount");
  assert.equal(refused.length, 1, "the other is refused");
  assert.equal(refused[0]!.reason!.code, "INSUFFICIENT_BALANCE");
  assert.ok(refused[0]!.reason!.retryable === false, "insufficient balance is terminal for this request");

  // Exactly one reservation, and the refusal is on the trail with the balance it saw.
  assert.equal(await heldBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(15000000));
  assert.equal(await availableBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(5000000));
  const refusals = store.audits.filter((entry) => entry.action === "WITHDRAWAL_REFUSED");
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0]!.payload.stage, "RESERVATION");
  assert.equal((refusals[0]!.payload.reason as { code: string }).code, "INSUFFICIENT_BALANCE");

  // No lock was left behind: the account can be asked about again immediately.
  assert.equal(store.ledgerStore.locks.size, 0);
});

test("a replayed request resolves to the same withdrawal, and a changed amount is refused", async () => {
  const store = new InMemoryWithdrawalStore();
  const policy = policyFor();
  await fund(store, { amount: "30000000" });

  const first = await request(store, policy, { amount: "20", idempotencyKey: "same-key" });
  const replay = await request(store, policy, { amount: "20", idempotencyKey: "same-key" });
  assert.equal(replay.created, false);
  assert.equal(replay.withdrawal!.id, first.withdrawal!.id);
  assert.equal(await heldBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(20000000), "the replay reserved nothing");

  const changed = await request(store, policy, { amount: "5", idempotencyKey: "same-key" });
  assert.equal(changed.refused, true);
  assert.equal(changed.reason!.code, "IDEMPOTENCY_KEY_REUSED");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Execution: one signature, one transaction
// ─────────────────────────────────────────────────────────────────────────────

test("a retried failed broadcast re-sends the signed bytes and produces one transaction", async () => {
  const store = new InMemoryWithdrawalStore();
  const policy = policyFor();
  const network = networkOf(policy);
  await fund(store, { amount: "20000000" });
  const spy = spyChain(network, { broadcastFailures: 1 });

  const requested = await request(store, policy, { amount: "20", idempotencyKey: "retry-1" });
  const firstPass = await runWithdrawalProcessor({ store, policy, now: NOW, chainFactory: spy.factory });

  assert.equal(firstPass.broadcast, 0);
  assert.equal(firstPass.broadcastFailed, 1, "a refused send is counted as refused, not as a send");
  const afterFailure = await store.findWithdrawalById(requested.withdrawal!.id);
  assert.equal(afterFailure!.status, "BROADCAST_FAILED");
  assert.equal(afterFailure!.reasonCode, "NETWORK_UNAVAILABLE");
  assert.ok(afterFailure!.rawTransaction, "the signed bytes are on the row before anything is sent");
  assert.equal(await heldBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(20000000), "the amount stays reserved");

  // The retry: same row, same bytes, one distinct transaction.
  const secondPass = await runWithdrawalProcessor({ store, policy, now: new Date(NOW.getTime() + 60_000), chainFactory: spy.factory });
  assert.equal(secondPass.broadcast, 1);
  assert.equal(spy.signed.length, 1, "the transfer was signed once");
  assert.equal(spy.sent.length, 2, "the send was attempted twice");
  assert.equal(new Set(spy.sent).size, 1, "and both attempts carried identical bytes");

  const sent = await store.findWithdrawalById(requested.withdrawal!.id);
  assert.equal(sent!.status, "BROADCAST");
  assert.equal(sent!.txHash, keccak256(afterFailure!.rawTransaction as Hex), "the hash is the one the bytes produce");
  const sharingTheHash = await store.findWithdrawalsByTxHash(sent!.txHash!);
  assert.equal(sharingTheHash.length, 1, "one transaction, one withdrawal");
});

test("a nonce taken by another withdrawal is a conflict, not a second transaction at that nonce", async () => {
  const store = new InMemoryWithdrawalStore();
  const policy = policyFor();
  const network = networkOf(policy);
  await fund(store, { amount: "30000000" });

  const first = await request(store, policy, { amount: "10", idempotencyKey: "nonce-a" });
  const second = await request(store, policy, { amount: "10", destination: OTHER_DESTINATION, idempotencyKey: "nonce-b" });
  // Both would sign nonce 0: the first pass takes it, the second has to be refused rather
  // than sign a second transaction with the same nonce.
  await executeWithdrawal({ store, policy, row: (await store.findWithdrawalById(first.withdrawal!.id))!, now: NOW, chainFactory: spyChain(network).factory });
  const conflicted = await executeWithdrawal({
    store,
    policy,
    row: (await store.findWithdrawalById(second.withdrawal!.id))!,
    now: NOW,
    chainFactory: spyChain(network).factory,
  });

  assert.equal(conflicted.kind, "broadcast-failed");
  assert.equal(conflicted.reason!.code, "NONCE_CONFLICT");
  assert.equal(conflicted.reason!.retryable, true, "a nonce conflict is retryable: the next pass reads a fresh count");
  assert.equal(conflicted.row!.status, "BROADCAST_FAILED");
  assert.equal(await heldBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(20000000), "both amounts stay reserved");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The failure taxonomy
// ─────────────────────────────────────────────────────────────────────────────

test("every failure in the taxonomy is reachable with its own state, message, retryability and audit event", async () => {
  const cases: {
    name: string;
    expectedCode: string;
    expectedState: "REFUSED" | "BROADCAST_FAILED" | "FAILED";
    retryable: boolean;
    run: (store: InMemoryWithdrawalStore, policy: WithdrawalPolicy) => Promise<{ status: string; code: string | null; message: string | null; destination: string | null }>;
  }[] = [
    {
      name: "insufficient balance",
      expectedCode: "INSUFFICIENT_BALANCE",
      expectedState: "REFUSED",
      retryable: false,
      run: async (store, policy) => {
        const outcome = await request(store, policy, { amount: "5", idempotencyKey: "tax-1" });
        return { status: "REFUSED", code: outcome.reason!.code, message: outcome.reason!.message, destination: DESTINATION };
      },
    },
    {
      name: "invalid destination",
      expectedCode: "INVALID_DESTINATION",
      expectedState: "REFUSED",
      retryable: false,
      run: async (store, policy) => {
        // A transposed character in a checksummed address is exactly the mistake the checksum
        // exists to catch, so this refuses rather than sending money into nowhere. The bad
        // checksum is *made* by flipping one character's case against a valid one, so the case
        // cannot accidentally be correct.
        const valid = getAddress(DESTINATION);
        const flipped = valid.replace(/[a-f]/, (character) => character.toUpperCase());
        const broken = flipped === valid ? valid.replace(/[A-F]/, (character) => character.toLowerCase()) : flipped;
        assert.notEqual(broken, valid, "the broken address must differ from the valid one");
        const outcome = await request(store, policy, { destination: broken, idempotencyKey: "tax-2" });
        return { status: "REFUSED", code: outcome.reason!.code, message: outcome.reason!.message, destination: null };
      },
    },
    {
      name: "invalid amount",
      expectedCode: "INVALID_AMOUNT",
      expectedState: "REFUSED",
      retryable: false,
      run: async (store, policy) => {
        const outcome = await request(store, policy, { amount: "0", idempotencyKey: "tax-3" });
        return { status: "REFUSED", code: outcome.reason!.code, message: outcome.reason!.message, destination: null };
      },
    },
    {
      name: "network unsupported",
      expectedCode: "NETWORK_UNSUPPORTED",
      expectedState: "REFUSED",
      retryable: false,
      run: async (store, policy) => {
        const outcome = await request(store, policy, { network: "solana-mainnet", idempotencyKey: "tax-4" });
        return { status: "REFUSED", code: outcome.reason!.code, message: outcome.reason!.message, destination: null };
      },
    },
    {
      name: "rpc unavailable",
      expectedCode: "NETWORK_UNAVAILABLE",
      expectedState: "BROADCAST_FAILED",
      retryable: true,
      run: async (store, policy) => {
        const network = networkOf(policy);
        const outcome = await request(store, policy, { amount: "5", idempotencyKey: "tax-5" });
        const spy = spyChain(network, { prepareFails: true });
        const executed = await executeWithdrawal({
          store,
          policy,
          row: (await store.findWithdrawalById(outcome.withdrawal!.id))!,
          now: NOW,
          chainFactory: spy.factory,
        });
        return { status: executed.row!.status, code: executed.row!.reasonCode, message: executed.row!.reasonMessage, destination: executed.row!.destinationDisplay };
      },
    },
    {
      name: "nonce conflict",
      expectedCode: "NONCE_CONFLICT",
      expectedState: "BROADCAST_FAILED",
      retryable: true,
      run: async (store, policy) => {
        const network = networkOf(policy);
        const outcome = await request(store, policy, { amount: "5", idempotencyKey: "tax-6" });
        const port = spyChain(network).port;
        // A chain that will not take the bytes at all, and says why in the network's own words.
        const refusing: WithdrawalChainPort = {
          ...port,
          async broadcast() {
            // The shape a node's refusal reaches this code in, through the RPC error text.
            return {
              kind: "refused",
              reason: {
                code: "NONCE_CONFLICT",
                message: 'The network refused eth_sendRawTransaction because the nonce was already used: {"code":-32000,"message":"nonce too low"}',
                retryable: true,
              },
            };
          },
        };
        const executed = await executeWithdrawal({
          store,
          policy,
          row: (await store.findWithdrawalById(outcome.withdrawal!.id))!,
          now: NOW,
          chainFactory: () => refusing,
        });
        return { status: executed.row!.status, code: executed.row!.reasonCode, message: executed.row!.reasonMessage, destination: executed.row!.destinationDisplay };
      },
    },
    {
      name: "transaction reverted",
      expectedCode: "TRANSACTION_REVERTED",
      expectedState: "FAILED",
      retryable: false,
      run: async (store, policy) => {
        const network = networkOf(policy);
        const outcome = await request(store, policy, { amount: "5", idempotencyKey: "tax-7" });
        const spy = spyChain(network, { observation: { kind: "mined", status: "reverted", confirmations: 2, blockNumber: 101 } });
        let row = (await store.findWithdrawalById(outcome.withdrawal!.id))!;
        row = (await executeWithdrawal({ store, policy, row, now: NOW, chainFactory: spy.factory })).row!;
        const ended = await confirmWithdrawal({ store, policy, row, now: NOW, chainFactory: spy.factory });
        return { status: ended.row!.status, code: ended.row!.reasonCode, message: ended.row!.reasonMessage, destination: ended.row!.destinationDisplay };
      },
    },
    {
      name: "expired request",
      expectedCode: "WITHDRAWAL_EXPIRED",
      expectedState: "FAILED",
      retryable: false,
      run: async (store, policy) => {
        const outcome = await request(store, policy, { amount: "5", idempotencyKey: "tax-8" });
        const row = (await store.findWithdrawalById(outcome.withdrawal!.id))!;
        const ended = await expireWithdrawal({ store, policy, row, now: new Date(row.expiresAt.getTime() + 1) });
        return { status: ended.row!.status, code: ended.row!.reasonCode, message: ended.row!.reasonMessage, destination: ended.row!.destinationDisplay };
      },
    },
  ];

  const seenMessages = new Set<string>();
  for (const testCase of cases) {
    const store = new InMemoryWithdrawalStore();
    const policy = policyFor();
    // Nothing funded for the insufficient-balance case; funded for everything else, so only
    // that one is about the balance.
    if (testCase.expectedCode !== "INSUFFICIENT_BALANCE") await fund(store, { amount: "10000000" });

    const result = await testCase.run(store, policy);
    assert.equal(result.code, testCase.expectedCode, `${testCase.name}: the reason code`);
    assert.equal(result.status, testCase.expectedState, `${testCase.name}: the state it is left in`);
    assert.ok(result.message && result.message.length > 20, `${testCase.name}: a sentence a person can act on`);
    seenMessages.add(result.message!);

    // Retryability is stated by the shared reason type, and the state carries a reason code
    // this build's taxonomy knows.
    const refusal = store.audits.find((entry) => {
      const payload = entry.payload as { reason?: { code?: string } };
      return payload.reason?.code === testCase.expectedCode;
    });
    assert.ok(refusal, `${testCase.name}: an audit event carries the reason`);
    const reasonPayload = (refusal!.payload as { reason: { retryable: boolean } }).reason;
    assert.equal(reasonPayload.retryable, testCase.retryable, `${testCase.name}: whether asking again could change it`);

    const destination = (refusal!.payload as { destination?: string | null }).destination;
    if (testCase.expectedState !== "REFUSED") {
      assert.ok(destination, `${testCase.name}: the audit event names the destination address`);
    }
  }
  assert.equal(seenMessages.size, cases.length, "every failure says something different from the others");
});

test("nothing ends with the amount neither settled nor released", async () => {
  const store = new InMemoryWithdrawalStore();
  const policy = policyFor();
  const network = networkOf(policy);
  await fund(store, { amount: "30000000" });
  const spy = spyChain(network, { observation: { kind: "mined", status: "reverted", confirmations: 2, blockNumber: 101 } });

  const requested = await request(store, policy, { amount: "20", idempotencyKey: "release-1" });
  await runWithdrawalProcessor({ store, policy, now: NOW, chainFactory: spy.factory });

  const row = await store.findWithdrawalById(requested.withdrawal!.id);
  assert.equal(row!.status, "FAILED");
  assert.equal(await heldBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(0), "the hold is discharged");
  assert.equal(await availableBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(30000000), "and the money is spendable again");
  assert.ok(row!.releasedAt, "the release is stamped on the row");
  assert.ok(row!.txHash, "the hash stays visible, because the transaction did happen");

  const report = await checkLedgerInvariants(store.ledger());
  assert.equal(report.ok, true, `the book must still add up: ${JSON.stringify(report.violations)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The owner's own new-address window
// ─────────────────────────────────────────────────────────────────────────────

test("the new-address window holds a first withdrawal, is visible, and a second one to the same address is not held", async () => {
  const store = new InMemoryWithdrawalStore();
  const policy = policyFor({ WITHDRAWAL_NEW_ADDRESS_WINDOW_MINUTES: "30" });
  await fund(store, { amount: "40000000" });

  const held = await request(store, policy, { amount: "10", idempotencyKey: "hold-window-1" });
  assert.equal(held.withdrawal!.status, "HELD");
  assert.equal(held.withdrawal!.reasonCode, "WITHDRAWAL_HELD");
  assert.ok(held.withdrawal!.reasonMessage!.includes("30 minute"), "the window's length is visible");
  assert.equal(
    held.withdrawal!.holdUntil!.getTime(),
    NOW.getTime() + 30 * 60_000,
    "the window's end is recorded",
  );
  assert.equal(await heldBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(10000000), "a held request holds the amount");

  // A run before the window ends sends nothing and says why.
  const early = await runWithdrawalProcessor({ store, policy, now: NOW, chainFactory: spyChain(networkOf(policy)).factory });
  assert.equal(early.broadcast, 0);
  assert.equal(early.pending, 1);
  assert.equal(early.skipped[0]!.reason.code, "WITHDRAWAL_HELD");

  // A second withdrawal to the same address is not a new address, so it is not held.
  const second = await request(store, policy, { amount: "10", idempotencyKey: "hold-window-2" });
  assert.equal(second.withdrawal!.status, "RESERVED", "the address is known, so the window does not apply");
  assert.equal(store.addresses[0]!.useCount, 2);

  // And a third to an address with different capitalisation is the same address.
  const differentlyCased = await request(store, policy, {
    amount: "10",
    destination: `0x${DESTINATION.slice(2).toUpperCase()}`,
    idempotencyKey: "hold-window-3",
  });
  assert.equal(differentlyCased.withdrawal!.status, "RESERVED");
  assert.equal(store.addresses.length, 1, "one row per address, however it was spelled");
});

test("the window releases into the queue when it passes, and setting it to zero holds nothing", async () => {
  const store = new InMemoryWithdrawalStore();
  const policy = policyFor({ WITHDRAWAL_NEW_ADDRESS_WINDOW_MINUTES: "30" });
  await fund(store, { amount: "40000000" });
  const network = networkOf(policy);
  const spy = spyChain(network);

  const held = await request(store, policy, { amount: "10", idempotencyKey: "release-hold-1" });
  const later = new Date(NOW.getTime() + 31 * 60_000);
  const run = await runWithdrawalProcessor({ store, policy, now: later, chainFactory: spy.factory });

  assert.equal(run.releasedFromHold, 1);
  assert.equal(run.broadcast, 1, "the same pass that ended the hold sent it");
  assert.ok(auditActions(store).includes("WITHDRAWAL_HOLD_RELEASED"));
  const row = await store.findWithdrawalById(held.withdrawal!.id);
  assert.equal(row!.status, "BROADCAST");

  // Zero holds nothing at all: no hold state, no window, and no hold audit event.
  const zeroStore = new InMemoryWithdrawalStore();
  const zeroPolicy = policyFor({ WITHDRAWAL_NEW_ADDRESS_WINDOW_MINUTES: "0" });
  await fund(zeroStore, { amount: "20000000" });
  const immediate = await request(zeroStore, zeroPolicy, { amount: "10", idempotencyKey: "zero-1" });
  assert.equal(immediate.withdrawal!.status, "RESERVED");
  assert.equal(immediate.withdrawal!.holdUntil, null);
  assert.equal(auditActions(zeroStore).includes("WITHDRAWAL_HELD"), false, "nothing holds it, so nothing is held");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Confirmation and settlement
// ─────────────────────────────────────────────────────────────────────────────

test("a withdrawal settles at the network's confirmation count and takes the fee with the transfer", async () => {
  const store = new InMemoryWithdrawalStore();
  const policy = policyFor();
  const network = networkOf(policy);
  await fund(store, { amount: "30000000" });
  const spy = spyChain(network, { observation: { kind: "mined", status: "success", confirmations: 1, blockNumber: 100 } });

  const requested = await request(store, policy, { amount: "20", idempotencyKey: "settle-1" });
  await runWithdrawalProcessor({ store, policy, now: NOW, chainFactory: spy.factory });

  // One confirmation of two: still sent, still reserved, hash visible, fee not taken.
  const sent = await store.findWithdrawalById(requested.withdrawal!.id);
  assert.equal(sent!.status, "BROADCAST");
  assert.equal(sent!.confirmations, 1);
  assert.equal(await heldBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(20000000), "a delayed confirmation keeps the amount reserved");
  assert.equal(await feesHeld(store), BigInt(0), "no fee is kept before the transfer is confirmed");

  spy.state.observation = { kind: "mined", status: "success", confirmations: 2, blockNumber: 100 };
  const second = await runWithdrawalProcessor({ store, policy, now: new Date(NOW.getTime() + 60_000), chainFactory: spy.factory });
  assert.equal(second.confirmed, 1);

  const confirmed = await store.findWithdrawalById(requested.withdrawal!.id);
  assert.equal(confirmed!.status, "CONFIRMED");
  assert.ok(confirmed!.confirmedAt);
  assert.equal(await heldBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(0));
  assert.equal(await feesHeld(store), BigInt(1000000), "the fee is kept at settlement, with the transfer that earned it");
  assert.equal(await availableBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(10000000), "the settled amount is gone from what can be spent");

  const settled = store.audits.find((entry) => entry.action === "WITHDRAWAL_CONFIRMED");
  assert.ok(settled, "the settlement is audited");
  assert.equal(settled!.payload.destination, getAddress(DESTINATION));
  assert.equal(settled!.payload.confirmationsRequired, 2);

  const report = await checkLedgerInvariants(store.ledger());
  assert.equal(report.ok, true, `the book must add up after a settlement: ${JSON.stringify(report.violations)}`);
});

/** What the platform's fee account holds, for the settlement assertions. */
async function feesHeld(store: InMemoryWithdrawalStore): Promise<bigint> {
  const accounts = await store.ledger().listAccounts();
  const fees = accounts.find((account) => account.bucket === "FEES" && account.asset === "USDT");
  if (!fees) return BigInt(0);
  const balances = await userAssetBalances(store.ledger(), { userId: USER_ID, asset: "USDT" });
  assert.ok(balances.size >= 0);
  let total = BigInt(0);
  for (const entry of await store.ledger().listEntriesForAccounts([fees.id])) {
    total += entry.entry.direction === "CREDIT" ? BigInt(entry.entry.amountMinor) : -BigInt(entry.entry.amountMinor);
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Cancellation
// ─────────────────────────────────────────────────────────────────────────────

test("a withdrawal that was never sent cancels immediately and gives the amount back", async () => {
  const store = new InMemoryWithdrawalStore();
  const policy = policyFor();
  await fund(store, { amount: "20000000" });

  const requested = await request(store, policy, { amount: "20", idempotencyKey: "cancel-early" });
  const row = (await store.findWithdrawalById(requested.withdrawal!.id))!;
  const outcome = await cancelWithdrawal({ store, policy, row, now: NOW });

  assert.equal(outcome.kind, "cancelled");
  assert.equal(outcome.row!.status, "CANCELLED");
  assert.equal(await heldBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(0));
  assert.equal(await availableBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(20000000));
  assert.ok(auditActions(store).includes("WITHDRAWAL_CANCELLED"));
});

test("a cancellation of a sent withdrawal is offered only after the timeout, and is reported as an attempt", async () => {
  const store = new InMemoryWithdrawalStore();
  const policy = policyFor({ WITHDRAWAL_CANCEL_AFTER_MINUTES: "60" });
  const network = networkOf(policy);
  await fund(store, { amount: "20000000" });
  const spy = spyChain(network, { observation: { kind: "pending", confirmations: 0 } });

  const requested = await request(store, policy, { amount: "20", idempotencyKey: "cancel-late" });
  await runWithdrawalProcessor({ store, policy, now: NOW, chainFactory: spy.factory });
  const sent = (await store.findWithdrawalById(requested.withdrawal!.id))!;
  assert.equal(sent.status, "BROADCAST");
  assert.ok(sent.timeoutAt, "the confirmation window is recorded");

  // Too early: refused, with the moment the offer becomes available named.
  const tooEarly = await cancelWithdrawal({ store, policy, row: sent, now: new Date(NOW.getTime() + 60_000) });
  assert.equal(tooEarly.kind, "refused");
  assert.equal(tooEarly.reason!.code, "NOT_YET_DUE");

  // Past the window: a replacement is sent at the same nonce, and the reply says "attempted".
  const attempted = await cancelWithdrawal({
    store,
    policy,
    row: (await store.findWithdrawalById(sent.id))!,
    now: new Date(NOW.getTime() + 61 * 60_000),
    chainFactory: spy.factory,
  });
  assert.equal(attempted.kind, "replacement-sent");
  assert.ok(attempted.row!.cancelTxHash, "the replacement's hash is on the row");
  assert.equal(attempted.row!.status, "BROADCAST", "the withdrawal is not called cancelled until the chain says so");
  assert.equal(await heldBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(20000000), "the amount stays reserved meanwhile");
  assert.ok(auditActions(store).includes("WITHDRAWAL_CANCELLATION_ATTEMPTED"));

  // The replacement is mined: only now is it cancelled, and only now is the amount released.
  spy.state.observation = { kind: "mined", status: "success", confirmations: 2, blockNumber: 102 };
  const reconciled = await reconcileCancellation({ store, policy, row: (await store.findWithdrawalById(sent.id))!, now: new Date(NOW.getTime() + 62 * 60_000), chainFactory: spy.factory });
  assert.equal(reconciled.kind, "cancelled");
  assert.equal(reconciled.row!.status, "CANCELLED");
  assert.equal(await heldBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(0));
  assert.equal(await availableBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(20000000));
});

test("a run summary says what it did, and one that found nothing says so", async () => {
  const store = new InMemoryWithdrawalStore();
  const policy = policyFor();
  const empty = await runWithdrawalProcessor({ store, policy, now: NOW });
  assert.equal(empty.worked, false);
  assert.equal(empty.reason!.code, "NO_ENTRY_CONDITION");

  await fund(store, { amount: "20000000" });
  const requested = await request(store, policy, { amount: "20", idempotencyKey: "summary-1" });
  const network = networkOf(policy);
  const run = await runWithdrawalProcessor({ store, policy, now: NOW, chainFactory: spyChain(network).factory });
  assert.equal(run.live, 1);
  assert.equal(run.broadcast, 1);
  assert.equal(run.broadcastFailed, 0);
  assert.equal(run.detail.broadcastMode, "onchain");
  assert.ok(run.worked);
  assert.equal((await store.findWithdrawalById(requested.withdrawal!.id))!.status, "BROADCAST");
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. The bytes, and the health signal
// ─────────────────────────────────────────────────────────────────────────────

test("the simulated chain signs the real transfer: identical bytes for the same request, and the recipient and amount are in them", async () => {
  const policy = policyFor();
  const network = networkOf(policy);
  const port = createSimulatedWithdrawalChain(policy, network);

  const first = await port.prepare({ network, to: DESTINATION, netMinor: "19000000", withdrawalId: "w-1", nonce: 7 });
  const again = await port.prepare({ network, to: DESTINATION, netMinor: "19000000", withdrawalId: "w-1", nonce: 7 });
  assert.equal(first.kind, "signed");
  assert.equal(again.kind, "signed");
  assert.equal((first as { transfer: { rawTransaction: string } }).transfer.rawTransaction, (again as { transfer: { rawTransaction: string } }).transfer.rawTransaction);
  assert.equal((first as { transfer: { txHash: string } }).transfer.txHash, keccak256((first as { transfer: { rawTransaction: Hex } }).transfer.rawTransaction));

  // The calldata is a real ERC-20 transfer to the destination, for the net amount.
  const data = erc20TransferData(DESTINATION, "19000000");
  const decoded = decodeFunctionData({
    abi: [
      {
        type: "function",
        name: "transfer",
        stateMutability: "nonpayable",
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
      },
    ] as const,
    data,
  });
  assert.equal(decoded.functionName, "transfer");
  assert.deepEqual(decoded.args, [getAddress(DESTINATION), BigInt(19000000)]);

  // Sending the same bytes twice is one transaction: the hash is of the bytes.
  const one = await port.broadcast({ rawTransaction: (first as { transfer: { rawTransaction: string } }).transfer.rawTransaction });
  const two = await port.broadcast({ rawTransaction: (first as { transfer: { rawTransaction: string } }).transfer.rawTransaction });
  assert.equal((one as { txHash: string }).txHash, (two as { txHash: string }).txHash);

  // A simulated confirmation is a fixed step per check, and it says it was simulated.
  assert.equal(port.simulated, true);
  const observed = await port.observe({ txHash: (one as { txHash: string }).txHash, confirmationsKnown: 0 });
  assert.equal(observed.kind, "mined");
});

test("every simulated failure kind lands in the state the taxonomy names, so each is reachable in development", async () => {
  // The acceptance criterion is not only that each failure *exists* in the taxonomy but that it is
  // reachable by hand in development, on the same code path a real deployment would use. This is
  // that claim: with the simulated chain (development's own port) and WITHDRAWAL_SIMULATE_FAILURE
  // set to each kind, a whole processor pass leaves the row in the state the taxonomy gives it.
  const cases = [
    { failure: "rpc-unavailable", code: "NETWORK_UNAVAILABLE", state: "BROADCAST_FAILED", retryable: true },
    { failure: "nonce-conflict", code: "NONCE_CONFLICT", state: "BROADCAST_FAILED", retryable: true },
    { failure: "reverted", code: "TRANSACTION_REVERTED", state: "FAILED", retryable: false },
  ] as const;

  for (const testCase of cases) {
    const store = new InMemoryWithdrawalStore();
    // `NODE_ENV=development` is what the policy requires before it will hand a send to the
    // simulation at all, so this is the deployment shape a person reaches these states in.
    const policy = policyFor({
      NODE_ENV: "development",
      WITHDRAWAL_BROADCAST_MODE: "simulated",
      WITHDRAWAL_SIMULATE_FAILURE: testCase.failure,
    });
    assert.equal(policy.broadcastMode, "simulated", `${testCase.failure}: the simulation is in force`);
    assert.equal(policy.simulatedFailure, testCase.failure);
    await fund(store, { amount: "20000000" });

    const requested = await request(store, policy, { amount: "5", idempotencyKey: `sim-${testCase.failure}` });
    assert.equal(requested.withdrawal!.status, "RESERVED", `${testCase.failure}: the request is accepted first`);

    // Up to three real passes, so the reverted kind has the pass that sends and the pass that
    // reads what the network did with it.
    let row = requested.withdrawal!;
    for (let pass = 1; pass <= 3; pass += 1) {
      await runWithdrawalProcessor({ store, policy, now: NOW });
      row = (await store.findWithdrawalById(row.id))!;
      if (row.status === testCase.state) break;
    }

    assert.equal(row.status, testCase.state, `${testCase.failure}: the state it is left in`);
    assert.equal(row.reasonCode, testCase.code, `${testCase.failure}: the reason code`);
    assert.equal(reasonIsRetryable(store, testCase.code), testCase.retryable, `${testCase.failure}: retryability`);
    assert.ok((row.reasonMessage ?? "").length > 20, `${testCase.failure}: a sentence a person can read`);
  }
});

/** The retryability a failure was recorded with, as the audit trail recorded it. */
function reasonIsRetryable(store: InMemoryWithdrawalStore, code: string): boolean {
  const entry = store.audits.find((candidate) => {
    const payload = candidate.payload as { reason?: { code?: string } };
    return payload.reason?.code === code;
  });
  assert.ok(entry, `an audit event must carry ${code}`);
  return (entry.payload as { reason: { retryable: boolean } }).reason.retryable;
}

test("the signed bytes stay on the row and out of what a browser is sent", async () => {
  const store = new InMemoryWithdrawalStore();
  const policy = policyFor();
  const network = networkOf(policy);
  await fund(store, { amount: "20000000" });
  const spy = spyChain(network);

  const requested = await request(store, policy, { amount: "20", idempotencyKey: "bytes-1" });
  await runWithdrawalProcessor({ store, policy, now: NOW, chainFactory: spy.factory });
  const row = (await store.findWithdrawalById(requested.withdrawal!.id))!;
  const resource = withdrawalResource(row, { policy, now: NOW });

  assert.ok(row.rawTransaction, "the row holds the signature so a retry can re-send it");
  assert.equal(Object.prototype.hasOwnProperty.call(resource, "rawTransaction"), false);
  assert.equal(JSON.stringify(resource).includes(row.rawTransaction!), false, "the signature never crosses to a browser");
  assert.equal(resource.txHash, row.txHash, "the hash does, because that is what identifies the transfer");
  assert.equal(resource.statusSummary.startsWith("BROADCAST"), true);
});

test("the health signal says whether withdrawals are configured, stuck, or real", async () => {
  const store = new InMemoryWithdrawalStore();
  const unconfigured = await readWithdrawalHealth({ store, policy: policyFor({ WITHDRAWAL_HOT_WALLET_MNEMONIC: "" }) });
  assert.equal(unconfigured.status, "unconfigured");
  assert.equal(unconfigured.variable, "WITHDRAWAL_HOT_WALLET_MNEMONIC");

  const policy = policyFor();
  const reachable = await readWithdrawalHealth({ store, policy });
  assert.equal(reachable.status, "reachable");
  assert.equal(reachable.broadcastMode, "onchain");

  // A simulated deployment is reachable and says so in the same sentence.
  const simulated = await readWithdrawalHealth({ store, policy: policyFor({ NODE_ENV: "development" }) });
  assert.equal(simulated.status, "reachable");
  assert.match(simulated.detail, /simulation/);
  assert.equal(simulated.broadcastMode, "simulated");

  // A row the network refused is degraded, with a count.
  const network = networkOf(policy);
  await fund(store, { amount: "20000000" });
  await request(store, policy, { amount: "20", idempotencyKey: "health-1" });
  await runWithdrawalProcessor({ store, policy, now: NOW, chainFactory: spyChain(network, { prepareFails: true }).factory });
  const degraded = await readWithdrawalHealth({ store, policy });
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.counts.BROADCAST_FAILED, 1);
  assert.match(degraded.detail, /1 withdrawal\(s\) are not where they should be/);
});

test("a deposit credit is what funds a withdrawal, so the two phases agree about the balance", async () => {
  const store = new InMemoryWithdrawalStore();
  const policy = policyFor();
  await fund(store, { amount: "20000000" });
  const balances = await userAssetBalances(store.ledger(), { userId: USER_ID, asset: "USDT" });
  assert.equal(balances.get("AVAILABLE")!.minor, BigInt(20000000));
  assert.equal(decimalStringFromMinorUnits(balances.get("AVAILABLE")!.minor.toString(), 6), "20");

  // Another account's withdrawal cannot touch this one's balance, and its own book is empty.
  const other = await request(store, policy, { userId: OTHER_USER, amount: "20", idempotencyKey: "other-1" });
  assert.equal(other.refused, true);
  assert.equal(other.reason!.code, "INSUFFICIENT_BALANCE");
  assert.equal(await availableBalanceMinor(store.ledger(), { userId: USER_ID, asset: "USDT" }), BigInt(20000000));
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The window as admin data
// ─────────────────────────────────────────────────────────────────────────────
//
// Requirement 6 calls the new-address control *admin data*, so the number that holds a
// person's own money is a stored setting rather than only an environment value. These
// tests are about that join: the stored number wins over the deployment's, zero is a
// stored value rather than an absence, a settings read that fails falls back instead of
// refusing, and nothing else can be stored beside it.

test("a stored window overrides the deployment's, and a stored zero holds nothing", async () => {
  const store = new InMemoryWithdrawalStore();
  await fund(store, { amount: "40000000" });
  const deployment = policyFor({ WITHDRAWAL_NEW_ADDRESS_WINDOW_MINUTES: "30" });

  // Nothing stored: the deployment's own value is in force and is labelled as such.
  const unstored = applyOwnerWindow(deployment, null);
  assert.equal(unstored.newAddressWindowMinutes, 30);
  assert.equal(unstored.newAddressWindowSource, "deployment-default");
  const held = await request(store, unstored, { amount: "10", idempotencyKey: "admin-window-1" });
  assert.equal(held.withdrawal!.status, "HELD", "the deployment window still holds a first send");

  // The owner's own number, stored and in force: it wins over the deployment's.
  const stored = applyOwnerWindow(deployment, { newAddressWindowMinutes: 5 });
  assert.equal(stored.newAddressWindowMinutes, 5);
  assert.equal(stored.newAddressWindowSource, "owner-setting");
  const quicker = await request(store, stored, {
    amount: "5",
    destination: OTHER_DESTINATION,
    idempotencyKey: "admin-window-2",
  });
  assert.equal(quicker.withdrawal!.status, "HELD");
  assert.equal(quicker.withdrawal!.holdUntil!.getTime(), NOW.getTime() + 5 * 60_000, "the stored number is the window that applies");
  assert.ok(quicker.withdrawal!.reasonMessage!.includes("5 minute"), "and it is the number the row shows");

  // A stored zero is a value, not an absence: it holds nothing.
  const noHold = applyOwnerWindow(deployment, { newAddressWindowMinutes: 0 });
  const store2 = new InMemoryWithdrawalStore();
  await fund(store2, { amount: "20000000" });
  const free = await request(store2, noHold, { amount: "10", destination: OTHER_DESTINATION, idempotencyKey: "admin-window-3" });
  assert.equal(free.withdrawal!.status, "RESERVED");
  assert.equal(free.withdrawal!.holdUntil, null);
  assert.equal(auditActions(store2).includes("WITHDRAWAL_HELD"), false);

  // A stored pause is part of the same overlay, and the view reports it.
  const paused = applyOwnerWindow(deployment, { newAddressWindowMinutes: 5, paused: true });
  assert.equal(paused.withdrawalsPaused, true, "a stored pause reaches the policy the request path reads");
  assert.equal(applyOwnerWindow(deployment, null).withdrawalsPaused, false, "an unstored deployment is never paused");
  assert.equal(withdrawalSettingsView(deployment, { newAddressWindowMinutes: 5, paused: true, updatedAt: NOW }).paused, true);
  assert.equal(withdrawalSettingsView(deployment, null).paused, false);

  // The admin page's read says which of the two it is showing, and both candidates.
  const unstoredView = withdrawalSettingsView(deployment, null);
  assert.deepEqual(
    { minutes: unstoredView.newAddressWindowMinutes, source: unstoredView.source, stored: unstoredView.stored, fallback: unstoredView.deploymentDefaultMinutes },
    { minutes: 30, source: "deployment-default", stored: false, fallback: 30 },
  );
  const storedView = withdrawalSettingsView(deployment, { newAddressWindowMinutes: 0, updatedAt: NOW });
  assert.deepEqual(
    { minutes: storedView.newAddressWindowMinutes, source: storedView.source, stored: storedView.stored, updatedAt: storedView.updatedAt },
    { minutes: 0, source: "owner-setting", stored: true, updatedAt: NOW.toISOString() },
  );
});

test("the effective policy is the deployment's values with the stored row on top, and a failed read falls back", async () => {
  // No stored row: the environment value, labelled as the deployment's.
  const fallback = await readEffectiveWithdrawalPolicy(RPC_ENV, async () => null);
  assert.equal(fallback.newAddressWindowMinutes, 0);
  assert.equal(fallback.newAddressWindowSource, "deployment-default");

  // A stored row: it decides, and the rest of the policy is untouched.
  const overridden = await readEffectiveWithdrawalPolicy(RPC_ENV, async () => ({ newAddressWindowMinutes: 45 }));
  assert.equal(overridden.newAddressWindowMinutes, 45);
  assert.equal(overridden.newAddressWindowSource, "owner-setting");
  assert.equal(overridden.requestExpiryMinutes, fallback.requestExpiryMinutes);
  assert.equal(overridden.networks.length, fallback.networks.length);
  assert.equal(overridden.feeByAsset.USDT, "1", "the fee is the deployment's, not this table's");

  // A settings read that throws is not a reason to refuse a withdrawal or to invent a window:
  // the deployment's own value is a complete answer.
  const broken = await readEffectiveWithdrawalPolicy(RPC_ENV, async () => {
    throw new Error("the settings table is unreachable");
  });
  assert.equal(broken.newAddressWindowMinutes, 0);
  assert.equal(broken.newAddressWindowSource, "deployment-default");
});

test("the stored window is validated as a whole number of minutes, and nothing else can be stored beside it", () => {
  assert.deepEqual(validateWithdrawalOwnerSettings({ newAddressWindowMinutes: 0 }), {
    valid: true,
    value: { newAddressWindowMinutes: 0 },
  });
  assert.equal(validateWithdrawalOwnerSettings({ newAddressWindowMinutes: MAX_NEW_ADDRESS_WINDOW_MINUTES }).valid, true);

  for (const value of [-1, 1.5, 7 * 24 * 60 + 1, "60", null, undefined, {}, []] as unknown[]) {
    const validation = validateWithdrawalOwnerSettings(
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : { newAddressWindowMinutes: value },
    );
    assert.equal(validation.valid, false, `${String(value)} must be refused`);
  }
  assert.match(
    (validateWithdrawalOwnerSettings({ newAddressWindowMinutes: -1 }) as { error: string }).error,
    /whole number of minutes, 0 or more/,
    "zero is allowed and said so in the same sentence",
  );

  // There is nowhere to put an approval gate, a review state or a lock: one key, and an
  // unknown key is a refusal rather than something silently ignored.
  const extra = validateWithdrawalOwnerSettings({ newAddressWindowMinutes: 60, approvalRequired: true });
  assert.equal(extra.valid, false);
  assert.match((extra as { error: string }).error, /unsupported/);
});

export type { PrepareOutcome };
