import { randomUUID } from "node:crypto";
import { reason, serializeReason, type Reason } from "@/lib/observability/reason";
import { availableBalanceMinor, reserveWithdrawal, withBalanceLock } from "@/lib/ledger/withdrawals";
import { LedgerAmountError, formatMinorUnits, minorUnitsFromDecimalString, type MinorUnits } from "@/lib/ledger/integer-cent-ledger";
import { checkDestination } from "./addresses";
import { withdrawalFeeMinor, withdrawalNetworkFor, type WithdrawalNetworkPolicy, type WithdrawalPolicy } from "./policy";
import type { WithdrawalRow, WithdrawalStore } from "./store";

/**
 * Asking for a withdrawal: validate, then reserve, then record.
 *
 * The order is the design. Everything that can be decided without touching the owner's
 * money is decided first — which network, which address, which amount, which fee — and
 * each refusal names the value it refused. Only then is the amount held, inside one
 * database transaction that also writes the row that explains the hold. A request that
 * is refused leaves the balance exactly where it was, and a request that is accepted
 * cannot be double-spent by the next one, because the money has already moved into the
 * hold account by the time the next request reads the balance.
 *
 * **Nothing here approves anything.** The phase-14 brief forbids an approval gate, a
 * manual review step or a confirmation dialogue in front of a withdrawal the owner
 * asks for, and forbids holding one for a policy this code invented. The one hold is
 * the owner's own new-address window, whose length is configuration, whose reason is
 * stamped on the row, and which does nothing at all when it is set to zero.
 *
 * **Idempotency is the caller's key, checked against intent.** Two submissions of one
 * form carry the same key and get the same withdrawal back; the same key on a
 * *different* withdrawal is refused rather than replayed, because replaying it would
 * silently answer a request the caller did not make. The key is compared against the
 * network, destination and amounts, which are the whole of what a withdrawal is.
 *
 * **A refused request still writes an audit event.** \"Every state change writes an
 * audit event including the reason and the destination address\" cannot be satisfied by
 * recording only the successes: the requests that were refused are the ones an owner
 * will ask about, and the refusal that is not written down is the refusal that cannot
 * be explained later. Refusals that happen before a row exists are therefore audited
 * on their own, with no object id — and an audit write that fails does not turn a
 * refusal into an acceptance.
 */

export type WithdrawalRequestInput = {
  store: WithdrawalStore;
  policy: WithdrawalPolicy;
  userId: string;
  /** The network slug the owner chose. */
  network: string;
  /** The destination address as typed. */
  destination: string;
  /** The gross amount as typed, in whole units of the asset. */
  amount: string;
  idempotencyKey: string;
  now: Date;
  /** The sending wallet, when the caller already resolved it, so it can be refused as a destination. */
  hotWalletAddress?: string | null;
  /** Bounded wait for the account's balance lock. Tests shorten it; production does not. */
  lockWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** A fresh holder for the balance lock. Injected in tests so two attempts differ. */
  holder?: string;
};

export type WithdrawalRequestOutcome = {
  /** The row, when one exists — created now, replayed from the key, or refused after a reservation attempt. */
  withdrawal: WithdrawalRow | null;
  reason: Reason | null;
  refused: boolean;
  /** False when this call found the withdrawal the key already names. */
  created: boolean;
  /** What the account could spend when it was read. Null when the request never got that far. */
  availableMinor: string | null;
  network: WithdrawalNetworkPolicy | null;
};

/** The intent a withdrawal's idempotency key is bound to, as a comparable string. */
export function withdrawalIntent(input: { network: string; destination: string; amountMinor: MinorUnits }): string {
  return `${input.network}|${input.destination.toLowerCase()}|${input.amountMinor}`;
}

/**
 * A refusal that happened before any money moved.
 *
 * Audited with the destination and the reason, so the trail answers \"did the owner try,
 * and what did we tell them?\" for the requests that never became rows. A failure to
 * write the audit row is swallowed deliberately and only here: the refusal is still the
 * answer, and turning a logged-out write failure into a 500 would tell the caller the
 * opposite of what happened.
 */
async function refuseBeforeReservation(
  store: WithdrawalStore,
  input: { actorUserId: string; reason: Reason; network: string; destination: string; amount: string; now: Date; intent: string },
): Promise<void> {
  try {
    await store.recordAudit({
      actorUserId: input.actorUserId,
      action: "WITHDRAWAL_REFUSED",
      objectType: "Withdrawal",
      objectId: null,
      outcome: "REFUSED",
      payload: {
        network: input.network,
        destination: input.destination,
        amount: input.amount,
        requestedAt: input.now.toISOString(),
        stage: "VALIDATION",
        reason: serializeReason(input.reason),
      },
    });
  } catch {
    // Nothing to do and nothing to say: the caller is answered either way.
  }
}

export async function requestWithdrawal(input: WithdrawalRequestInput): Promise<WithdrawalRequestOutcome> {
  const { store, policy, userId, now } = input;
  const refusal = (
    refusalReason: Reason,
    extra: Partial<WithdrawalRequestOutcome> = {},
  ): WithdrawalRequestOutcome => ({
    withdrawal: null,
    reason: refusalReason,
    refused: true,
    created: false,
    availableMinor: null,
    network: null,
    ...extra,
  });

  // ── the owner's stop switch ───────────────────────────────────────────────────
  // A pause is not an approval gate: it does not review an individual withdrawal, it
  // stops the whole outbound path. It is checked before validation so the answer names
  // the switch rather than a field the caller cannot fix, and nothing is held.
  if (policy.withdrawalsPaused) {
    const paused = reason("WITHDRAWALS_PAUSED", {
      message:
        "Withdrawals are paused by the owner, so this request was refused and nothing was held. " +
        "The pause is a setting on /admin/access; once it is released the request can be made again.",
    });
    await refuseBeforeReservation(store, {
      actorUserId: userId,
      reason: paused,
      network: input.network,
      destination: input.destination,
      amount: input.amount,
      now,
      intent: input.idempotencyKey?.trim() ?? "",
    });
    return refusal(paused);
  }

  // ── the key, before anything else ─────────────────────────────────────────────
  const idempotencyKey = input.idempotencyKey?.trim() ?? "";
  if (!idempotencyKey) {
    return refusal(
      // A missing key is its own refusal. Answering it with "the key was reused" told a
      // client to generate a new key it had never sent, which is the opposite of the fix.
      reason("MISSING_IDEMPOTENCY_KEY", {
        message:
          "Every withdrawal needs an idempotency key, so a repeated submit resolves to the same request instead of a second withdrawal.",
      }),
    );
  }

  // ── the network ───────────────────────────────────────────────────────────────
  const network = withdrawalNetworkFor(input.network, policy);
  if (!network.ok) {
    await refuseBeforeReservation(store, {
      actorUserId: userId,
      reason: network.reason,
      network: input.network,
      destination: input.destination,
      amount: input.amount,
      now,
      intent: idempotencyKey,
    });
    return refusal(network.reason);
  }
  const selected = network.network;

  // ── the destination ───────────────────────────────────────────────────────────
  const blocked = input.hotWalletAddress
    ? [
        {
          address: input.hotWalletAddress,
          reason: reason("INVALID_DESTINATION", {
            message:
              "That is the address this deployment sends from, so a withdrawal to it would pay gas to move nothing; " +
              "use the wallet you want the money in.",
          }),
        },
      ]
    : [];
  const destination = checkDestination(input.destination, { blocked });
  if (!destination.ok) {
    await refuseBeforeReservation(store, {
      actorUserId: userId,
      reason: destination.reason,
      network: selected.slug,
      destination: input.destination,
      amount: input.amount,
      now,
      intent: idempotencyKey,
    });
    return refusal(destination.reason, { network: selected });
  }

  // ── the amount ────────────────────────────────────────────────────────────────
  let amountMinor: MinorUnits;
  try {
    amountMinor = minorUnitsFromDecimalString(input.amount, selected.token.decimals);
  } catch (error) {
    const amountReason = reason("INVALID_AMOUNT", {
      message:
        error instanceof LedgerAmountError
          ? `${input.amount} is not an amount of ${selected.token.symbol} at ${selected.token.decimals} decimals: ${error.message}`
          : `${input.amount} is not an amount this deployment can withdraw.`,
    });
    await refuseBeforeReservation(store, {
      actorUserId: userId,
      reason: amountReason,
      network: selected.slug,
      destination: destination.display,
      amount: input.amount,
      now,
      intent: idempotencyKey,
    });
    return refusal(amountReason, { network: selected });
  }
  if (BigInt(amountMinor) === BigInt(0)) {
    const zeroReason = reason("INVALID_AMOUNT", { message: "A withdrawal of zero moves nothing, so it was refused." });
    await refuseBeforeReservation(store, {
      actorUserId: userId,
      reason: zeroReason,
      network: selected.slug,
      destination: destination.display,
      amount: input.amount,
      now,
      intent: idempotencyKey,
    });
    return refusal(zeroReason, { network: selected });
  }

  // ── the fee ───────────────────────────────────────────────────────────────────
  const fee = withdrawalFeeMinor(policy, { asset: selected.token.symbol, decimals: selected.token.decimals });
  if (!fee.ok) {
    await refuseBeforeReservation(store, {
      actorUserId: userId,
      reason: fee.reason,
      network: selected.slug,
      destination: destination.display,
      amount: input.amount,
      now,
      intent: idempotencyKey,
    });
    return refusal(fee.reason, { network: selected });
  }
  const feeMinor = fee.minor;
  // A fee at or above the amount leaves nothing to send, and it is refused here, before
  // the reservation, with the two numbers named: this is the phase's failure case —
  // "set a fee larger than the balance" — and the answer has to be a sentence the owner
  // can act on rather than a settlement that later refuses to post. Checked before the
  // net is formatted, because a negative net is not an amount this ledger can hold.
  if (BigInt(feeMinor) >= BigInt(amountMinor)) {
    const feeReason = reason("INVALID_AMOUNT", {
      message:
        `The withdrawal fee of ${policy.feeByAsset[selected.token.symbol] ?? "0"} ${selected.token.symbol} ` +
        `leaves nothing of ${input.amount} ${selected.token.symbol} to send, so the request was refused and nothing was held. ` +
        "Withdraw a larger amount or lower the fee.",
      detail: `fee ${feeMinor} minor units against ${amountMinor}`,
    });
    await refuseBeforeReservation(store, {
      actorUserId: userId,
      reason: feeReason,
      network: selected.slug,
      destination: destination.display,
      amount: input.amount,
      now,
      intent: idempotencyKey,
    });
    return refusal(feeReason, { network: selected });
  }
  const netMinor = formatMinorUnits(BigInt(amountMinor) - BigInt(feeMinor));

  // ── the replay ────────────────────────────────────────────────────────────────
  const existing = await store.findWithdrawalByIdempotencyKey(idempotencyKey);
  if (existing) {
    const sameIntent =
      withdrawalIntent({ network: existing.network, destination: existing.destination, amountMinor: existing.amountMinor }) ===
      withdrawalIntent({ network: selected.slug, destination: destination.address, amountMinor });
    if (!sameIntent) {
      return refusal(
        reason("IDEMPOTENCY_KEY_REUSED", {
          message:
            `The idempotency key ${JSON.stringify(idempotencyKey)} already names a different withdrawal, so this request was ` +
            "refused rather than answered with it.",
          detail: existing.id,
        }),
        { withdrawal: existing, network: selected },
      );
    }
    return {
      withdrawal: existing,
      reason: null,
      refused: false,
      created: false,
      availableMinor: null,
      network: selected,
    };
  }

  // ── the reservation ───────────────────────────────────────────────────────────
  const windowMinutes = policy.newAddressWindowMinutes;
  const expiresAt = new Date(now.getTime() + policy.requestExpiryMinutes * 60_000);
  const intent = withdrawalIntent({ network: selected.slug, destination: destination.address, amountMinor });

  const locked = await withBalanceLock(
    store.ledger(),
    {
      userId,
      asset: selected.token.symbol,
      holder: input.holder ?? randomUUID(),
      now,
      ...(input.lockWaitMs !== undefined ? { waitMs: input.lockWaitMs } : {}),
      ...(input.sleep ? { sleep: input.sleep } : {}),
    },
    async () =>
      store.transaction(async (transaction) => {
        const ledger = transaction.ledger();

        // The owner's own new-address window, decided from the book and nothing else. It is
        // read *inside* the transaction, against the committed rows, so the decision is made
        // on a fact rather than on a set a previous request left in memory — and the balance
        // lock above means two requests for one account's asset cannot both see an empty book
        // and both decide they are the first.
        const known =
          windowMinutes === 0
            ? null
            : await transaction.findWithdrawalAddress({ userId, network: selected.slug, address: destination.address });
        const hold = windowMinutes > 0 && known === null;
        const holdUntil = hold ? new Date(now.getTime() + windowMinutes * 60_000) : null;

        const available = await availableBalanceMinor(ledger, { userId, asset: selected.token.symbol });
        if (available < BigInt(amountMinor)) {
          // The refusal is written in the same transaction as the decision, so the
          // trail and the balance the decision was made against cannot disagree.
          const shortfall = reason("INSUFFICIENT_BALANCE", {
            message:
              `The account can spend ${formatMinorUnits(available)} of ${amountMinor} ${selected.token.symbol} minor units ` +
              `requested, so the withdrawal was refused and nothing was held.`,
            detail: `available ${available.toString()}`,
          });
          await transaction.recordAudit({
            actorUserId: userId,
            action: "WITHDRAWAL_REFUSED",
            objectType: "Withdrawal",
            objectId: null,
            outcome: "REFUSED",
            payload: {
              network: selected.slug,
              destination: destination.display,
              amount: input.amount,
              amountMinor,
              availableMinor: available.toString(),
              requestedAt: now.toISOString(),
              stage: "RESERVATION",
              reason: serializeReason(shortfall),
            },
          });
          return { kind: "refused" as const, reason: shortfall, available };
        }

        const inserted = await transaction.insertWithdrawalOnce({
          userId,
          network: selected.slug,
          chainId: selected.chainId,
          asset: selected.token.symbol,
          decimals: selected.token.decimals,
          amountMinor,
          feeMinor,
          netMinor,
          destination: destination.address,
          destinationDisplay: destination.display,
          status: hold ? "HELD" : "RESERVED",
          reasonCode: hold ? "WITHDRAWAL_HELD" : null,
          reasonMessage: hold
            ? reason("WITHDRAWAL_HELD", {
                message:
                  `This is the first withdrawal to ${destination.display} on ${selected.displayName}, so it is held for ` +
                  `${windowMinutes} minute${windowMinutes === 1 ? "" : "s"} before it is sent.`,
                detail: holdUntil ? holdUntil.toISOString() : undefined,
              }).message
            : null,
          idempotencyKey,
          fromAddress: null,
          nonce: null,
          rawTransaction: null,
          txHash: null,
          cancelRawTransaction: null,
          cancelTxHash: null,
          attempts: 0,
          confirmations: 0,
          confirmationsRequired: selected.confirmations,
          holdUntil,
          expiresAt,
          timeoutAt: null,
          broadcastAt: null,
          confirmedAt: null,
          failedAt: null,
          cancelledAt: null,
          releasedAt: null,
          lastCheckedAt: null,
        });

        if (!inserted.created) {
          // Another request with this key won the race between the lookup above and
          // this insert. Its row is the answer, and the amount it reserved is the one
          // that counts, so nothing is reserved a second time.
          return { kind: "replayed" as const, row: inserted.row, available };
        }

        const reserved = await reserveWithdrawal(ledger, {
          withdrawalId: inserted.row.id,
          userId,
          asset: selected.token.symbol,
          decimals: selected.token.decimals,
          amountMinor,
          occurredAt: now,
          network: selected.slug,
          destination: destination.display,
        });
        if (!reserved.posted) {
          // Unreachable by construction: the key is the withdrawal's own and it was
          // created here. If it happens, the whole transaction is rolled back rather
          // than leaving a withdrawal whose money was never held.
          throw new Error(
            `The ledger refused to reserve ${amountMinor} for withdrawal ${inserted.row.id}: ${reserved.reason?.message ?? "no reason"}`,
          );
        }

        await transaction.rememberWithdrawalAddress({
          userId,
          network: selected.slug,
          chainId: selected.chainId,
          address: destination.address,
          addressDisplay: destination.display,
          firstSeenAt: now,
        });

        await transaction.recordAudit({
          actorUserId: userId,
          action: hold ? "WITHDRAWAL_HELD" : "WITHDRAWAL_REQUESTED",
          objectType: "Withdrawal",
          objectId: inserted.row.id,
          outcome: "SUCCESS",
          payload: {
            network: selected.slug,
            chainId: selected.chainId,
            asset: selected.token.symbol,
            tokenAddress: selected.token.address,
            decimals: selected.token.decimals,
            amount: input.amount,
            amountMinor,
            feeMinor,
            netMinor,
            feeSource: policy.feeSource,
            networkCost: policy.networkCostByAsset[selected.token.symbol] ?? "0",
            destination: destination.display,
            status: inserted.row.status,
            hold: hold ? "FIRST_SEND_TO_THIS_ADDRESS" : windowMinutes === 0 ? "WINDOW_DISABLED" : "ADDRESS_ALREADY_USED",
            holdUntil: holdUntil ? holdUntil.toISOString() : null,
            newAddressWindowMinutes: windowMinutes,
            expiresAt: expiresAt.toISOString(),
            confirmationsRequired: selected.confirmations,
            ledgerTransactionId: reserved.transactionId,
            ledgerTransactionKey: `withdrawal:${inserted.row.id}:reserve`,
            requestedAt: now.toISOString(),
            intent,
          },
        });

        return { kind: "created" as const, row: inserted.row, available };
      }),
  );

  if (!locked.ok) {
    return refusal(
      reason("ALREADY_RUNNING", {
        message:
          "Another request for this account's balance is being decided right now, so this one was not started. Try again in a moment.",
        detail: locked.holder ?? undefined,
      }),
      { network: selected },
    );
  }

  const outcome = locked.value;
  if (outcome.kind === "refused") {
    return {
      withdrawal: null,
      reason: outcome.reason,
      refused: true,
      created: false,
      availableMinor: outcome.available.toString(),
      network: selected,
    };
  }
  return {
    withdrawal: outcome.row,
    reason: null,
    refused: false,
    created: outcome.kind === "created",
    availableMinor: outcome.available.toString(),
    network: selected,
  };
}
