import { prisma } from "@/lib/db";
import { auditCreate, recordAudit } from "@/lib/audit/record";
import { AUDIT_RETENTION_ACTION } from "@/lib/audit/verify";

/**
 * Retention as admin data, with its own audit trail (phase 36).
 *
 * A zero window keeps everything, which is the default: an audit trail that
 * silently expires is worse than one that grows. When an owner sets a window, the
 * daily job removes rows older than it, but first writes an
 * `AUDIT_RETENTION_APPLIED` marker carrying the deleted range and the hash of the
 * last deleted row. The verifier treats that marker as an explanation for the gap,
 * so an intentional deletion is not reported as tampering — while an unexplained
 * gap still is.
 *
 * The marker and the deletion are one transaction. A marker that claims a deletion
 * which did not happen, or a deletion with no marker, would both be lies the
 * verifier could not distinguish from an attack.
 */

export const AUDIT_RETENTION_MAX_DAYS = 3_650;
export const AUDIT_RETENTION_BATCH = 1_000;

export type AuditRetentionView = {
  windowDays: number;
  updatedAt: string | null;
  updatedByUserId: string | null;
};

export async function readAuditRetention(): Promise<AuditRetentionView> {
  const row = await prisma.auditRetentionPolicy.findUnique({
    where: { id: "global" },
    select: { windowDays: true, updatedAt: true, updatedByUserId: true },
  });
  return {
    windowDays: row?.windowDays ?? 0,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    updatedByUserId: row?.updatedByUserId ?? null,
  };
}

export function auditRetentionCutoff(windowDays: number, now = new Date()): Date | null {
  if (!Number.isInteger(windowDays) || windowDays <= 0 || windowDays > AUDIT_RETENTION_MAX_DAYS) return null;
  return new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
}

export async function saveAuditRetention(input: {
  actorUserId: string;
  windowDays: unknown;
}): Promise<AuditRetentionView> {
  const windowDays = typeof input.windowDays === "number" ? Math.trunc(input.windowDays) : Number.NaN;
  if (!Number.isInteger(windowDays) || windowDays < 0 || windowDays > AUDIT_RETENTION_MAX_DAYS) {
    throw new AuditRetentionRefusal(
      `A retention window is a whole number of days from 0 to ${AUDIT_RETENTION_MAX_DAYS}; 0 keeps everything.`,
    );
  }

  return prisma.$transaction(async (tx) => {
    const before = await tx.auditRetentionPolicy.findUnique({
      where: { id: "global" },
      select: { windowDays: true, updatedAt: true },
    });
    const row = await tx.auditRetentionPolicy.upsert({
      where: { id: "global" },
      create: { id: "global", windowDays, updatedByUserId: input.actorUserId },
      update: { windowDays, updatedByUserId: input.actorUserId },
      select: { windowDays: true, updatedAt: true, updatedByUserId: true },
    });
    await auditCreate(tx, {
      data: {
        actorUserId: input.actorUserId,
        action: "AUDIT_RETENTION_POLICY_CHANGED",
        objectType: "AuditRetentionPolicy",
        objectId: "global",
        outcome: "SUCCESS",
        source: "admin",
        beforeJson: JSON.stringify({ windowDays: before?.windowDays ?? 0 }),
        afterJson: JSON.stringify({ windowDays: row.windowDays }),
        redactedJson: JSON.stringify({
          before: { windowDays: before?.windowDays ?? 0 },
          after: { windowDays: row.windowDays },
        }),
      },
    });
    return {
      windowDays: row.windowDays,
      updatedAt: row.updatedAt.toISOString(),
      updatedByUserId: row.updatedByUserId,
    };
  });
}

export class AuditRetentionRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditRetentionRefusal";
  }
}

export type AuditRetentionRun = {
  applied: boolean;
  windowDays: number;
  cutoff: string | null;
  deleted: number;
  deletedChained: number;
  markerId: string | null;
};

/**
 * Delete rows past the owner's window, with their marker.
 *
 * Bounded to one batch per run. The job runs daily, so a very old database takes a
 * few days to trim rather than holding a long transaction over the whole trail.
 */
export async function applyAuditRetention(
  input: { now?: Date; actorUserId?: string | null; correlationId?: string | null } = {},
): Promise<AuditRetentionRun> {
  const now = input.now ?? new Date();
  const policy = await readAuditRetention();
  const cutoff = auditRetentionCutoff(policy.windowDays, now);
  if (!cutoff) {
    return {
      applied: false,
      windowDays: policy.windowDays,
      cutoff: null,
      deleted: 0,
      deletedChained: 0,
      markerId: null,
    };
  }

  const candidates = await prisma.auditEvent.findMany({
    where: {
      occurredAt: { lt: cutoff },
      NOT: { action: { startsWith: "AUDIT_RETENTION_" } },
    },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    take: AUDIT_RETENTION_BATCH,
    select: { id: true, chainIndex: true, hash: true },
  });
  if (candidates.length === 0) {
    return {
      applied: false,
      windowDays: policy.windowDays,
      cutoff: cutoff.toISOString(),
      deleted: 0,
      deletedChained: 0,
      markerId: null,
    };
  }

  const chained = candidates.filter((row) => row.chainIndex !== null && row.hash !== null);
  const deletedFromIndex = chained.length > 0 ? Math.min(...chained.map((row) => row.chainIndex!)) : null;
  const deletedToIndex = chained.length > 0 ? Math.max(...chained.map((row) => row.chainIndex!)) : null;
  const deletedTailHash =
    deletedToIndex === null
      ? null
      : (chained.find((row) => row.chainIndex === deletedToIndex)?.hash ?? null);
  const ids = candidates.map((row) => row.id);

  const marker = await prisma.$transaction(async (tx) => {
    const created = await recordAudit(tx, {
      actorUserId: input.actorUserId ?? null,
      action: AUDIT_RETENTION_ACTION,
      objectType: "AuditEvent",
      objectId: null,
      outcome: "SUCCESS",
      source: "retention",
      correlationId: input.correlationId ?? "job:audit-integrity",
      beforeJson: JSON.stringify({ windowDays: policy.windowDays }),
      afterJson: JSON.stringify({
        deletedCount: candidates.length,
        deletedFromIndex,
        deletedToIndex,
        deletedTailHash,
        cutoff: cutoff.toISOString(),
      }),
      redactedJson: JSON.stringify({
        windowDays: policy.windowDays,
        cutoff: cutoff.toISOString(),
        deletedCount: candidates.length,
        deletedFromIndex,
        deletedToIndex,
        deletedTailHash,
      }),
    });
    await tx.auditEvent.deleteMany({ where: { id: { in: ids } } });
    return created;
  });

  return {
    applied: true,
    windowDays: policy.windowDays,
    cutoff: cutoff.toISOString(),
    deleted: candidates.length,
    deletedChained: chained.length,
    markerId: marker.id,
  };
}
