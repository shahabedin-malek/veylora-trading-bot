import assert from "node:assert/strict";
import test from "node:test";
import { ensureDepositAddressesForUser, deriveDepositAddressFor } from "@/lib/deposits/addresses";
import { createChainReader, TRANSFER_TOPIC } from "@/lib/deposits/chain";
import { readDepositPolicy, type DepositPolicy } from "@/lib/deposits/policy";
import { describeDepositsForUser, runDepositWatcher } from "@/lib/deposits/service";
import { classifyObservation, recordObservation, scanNetwork, type TransferObservation } from "@/lib/deposits/watcher";
import { checkLedgerInvariants } from "@/lib/ledger/invariants";
import { readLedgerView } from "@/lib/ledger/statements";
import { InMemoryDepositStore } from "./support/in-memory-deposit-store";

/**
 * The watcher: what a transfer means, that replaying it credits nothing twice,
 * and that a reorg voids a pending row with a reason.
 *
 * The chain is a stub, and deliberately a *thin* one: it answers JSON-RPC by
 * method and nothing else, so a test states the chain's facts (this log, this
 * block, this receipt) and asserts what the deployment made of them. Nothing here
 * reaches a network. It also records the `topics` of every `eth_getLogs`, which is
 * how the *narrow* read (filtered on our addresses) is told apart from the wide
 * one (unfiltered) without a second stub.
 */

const MNEMONIC = "test test test test test test test test test test test junk";
const USDT_MAINNET = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const USER_ID = "user-1";
// `ProcessEnv` requires NODE_ENV, and stating it here (rather than spreading the
// shell's own environment) keeps every network read in this file resolving the
// endpoint written down below.
const RPC_ENV = { NODE_ENV: "test", ALCHEMY_ETHEREUM_MAINNET_RPC_URL: "https://eth-mainnet.g.alchemy.com/v2/test-key" } as NodeJS.ProcessEnv;

const HEAD = 100;
const BLOCK_NUMBER = 99;
const BLOCK_HASH = "0xblock99";
const TX_HASH = "0xtransfer1";

function hex(value: number | bigint): string {
  return `0x${value.toString(16)}`;
}

function pad(value: string): string {
  return `0x${value.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
}

function policyFor(env: Record<string, string> = {}): DepositPolicy {
  return readDepositPolicy({
    DEPOSIT_ADDRESS_MNEMONIC: MNEMONIC,
    DEPOSIT_ENABLED_NETWORKS: "ethereum-mainnet",
    DEPOSIT_WATCH_BLOCKS: "3",
    ...RPC_ENV,
    ...env,
  });
}

/**
 * One ERC-20 `Transfer` log, in the shape the RPC *answers with* — quantities as
 * the hex strings Ethereum returns, not as the numbers this project decodes them
 * into. The distinction matters: a stub that answered with numbers would be
 * answering in a shape no endpoint uses, and the reader (rightly) refuses a
 * quantity it cannot read rather than guessing.
 */
function transferLog(input: {
  to: string;
  amountRaw: bigint;
  token?: string;
  logIndex?: number;
  blockNumber?: number;
  blockHash?: string;
  txHash?: string;
}): Record<string, unknown> {
  return {
    address: input.token ?? USDT_MAINNET,
    logIndex: hex(input.logIndex ?? 0),
    transactionHash: input.txHash ?? TX_HASH,
    blockNumber: hex(input.blockNumber ?? BLOCK_NUMBER),
    blockHash: input.blockHash ?? BLOCK_HASH,
    topics: [TRANSFER_TOPIC, pad("0x1111111111111111111111111111111111111111"), pad(input.to)],
    data: pad(hex(input.amountRaw)),
    removed: false,
  };
}

function nativeBlock(number: number, transfers: { hash: string; to: string; value: bigint }[] = []) {
  return {
    number: hex(number),
    hash: `0xblock${number}`,
    transactions: transfers.map((transfer) => ({
      hash: transfer.hash,
      from: "0x2222222222222222222222222222222222222222",
      to: transfer.to,
      value: hex(transfer.value),
      input: "0x",
    })),
  };
}

type ChainStub = {
  fetch: typeof fetch;
  /** The `topics` array of every `eth_getLogs` the code asked for. */
  logTopics: (string[] | null)[][];
  methods: string[];
};

/**
 * A chain that answers by JSON-RPC method.
 *
 * `logs` answers a *filtered* `eth_getLogs` and `allLogs` answers the unfiltered
 * one, so a test can state both reads independently — which is exactly the
 * distinction the wide scan turns on.
 */
function stubChain(handlers: {
  head?: number;
  logs?: Record<string, unknown>[];
  allLogs?: Record<string, unknown>[];
  blocks?: Record<number, ReturnType<typeof nativeBlock>>;
  receipts?: Record<string, unknown>;
  fail?: boolean;
}): ChainStub {
  const methods: string[] = [];
  const logTopics: (string[] | null)[][] = [];
  const stub = (async (_input: unknown, init?: RequestInit) => {
    if (handlers.fail) throw new Error("the endpoint did not answer");
    const payload = JSON.parse(String(init?.body ?? "[]")) as { id: number; method: string; params: unknown[] }[];
    const body = payload.map((call) => {
      methods.push(call.method);
      if (call.method === "eth_blockNumber") return { jsonrpc: "2.0", id: call.id, result: hex(handlers.head ?? HEAD) };
      if (call.method === "eth_getLogs") {
        const params = call.params[0] as { topics: (string[] | null)[] };
        logTopics.push(params.topics);
        const filtered = params.topics[2] !== null;
        return { jsonrpc: "2.0", id: call.id, result: filtered ? handlers.logs ?? [] : handlers.allLogs ?? [] };
      }
      if (call.method === "eth_getBlockByNumber") {
        const number = Number(BigInt(String(call.params[0])));
        return { jsonrpc: "2.0", id: call.id, result: handlers.blocks?.[number] ?? null };
      }
      if (call.method === "eth_getTransactionReceipt") {
        return { jsonrpc: "2.0", id: call.id, result: handlers.receipts?.[String(call.params[0])] ?? null };
      }
      return { jsonrpc: "2.0", id: call.id, result: null };
    });
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: stub, logTopics, methods };
}

function readerFor(stub: ChainStub) {
  const created = createChainReader("ethereum-mainnet", { fetch: stub.fetch, env: RPC_ENV });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("the chain stub could not be resolved into a reader");
  return created.reader;
}

function receipt(blockNumber: number, blockHash: string, txHash = TX_HASH) {
  return { transactionHash: txHash, status: "0x1", blockNumber: hex(blockNumber), blockHash, logs: [] };
}

async function seeded(input: { store: InMemoryDepositStore; policy: DepositPolicy }) {
  const issuance = await ensureDepositAddressesForUser({ userId: USER_ID, store: input.store, policy: input.policy });
  return issuance.created[0] ?? issuance.existing[0];
}

function observationFor(input: {
  to: string;
  amountRaw: bigint;
  kind?: "erc20" | "native";
  tokenAddress?: string | null;
  amount?: string;
  origin?: "WATCHER" | "UNFILTERED";
}): TransferObservation {
  const native = input.kind === "native";
  return {
    network: "ethereum-mainnet",
    chainId: 1,
    kind: input.kind ?? "erc20",
    txHash: TX_HASH,
    logIndex: 0,
    blockNumber: BLOCK_NUMBER,
    blockHash: BLOCK_HASH,
    from: "0x1111111111111111111111111111111111111111",
    to: input.to,
    tokenAddress: input.tokenAddress === undefined ? USDT_MAINNET : input.tokenAddress,
    tokenSymbol: native ? "ETH" : "USDT",
    decimals: native ? 18 : 6,
    rawAmount: input.amountRaw.toString(),
    amount: input.amount ?? (native ? "1" : "20"),
    origin: input.origin ?? "WATCHER",
    evidence: {},
  };
}

test("a transfer of the enabled token to our address is pending, and says what it is waiting for", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor({ DEPOSIT_CONFIRMATIONS_ETHEREUM_MAINNET: "12" });
  const address = await seeded({ store, policy });

  const classified = classifyObservation(observationFor({ to: address.address, amountRaw: BigInt(20_000_000) }), {
    policy: policy.networks[0],
    addresses: [address],
  });
  assert.equal(classified.state, "PENDING");
  assert.equal(classified.reason.code, "AWAITING_CONFIRMATIONS");
  assert.deepEqual(classified.attribution, { userId: USER_ID, depositAddressId: address.id });
});

test("a recipient that is not ours is recorded unmatched, and credited to nobody", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor();
  const address = await seeded({ store, policy });

  const classified = classifyObservation(observationFor({ to: "0x9999999999999999999999999999999999999999", amountRaw: BigInt(20_000_000) }), {
    policy: policy.networks[0],
    addresses: [address],
  });
  assert.equal(classified.state, "UNMATCHED");
  assert.equal(classified.reason.code, "UNKNOWN_RECIPIENT");
  // No account: an arrival we can see but cannot attribute must not be forced onto
  // the one account that happens to exist.
  assert.equal(classified.attribution, null);
});

test("the native coin arriving is recorded for a valuation, and the reason names the coin", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor();
  const address = await seeded({ store, policy });

  const classified = classifyObservation(
    observationFor({ to: address.address, amountRaw: BigInt(10) ** BigInt(18), kind: "native", tokenAddress: null }),
    { policy: policy.networks[0], addresses: [address] },
  );
  assert.equal(classified.state, "AWAITING_VALUATION");
  assert.equal(classified.reason.code, "TOKEN_AWAITING_VALUATION");
  assert.match(classified.reason.message, /native coin \(ETH\)/);
  assert.match(classified.reason.message, /USDT value/);
  assert.equal(classified.attribution?.userId, USER_ID);
});

test("a token this network does not configure is recorded for a valuation and never auto-credited", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor();
  const address = await seeded({ store, policy });

  const classified = classifyObservation(
    observationFor({ to: address.address, amountRaw: BigInt(20_000_000), tokenAddress: "0x4444444444444444444444444444444444444444" }),
    { policy: policy.networks[0], addresses: [address] },
  );
  assert.equal(classified.state, "AWAITING_VALUATION");
  // The configured token is named in the reason, so the owner can see what arrived
  // against what this network expects before putting a value on it.
  assert.match(classified.reason.message, new RegExp(USDT_MAINNET));
  assert.match(classified.reason.message, /owner to credit it at a USDT value/);
});

test("an amount below the network's dust guard is recorded and not credited", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor({ DEPOSIT_MIN_AMOUNT_ETHEREUM_MAINNET: "25" });
  const address = await seeded({ store, policy });

  const classified = classifyObservation(observationFor({ to: address.address, amountRaw: BigInt(20_000_000) }), {
    policy: policy.networks[0],
    addresses: [address],
  });
  assert.equal(classified.state, "BELOW_DUST");
  assert.equal(classified.reason.code, "BELOW_MINIMUM_AMOUNT");
  assert.match(classified.reason.message, /below this network's deposit minimum of 25/);
});

test("the scan reads the recipient filter for tokens and the blocks for native transfers", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor();
  const address = await seeded({ store, policy });
  const chain = stubChain({
    logs: [transferLog({ to: address.address, amountRaw: BigInt(20_000_000) })],
    blocks: { 98: nativeBlock(98), 99: nativeBlock(99), 100: nativeBlock(100, [{ hash: "0xnative1", to: address.address, value: BigInt(10) ** BigInt(18) }]) },
  });

  const scan = await scanNetwork({
    policy: policy.networks[0],
    reader: readerFor(chain),
    addresses: [address],
    watchBlocks: 3,
    scanUnfiltered: false,
    cursor: null,
  });

  assert.equal(scan.skipped, null);
  // No cursor means "read back the watch window", not "read from the genesis block".
  assert.deepEqual({ from: scan.fromBlock, to: scan.toBlock, head: scan.head }, { from: 98, to: 100, head: HEAD });
  assert.deepEqual(
    scan.observations.map((observed) => [observed.kind, observed.amount, observed.logIndex]),
    [
      ["erc20", "20", 0],
      ["native", "1", -1],
    ],
  );
  // One log read, filtered on our own address in `topics[2]`; and a block read per
  // block in the window, because a native transfer writes no log at all.
  assert.equal(chain.logTopics.length, 1);
  assert.deepEqual(chain.logTopics[0][2], [pad(address.address)]);
  assert.equal(chain.methods.filter((method) => method === "eth_getBlockByNumber").length, 3);
});

test("the wide scan is the only read that can see money sent elsewhere, and it is off by default", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor({ DEPOSIT_SCAN_UNFILTERED: "1" });
  const address = await seeded({ store, policy });
  const strangerLog = transferLog({ to: "0x9999999999999999999999999999999999999999", amountRaw: BigInt(5_000_000), logIndex: 4 });
  const chain = stubChain({
    logs: [transferLog({ to: address.address, amountRaw: BigInt(20_000_000) })],
    allLogs: [transferLog({ to: address.address, amountRaw: BigInt(20_000_000) }), strangerLog],
  });

  const scan = await scanNetwork({
    policy: policy.networks[0],
    reader: readerFor(chain),
    addresses: [address],
    watchBlocks: 3,
    scanUnfiltered: true,
    cursor: null,
  });

  assert.equal(chain.logTopics.length, 2);
  assert.equal(chain.logTopics[1][2], null);
  // The wide pass adds the stranger's transfer and does not duplicate ours: the
  // log that is already recorded is skipped by (transactionHash, logIndex).
  // The addresses come back lowercased, as the log's topics are: the row keeps the
  // chain's own casing, and matching against a deposit address is case-insensitive
  // everywhere it happens.
  assert.deepEqual(
    scan.observations.map((observed) => [observed.to, observed.origin]),
    [
      [address.address.toLowerCase(), "WATCHER"],
      ["0x9999999999999999999999999999999999999999", "UNFILTERED"],
    ],
  );
});

test("a cursor that has caught up says so instead of re-reading the same blocks", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor();
  const address = await seeded({ store, policy });
  const chain = stubChain({ head: HEAD });

  const scan = await scanNetwork({
    policy: policy.networks[0],
    reader: readerFor(chain),
    addresses: [address],
    watchBlocks: 3,
    scanUnfiltered: false,
    cursor: HEAD,
  });

  assert.equal(scan.observations.length, 0);
  assert.equal(scan.skipped?.code, "NOT_YET_DUE");
  assert.match(scan.skipped?.message ?? "", /no new block to read/);
  assert.equal(chain.methods.includes("eth_getLogs"), false);
});

test("a chain that cannot be read raises, because 'we did not look' is not 'nothing arrived'", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor();
  const address = await seeded({ store, policy });
  const chain = stubChain({ fail: true });

  await assert.rejects(
    scanNetwork({
      policy: policy.networks[0],
      reader: readerFor(chain),
      addresses: [address],
      watchBlocks: 3,
      scanUnfiltered: false,
      cursor: null,
    }),
    /did not answer/,
  );
});

test("replaying the same chain event records it once and credits it once", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor({ DEPOSIT_CONFIRMATIONS_ETHEREUM_MAINNET: "2" });
  const address = await seeded({ store, policy });
  const chain = stubChain({
    logs: [transferLog({ to: address.address, amountRaw: BigInt(20_000_000) })],
    blocks: { 99: nativeBlock(99) },
    receipts: { [TX_HASH]: receipt(BLOCK_NUMBER, BLOCK_HASH) },
  });

  const first = await runDepositWatcher({ store, policy, fetch: chain.fetch, env: RPC_ENV, now: new Date("2026-10-16T00:00:00.000Z") });
  assert.equal(first.observations, 1);
  assert.equal(first.recorded, 1);
  assert.equal(first.credited, 1);
  assert.equal(store.depositCount, 1);
  assert.equal(store.creditCount, 1);

  // Since phase 13 the credit is also a balanced movement in the ledger of
  // record: the platform's treasury debited, the account credited, posted in the
  // same transaction as the claim.
  assert.equal(store.ledgerRows.transactions.length, 1);
  assert.equal(store.ledgerRows.entries.length, 2);
  assert.equal((await checkLedgerInvariants(store.ledgerRows)).ok, true);

  const credited = store.deposits[0];
  assert.equal(credited.txHash, TX_HASH);
  assert.equal(credited.amount, "20");
  assert.equal(credited.tokenSymbol, "USDT");
  assert.equal(credited.status, "CREDITED");
  assert.equal(credited.blockNumber, BLOCK_NUMBER);
  assert.equal(credited.blockHash, BLOCK_HASH);
  // The evidence the credit was decided from is kept with the decision.
  assert.match(credited.evidenceJson, /"topics"/);
  const audit = store.auditsFor("DEPOSIT_CREDITED");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].payload.txHash, TX_HASH);
  assert.equal(audit[0].payload.confirmationsRequired, 2);
  assert.equal(audit[0].payload.amount, "20");

  // Rewind the cursor and read the very same range again: that is the replay the
  // acceptance criterion names.
  await store.writeCursor("ethereum-mainnet", 0);
  const replay = await runDepositWatcher({ store, policy, fetch: chain.fetch, env: RPC_ENV });
  assert.equal(replay.recorded, 0);
  assert.equal(replay.duplicates, 1);
  assert.equal(replay.credited, 0);
  assert.equal(store.depositCount, 1);
  assert.equal(store.creditCount, 1);
  assert.equal(store.auditsFor("DEPOSIT_DETECTED").length, 1);
  assert.equal(store.auditsFor("DEPOSIT_CREDITED").length, 1);
  // A replay posts nothing to the ledger either: the movement is keyed by the
  // deposit, so the second run finds it already there.
  assert.equal(store.ledgerRows.transactions.length, 1);
  assert.equal(store.ledgerRows.entries.length, 2);
});

test("the credited total an owner is shown is the sum of the rows that reached CREDITED", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor({ DEPOSIT_CONFIRMATIONS_ETHEREUM_MAINNET: "2" });
  const address = await seeded({ store, policy });
  const chain = stubChain({
    logs: [
      transferLog({ to: address.address, amountRaw: BigInt(20_000_000) }),
      transferLog({ to: address.address, amountRaw: BigInt(2_000_000), logIndex: 1, txHash: "0xtransfer2" }),
      transferLog({ to: address.address, amountRaw: BigInt(1_000_000), logIndex: 2, txHash: "0xtransfer3" }),
    ],
    blocks: { 99: nativeBlock(99) },
    receipts: {
      [TX_HASH]: receipt(BLOCK_NUMBER, BLOCK_HASH),
      "0xtransfer2": null,
      "0xtransfer3": receipt(BLOCK_NUMBER, BLOCK_HASH, "0xtransfer3"),
    },
  });
  // The second transfer's receipt is gone: it is reverted, and its 2 USDT is not part
  // of what the account holds.
  //
  // The run's clock is pinned inside the window read below. Left on the wall clock the
  // credit would be stamped "now", and the fixed October range would stop covering it on
  // the day the calendar moved past that range — a test that goes red on a date change
  // rather than on a change in the code.
  const runAt = new Date("2026-10-16T12:00:00.000Z");
  await runDepositWatcher({ store, policy, fetch: chain.fetch, env: RPC_ENV, now: runAt });

  const { view } = await describeDepositsForUser({ userId: USER_ID, store, policy });
  assert.deepEqual(view.creditedTotals, [{ tokenSymbol: "USDT", amount: "21" }]);
  assert.deepEqual(
    view.deposits.map((deposit) => deposit.status).sort(),
    ["CREDITED", "CREDITED", "REVERTED"],
  );

  // The two surfaces are two reads of two tables, and they agree: what the deposit
  // panel credits (21 USDT) is what the ledger says the account holds — the
  // reverted transfer contributed to neither.
  const ledger = await readLedgerView(store.ledgerRows, {
    userId: USER_ID,
    from: new Date("2026-10-01T00:00:00.000Z"),
    to: new Date("2026-10-16T23:59:59.999Z"),
  });
  assert.equal(ledger.balances.find((balance) => balance.asset === "USDT")?.decimal, "21");
  assert.equal(ledger.statement.lines.length, 2, "one balanced movement per credited transfer");
  assert.equal(ledger.statement.totals[0]?.netDecimal, "21");
  assert.equal((await checkLedgerInvariants(store.ledgerRows)).ok, true);
});

test("a reorg that removes a pending transfer reverts the row and says why", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor({ DEPOSIT_CONFIRMATIONS_ETHEREUM_MAINNET: "5" });
  const address = await seeded({ store, policy });

  const intact = stubChain({
    logs: [transferLog({ to: address.address, amountRaw: BigInt(20_000_000) })],
    blocks: { 99: nativeBlock(99) },
    receipts: { [TX_HASH]: receipt(BLOCK_NUMBER, BLOCK_HASH) },
  });
  const first = await runDepositWatcher({ store, policy, fetch: intact.fetch, env: RPC_ENV });
  assert.equal(first.awaiting, 1);
  assert.equal(first.credited, 0);
  assert.equal(store.deposits[0].status, "PENDING");

  // The same transaction now resolves to a different block: the block that carried
  // it is gone.
  const reorged = stubChain({ receipts: { [TX_HASH]: receipt(101, "0xblock101") } });
  const second = await runDepositWatcher({ store, policy, fetch: reorged.fetch, env: RPC_ENV });
  assert.equal(second.reverted, 1);
  assert.equal(second.credited, 0);

  const reverted = store.deposits[0];
  assert.equal(reverted.status, "REVERTED");
  assert.equal(reverted.reasonCode, "CHAIN_REORGANIZED");
  assert.match(reverted.reasonMessage ?? "", /now has 101/);
  const audit = store.auditsFor("DEPOSIT_REVERTED");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].outcome, "REFUSED");
  assert.equal(audit[0].payload.recordedBlockHash, BLOCK_HASH);
  assert.equal(audit[0].payload.observedBlockHash, "0xblock101");

  // A reverted row is settled: a later run does not quietly credit it.
  const third = await runDepositWatcher({ store, policy, fetch: intact.fetch, env: RPC_ENV });
  assert.equal(third.credited, 0);
  assert.equal(store.creditCount, 0);
});

test("recording the same observation twice writes one row and one audit event", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor();
  const address = await seeded({ store, policy });
  const observation = observationFor({ to: address.address, amountRaw: BigInt(20_000_000) });
  const classification = classifyObservation(observation, { policy: policy.networks[0], addresses: [address] });

  const first = await recordObservation({ store, observation, classification, now: new Date(0) });
  const second = await recordObservation({ store, observation, classification, now: new Date(0) });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.row.id, first.row.id);
  assert.equal(store.depositCount, 1);
  assert.equal(store.auditsFor("DEPOSIT_DETECTED").length, 1);
});

test("an unmatched arrival is stored without an account, so it is visible and attributed to nobody", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor();
  const address = await seeded({ store, policy });
  const observation = observationFor({ to: "0x9999999999999999999999999999999999999999", amountRaw: BigInt(20_000_000) });
  const classification = classifyObservation(observation, { policy: policy.networks[0], addresses: [address] });

  const recorded = await recordObservation({ store, observation, classification, now: new Date(0) });
  assert.equal(recorded.row.userId, null);
  assert.equal(recorded.row.status, "UNMATCHED");
  assert.equal(recorded.row.depositAddressId, null);
  // The audit event is written as a refusal, because no money moved.
  assert.equal(store.auditsFor("DEPOSIT_DETECTED")[0].outcome, "REFUSED");
});

test("the address the watcher watches is the one the owner was shown", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor();
  const address = await seeded({ store, policy });
  assert.equal(address.address, deriveDepositAddressFor(MNEMONIC, USER_ID, "ethereum-mainnet").address);
});
