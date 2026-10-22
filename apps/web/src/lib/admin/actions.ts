import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  ensurePlatformAccounts,
  ensureUserAccount,
  platformAccountCode,
  userAccountCode,
} from "@/lib/ledger/accounts";
import { balancesForUser } from "@/lib/ledger/statements";
import { LedgerAmountError, postLedgerTransaction } from "@/lib/ledger/integer-cent-ledger";
import { createLedgerStore } from "@/lib/ledger/store";
import {
  assetBalance,
  ledgerCorrectionAuditObject,
  ledgerCorrectionAuditPayload,
  ledgerCorrectionPostings,
  type ParsedLedgerCorrection,
} from "@/lib/admin/views";
import { auditCreate } from "@/lib/audit/record";

/**
 * The console's one money action: a balanced correcting entry.
 *
 * The authorisation is the caller's permission, checked by the route before it
 * gets here. There is no second step, no prompt and no second person — the
 * requirement is explicit that the owner's action *is* the authorisation. What
 * this function adds is the part that makes the action safe to run:
 *
 *  - **Both legs are posted together.** A correction is `AVAILABLE` against
 *    `TREASURY`, so the platform's book still balances and the movement is
 *    reproducible from the ledger alone.
 *  - **A debit cannot overdraw an account.** The ledger's invariant is that a
 *    user balance does not go negative without an explicit credit line, so a
 *    correction that would do that is refused with the exact figures rather
 *    than posting a balance nothing else can honour.
 *  - **The audit row is written in the same transaction** as the posting, with
 *    the actor, the target, the reason and the available/total before and after.
 *    A correction that posts but is not audited is not representable.
 *  - **A retry with the same key changes nothing.** The post returns
 *    `ALREADY_COMPLETED`, and this function answers with the original
 *    transaction instead of writing a second audit row for an action that did
 *    not happen again.
 */

export class CorrectionRefused extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "CorrectionRefused";
  }
}

export type CorrectionResult =
  | {
      ok: true;
      transactionId: string;
      alreadyCompleted: boolean;
      asset: string;
      amount: string;
      direction: string;
      before: { available: string; total: string };
      after: { available: string; total: string };
      message: string;
    }
  | { ok: false; status: number; error: string };

export async function postAdminLedgerCorrection(input: {
  actorUserId: string;
  value: ParsedLedgerCorrection;
}): Promise<CorrectionResult> {
  const { actorUserId, value } = input;
  const target = await prisma.user.findUnique({
    where: { id: value.userId },
    select: {
      id: true,
      walletIdentity: { where: { revokedAt: null }, orderBy: { verifiedAt: "desc" }, take: 1, select: { addressDisplay: true } },
    },
  });
  if (!target) return { ok: false, status: 404, error: `No account ${value.userId}.` };
  const targetLabel = target.walletIdentity[0]?.addressDisplay ?? target.id;

  try {
    return await prisma.$transaction(async (transaction) => {
      const store = createLedgerStore(transaction as unknown as PrismaClient, { inTransaction: true });

      // The stored account's scale wins when the account already exists: a
      // correction is posted in the units the ledger already uses, never at a
      // scale a form happened to send.
      const existing = await transaction.ledgerAccount.findMany({
        where: { userId: value.userId, asset: value.asset },
        select: { decimals: true },
      });
      const decimals = existing[0]?.decimals ?? value.decimals;
      if (existing.some((account) => account.decimals !== decimals)) {
        throw new CorrectionRefused(
          `${value.asset} exists on this account at more than one scale, so a correction cannot choose one. Inspect the ledger accounts first.`,
        );
      }

      await ensureUserAccount(store, { userId: value.userId, asset: value.asset, decimals });
      await ensurePlatformAccounts(store, { asset: value.asset, decimals });

      const beforeBalances = await balancesForUser(store, value.userId);
      const before = assetBalance(beforeBalances, value.asset);
      if (value.direction === "DEBIT" && BigInt(before.availableMinor) < BigInt(value.amountMinor)) {
        throw new CorrectionRefused(
          `This debit is ${value.amount} ${value.asset} and the account's available balance is ${before.available} ${value.asset}. The ledger does not allow a user balance to go negative without a credit line, so nothing was posted.`,
        );
      }

      const available = await store.findAccountByCode(userAccountCode(value.userId, value.asset));
      const treasury = await store.findAccountByCode(platformAccountCode("TREASURY", value.asset));
      if (!available || !treasury) {
        throw new CorrectionRefused("The ledger accounts for this correction could not be resolved, so nothing was posted.", 503);
      }

      const outcome = await postLedgerTransaction(store, {
        kind: "ADMIN_CORRECTION",
        idempotencyKey: value.idempotencyKey,
        occurredAt: new Date(),
        postings: ledgerCorrectionPostings({
          direction: value.direction,
          amountMinor: value.amountMinor,
          availableAccountId: available.id,
          treasuryAccountId: treasury.id,
        }),
        actorUserId,
        sourceType: "ADMIN_CONSOLE",
        sourceId: actorUserId,
        memo: value.reason,
      });

      if (!outcome.posted) {
        return {
          ok: true as const,
          transactionId: outcome.transactionId,
          alreadyCompleted: true,
          asset: value.asset,
          amount: value.amount,
          direction: value.direction,
          before,
          after: before,
          message: `Transaction ${outcome.transactionId} already holds this idempotency key, so nothing was posted again.`,
        };
      }

      const afterBalances = await balancesForUser(store, value.userId);
      const after = assetBalance(afterBalances, value.asset);

      await auditCreate(transaction, {
        data: {
          actorUserId,
          action: "ADMIN_LEDGER_CORRECTION",
          ...ledgerCorrectionAuditObject(value.userId),
          outcome: "SUCCESS",
          redactedJson: ledgerCorrectionAuditPayload({
            actorUserId,
            targetUserId: value.userId,
            userLabel: targetLabel,
            asset: value.asset,
            amount: value.amount,
            amountMinor: value.amountMinor,
            direction: value.direction,
            reason: value.reason,
            transactionId: outcome.transactionId,
            availableAccountCode: available.code,
            treasuryAccountCode: treasury.code,
            before: { available: before.available, total: before.total },
            after: { available: after.available, total: after.total },
          }),
        },
      });

      return {
        ok: true as const,
        transactionId: outcome.transactionId,
        alreadyCompleted: false,
        asset: value.asset,
        amount: value.amount,
        direction: value.direction,
        before,
        after,
        message: `Posted ${value.direction === "CREDIT" ? "+" : "−"}${value.amount} ${value.asset}. Available ${before.available} → ${after.available}; total ${before.total} → ${after.total}.`,
      };
    });
  } catch (error) {
    if (error instanceof CorrectionRefused) return { ok: false, status: error.status, error: error.message };
    if (error instanceof LedgerAmountError) {
      return { ok: false, status: 400, error: error.message };
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: false, status: 409, error: "That idempotency key is already in use by a different correction." };
    }
    return {
      ok: false,
      status: 503,
      error: "The correcting entry could not be posted and audited, so nothing was changed.",
    };
  }
}
