import assert from "node:assert/strict";
import test from "node:test";
import { mnemonicToAccount } from "viem/accounts";
import {
  depositAddressIndexFor,
  depositDerivationPath,
  depositSeedReason,
  deriveDepositAddressFor,
  ensureDepositAddressesForUser,
  isUsableMnemonic,
} from "@/lib/deposits/addresses";
import { sumCreditedTotals } from "@/lib/deposits/credit";
import { depositEnvKey, formatDepositInterval, readDepositPolicy } from "@/lib/deposits/policy";
import {
  DEFAULT_ENABLED_DEPOSIT_NETWORKS,
  DEPOSIT_NETWORKS,
  depositAddressUrl,
  depositTransactionUrl,
  getDepositNetwork,
} from "@/lib/deposits/registry";
import { availabilityOf, describeDepositsForUser } from "@/lib/deposits/service";
import { issueDepositAddressesForSignIn } from "@/lib/deposits/sign-in";
import type { NewDepositRow } from "@/lib/deposits/store";
import { InMemoryDepositStore } from "./support/in-memory-deposit-store";

/**
 * The deposit half of phase 12 that is *not* about reading a chain: what address
 * an account gets, where the policy's numbers come from, and what the panel is
 * told.
 *
 * The seed below is the standard BIP-39 test mnemonic ("test … junk"). It is a
 * well-known value, which is exactly why it is the right one here — it must never
 * be a deployment's, and a test that used a real seed would be a test with money
 * in it.
 */
const MNEMONIC = "test test test test test test test test test test test junk";
const USDT_MAINNET = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
// `ProcessEnv` requires NODE_ENV, and a test that stated only the variables it
// cares about would also pick up whatever is exported in the shell it runs in.
// Naming it here keeps the policy these tests read the one they wrote down.
const RPC_ENV = { NODE_ENV: "test", ALCHEMY_ETHEREUM_MAINNET_RPC_URL: "https://eth-mainnet.g.alchemy.com/v2/test-key" } as NodeJS.ProcessEnv;
const TEST_ENV = { NODE_ENV: "test" } as NodeJS.ProcessEnv;

function policyFor(env: Record<string, string> = {}) {
  return readDepositPolicy({
    DEPOSIT_ADDRESS_MNEMONIC: MNEMONIC,
    DEPOSIT_ENABLED_NETWORKS: "ethereum-mainnet",
    ...RPC_ENV,
    ...env,
  });
}

function addressRow(userId: string, network: string, address: string, index = 1): Parameters<InMemoryDepositStore["insertAddressOnce"]>[0] {
  return {
    userId,
    network,
    chainId: getDepositNetwork(network)?.chainId ?? 1,
    address,
    derivationIndex: index,
    tokenSymbol: "USDT",
    tokenAddress: USDT_MAINNET,
    tokenDecimals: 6,
  };
}

function depositRow(overrides: Partial<NewDepositRow> = {}): NewDepositRow {
  return {
    userId: "user-1",
    depositAddressId: "address-1",
    network: "ethereum-mainnet",
    chainId: 1,
    tokenSymbol: "USDT",
    tokenAddress: USDT_MAINNET,
    decimals: 6,
    amount: "10.5",
    rawAmount: "10500000",
    txHash: "0xaaaa",
    logIndex: 3,
    blockNumber: 99,
    blockHash: "0xbbbb",
    status: "PENDING",
    reasonCode: null,
    reasonMessage: null,
    evidenceJson: "{}",
    origin: "WATCHER",
    observedAt: new Date("2026-10-16T00:00:00.000Z"),
    creditedAt: null,
    lastCheckedAt: null,
    revertedAt: null,
    ...overrides,
  };
}

test("a deposit address is a pure function of the account and the network", () => {
  const first = depositAddressIndexFor("user-1", "ethereum-mainnet");
  assert.equal(depositAddressIndexFor("user-1", "ethereum-mainnet"), first);
  assert.equal(depositDerivationPath(first), `m/44'/60'/0'/0/${first}`);

  // Different account, different network, different index — otherwise two people
  // (or one person on two chains) would share a funding address.
  assert.notEqual(depositAddressIndexFor("user-2", "ethereum-mainnet"), first);
  assert.notEqual(depositAddressIndexFor("user-1", "base-mainnet"), first);

  const derived = deriveDepositAddressFor(MNEMONIC, "user-1", "ethereum-mainnet");
  assert.equal(derived.index, first);
  assert.equal(derived.address, mnemonicToAccount(MNEMONIC, { addressIndex: first }).address);
  // The whole point of deriving rather than allocating: the second call, on any
  // machine, produces the same address.
  assert.deepEqual(deriveDepositAddressFor(MNEMONIC, "user-1", "ethereum-mainnet"), derived);
});

test("a sign-in issues one address per enabled network, and a second sign-in issues nothing", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor();

  const first = await ensureDepositAddressesForUser({ userId: "user-1", store, policy });
  assert.deepEqual(first.created.map((row) => row.network), ["ethereum-mainnet"]);
  assert.equal(first.existing.length, 0);
  assert.equal(first.skipped.length, 0);
  assert.equal(store.addresses.length, 1);
  assert.deepEqual(store.auditsFor("DEPOSIT_ADDRESS_ISSUED").length, 1);

  const second = await ensureDepositAddressesForUser({ userId: "user-1", store, policy });
  assert.equal(second.created.length, 0);
  assert.deepEqual(second.existing.map((row) => row.network), ["ethereum-mainnet"]);
  assert.equal(store.addresses.length, 1);
  // Issued once, audited once: the row and its audit event share a transaction, so
  // an address without its record cannot exist.
  assert.equal(store.auditsFor("DEPOSIT_ADDRESS_ISSUED").length, 1);

  const issued = store.addresses[0];
  assert.equal(issued.address, deriveDepositAddressFor(MNEMONIC, "user-1", "ethereum-mainnet").address);
  assert.equal(issued.tokenAddress, USDT_MAINNET);
  assert.equal(store.auditsFor("DEPOSIT_ADDRESS_ISSUED")[0].payload.address, issued.address);
});

test("a deployment with no seed issues nothing at all and names the variable", async () => {
  const store = new InMemoryDepositStore();
  const policy = readDepositPolicy({ DEPOSIT_ENABLED_NETWORKS: "ethereum-mainnet", ...RPC_ENV });

  const outcome = await ensureDepositAddressesForUser({ userId: "user-1", store, policy });
  assert.equal(outcome.created.length, 0);
  assert.equal(outcome.existing.length, 0);
  assert.equal(outcome.skipped.length, 1);
  assert.equal(outcome.skipped[0].network, "ethereum-mainnet");
  assert.equal(outcome.skipped[0].reason.code, "MISSING_CONFIGURATION");
  assert.equal(outcome.skipped[0].reason.variable, "DEPOSIT_ADDRESS_MNEMONIC");
  // No store touched: an unconfigured deployment does not write a placeholder
  // address, and it does not write an audit event about one.
  assert.equal(store.addresses.length, 0);
  assert.equal(store.audits.length, 0);
});

test("a seed that is not a mnemonic is reported as malformed, not as absent", () => {
  assert.equal(isUsableMnemonic(MNEMONIC), true);
  assert.equal(isUsableMnemonic("one two three four"), false);

  const malformed = depositSeedReason(readDepositPolicy({ ...TEST_ENV, DEPOSIT_ADDRESS_MNEMONIC: "one two three four" }));
  assert.equal(malformed?.code, "MISSING_CONFIGURATION");
  assert.equal(malformed?.variable, "DEPOSIT_ADDRESS_MNEMONIC");
  assert.match(malformed?.message ?? "", /BIP-39/);

  const absent = depositSeedReason(readDepositPolicy(TEST_ENV));
  assert.match(absent?.message ?? "", /is not configured/);
});

test("the sign-in seam reports what it issued, and a storage failure never refuses the sign-in", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor();

  const issued = await issueDepositAddressesForSignIn({ userId: "user-1", store, policy });
  assert.deepEqual({ issued: issued.issued, existing: issued.existing, failed: issued.failed }, { issued: 1, existing: 0, failed: false });

  const again = await issueDepositAddressesForSignIn({ userId: "user-1", store, policy });
  assert.deepEqual({ issued: again.issued, existing: again.existing, failed: again.failed }, { issued: 0, existing: 1, failed: false });

  store.failNextTransaction.value = true;
  const failed = await issueDepositAddressesForSignIn({ userId: "user-2", store, policy });
  // A side-effect of the sign-in must never cost somebody their session: the
  // failure is reported, logged, and the address is issued on the next read.
  assert.equal(failed.failed, true);
  assert.equal(failed.issued, 0);
});

test("the default network set is the mainnets whose deposit token is already known", () => {
  assert.ok(DEFAULT_ENABLED_DEPOSIT_NETWORKS.includes("ethereum-mainnet"));
  assert.ok(!DEFAULT_ENABLED_DEPOSIT_NETWORKS.includes("ethereum-sepolia"));

  const policy = readDepositPolicy({ DEPOSIT_ADDRESS_MNEMONIC: MNEMONIC, ...RPC_ENV });
  assert.deepEqual(policy.enabledNetworks.map((network) => network.slug), [...DEFAULT_ENABLED_DEPOSIT_NETWORKS]);

  // A testnet is in the registry but needs a token from the owner, so it is
  // reported with the two variables that would fix it rather than watched with a
  // guess about which contract their test dollars live at.
  const testnet = readDepositPolicy({
    ...TEST_ENV,
    DEPOSIT_ADDRESS_MNEMONIC: MNEMONIC,
    DEPOSIT_ENABLED_NETWORKS: "ethereum-sepolia",
    ALCHEMY_ETHEREUM_SEPOLIA_RPC_URL: "https://eth-sepolia.g.alchemy.com/v2/test-key",
  }).networks.find((network) => network.slug === "ethereum-sepolia");
  assert.equal(testnet?.status, "missing-token");
  assert.ok(testnet?.missing.includes("DEPOSIT_TOKEN_ADDRESS_ETHEREUM_SEPOLIA"));
  assert.ok(testnet?.missing.includes("DEPOSIT_TOKEN_DECIMALS_ETHEREUM_SEPOLIA"));
  assert.equal(testnet?.token, null);
});

test("a slug the registry does not know is named rather than silently dropped", () => {
  const policy = readDepositPolicy({
    DEPOSIT_ADDRESS_MNEMONIC: MNEMONIC,
    DEPOSIT_ENABLED_NETWORKS: "ethereum-mainnet,dogecoin",
    ...RPC_ENV,
  });
  // Stated once, against the list rather than repeated on every network row, and
  // never dropped: a typo in the variable would otherwise be indistinguishable
  // from a deployment that meant to enable exactly what it typed.
  assert.deepEqual(policy.problems, [
    'DEPOSIT_ENABLED_NETWORKS lists "dogecoin", which is not a deposit network this build knows, so it was not enabled.',
  ]);
  const ethereum = policy.networks.find((network) => network.slug === "ethereum-mainnet");
  assert.equal(ethereum?.status, "ready");
  assert.ok(!policy.enabledNetworks.some((network) => network.slug === "dogecoin"));
});

test("confirmations and the dust guard come from the owner when set, and are visible either way", () => {
  const base = policyFor().networks.find((network) => network.slug === "ethereum-mainnet");
  assert.equal(base?.confirmations, 12);
  assert.equal(base?.configuredBy.confirmations, false);

  const overridden = policyFor({
    DEPOSIT_CONFIRMATIONS_ETHEREUM_MAINNET: "2",
    DEPOSIT_MIN_AMOUNT_ETHEREUM_MAINNET: "25.5",
  }).networks.find((network) => network.slug === "ethereum-mainnet");
  assert.equal(overridden?.confirmations, 2);
  assert.equal(overridden?.configuredBy.confirmations, true);
  assert.equal(overridden?.minimumAmount, "25.5");
  assert.equal(overridden?.configuredBy.minimumAmount, true);

  // A value that cannot be read is reported, never rounded into something that
  // would credit sooner or later than the owner asked for.
  const broken = policyFor({ DEPOSIT_CONFIRMATIONS_ETHEREUM_MAINNET: "0", DEPOSIT_MIN_AMOUNT_ETHEREUM_MAINNET: "lots" }).networks.find(
    (network) => network.slug === "ethereum-mainnet",
  );
  assert.equal(broken?.status, "invalid-config");
  assert.equal(broken?.problems.length, 2);
  assert.equal(broken?.confirmations, 12);
});

test("a half-configured token is a named gap, never the registry's as a silent fallback", () => {
  const complete = policyFor({
    DEPOSIT_TOKEN_ADDRESS_ETHEREUM_MAINNET: "0x1111111111111111111111111111111111111111",
    DEPOSIT_TOKEN_DECIMALS_ETHEREUM_MAINNET: "8",
    DEPOSIT_TOKEN_SYMBOL_ETHEREUM_MAINNET: "TST",
  }).networks.find((network) => network.slug === "ethereum-mainnet");
  assert.deepEqual(
    { address: complete?.token?.address, decimals: complete?.token?.decimals, symbol: complete?.token?.symbol },
    { address: "0x1111111111111111111111111111111111111111", decimals: 8, symbol: "TST" },
  );
  assert.equal(complete?.configuredBy.token, true);

  const half = policyFor({ DEPOSIT_TOKEN_ADDRESS_ETHEREUM_MAINNET: "0x1111111111111111111111111111111111111111" }).networks.find(
    (network) => network.slug === "ethereum-mainnet",
  );
  assert.equal(half?.status, "missing-token");
  assert.equal(half?.token, null);
  assert.deepEqual(half?.missing, ["DEPOSIT_TOKEN_DECIMALS_ETHEREUM_MAINNET"]);

  const malformed = policyFor({
    DEPOSIT_TOKEN_ADDRESS_ETHEREUM_MAINNET: "not-an-address",
    DEPOSIT_TOKEN_DECIMALS_ETHEREUM_MAINNET: "6",
  }).networks.find((network) => network.slug === "ethereum-mainnet");
  assert.equal(malformed?.status, "invalid-config");
  assert.match(malformed?.problems[0] ?? "", /20-byte hex address/);
});

test("the registry states what each deposit token actually is", () => {
  // A ticker that overstates the token is the one thing this file must not do:
  // only Ethereum mainnet carries the contract Tether issues and redeems.
  assert.equal(getDepositNetwork("ethereum-mainnet")?.token?.decimals, 6);
  assert.equal(getDepositNetwork("ethereum-mainnet")?.token?.note, undefined);
  assert.match(getDepositNetwork("bnb-mainnet")?.token?.note ?? "", /Binance-Peg/);
  assert.equal(getDepositNetwork("bnb-mainnet")?.token?.decimals, 18);
  assert.match(getDepositNetwork("base-mainnet")?.token?.note ?? "", /Bridged/);
  for (const network of DEPOSIT_NETWORKS.filter((candidate) => candidate.testnet)) {
    assert.equal(network.token, null);
  }
  assert.equal(new Set(DEPOSIT_NETWORKS.map((network) => network.slug)).size, DEPOSIT_NETWORKS.length);
  assert.equal(depositEnvKey("DEPOSIT_CONFIRMATIONS", "arb-mainnet"), "DEPOSIT_CONFIRMATIONS_ARB_MAINNET");
});

test("credited deposits are summed with decimals, and a value that is not a number is skipped", () => {
  assert.deepEqual(
    sumCreditedTotals([
      { tokenSymbol: "USDT", amount: "10.5" },
      { tokenSymbol: "USDT", amount: "9.5" },
      { tokenSymbol: "USDC", amount: "1" },
      { tokenSymbol: "USDT", amount: "not-a-number" },
    ]),
    [
      { tokenSymbol: "USDC", amount: "1" },
      { tokenSymbol: "USDT", amount: "20" },
    ],
  );
});

test("with nothing configured the surface says which variable is missing", () => {
  const unconfigured = availabilityOf(readDepositPolicy(TEST_ENV));
  assert.equal(unconfigured?.variable, "DEPOSIT_ADDRESS_MNEMONIC");
  assert.match(unconfigured?.message ?? "", /cannot derive a deposit address/);

  // A list whose every entry the registry rejects leaves nothing enabled, and the
  // gap names the list rather than the seed — the owner's edit, not the seed.
  const noNetworks = availabilityOf(
    readDepositPolicy({ ...TEST_ENV, DEPOSIT_ADDRESS_MNEMONIC: MNEMONIC, DEPOSIT_ENABLED_NETWORKS: "dogecoin" }),
  );
  assert.equal(noNetworks?.variable, "DEPOSIT_ENABLED_NETWORKS");
});

test("the view an owner reads carries the address, the confirmations required and the wait", async () => {
  const store = new InMemoryDepositStore();
  const policy = policyFor();
  const derived = deriveDepositAddressFor(MNEMONIC, "user-1", "ethereum-mainnet");
  await store.insertAddressOnce(addressRow("user-1", "ethereum-mainnet", derived.address, derived.index));
  const [address] = store.addresses;
  await store.insertDepositOnce(depositRow({ depositAddressId: address.id, confirmations: 1 }));

  const { view, issuance } = await describeDepositsForUser({ userId: "user-1", store, policy });
  assert.equal(issuance.created.length, 0);
  assert.equal(issuance.existing.length, 1);

  const ethereum = view.networks.find((network) => network.slug === "ethereum-mainnet");
  assert.equal(ethereum?.address, derived.address);
  assert.equal(ethereum?.derivationPath, `m/44'/60'/0'/0/${derived.index}`);
  assert.equal(ethereum?.confirmations, 12);
  assert.equal(ethereum?.depositCount, 1);

  const shown = view.deposits[0];
  assert.equal(shown.confirmationsRequired, 12);
  assert.equal(shown.stateLabel, "PENDING");
  assert.match(shown.wait ?? "", /1 of 12 confirmation\(s\); 11 more before it is credited/);
  // The link the owner can follow to check for themselves, and the total that is
  // the sum of credited rows only.
  assert.equal(shown.explorerUrl, `https://etherscan.io/tx/0xaaaa`);
  assert.deepEqual(view.creditedTotals, []);
  assert.equal(view.configured, true);
});

test("the explorer helpers are per network, and a network without one is null", () => {
  assert.equal(depositTransactionUrl("ethereum-mainnet", "0xabc"), "https://etherscan.io/tx/0xabc");
  assert.equal(depositAddressUrl("base-mainnet", "0xabc"), "https://basescan.org/address/0xabc");
  assert.equal(depositTransactionUrl("not-a-network", "0xabc"), null);
  assert.equal(formatDepositInterval(5), "5 minutes");
  assert.equal(formatDepositInterval(60), "1 hour");
  assert.equal(formatDepositInterval(1_440), "1 day");
});
