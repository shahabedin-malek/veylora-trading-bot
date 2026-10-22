import type { Prisma } from "@prisma/client";
import type { TotpServiceStore } from "@/lib/auth/totp-service";
import { auditCreate } from "@/lib/audit/record";

/**
 * The service's store, over a Prisma transaction.
 *
 * Separate from the routes because two of them need it and a route file may only
 * export its handlers. The transaction stays with the caller: enrolling, issuing
 * backup codes and writing the audit entry are one unit of work, and so is proving
 * a code and consuming it.
 *
 * `markBackupCodeUsed` is the one operation that is not a plain write. It is a
 * conditional UPDATE on `usedAt`, so single-use is decided by the database rather
 * than by a read followed by a write — two requests presenting the same code
 * cannot both be told they succeeded.
 */
export type TotpTransaction = Prisma.TransactionClient;

export function totpStore(transaction: TotpTransaction): TotpServiceStore {
  return {
    findCredential: (userId) => transaction.totpCredential.findUnique({ where: { userId } }),
    createCredential: (data) => transaction.totpCredential.create({ data }),
    updateCredential: (userId, data) => transaction.totpCredential.update({ where: { userId }, data }),
    deleteCredential: async (userId) => {
      await transaction.totpBackupCode.deleteMany({ where: { credential: { userId } } });
      await transaction.totpCredential.deleteMany({ where: { userId } });
    },
    replaceBackupCodes: async (credentialId, codeHashes) => {
      await transaction.totpBackupCode.deleteMany({ where: { credentialId } });
      if (codeHashes.length > 0) {
        await transaction.totpBackupCode.createMany({
          data: codeHashes.map((codeHash) => ({ credentialId, codeHash })),
        });
      }
    },
    findBackupCode: (credentialId, codeHash) =>
      transaction.totpBackupCode.findUnique({
        where: { credentialId_codeHash: { credentialId, codeHash } },
        select: { id: true, usedAt: true },
      }),
    markBackupCodeUsed: async (backupCodeId, at) => {
      const result = await transaction.totpBackupCode.updateMany({
        where: { id: backupCodeId, usedAt: null },
        data: { usedAt: at },
      });
      return result.count === 1;
    },
    countUnusedBackupCodes: (credentialId) =>
      transaction.totpBackupCode.count({ where: { credentialId, usedAt: null } }),
    recordAudit: async ({ actorUserId, action, objectType, objectId, outcome, detail }) => {
      await auditCreate(transaction, {
        data: { actorUserId, action, objectType, objectId, outcome, redactedJson: JSON.stringify(detail) },
      });
    },
  };
}
