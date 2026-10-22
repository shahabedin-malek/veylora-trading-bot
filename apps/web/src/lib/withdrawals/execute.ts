import type { Reason } from "@/lib/observability/reason";
import { createOnchainWithdrawalChain, createSimulatedWithdrawalChain, type WithdrawalChainPort } from "./chain";
import { withdrawalNetworkFor, type WithdrawalNetworkPolicy, type WithdrawalPolicy } from "./policy";
import type { WithdrawalRow, WithdrawalStore } from "./store";

/**
 * Sending a reserved withdrawal, and the one rule that makes a retry safe.
 *
 * The rule: **the signature is made once and stored, and every later attempt sends the
 * bytes that are already on the row.** So `prepare` is called only when the row has no
 * signed bytes, and `broadcast` is called with the stored ones. A node deduplicates by
 * transaction hash, so a re-send is one transaction on chain even when it lands twice —
 * and a re-*sign* would not be, because a transfer signed a second time after a nonce or
 * a fee moved is a different transaction with a different hash, and if both were mined
 * the money would move twice. That is the whole reason the bytes are persisted before
 * they are sent rather than held in memory across the call.
 *
 * Everything that fails here is `BROADCAST_FAILED`, and that state is deliberately *not*
 * the end of the withdrawal: an endpoint that could not be reached and a nonce that was
 * taken have both taken nothing, so the amount stays reserved and the next pass tries
 * again — with the same bytes when there are bytes, and with a fresh signature when the
 * previous attempt never got one. A failure that means the transfer is *dead* is not
 * decided here: a reverted receipt and an expired request are the confirmation step's
 * business, because only the chain can say those.
 *
 * A nonce is claimed only when a signature is made, and a claim that collides with another
 * withdrawal's nonce is a `NONCE_CONFLICT` rather than a second transaction at that nonce:
 * the unique `(network, fromAddress, nonce)` constraint does the deciding, and the next
 * attempt reads a fresh count from the chain.
 */

/**
 * The port one withdrawal is sent through.
 *
 * Split out so a test can hand the runner a port that records what it was asked to do, and
 * so the choice of mode is a choice of *port* rather than a branch inside the sending code.
 */
export function createWithdrawalChain(policy: WithdrawalPolicy, network: WithdrawalNetworkPolicy): WithdrawalChainPort {
  return policy.broadcastMode === "simulated"
    ? createSimulatedWithdrawalChain(policy, network)
    : createOnchainWithdrawalChain(policy, network);
}

export type ExecuteOutcome = {
  /** What this attempt did: sent it, could not send it, or found nothing to do. */
  kind: "broadcast" | "broadcast-failed" | "noop";
  row: WithdrawalRow | null;
  reason: Reason | null;
};

/** How many nonces one attempt may walk past before giving up for this pass. */
export const MAX_NONCE_ATTEMPTS = 3;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

export async function executeWithdrawal(input: {
  store: WithdrawalStore;
  policy: WithdrawalPolicy;
  row: WithdrawalRow;
  now: Date;
  /** Overridden by a test; production builds the port from the policy's broadcast mode. */
  chainFactory?: (network: WithdrawalNetworkPolicy) => WithdrawalChainPort;
}): Promise<ExecuteOutcome> {
  const { store, policy, now } = input;
  const row = input.row;

  if (row.status !== "RESERVED" && row.status !== "BROADCAST_FAILED") {
    return { kind: "noop", row, reason: null };
  }
  // An expired request is the expiry path's business, not this one: sending a request the
  // owner has already been told expired would be a transfer nobody authorised.
  if (row.expiresAt.getTime() <= now.getTime()) return { kind: "noop", row, reason: null };

  const resolved = withdrawalNetworkFor(row.network, policy);
  if (!resolved.ok) {
    // The route went away after the request was accepted. Nothing was sent, so the amount
    // stays held and the reason is recorded: a deployment that restores the route resumes
    // it, and the owner can cancel it meanwhile.
    const updated = await store.updateWithdrawal(row.id, {
      status: "BROADCAST_FAILED",
      reasonCode: resolved.reason.code,
      reasonMessage: resolved.reason.message,
      lastCheckedAt: now,
    });
    await store.recordAudit({
      actorUserId: row.userId,
      action: "WITHDRAWAL_BROADCAST_REFUSED",
      objectType: "Withdrawal",
      objectId: row.id,
      outcome: "REFUSED",
      payload: {
        network: row.network,
        asset: row.asset,
        amountMinor: row.amountMinor,
        destination: row.destinationDisplay,
        status: "BROADCAST_FAILED",
        attempts: row.attempts,
        reason: { code: resolved.reason.code, message: resolved.reason.message, retryable: resolved.reason.retryable },
        refusedAt: now.toISOString(),
        amountStillReserved: true,
      },
    });
    return { kind: "broadcast-failed", row: updated, reason: resolved.reason };
  }
  const network = resolved.network;

  const port = input.chainFactory ? input.chainFactory(network) : createWithdrawalChain(policy, network);
  const sender = port.sender();
  if (sender.kind === "unavailable") {
    const updated = await store.updateWithdrawal(row.id, {
      status: "BROADCAST_FAILED",
      reasonCode: sender.reason.code,
      reasonMessage: sender.reason.message,
      lastCheckedAt: now,
    });
    await store.recordAudit({
      actorUserId: row.userId,
      action: "WITHDRAWAL_BROADCAST_REFUSED",
      objectType: "Withdrawal",
      objectId: row.id,
      outcome: "REFUSED",
      payload: {
        network: row.network,
        asset: row.asset,
        amountMinor: row.amountMinor,
        destination: row.destinationDisplay,
        status: "BROADCAST_FAILED",
        attempts: row.attempts,
        reason: { code: sender.reason.code, message: sender.reason.message, retryable: sender.reason.retryable },
        refusedAt: now.toISOString(),
        amountStillReserved: true,
      },
    });
    return { kind: "broadcast-failed", row: updated, reason: sender.reason };
  }

  // One attempt counter for this pass, written by whichever write happens first, so a
  // retry that re-sends stored bytes is still counted once.
  const attemptNumber = row.attempts + 1;
  const reusingStoredBytes = row.rawTransaction !== null && row.txHash !== null;

  /**
   * Leave the row reserved, and write down why in the trail as well as on the row.
   *
   * A refused send is a state change — `RESERVED` or `BROADCAST_FAILED` with a different
   * reason — and the phase's rule is that every state change is audited with the reason and
   * the destination address. Without this the trail would show a withdrawal that was sent
   * and one that was refused by a network identically, which is the difference an owner
   * asking "what happened to my money?" actually needs.
   */
  const fail = async (failure: Reason, attempts: number): Promise<ExecuteOutcome> => {
    const updated = await store.updateWithdrawal(row.id, {
      status: "BROADCAST_FAILED",
      reasonCode: failure.code,
      reasonMessage: failure.message,
      attempts,
      lastCheckedAt: now,
    });
    await store.recordAudit({
      actorUserId: row.userId,
      action: "WITHDRAWAL_BROADCAST_REFUSED",
      objectType: "Withdrawal",
      objectId: row.id,
      outcome: "REFUSED",
      payload: {
        network: row.network,
        chainId: row.chainId,
        asset: row.asset,
        amountMinor: row.amountMinor,
        feeMinor: row.feeMinor,
        netMinor: row.netMinor,
        destination: row.destinationDisplay,
        previousStatus: row.status,
        status: "BROADCAST_FAILED",
        attempts,
        transport: port.id,
        simulated: port.simulated,
        retryable: failure.retryable,
        reason: { code: failure.code, message: failure.message, retryable: failure.retryable },
        refusedAt: now.toISOString(),
        // Said plainly: nothing was sent, so the amount is still held and a later pass will
        // try again. A refusal that read as a loss would be the one misleading thing here.
        amountStillReserved: true,
      },
    });
    return { kind: "broadcast-failed", row: updated, reason: failure };
  };

  let signed: { rawTransaction: string; txHash: string; nonce: number; fromAddress: string };
  if (reusingStoredBytes) {
    signed = {
      rawTransaction: row.rawTransaction as string,
      txHash: row.txHash as string,
      nonce: row.nonce ?? 0,
      fromAddress: row.fromAddress ?? sender.address,
    };
  } else {
    let nonceHint = row.nonce;
    let prepared: Awaited<ReturnType<WithdrawalChainPort["prepare"]>> | null = null;
    for (let attempt = 0; attempt < MAX_NONCE_ATTEMPTS; attempt += 1) {
      const outcome = await port.prepare({
        network,
        to: row.destination,
        netMinor: row.netMinor,
        withdrawalId: row.id,
        nonce: nonceHint,
      });
      if (outcome.kind === "signed") {
        prepared = outcome;
        break;
      }
      if (outcome.reason.code !== "NONCE_CONFLICT") {
        prepared = outcome;
        break;
      }
      // The chain says that nonce is taken. Walk to the next one rather than failing the
      // whole pass: a nonce conflict is exactly the case a retry can fix.
      nonceHint = (nonceHint ?? 0) + 1;
    }

    if (prepared === null) {
      const conflict: Reason = {
        code: "NONCE_CONFLICT",
        message:
          `The first ${MAX_NONCE_ATTEMPTS} nonces this attempt tried were all taken, so withdrawal ${row.id} was not signed ` +
          "and will be retried on the next pass.",
        retryable: true,
      };
      return fail(conflict, attemptNumber);
    }
    if (prepared.kind === "refused") return fail(prepared.reason, attemptNumber);
    signed = prepared.transfer;

    // The bytes are written down *before* they are sent, so a process that dies between
    // signing and sending leaves a retry that re-sends this exact transaction rather than
    // signing a second one. The claim also fences two runners: whoever wins writes the
    // bytes and the nonce, and the loser finds the row already carrying them.
    try {
      const claimed = await store.claimWithdrawal(row.id, ["RESERVED", "BROADCAST_FAILED"], {
        status: "BROADCAST_FAILED",
        rawTransaction: signed.rawTransaction,
        txHash: signed.txHash,
        nonce: signed.nonce,
        fromAddress: signed.fromAddress,
        attempts: attemptNumber,
        lastCheckedAt: now,
        reasonCode: null,
        reasonMessage: null,
      });
      if (!claimed) {
        return { kind: "noop", row: (await store.findWithdrawalById(row.id)) ?? row, reason: null };
      }
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Another withdrawal holds this nonce. Its signature is already in the database and
      // this row's is not, so nothing was sent and this row waits for the next pass.
      return fail(
        {
          code: "NONCE_CONFLICT",
          message: `Nonce ${signed.nonce} is already used by another withdrawal on ${network.displayName}, so this transfer was not signed with it.`,
          retryable: true,
        },
        attemptNumber,
      );
    }
  }

  const sent = await port.broadcast({ rawTransaction: signed.rawTransaction });
  if (sent.kind === "refused") return fail(sent.reason, attemptNumber);

  // On chain. The confirmation clock starts here, and `timeoutAt` is when the owner may
  // ask for a replacement — the only moment a cancellation attempt is offered, because
  // before it a transfer that is merely slow has not earned one.
  const claimed = await store.claimWithdrawal(row.id, ["RESERVED", "BROADCAST_FAILED"], {
    status: "BROADCAST",
    rawTransaction: signed.rawTransaction,
    txHash: sent.txHash,
    nonce: signed.nonce,
    fromAddress: signed.fromAddress,
    attempts: attemptNumber,
    broadcastAt: now,
    timeoutAt: new Date(now.getTime() + policy.cancelAfterMinutes * 60_000),
    lastCheckedAt: now,
    reasonCode: null,
    reasonMessage: null,
  });
  const current = (await store.findWithdrawalById(row.id)) ?? row;

  await store.recordAudit({
    actorUserId: current.userId,
    action: "WITHDRAWAL_BROADCAST",
    objectType: "Withdrawal",
    objectId: current.id,
    outcome: "SUCCESS",
    payload: {
      network: current.network,
      chainId: current.chainId,
      asset: current.asset,
      amountMinor: current.amountMinor,
      feeMinor: current.feeMinor,
      netMinor: current.netMinor,
      destination: current.destinationDisplay,
      txHash: sent.txHash,
      nonce: signed.nonce,
      fromAddress: signed.fromAddress,
      tokenAddress: network.token.address,
      transport: port.id,
      simulated: port.simulated,
      // Whether *this* pass moved the row to BROADCAST, or found another pass already had.
      claimedByThisPass: claimed,
      // Whether this send re-sent bytes the row already carried, which is the retry path.
      reusedStoredBytes: reusingStoredBytes,
      attemptNumber,
      broadcastAt: now.toISOString(),
      // The signature stays on the row and out of the trail: an audit payload records what
      // was decided, not a copy of what could be spent.
      signedBytesStored: true,
    },
  });

  return { kind: "broadcast", row: current, reason: null };
}
