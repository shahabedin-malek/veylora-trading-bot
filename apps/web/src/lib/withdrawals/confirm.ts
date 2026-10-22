import { reason, serializeReason, type Reason } from "@/lib/observability/reason";
import { releaseWithdrawal, settleWithdrawal } from "@/lib/ledger/withdrawals";
import type { WithdrawalChainPort } from "./chain";
import { createWithdrawalChain } from "./execute";
import { withdrawalNetworkFor, type WithdrawalNetworkPolicy, type WithdrawalPolicy } from "./policy";
import type { WithdrawalRow, WithdrawalStore } from "./store";

/**
 * The end of a withdrawal's life: confirmed, reverted, expired or cancelled.
 *
 * Each of the four has to give the money somewhere, and the whole of this file is the
 * answer to \"where\": a confirmed withdrawal settles (the hold is discharged, the treasury
 * falls by what was sent and the fee account rises by the platform's cut), and every other
 * ending *releases* the hold back to what the owner can spend. There is no path that ends
 * with the amount neither settled nor released — that is a state in which the owner's money
 * is invisible, and it is exactly what the invariant check downstream would flag but this
 * code is not allowed to produce.
 *
 * Four decisions are worth stating plainly.
 *
 * **A confirmation is counted, never assumed.** The network's own confirmation count — the
 * same number the deposit watcher waits for, from one policy — has to be reached before the
 * withdrawal is complete, so a transaction that is mined into a block that later disappears
 * never became money in the first place. The row keeps the hash from the moment it is
 * broadcast and the count as it grows, so \"where is my withdrawal?\" is answered from the
 * row rather than from a log line.
 *
 * **A reverted transfer is the end of the request, not a retry.** The chain has taken the
 * fee and moved nothing, so the amount is released and the reason says what happened. Retrying
 * the same bytes would revert again and spend another fee.
 *
 * **A cancellation is an attempt, and it says so.** On an account-based chain a withdrawal is
 * cancelled by sending a second, empty transaction with the *same nonce* and a *higher fee*,
 * which the network accepts instead of the first. Which of the two is mined is decided by the
 * chain and not by us, so a cancel request broadcasts the replacement and reports that a
 * replacement is in flight; the next confirmation pass looks at both hashes and settles the
 * question — the replacement mined means cancelled and released, the original mined means
 * confirmed. Claiming a cancellation the chain has not granted would be the one lie this file
 * could tell, so it does not.
 *
 * **A request that was never sent expires and gives the money back.** The window is the owner's
 * configuration, and the expiry exists because a request left reserved forever is money the
 * owner cannot spend and did not mean to send.
 */

export type ConfirmOutcome = {
  kind: "confirmed" | "failed" | "cancelled" | "pending" | "noop";
  row: WithdrawalRow | null;
  reason: Reason | null;
};

/**
 * Give the amount back and end the withdrawal, in one database transaction.
 *
 * The claim comes first and the ledger movement second, inside the same transaction, so the
 * row cannot be marked released without the release having been posted — and the release
 * cannot be posted twice, because the claim moves the row out of the live states and a
 * second caller loses it.
 */
async function releaseAndEnd(input: {
  store: WithdrawalStore;
  row: WithdrawalRow;
  now: Date;
  status: "FAILED" | "CANCELLED";
  reason: Reason;
  /** A replacement that won the nonce, when that is why this is being cancelled. */
  cancelTxHash?: string | null;
  action: string;
}): Promise<ConfirmOutcome> {
  const { store, row, now } = input;
  const ended = await store.transaction(async (transaction) => {
    const claimed = await transaction.claimWithdrawal(row.id, ["HELD", "RESERVED", "BROADCAST_FAILED", "BROADCAST"], {
      status: input.status,
      reasonCode: input.reason.code,
      reasonMessage: input.reason.message,
      ...(input.status === "FAILED" ? { failedAt: now } : { cancelledAt: now }),
      releasedAt: now,
      lastCheckedAt: now,
      ...(input.cancelTxHash ? { cancelTxHash: input.cancelTxHash } : {}),
    });
    if (!claimed) return null;

    const released = await releaseWithdrawal(transaction.ledger(), {
      withdrawalId: row.id,
      userId: row.userId,
      asset: row.asset,
      decimals: row.decimals,
      amountMinor: row.amountMinor,
      occurredAt: now,
      network: row.network,
      destination: row.destinationDisplay,
    });
    if (!released.posted) {
      throw new Error(
        `The ledger refused to release ${row.amountMinor} for withdrawal ${row.id}: ${released.reason?.message ?? "no reason"}`,
      );
    }

    await transaction.recordAudit({
      actorUserId: row.userId,
      action: input.action,
      objectType: "Withdrawal",
      objectId: row.id,
      outcome: input.status === "FAILED" ? "REFUSED" : "SUCCESS",
      payload: {
        network: row.network,
        asset: row.asset,
        amountMinor: row.amountMinor,
        feeMinor: row.feeMinor,
        netMinor: row.netMinor,
        destination: row.destinationDisplay,
        previousStatus: row.status,
        status: input.status,
        txHash: row.txHash,
        cancelTxHash: input.cancelTxHash ?? null,
        confirmations: row.confirmations,
        confirmationsRequired: row.confirmationsRequired,
        attempts: row.attempts,
        reason: serializeReason(input.reason),
        releasedAt: now.toISOString(),
        ledgerTransactionId: released.transactionId,
        ledgerTransactionKey: `withdrawal:${row.id}:release`,
      },
    });
    return released;
  });

  if (!ended) return { kind: "noop", row: (await store.findWithdrawalById(row.id)) ?? row, reason: null };
  const current = await store.findWithdrawalById(row.id);
  return {
    kind: input.status === "CANCELLED" ? "cancelled" : "failed",
    row: current ?? row,
    reason: input.reason,
  };
}

/** Release a request that was never sent, because its expiry has passed. */
export async function expireWithdrawal(input: {
  store: WithdrawalStore;
  policy: WithdrawalPolicy;
  row: WithdrawalRow;
  now: Date;
}): Promise<ConfirmOutcome> {
  const { store, row, now } = input;
  if (row.status !== "HELD" && row.status !== "RESERVED" && row.status !== "BROADCAST_FAILED") {
    return { kind: "noop", row, reason: null };
  }
  if (row.expiresAt.getTime() > now.getTime()) return { kind: "noop", row, reason: null };
  return releaseAndEnd({
    store,
    row,
    now,
    status: "FAILED",
    action: "WITHDRAWAL_EXPIRED",
    reason: reason("WITHDRAWAL_EXPIRED", {
      message:
        `The request sat unsent past ${row.expiresAt.toISOString()}, so it was cancelled and ` +
        `${row.amountMinor} ${row.asset} minor units went back to the balance.`,
    }),
  });
}

/**
 * Read the chain for one sent withdrawal and end it if the chain has decided.
 *
 * The original hash is asked about first and the replacement second, because the original is
 * the one that moves the owner's money: if it is mined, nothing else about this row matters.
 */
export async function confirmWithdrawal(input: {
  store: WithdrawalStore;
  policy: WithdrawalPolicy;
  row: WithdrawalRow;
  now: Date;
  chainFactory?: (network: WithdrawalNetworkPolicy) => WithdrawalChainPort;
}): Promise<ConfirmOutcome> {
  const { store, policy, row, now } = input;
  if (row.status !== "BROADCAST" || !row.txHash) return { kind: "noop", row, reason: null };

  const resolved = withdrawalNetworkFor(row.network, policy);
  if (!resolved.ok) {
    // The confirmation cannot be read without a route to the chain. The row stays sent and
    // its hash stays visible: the money is on chain, and saying so is better than guessing.
    const updated = await store.updateWithdrawal(row.id, { lastCheckedAt: now });
    return { kind: "pending", row: updated, reason: resolved.reason };
  }
  const network = resolved.network;
  const port = input.chainFactory ? input.chainFactory(network) : createWithdrawalChain(policy, network);

  const observation = await port.observe({ txHash: row.txHash, confirmationsKnown: row.confirmations });
  if (observation.kind === "unknown") {
    // Not a failed withdrawal: an unreadable chain is an unanswered question, and the amount
    // stays reserved because the transfer may well be mined.
    const updated = await store.updateWithdrawal(row.id, {
      lastCheckedAt: now,
      reasonCode: observation.reason.code,
      reasonMessage: observation.reason.message,
    });
    return { kind: "pending", row: updated, reason: observation.reason };
  }

  if (observation.kind === "mined" && observation.status === "reverted") {
    return releaseAndEnd({
      store,
      row,
      now,
      status: "FAILED",
      action: "WITHDRAWAL_REVERTED",
      reason: reason("TRANSACTION_REVERTED", {
        message:
          `Transaction ${row.txHash} was mined and reverted, so the transfer did not happen and ` +
          `${row.amountMinor} ${row.asset} minor units went back to the balance. The fee the network charged for it is not refundable.`,
        detail: `block ${observation.blockNumber}`,
      }),
    });
  }

  if (observation.kind === "pending") {
    // A transfer that is on its way: the amount stays reserved and the hash stays visible.
    const updated = await store.updateWithdrawal(row.id, {
      confirmations: observation.confirmations,
      lastCheckedAt: now,
    });
    return { kind: "pending", row: updated, reason: null };
  }

  // Mined and successful. The confirmation count is the network's policy, so a block that
  // is later reorged out has not yet become money.
  const required = row.confirmationsRequired ?? network.confirmations;
  if (observation.confirmations < required) {
    const updated = await store.updateWithdrawal(row.id, {
      confirmations: observation.confirmations,
      lastCheckedAt: now,
    });
    return { kind: "pending", row: updated, reason: null };
  }

  const settled = await store.transaction(async (transaction) => {
    const claimed = await transaction.claimWithdrawal(row.id, ["BROADCAST"], {
      status: "CONFIRMED",
      confirmations: observation.confirmations,
      confirmedAt: now,
      lastCheckedAt: now,
      reasonCode: null,
      reasonMessage: null,
    });
    if (!claimed) return null;

    const movement = await settleWithdrawal(transaction.ledger(), {
      withdrawalId: row.id,
      userId: row.userId,
      asset: row.asset,
      decimals: row.decimals,
      amountMinor: row.amountMinor,
      netMinor: row.netMinor,
      feeMinor: row.feeMinor,
      occurredAt: now,
      network: row.network,
      destination: row.destinationDisplay,
      txHash: row.txHash as string,
    });
    if (!movement.posted) {
      throw new Error(
        `The ledger refused to settle withdrawal ${row.id}: ${movement.reason?.message ?? "no reason"}`,
      );
    }

    await transaction.recordAudit({
      actorUserId: row.userId,
      action: "WITHDRAWAL_CONFIRMED",
      objectType: "Withdrawal",
      objectId: row.id,
      outcome: "SUCCESS",
      payload: {
        network: row.network,
        chainId: row.chainId,
        asset: row.asset,
        amountMinor: row.amountMinor,
        feeMinor: row.feeMinor,
        netMinor: row.netMinor,
        destination: row.destinationDisplay,
        txHash: row.txHash,
        nonce: row.nonce,
        fromAddress: row.fromAddress,
        confirmations: observation.confirmations,
        confirmationsRequired: required,
        blockNumber: observation.blockNumber,
        attempts: row.attempts,
        broadcastAt: row.broadcastAt?.toISOString() ?? null,
        confirmedAt: now.toISOString(),
        ledgerTransactionId: movement.transactionId,
        ledgerTransactionKey: `withdrawal:${row.id}:settle`,
      },
    });
    return movement;
  });

  if (!settled) return { kind: "noop", row: (await store.findWithdrawalById(row.id)) ?? row, reason: null };
  const current = await store.findWithdrawalById(row.id);
  return { kind: "confirmed", row: current ?? row, reason: null };
}

/**
 * Read both hashes of a row whose cancellation has been attempted.
 *
 * A separate step from {@link confirmWithdrawal} because it answers a different question: not
 * \"did the transfer happen?\" but \"which of the two transactions took the nonce?\". It is
 * called by the same pass, after the confirmation read has said the original is not mined.
 */
export async function reconcileCancellation(input: {
  store: WithdrawalStore;
  policy: WithdrawalPolicy;
  row: WithdrawalRow;
  now: Date;
  chainFactory?: (network: WithdrawalNetworkPolicy) => WithdrawalChainPort;
}): Promise<ConfirmOutcome> {
  const { store, policy, row, now } = input;
  if (row.status !== "BROADCAST" || !row.cancelTxHash) return { kind: "noop", row, reason: null };
  const resolved = withdrawalNetworkFor(row.network, policy);
  if (!resolved.ok) return { kind: "noop", row, reason: resolved.reason };
  const port = input.chainFactory ? input.chainFactory(resolved.network) : createWithdrawalChain(policy, resolved.network);

  const observation = await port.observe({ txHash: row.cancelTxHash, confirmationsKnown: row.confirmations });
  if (observation.kind === "pending") {
    const updated = await store.updateWithdrawal(row.id, { lastCheckedAt: now });
    return { kind: "pending", row: updated, reason: null };
  }
  if (observation.kind === "unknown") {
    // The replacement's state is unknown, and so is whether it won the nonce: the row keeps
    // its reserve and its original hash until the chain answers.
    const updated = await store.updateWithdrawal(row.id, { lastCheckedAt: now });
    return { kind: "pending", row: updated, reason: observation.reason };
  }

  const required = row.confirmationsRequired ?? resolved.network.confirmations;
  if (observation.confirmations < required) {
    const updated = await store.updateWithdrawal(row.id, {
      confirmations: observation.confirmations,
      lastCheckedAt: now,
    });
    return { kind: "pending", row: updated, reason: null };
  }

  return releaseAndEnd({
    store,
    row,
    now,
    status: "CANCELLED",
    action: "WITHDRAWAL_CANCELLED",
    cancelTxHash: row.cancelTxHash,
    // A replacement that reverted still took the nonce, which is all a cancellation needs:
    // the original transaction can never be mined once another transaction uses its nonce.
    // Which one the chain mined is recorded either way, so nothing is inferred.
    reason: reason("ALREADY_COMPLETED", {
      message:
        `The replacement transaction ${row.cancelTxHash} was mined at nonce ${row.nonce} instead of ${row.txHash} ` +
        `(status ${observation.status}), so the withdrawal was cancelled and ${row.amountMinor} ${row.asset} minor units went back to the balance.`,
      detail: `block ${observation.blockNumber}`,
    }),
  });
}

export type CancelOutcome = {
  kind: "cancelled" | "replacement-sent" | "replacement-already-sent" | "refused" | "noop";
  row: WithdrawalRow | null;
  reason: Reason | null;
};

/**
 * The owner asks to take a withdrawal back.
 *
 * Three situations, and they are genuinely different:
 *
 *  - **Nothing was sent** (`HELD`, `RESERVED`, `BROADCAST_FAILED`). The amount is still ours
 *    to give back, so it is released immediately. No chain, no fee, no waiting.
 *  - **Sent but unconfirmed, and the timeout has passed** (`BROADCAST`). The only way to take
 *    it back is a replacement transaction at the same nonce, and whether that wins is the
 *    chain's decision — so the answer is \"a replacement is in flight\", not \"cancelled\".
 *  - **Sent and not yet past the timeout.** Refused, with the timeout named. Cancelling a
 *    transfer that is merely a little slow would be the owner paying a second fee to cancel
 *    something that was about to arrive.
 */
export async function cancelWithdrawal(input: {
  store: WithdrawalStore;
  policy: WithdrawalPolicy;
  row: WithdrawalRow;
  now: Date;
  chainFactory?: (network: WithdrawalNetworkPolicy) => WithdrawalChainPort;
}): Promise<CancelOutcome> {
  const { store, policy, row, now } = input;

  if (row.status === "HELD" || row.status === "RESERVED" || row.status === "BROADCAST_FAILED") {
    const ended = await releaseAndEnd({
      store,
      row,
      now,
      status: "CANCELLED",
      action: "WITHDRAWAL_CANCELLED",
      reason: reason("ALREADY_COMPLETED", {
        message: `The owner cancelled the withdrawal before it was sent, so ${row.amountMinor} ${row.asset} minor units went back to the balance.`,
      }),
    });
    return { kind: ended.kind === "cancelled" ? "cancelled" : "noop", row: ended.row, reason: null };
  }

  if (row.status !== "BROADCAST") {
    return {
      kind: "refused",
      row,
      reason: reason("ALREADY_COMPLETED", {
        message: `A withdrawal in ${row.status} has already ended, so there is nothing left to cancel.`,
      }),
    };
  }

  if (row.timeoutAt && row.timeoutAt.getTime() > now.getTime()) {
    return {
      kind: "refused",
      row,
      reason: reason("NOT_YET_DUE", {
        message:
          `Transaction ${row.txHash} is still within its confirmation window; a cancellation attempt is offered after ` +
          `${row.timeoutAt.toISOString()}.`,
      }),
    };
  }

  const resolved = withdrawalNetworkFor(row.network, policy);
  if (!resolved.ok) return { kind: "refused", row, reason: resolved.reason };
  const network = resolved.network;
  const port = input.chainFactory ? input.chainFactory(network) : createWithdrawalChain(policy, network);

  let replacement: { rawTransaction: string; txHash: string };
  if (row.cancelRawTransaction && row.cancelTxHash) {
    replacement = { rawTransaction: row.cancelRawTransaction, txHash: row.cancelTxHash };
  } else {
    const prepared = await port.prepareCancel({
      network,
      withdrawalId: row.id,
      nonce: row.nonce ?? 0,
      aboveGasPriceWei: "0",
    });
    if (prepared.kind === "refused") return { kind: "refused", row, reason: prepared.reason };
    replacement = { rawTransaction: prepared.transfer.rawTransaction, txHash: prepared.transfer.txHash };
    const claimed = await store.claimWithdrawal(row.id, ["BROADCAST"], {
      cancelRawTransaction: replacement.rawTransaction,
      cancelTxHash: replacement.txHash,
      lastCheckedAt: now,
    });
    if (!claimed) return { kind: "noop", row: (await store.findWithdrawalById(row.id)) ?? row, reason: null };
  }

  const sent = await port.broadcast({ rawTransaction: replacement.rawTransaction });
  if (sent.kind === "refused") {
    return { kind: "refused", row, reason: sent.reason };
  }

  const current = (await store.findWithdrawalById(row.id)) ?? row;
  await store.recordAudit({
    actorUserId: row.userId,
    action: "WITHDRAWAL_CANCELLATION_ATTEMPTED",
    objectType: "Withdrawal",
    objectId: row.id,
    outcome: "SUCCESS",
    payload: {
      network: row.network,
      asset: row.asset,
      amountMinor: row.amountMinor,
      destination: row.destinationDisplay,
      txHash: row.txHash,
      cancelTxHash: replacement.txHash,
      nonce: row.nonce,
      requestedAt: now.toISOString(),
      // Said plainly, because the next pass decides it: which transaction takes the nonce is
      // the chain's answer, not this one's.
      note: "A replacement transaction has been sent at the same nonce; the withdrawal is cancelled if the chain mines the replacement.",
    },
  });

  return {
    kind: row.cancelTxHash ? "replacement-already-sent" : "replacement-sent",
    row: current,
    reason: null,
  };
}

/** Whether a cancel is worth offering this owner right now, and why not when it is not. */
export function cancellationOffer(row: WithdrawalRow, now: Date): { offered: boolean; reason: Reason | null } {
  if (row.status === "HELD" || row.status === "RESERVED" || row.status === "BROADCAST_FAILED") {
    return { offered: true, reason: null };
  }
  if (row.status === "BROADCAST") {
    if (row.cancelTxHash) return { offered: true, reason: null };
    if (row.timeoutAt && row.timeoutAt.getTime() > now.getTime()) {
      return {
        offered: false,
        reason: reason("NOT_YET_DUE", {
          message: `A cancellation attempt becomes available at ${row.timeoutAt.toISOString()}.`,
        }),
      };
    }
    return { offered: true, reason: null };
  }
  return { offered: false, reason: null };
}

/** Does this row's hold window end with this pass? Used by the runner, exposed for its test. */
export function holdHasPassed(row: WithdrawalRow, now: Date): boolean {
  return row.status === "HELD" && row.holdUntil !== null && row.holdUntil.getTime() <= now.getTime();
}
