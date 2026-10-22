import { reason, serializeReason, type Reason } from "@/lib/observability/reason";
import {
  ensureDepositAddressesForUser,
  type DepositAddressRow,
  type IssuanceOutcome,
} from "./addresses";
import { createChainReader } from "./chain";
import { creditDeposit, creditedTotalsForUser, describeDepositWait, type CreditedTotal } from "./credit";
import { readDepositPolicy, type DepositNetworkPolicy, type DepositPolicy } from "./policy";
import { depositTransactionUrl } from "./registry";
import { depositStore, type DepositRow, type DepositStore } from "./store";
import { classifyObservation, describePendingConfirmations, reconcilePendingDeposits, recordObservation, scanNetwork } from "./watcher";

/**
 * The composition: one watcher run, and the view an owner reads.
 *
 * The run is written so that a single network failing cannot stop the others, and
 * so that "nothing to do" is never reported as success without a sentence. Every
 * skip and every failure carries the shared `Reason`, which is what the run
 * summary, the job's heartbeat and the deposit panel all read.
 */

const MAX_LISTED_DEPOSITS = 50;

export type DepositRunSummary = {
  /** Networks the policy allows this run to touch. */
  networks: number;
  /** Networks whose block range was actually read. */
  scanned: number;
  observations: number;
  recorded: number;
  duplicates: number;
  credited: number;
  reverted: number;
  awaiting: number;
  skipped: { network: string; reason: Reason }[];
  failed: { network: string; reason: Reason }[];
  worked: boolean;
  reason: Reason | null;
  detail: Record<string, number | string | boolean | null>;
};

export type DepositRunDependencies = {
  store?: DepositStore;
  policy?: DepositPolicy;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: Date;
};

/**
 * One pass of the deposit watcher: scan every enabled network, record what is
 * new, then re-check and credit what was already pending.
 *
 * Safe to run twice, in parallel, or after a restart — the record step is keyed by
 * the chain's own identity for a transfer and the credit step is a claim, so a
 * repeated run finds its own work already done and says so.
 */
export async function runDepositWatcher(dependencies: DepositRunDependencies = {}): Promise<DepositRunSummary> {
  const store = dependencies.store ?? depositStore;
  const policy = dependencies.policy ?? readDepositPolicy(dependencies.env);
  const now = dependencies.now ?? new Date();

  const summary: DepositRunSummary = {
    networks: policy.enabledNetworks.length,
    scanned: 0,
    observations: 0,
    recorded: 0,
    duplicates: 0,
    credited: 0,
    reverted: 0,
    awaiting: 0,
    skipped: [],
    failed: [],
    worked: false,
    reason: null,
    detail: {},
  };

  if (!policy.mnemonic) {
    summary.reason = reason("MISSING_CONFIGURATION", {
      variable: "DEPOSIT_ADDRESS_MNEMONIC",
      message: "DEPOSIT_ADDRESS_MNEMONIC is not configured, so no deposit address exists to watch for.",
    });
    return summary;
  }
  if (policy.enabledNetworks.length === 0) {
    summary.reason = reason("MISSING_CONFIGURATION", {
      variable: "DEPOSIT_ENABLED_NETWORKS",
      message: "No deposit network is enabled, so the watcher has nothing to read.",
    });
    return summary;
  }

  for (const network of policy.enabledNetworks) {
    if (network.status !== "ready") {
      summary.skipped.push({
        network: network.slug,
        reason: reason("MISSING_CONFIGURATION", {
          variable: network.missing[0] ?? network.problems[0],
          message:
            network.status === "missing-token"
              ? `${network.displayName} has no deposit token configured, so its addresses were not watched.`
              : network.status === "missing-rpc"
                ? `${network.displayName} has no RPC endpoint configured, so the chain could not be read.`
                : `${network.displayName} is not configured correctly: ${network.problems[0] ?? "see the deposit policy"}.`,
        }),
      });
      continue;
    }

    const created = createChainReader(network.alchemyNetwork, { fetch: dependencies.fetch, env: dependencies.env });
    if (!created.ok) {
      summary.failed.push({
        network: network.slug,
        reason: reason("MISSING_CONFIGURATION", {
          variable: network.missing[0],
          message: `${network.displayName} could not be read: no usable RPC endpoint is configured.`,
        }),
      });
      continue;
    }

    try {
      const addresses = await store.listAddressesByNetwork(network.slug);
      const cursor = await store.readCursor(network.slug);
      const scan = await scanNetwork({
        policy: network,
        reader: created.reader,
        addresses,
        watchBlocks: policy.watchBlocks,
        scanUnfiltered: policy.scanUnfiltered,
        cursor,
      });

      for (const observation of scan.observations) {
        summary.observations += 1;
        const classification = classifyObservation(observation, { policy: network, addresses });
        const outcome = await recordObservation({ store, observation, classification, now });
        if (outcome.created) summary.recorded += 1;
        else summary.duplicates += 1;
      }

      // The second look runs whenever the chain answered, including a run that
      // found no new blocks: a reorg can void a pending transfer without any new
      // block being produced, and the owner should not have to wait for one.
      if (scan.skipped === null || scan.skipped.code === "NOT_YET_DUE") {
        const reconciliation = await reconcilePendingDeposits({
          store,
          policy: network,
          reader: created.reader,
          head: scan.head,
          now,
          credit: (row, confirmations) => creditDeposit({ store, policy: network, row, confirmations, now }).then((outcome) => outcome.credited),
        });
        summary.credited += reconciliation.credited;
        summary.reverted += reconciliation.reverted;
        summary.awaiting += reconciliation.awaiting;
      }

      if (scan.skipped === null) {
        summary.scanned += 1;
        await store.writeCursor(network.slug, scan.toBlock);
        summary.detail[`${network.slug}Range`] = `${scan.fromBlock}-${scan.toBlock} of ${scan.head}`;
      } else {
        summary.skipped.push({ network: network.slug, reason: scan.skipped });
      }
      summary.detail[`${network.slug}Observed`] = scan.observations.length;
    } catch (error) {
      summary.failed.push({
        network: network.slug,
        reason: reason("PROVIDER_ERROR", {
          providerId: "alchemy-rpc",
          message: `${network.displayName} could not be read, so its deposits were not checked: ${error instanceof Error ? error.message : "unknown error"}`,
        }),
      });
    }
  }

  summary.worked = summary.recorded > 0 || summary.credited > 0 || summary.reverted > 0;
  summary.reason = summarizeRun({
    networks: summary.networks,
    scanned: summary.scanned,
    recorded: summary.recorded,
    duplicates: summary.duplicates,
    credited: summary.credited,
    reverted: summary.reverted,
    awaiting: summary.awaiting,
    skipped: summary.skipped,
    failed: summary.failed,
  });
  return summary;
}

function summarizeRun(input: {
  networks: number;
  scanned: number;
  recorded: number;
  duplicates: number;
  credited: number;
  reverted: number;
  awaiting: number;
  skipped: { network: string; reason: Reason }[];
  failed: { network: string; reason: Reason }[];
}): Reason | null {
  if (input.credited > 0 || input.reverted > 0 || input.recorded > 0) return null;
  if (input.failed.length > 0) {
    const first = input.failed[0]!;
    return reason("PROVIDER_ERROR", {
      message: `${input.failed.length} of ${input.networks} network(s) could not be read: ${first.reason.message}`,
      detail: `first failure on ${first.network}`,
      providerId: "alchemy-rpc",
    });
  }
  if (input.awaiting > 0) {
    return reason("AWAITING_CONFIRMATIONS", {
      message: `${input.awaiting} pending deposit(s) are on chain and still short of their confirmation count.`,
    });
  }
  if (input.duplicates > 0) {
    return reason("ALREADY_COMPLETED", {
      message: `Every transfer in the scanned block range was already recorded (${input.duplicates} known event(s)), so nothing was credited twice.`,
    });
  }
  if (input.skipped.length > 0) {
    const first = input.skipped[0]!;
    return reason(first.reason.code, {
      message: `${input.skipped.length} of ${input.networks} network(s) had nothing to read: ${first.reason.message}`,
      ...(first.reason.variable ? { variable: first.reason.variable } : {}),
      detail: first.network,
    });
  }
  return reason("NO_ENTRY_CONDITION", {
    message: `${input.scanned} network(s) were read and no new transfer addressed to a deposit address was found.`,
  });
}

export type DepositView = {
  configured: boolean;
  availability: ReturnType<typeof serializeReason> | null;
  /** Problems with the policy as a whole, e.g. a slug the registry does not know. */
  problems: string[];
  watchIntervalMinutes: number;
  scanUnfiltered: boolean;
  creditedTotals: CreditedTotal[];
  networks: (DepositNetworkPolicy & { address: string | null; derivationPath: string | null; depositCount: number })[];
  deposits: (DepositRow & {
    networkDisplayName: string;
    stateLabel: string;
    confirmationsRequired: number;
    explorerUrl: string | null;
    wait: string | null;
  })[];
};

/**
 * What the owner sees on the deposit surface, and what a *fresh* account sees
 * when it arrives for the first time: the same call issues any missing address
 * (exactly once) and then reads. Nothing here depends on a browser being open —
 * the watcher credits with or without one — and nothing here invents a balance:
 * the total shown is the sum of deposits that reached CREDITED.
 */
export async function describeDepositsForUser(input: {
  userId: string;
  store?: DepositStore;
  policy?: DepositPolicy;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<{ view: DepositView; issuance: IssuanceOutcome }> {
  const store = input.store ?? depositStore;
  const policy = input.policy ?? readDepositPolicy(input.env);
  const now = input.now ?? new Date();

  const issuance = await ensureDepositAddressesForUser({ userId: input.userId, store, policy, now });
  const [addresses, deposits, creditedTotals] = await Promise.all([
    store.listAddressesForUser(input.userId),
    store.listDepositsForUser(input.userId, MAX_LISTED_DEPOSITS),
    creditedTotalsForUser(store, input.userId),
  ]);

  return { view: buildView({ policy, addresses, deposits, creditedTotals }), issuance };
}

export function buildView(input: {
  policy: DepositPolicy;
  addresses: readonly DepositAddressRow[];
  deposits: readonly DepositRow[];
  creditedTotals: CreditedTotal[];
}): DepositView {
  const byNetwork = new Map(input.addresses.map((row) => [row.network, row]));
  const depositsByNetwork = new Map<string, number>();
  for (const deposit of input.deposits) {
    depositsByNetwork.set(deposit.network, (depositsByNetwork.get(deposit.network) ?? 0) + 1);
  }

  return {
    configured: input.policy.enabledNetworks.some((network) => network.status === "ready") && input.policy.mnemonic !== null,
    availability: availabilityOf(input.policy),
    problems: input.policy.problems,
    watchIntervalMinutes: input.policy.watchIntervalMinutes,
    scanUnfiltered: input.policy.scanUnfiltered,
    creditedTotals: input.creditedTotals,
    networks: input.policy.networks.map((network) => {
      const row = byNetwork.get(network.slug);
      return {
        ...network,
        address: row?.address ?? null,
        derivationPath: row ? `m/44'/60'/0'/0/${row.derivationIndex}` : null,
        depositCount: depositsByNetwork.get(network.slug) ?? 0,
      };
    }),
    deposits: input.deposits.map((deposit) => {
      const network = input.policy.networks.find((candidate) => candidate.slug === deposit.network);
      return {
        ...deposit,
        networkDisplayName: network?.displayName ?? deposit.network,
        stateLabel: deposit.status,
        confirmationsRequired: network?.confirmations ?? 0,
        // The link the owner can follow to see the transfer for themselves. Null
        // when the network has no explorer listed, and the panel shows the hash
        // as text rather than a dead link.
        explorerUrl: depositTransactionUrl(deposit.network, deposit.txHash),
        wait:
          deposit.status === "PENDING" && network
            ? describePendingConfirmations(deposit, network.confirmations)
            : null,
      };
    }),
  };
}

export function availabilityOf(policy: DepositPolicy) {
  if (!policy.mnemonic) {
    return serializeReason(
      reason("MISSING_CONFIGURATION", {
        variable: "DEPOSIT_ADDRESS_MNEMONIC",
        message: "DEPOSIT_ADDRESS_MNEMONIC is not configured, so this deployment cannot derive a deposit address.",
      }),
    );
  }
  if (policy.enabledNetworks.length === 0) {
    return serializeReason(
      reason("MISSING_CONFIGURATION", {
        variable: "DEPOSIT_ENABLED_NETWORKS",
        message: "No deposit network is enabled. Set DEPOSIT_ENABLED_NETWORKS, and configure a token for each network it names.",
      }),
    );
  }
  return null;
}

/** One address, for the per-address surface: the rows and the policy that governs them. */
export async function describeDepositAddress(input: {
  userId: string;
  address: string;
  store?: DepositStore;
  policy?: DepositPolicy;
  env?: NodeJS.ProcessEnv;
}): Promise<{ found: boolean; network: DepositNetworkPolicy | null; address: DepositAddressRow | null; deposits: (DepositRow & { wait: string | null })[] }> {
  const store = input.store ?? depositStore;
  const policy = input.policy ?? readDepositPolicy(input.env);
  const addresses = await store.listAddressesForUser(input.userId);
  const row = addresses.find((candidate) => candidate.address.toLowerCase() === input.address.toLowerCase()) ?? null;
  if (!row) return { found: false, network: null, address: null, deposits: [] };
  const network = policy.networks.find((candidate) => candidate.slug === row.network) ?? null;
  const deposits = await store.listDepositsForAddress(row.id, MAX_LISTED_DEPOSITS);
  return {
    found: true,
    network,
    address: row,
    deposits: deposits.map((deposit) => ({
      ...deposit,
      wait: deposit.status === "PENDING" && network ? describePendingConfirmations(deposit, network.confirmations) : null,
    })),
  };
}

export { describeDepositWait };
