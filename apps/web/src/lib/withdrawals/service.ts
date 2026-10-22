import { depositAddressUrl, depositTransactionUrl } from "@/lib/deposits/registry";
import { formatFeeAmount } from "@/lib/fees/amounts";
import { withdrawalHoldBucket } from "@/lib/ledger/accounts";
import { decimalStringFromMinorUnits } from "@/lib/ledger/integer-cent-ledger";
import { userAssetBalances } from "@/lib/ledger/withdrawals";
import { isReasonCode, reason, serializeReason, type Reason, type SerializedReason } from "@/lib/observability/reason";
import { cancellationOffer, confirmWithdrawal, expireWithdrawal, holdHasPassed, reconcileCancellation } from "./confirm";
import { senderWallet, type WithdrawalChainPort } from "./chain";
import { executeWithdrawal } from "./execute";
import {
  withdrawalAvailabilityReason,
  withdrawalFeeLabel,
  formatWithdrawalWindow,
  type WithdrawalNetworkPolicy,
  type WithdrawalPolicy,
} from "./policy";
import { readEffectiveWithdrawalPolicy, readPricedWithdrawalPolicy } from "./settings";
import { withdrawalStateLabel, withdrawalStateSummary } from "./states";
import { withdrawalStore, type WithdrawalRow, type WithdrawalStore } from "./store";

/**
 * The composition: one pass of the withdrawal runner, and the view the owner reads.
 *
 * The pass is written so that one withdrawal failing cannot stop the others, and so that
 * \"nothing to do\" is never reported as success without a sentence — every step's reason is
 * the shared one, which is what the heartbeat, the job list and the panel all read.
 *
 * The order inside one pass matters and is deliberate: a held request whose window has
 * passed is released into the queue *and* sent in the same pass, so an owner who configured
 * a two-minute window does not wait a third pass for the send; a request that has expired is
 * ended rather than sent; and a sent row is confirmed before anything else is tried on it.
 * A row that a previous pass left in `BROADCAST_FAILED` is retried here, with the bytes it
 * already carries, which is why a retry cannot become a second transaction.
 */

const MAX_WITHDRAWALS_PER_PASS = 50;
const MAX_LISTED_WITHDRAWALS = 50;

export type WithdrawalRunSummary = {
  /** Rows this pass considered. */
  live: number;
  /** Held requests whose window had passed and were moved into the queue. */
  releasedFromHold: number;
  /** Rows this pass sent. */
  broadcast: number;
  /** Rows whose send was refused. They stay reserved. */
  broadcastFailed: number;
  /** Rows that reached their confirmation count and settled. */
  confirmed: number;
  /** Rows that reverted, or expired, and had their amount released. */
  failed: number;
  /** Rows the owner's cancellation ended. */
  cancelled: number;
  /** Rows still on their way, or still inside their hold window. */
  pending: number;
  skipped: { withdrawalId: string; reason: Reason }[];
  worked: boolean;
  reason: Reason | null;
  detail: Record<string, number | string | boolean | null>;
};

export type WithdrawalRunDependencies = {
  store?: WithdrawalStore;
  policy?: WithdrawalPolicy;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  limit?: number;
  /** Restrict the pass to one account's rows, which is what the panel's check-now does. */
  userId?: string;
  /** Overridden by a test, so no chain is contacted. */
  chainFactory?: (network: WithdrawalNetworkPolicy) => WithdrawalChainPort;
};

/**
 * One pass: advance every withdrawal that is still in flight.
 *
 * Safe to run twice, in parallel, or after a restart. Every step that moves a row does it
 * with a compare-and-set claim, so two runners advancing the same withdrawal produce one
 * broadcast and one audit row — and a re-send of signed bytes is one transaction on chain
 * even when both runners get that far.
 */
export async function runWithdrawalProcessor(dependencies: WithdrawalRunDependencies = {}): Promise<WithdrawalRunSummary> {
  const store = dependencies.store ?? withdrawalStore;
  const policy = dependencies.policy ?? (await readEffectiveWithdrawalPolicy(dependencies.env));
  const now = dependencies.now ?? new Date();
  const limit = dependencies.limit ?? MAX_WITHDRAWALS_PER_PASS;

  const summary: WithdrawalRunSummary = {
    live: 0,
    releasedFromHold: 0,
    broadcast: 0,
    broadcastFailed: 0,
    confirmed: 0,
    failed: 0,
    cancelled: 0,
    pending: 0,
    skipped: [],
    worked: false,
    reason: null,
    detail: {},
  };

  const live = dependencies.userId
    ? (await store.listWithdrawalsForUser(dependencies.userId, limit)).filter(isLiveRow)
    : await store.listLiveWithdrawals(limit);
  summary.live = live.length;

  for (const starting of live) {
    let row = starting;
    try {
      // ── the owner's own hold window ──────────────────────────────────────────
      if (holdHasPassed(row, now)) {
        const claimed = await store.claimWithdrawal(row.id, ["HELD"], {
          status: "RESERVED",
          reasonCode: null,
          reasonMessage: null,
          lastCheckedAt: now,
        });
        if (claimed) {
          summary.releasedFromHold += 1;
          await store.recordAudit({
            actorUserId: row.userId,
            action: "WITHDRAWAL_HOLD_RELEASED",
            objectType: "Withdrawal",
            objectId: row.id,
            outcome: "SUCCESS",
            payload: {
              network: row.network,
              asset: row.asset,
              amountMinor: row.amountMinor,
              destination: row.destinationDisplay,
              heldUntil: row.holdUntil?.toISOString() ?? null,
              newAddressWindowMinutes: policy.newAddressWindowMinutes,
              releasedAt: now.toISOString(),
            },
          });
          row = (await store.findWithdrawalById(row.id)) ?? row;
        }
      }
      if (row.status === "HELD") {
        summary.pending += 1;
        summary.skipped.push({
          withdrawalId: row.id,
          reason: reason("WITHDRAWAL_HELD", {
            message:
              `Withdrawal ${row.id} is held until ${row.holdUntil?.toISOString() ?? "its window ends"}, because it is the first ` +
              "send to that address.",
          }),
        });
        continue;
      }

      // ── a request that was never sent ────────────────────────────────────────
      if (row.status === "RESERVED" || row.status === "BROADCAST_FAILED") {
        if (row.expiresAt.getTime() <= now.getTime()) {
          const expired = await expireWithdrawal({ store, policy, row, now });
          if (expired.kind === "failed") {
            summary.failed += 1;
            continue;
          }
        }
      }

      // ── the owner's stop switch ───────────────────────────────────────────────
      // A paused deployment sends nothing new. Rows already in flight are still read
      // below, so a confirmation is never lost and the book can still say where the
      // money went; what stops is placing more of it on the wire.
      if (policy.withdrawalsPaused && (row.status === "RESERVED" || row.status === "BROADCAST_FAILED")) {
        summary.pending += 1;
        summary.skipped.push({
          withdrawalId: row.id,
          reason: reason("WITHDRAWALS_PAUSED", {
            message: `Withdrawal ${row.id} is reserved and will not be sent while the owner's pause is in force.`,
          }),
        });
        continue;
      }

      // ── sending, and reading what the chain says ─────────────────────────────
      if (row.status === "RESERVED" || row.status === "BROADCAST_FAILED") {
        const executed = await executeWithdrawal({
          store,
          policy,
          row,
          now,
          ...(dependencies.chainFactory ? { chainFactory: dependencies.chainFactory } : {}),
        });
        if (executed.kind === "broadcast") summary.broadcast += 1;
        else if (executed.kind === "broadcast-failed") {
          summary.broadcastFailed += 1;
          summary.skipped.push({
            withdrawalId: row.id,
            reason: executed.reason ?? reason("NETWORK_UNAVAILABLE", { message: `Withdrawal ${row.id} could not be sent.` }),
          });
        }
        row = executed.row ?? row;
      }

      if (row.status === "BROADCAST") {
        const confirmed = await confirmWithdrawal({
          store,
          policy,
          row,
          now,
          ...(dependencies.chainFactory ? { chainFactory: dependencies.chainFactory } : {}),
        });
        if (confirmed.kind === "confirmed") summary.confirmed += 1;
        else if (confirmed.kind === "failed") summary.failed += 1;
        else {
          row = confirmed.row ?? row;
          // A row whose cancellation was attempted has two hashes; the confirmation read
          // only settled the original, so the replacement is read next. Which one took the
          // nonce is the chain's answer, and this is where it is read.
          if (row.status === "BROADCAST" && row.cancelTxHash) {
            const reconciled = await reconcileCancellation({
              store,
              policy,
              row,
              now,
              ...(dependencies.chainFactory ? { chainFactory: dependencies.chainFactory } : {}),
            });
            if (reconciled.kind === "cancelled") summary.cancelled += 1;
            else summary.pending += 1;
          } else {
            summary.pending += 1;
            if (confirmed.reason) summary.skipped.push({ withdrawalId: row.id, reason: confirmed.reason });
          }
        }
      }
    } catch (error) {
      summary.skipped.push({
        withdrawalId: row.id,
        reason: reason("UNKNOWN", {
          message: `Withdrawal ${row.id} could not be advanced: ${error instanceof Error ? error.message : "unknown error"}`,
        }),
      });
    }
  }

  summary.worked =
    summary.releasedFromHold > 0 ||
    summary.broadcast > 0 ||
    summary.confirmed > 0 ||
    summary.failed > 0 ||
    summary.cancelled > 0;
  summary.reason = summarizeRun(summary, policy);
  summary.detail = {
    live: summary.live,
    releasedFromHold: summary.releasedFromHold,
    broadcast: summary.broadcast,
    broadcastFailed: summary.broadcastFailed,
    confirmed: summary.confirmed,
    failed: summary.failed,
    cancelled: summary.cancelled,
    pending: summary.pending,
    broadcastMode: policy.broadcastMode,
    simulated: policy.broadcastMode === "simulated",
  };
  return summary;
}

function isLiveRow(row: WithdrawalRow): boolean {
  return row.status === "HELD" || row.status === "RESERVED" || row.status === "BROADCAST_FAILED" || row.status === "BROADCAST";
}

/**
 * One sentence for a pass that did nothing, in the same vocabulary the rest of the app uses.
 *
 * A run that advanced nothing is not a failure and not a success: it is a run that found
 * nothing to do, and the sentence says which nothing — everything held, everything waiting on
 * a confirmation, or nothing in flight at all. The order below is the order of how much the
 * owner should care.
 */
function summarizeRun(summary: WithdrawalRunSummary, policy: WithdrawalPolicy): Reason | null {
  if (summary.live === 0) {
    return reason("NO_ENTRY_CONDITION", {
      message: "No withdrawal is in flight, so there was nothing to advance.",
    });
  }
  if (summary.broadcastFailed > 0) {
    const first = summary.skipped.find((entry) => entry.reason.retryable);
    return reason("NETWORK_UNAVAILABLE", {
      message:
        `${summary.broadcastFailed} withdrawal(s) could not be sent and stay reserved; the next pass retries them` +
        (first ? `: ${first.reason.message}` : "."),
      ...(first?.reason.providerId ? { providerId: first.reason.providerId } : {}),
    });
  }
  if (summary.pending > 0 && summary.releasedFromHold === 0) {
    return reason("AWAITING_CONFIRMATIONS", {
      message:
        `${summary.pending} withdrawal(s) are either inside the owner's new-address window or waiting for confirmations; ` +
        `the processor runs every ${policy.processIntervalMinutes} minute${policy.processIntervalMinutes === 1 ? "" : "s"}, ` +
        "or you can ask for a check now.",
    });
  }
  if (summary.worked) return null;
  return reason("NO_ENTRY_CONDITION", {
    message: `${summary.live} withdrawal(s) were checked and none of them changed state in this pass.`,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// What the owner reads.
// ─────────────────────────────────────────────────────────────────────────────

export type WithdrawalResource = {
  id: string;
  network: string;
  networkDisplayName: string;
  chainId: number;
  asset: string;
  decimals: number;
  /** The gross the owner authorised, as a person reads it. */
  amount: string;
  amountMinor: string;
  fee: string;
  feeMinor: string;
  /** What the chain is asked to send. */
  net: string;
  netMinor: string;
  destination: string;
  destinationDisplay: string;
  status: string;
  statusLabel: string;
  /** The state and its reason in one line, which is what a row in the list shows. */
  statusSummary: string;
  reason: SerializedReason | null;
  /** The hash of the transfer, visible from the moment it is broadcast. */
  txHash: string | null;
  explorerUrl: string | null;
  /** The replacement a cancellation attempt sent, when there is one. */
  cancelTxHash: string | null;
  cancelExplorerUrl: string | null;
  nonce: number | null;
  fromAddress: string | null;
  confirmations: number;
  confirmationsRequired: number | null;
  holdUntil: string | null;
  expiresAt: string;
  timeoutAt: string | null;
  broadcastAt: string | null;
  confirmedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  releasedAt: string | null;
  attempts: number;
  createdAt: string;
  /** Whether a cancel is worth offering now, and why not when it is not. */
  cancellable: boolean;
  cancellationReason: SerializedReason | null;
  /** True when this transfer was sent by the development simulation, not a real chain. */
  simulated: boolean;
};

/**
 * One withdrawal as a response body.
 *
 * The signed bytes are deliberately *not* here: they are a signature over the owner's money,
 * and a browser never needs them — the hash is what identifies the transfer, and the row keeps
 * the bytes so a retry can re-send them. Everything a person could want in order to check the
 * transfer for themselves is here, including the explorer link, and a network with no explorer
 * listed returns null for it so the panel shows the hash as text rather than a dead link.
 */
export function withdrawalResource(row: WithdrawalRow, input: { policy: WithdrawalPolicy; now?: Date }): WithdrawalResource {
  const now = input.now ?? new Date();
  const network = input.policy.networks.find((candidate) => candidate.slug === row.network) ?? null;
  const offer = cancellationOffer(row, now);
  return {
    id: row.id,
    network: row.network,
    networkDisplayName: network?.displayName ?? row.network,
    chainId: row.chainId,
    asset: row.asset,
    decimals: row.decimals,
    amount: decimalStringFromMinorUnits(row.amountMinor, row.decimals),
    amountMinor: row.amountMinor,
    fee: decimalStringFromMinorUnits(row.feeMinor, row.decimals),
    feeMinor: row.feeMinor,
    net: decimalStringFromMinorUnits(row.netMinor, row.decimals),
    netMinor: row.netMinor,
    destination: row.destination,
    destinationDisplay: row.destinationDisplay,
    status: row.status,
    statusLabel: withdrawalStateLabel(row.status),
    statusSummary: withdrawalStateSummary(row.status, row.reasonCode, row.reasonMessage),
    reason: reasonOf(row),
    txHash: row.txHash,
    explorerUrl: row.txHash ? depositTransactionUrl(row.network, row.txHash) : null,
    cancelTxHash: row.cancelTxHash,
    cancelExplorerUrl: row.cancelTxHash ? depositTransactionUrl(row.network, row.cancelTxHash) : null,
    nonce: row.nonce,
    fromAddress: row.fromAddress,
    confirmations: row.confirmations,
    confirmationsRequired: row.confirmationsRequired,
    holdUntil: row.holdUntil?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    timeoutAt: row.timeoutAt?.toISOString() ?? null,
    broadcastAt: row.broadcastAt?.toISOString() ?? null,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    releasedAt: row.releasedAt?.toISOString() ?? null,
    attempts: row.attempts,
    createdAt: row.createdAt.toISOString(),
    cancellable: offer.offered,
    cancellationReason: offer.reason ? serializeReason(offer.reason) : null,
    simulated: input.policy.broadcastMode === "simulated",
  };
}

/** The reason a row carries, read back off its two columns. */
export function reasonOf(row: WithdrawalRow): SerializedReason | null {
  if (!row.reasonCode) return null;
  const code = isReasonCode(row.reasonCode) ? row.reasonCode : "UNKNOWN";
  return serializeReason(reason(code, { message: row.reasonMessage ?? undefined }));
}

export type WithdrawalAssetBalance = {
  asset: string;
  decimals: number;
  /** What the account can spend now, exact. */
  availableMinor: string;
  available: string;
  /** What is held against withdrawals in flight. */
  heldMinor: string;
  held: string;
};

export type WithdrawalView = {
  configured: boolean;
  availability: SerializedReason | null;
  problems: string[];
  broadcastMode: "onchain" | "simulated";
  /** The sending wallet's address, or null when the deployment has none. */
  hotWalletAddress: string | null;
  hotWalletExplorerUrl: string | null;
  newAddressWindowMinutes: number;
  windowLabel: string;
  /** Whether that window is the owner's stored setting or this deployment's default. */
  windowSource: WithdrawalPolicy["newAddressWindowSource"];
  requestExpiryMinutes: number;
  cancelAfterMinutes: number;
  /** The platform's fee per asset, exact, as the request path will charge it. */
  feeByAsset: Record<string, string>;
  /** What the chain costs to send, per asset. Disclosed only; never deducted. */
  networkCostByAsset: Record<string, string>;
  /** Whether those prices came from the stored fee table or this deployment's values. */
  feeSource: WithdrawalPolicy["feeSource"];
  networks: {
    slug: string;
    chainId: number;
    displayName: string;
    confirmations: number;
    /** The fee as configured, exact. */
    fee: string;
    /** The fee in words: `no fee` when it is zero. */
    feeLabel: string;
    networkCost: string;
    networkCostLabel: string;
    token: WithdrawalNetworkPolicy["token"];
    /** Whether this network can be sent on right now; the reason it cannot is in `availability`. */
    ready: boolean;
  }[];
  balances: WithdrawalAssetBalance[];
  withdrawals: WithdrawalResource[];
};

/**
 * What the owner sees on the withdrawal surface.
 *
 * It reads the ledger for what can be spent and what is held, and the policy for everything
 * that governs a request — the fee, the window, the timeout, the networks — so the panel can
 * say what a withdrawal will cost and what will happen to it before the owner submits one.
 * A deployment with no sending wallet is reported as unconfigured with the variable named,
 * rather than as an empty list: the panel has to render an honest explanation, and a blank
 * panel would say nothing.
 */
export async function describeWithdrawalsForUser(input: {
  userId: string;
  store?: WithdrawalStore;
  policy?: WithdrawalPolicy;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<WithdrawalView> {
  const store = input.store ?? withdrawalStore;
  const policy = input.policy ?? (await readPricedWithdrawalPolicy({ env: input.env, now: input.now }));
  const now = input.now ?? new Date();
  const availability = withdrawalAvailabilityReason(policy);

  const rows = await store.listWithdrawalsForUser(input.userId, MAX_LISTED_WITHDRAWALS);
  const ledger = store.ledger();

  const assets = [...new Set(policy.networks.map((network) => network.token.symbol))].sort();
  const balances: WithdrawalAssetBalance[] = [];
  for (const asset of assets) {
    const decimals = policy.networks.find((network) => network.token.symbol === asset)?.token.decimals ?? 0;
    const perBucket = await userAssetBalances(ledger, { userId: input.userId, asset });
    const available = perBucket.get("AVAILABLE")?.minor ?? BigInt(0);
    const held = perBucket.get(withdrawalHoldBucket())?.minor ?? BigInt(0);
    balances.push({
      asset,
      decimals,
      availableMinor: available.toString(),
      available: decimalStringFromMinorUnits(available.toString(), decimals),
      heldMinor: held.toString(),
      held: decimalStringFromMinorUnits(held.toString(), decimals),
    });
  }

  const wallet = policy.hotWalletMnemonic ? senderWallet(policy) : null;
  const hotWalletAddress = wallet?.ok ? wallet.address : null;
  const firstNetwork = policy.networks[0]?.slug ?? null;

  return {
    configured: availability === null,
    availability: availability ? serializeReason(availability) : null,
    problems: [...policy.problems, ...policy.source.problems],
    broadcastMode: policy.broadcastMode,
    hotWalletAddress,
    hotWalletExplorerUrl: hotWalletAddress && firstNetwork ? depositAddressUrl(firstNetwork, hotWalletAddress) : null,
    newAddressWindowMinutes: policy.newAddressWindowMinutes,
    windowLabel: formatWithdrawalWindow(policy.newAddressWindowMinutes),
    windowSource: policy.newAddressWindowSource,
    requestExpiryMinutes: policy.requestExpiryMinutes,
    cancelAfterMinutes: policy.cancelAfterMinutes,
    feeByAsset: policy.feeByAsset,
    networkCostByAsset: policy.networkCostByAsset,
    feeSource: policy.feeSource,
    networks: policy.networks.map((network) => {
      const usable = policy.source.networks.find((candidate) => candidate.slug === network.slug);
      const fee = withdrawalFeeLabel(network.token.symbol, policy);
      const networkCost = policy.networkCostByAsset[network.token.symbol] ?? "0";
      return {
        slug: network.slug,
        chainId: network.chainId,
        displayName: network.displayName,
        confirmations: network.confirmations,
        fee,
        feeLabel: formatFeeAmount(fee, network.token.symbol),
        networkCost,
        networkCostLabel: formatFeeAmount(networkCost, network.token.symbol),
        token: network.token,
        ready: usable?.status === "ready",
      };
    }),
    balances,
    withdrawals: rows.map((row) => withdrawalResource(row, { policy, now })),
  };
}

export type WithdrawalHealth = {
  id: "withdrawals";
  label: string;
  status: "reachable" | "degraded" | "unconfigured" | "unknown";
  detail: string;
  /** The variable that would fix it, when configuration is the cause. */
  variable?: string;
  broadcastMode: "onchain" | "simulated";
  /** How many withdrawals sit in each state. */
  counts: Record<string, number>;
  reason: SerializedReason | null;
};

/**
 * The health signal the admin panel reads for withdrawals.
 *
 * Three statuses and one refusal, each with a sentence that says what to do:
 *
 *  - **unconfigured** when there is no sending wallet or no ready network, naming the
 *    variable. Nothing can be withdrawn, which is a fact about the deployment and not a
 *    fault in the withdrawal path.
 *  - **degraded** when any withdrawal is stuck: a send that was refused, or one the chain
 *    reverted. The count of each is in the sentence, because "something is degraded" without
 *    a number is not something an owner can act on.
 *  - **unknown** when the rows could not be read at all. A read that failed asserted
 *    nothing, and calling it healthy would be the one lie this function could tell.
 *  - **reachable** otherwise, with the counts and — said in the same sentence — whether the
 *    transfers are real. A simulated confirmation is never allowed to read as a real one.
 */
export async function readWithdrawalHealth(input: {
  store?: WithdrawalStore;
  policy?: WithdrawalPolicy;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<WithdrawalHealth> {
  const store = input.store ?? withdrawalStore;
  const policy = input.policy ?? (await readEffectiveWithdrawalPolicy(input.env));
  const availability = withdrawalAvailabilityReason(policy);
  const simulationNote =
    policy.broadcastMode === "simulated"
      ? " Withdrawals are being sent by the development simulation: a confirmation here is a promise this code kept, not a chain."
      : "";

  let counts: Record<string, number>;
  try {
    counts = await store.countWithdrawalsByStatus();
  } catch (error) {
    return {
      id: "withdrawals",
      label: "Withdrawals",
      status: "unknown",
      detail: `The withdrawal rows could not be read, so nothing is asserted about them: ${error instanceof Error ? error.message : "unknown error"}.`,
      broadcastMode: policy.broadcastMode,
      counts: {},
      reason: null,
    };
  }

  if (availability) {
    return {
      id: "withdrawals",
      label: "Withdrawals",
      status: "unconfigured",
      detail: `${availability.message}${simulationNote}`,
      ...(availability.variable ? { variable: availability.variable } : {}),
      broadcastMode: policy.broadcastMode,
      counts,
      reason: serializeReason(availability),
    };
  }

  const stuck = (counts.BROADCAST_FAILED ?? 0) + (counts.FAILED ?? 0);
  const live = (counts.HELD ?? 0) + (counts.RESERVED ?? 0) + (counts.BROADCAST_FAILED ?? 0) + (counts.BROADCAST ?? 0);
  const summary =
    `${live} in flight (${counts.HELD ?? 0} held, ${counts.RESERVED ?? 0} queued, ${counts.BROADCAST ?? 0} sent, ` +
    `${counts.BROADCAST_FAILED ?? 0} refused by the network), ${counts.CONFIRMED ?? 0} confirmed, ` +
    `${counts.CANCELLED ?? 0} cancelled, ${counts.FAILED ?? 0} failed.`;

  if (stuck > 0) {
    return {
      id: "withdrawals",
      label: "Withdrawals",
      status: "degraded",
      detail: `${stuck} withdrawal(s) are not where they should be. ${summary}${simulationNote}`,
      broadcastMode: policy.broadcastMode,
      counts,
      reason: serializeReason(
        reason("NETWORK_UNAVAILABLE", {
          message: `${stuck} withdrawal(s) were refused by the network or reverted and are reported above.`,
        }),
      ),
    };
  }

  return {
    id: "withdrawals",
    label: "Withdrawals",
    status: "reachable",
    detail: summary + simulationNote,
    broadcastMode: policy.broadcastMode,
    counts,
    reason: null,
  };
}

/**
 * The reason a withdrawable route is not ready, for a network row that has one.
 * A network whose token this build does not know is simply absent from the list, and the
 * list is built from the policy so it can never offer a chain the sender cannot reach.
 */
export function networkRefusalReason(policy: WithdrawalPolicy, slug: string): SerializedReason | null {
  const known = policy.source.networks.find((network) => network.slug === slug);
  if (!known) return null;
  if (known.status === "ready") return null;
  return serializeReason(
    reason("NETWORK_UNSUPPORTED", {
      variable: known.missing[0] ?? known.problems[0] ?? undefined,
      message: `${known.displayName} cannot be sent on: ${known.problems[0] ?? known.missing[0] ?? "see the deposit policy"}.`,
    }),
  );
}
