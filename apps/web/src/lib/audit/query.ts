import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { AuditFilterRange } from "@/lib/audit/export";

/**
 * The audit read used by the view, the export and the correlation follow.
 *
 * Filters are validated here rather than in the route so the page and the export
 * cannot disagree about what a range means, and every read is bounded: an audit
 * view is a recent record, not an unbounded dump.
 */

export const AUDIT_PAGE_LIMIT = 200;
export const AUDIT_EXPORT_LIMIT = 10_000;

export type AuditFilters = AuditFilterRange & {
  limit: number;
  check: boolean;
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function readDate(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = DATE_ONLY.test(trimmed) ? new Date(`${trimmed}T00:00:00.000Z`) : new Date(trimmed);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function endOfRange(value: string | null): string | null {
  const iso = readDate(value);
  if (!iso) return null;
  const original = value?.trim() ?? "";
  if (!DATE_ONLY.test(original)) return iso;
  return new Date(new Date(iso).getTime() + 24 * 60 * 60 * 1000 - 1).toISOString();
}

export function parseAuditFilters(search: URLSearchParams): AuditFilters {
  const limitRaw = Number(search.get("limit") ?? AUDIT_PAGE_LIMIT);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), AUDIT_EXPORT_LIMIT)
    : AUDIT_PAGE_LIMIT;
  return {
    actor: search.get("actor")?.trim().slice(0, 128) || undefined,
    target: search.get("target")?.trim().slice(0, 128) || undefined,
    action: search.get("action")?.trim().slice(0, 160) || undefined,
    correlationId: search.get("correlationId")?.trim().slice(0, 128) || undefined,
    source: search.get("source")?.trim().slice(0, 64) || undefined,
    from: readDate(search.get("from")) ?? undefined,
    to: endOfRange(search.get("to")) ?? undefined,
    limit,
    check: search.get("check") === "1",
  };
}

export function auditWhere(filters: AuditFilters): Prisma.AuditEventWhereInput {
  return {
    ...(filters.actor ? { actorUserId: filters.actor } : {}),
    ...(filters.target
      ? {
          OR: [
            { objectId: filters.target },
            { objectType: filters.target },
          ],
        }
      : {}),
    ...(filters.action ? { action: { contains: filters.action } } : {}),
    ...(filters.correlationId ? { correlationId: filters.correlationId } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.from || filters.to
      ? {
          occurredAt: {
            ...(filters.from ? { gte: new Date(filters.from) } : {}),
            ...(filters.to ? { lte: new Date(filters.to) } : {}),
          },
        }
      : {}),
  };
}

export type AuditRow = {
  id: string;
  chainIndex: number | null;
  occurredAt: Date;
  actorUserId: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  outcome: string;
  source: string | null;
  correlationId: string | null;
  hash: string | null;
  previousHash: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  redactedJson: string;
};

const AUDIT_SELECT = {
  id: true,
  chainIndex: true,
  occurredAt: true,
  actorUserId: true,
  action: true,
  objectType: true,
  objectId: true,
  outcome: true,
  source: true,
  correlationId: true,
  hash: true,
  previousHash: true,
  beforeJson: true,
  afterJson: true,
  redactedJson: true,
} as const;

export async function readAuditEvents(
  filters: AuditFilters,
  limit = filters.limit,
): Promise<{ rows: AuditRow[]; total: number }> {
  const where = auditWhere(filters);
  const [rows, total] = await Promise.all([
    prisma.auditEvent.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: Math.min(limit, AUDIT_EXPORT_LIMIT),
      select: AUDIT_SELECT,
    }),
    prisma.auditEvent.count({ where }),
  ]);
  return { rows, total };
}

/** How many rows the filter holds, without reading one of them. */
export async function countAuditEvents(filters: AuditFilters): Promise<number> {
  return prisma.auditEvent.count({ where: auditWhere(filters) });
}

/**
 * One page of an export, in the export's own order.
 *
 * The trail is read oldest-first (legacy rows in time, then by chain index) so a
 * writer can emit a file whose manifest is computable as it goes and whose hash
 * covers the bytes a reader will verify. A page is at most `AUDIT_EXPORT_BATCH`
 * rows, which is the memory ceiling of the export regardless of the range.
 */
export const AUDIT_EXPORT_BATCH = 1_000;

export async function* iterateAuditEvents(
  filters: AuditFilters,
  batchSize = AUDIT_EXPORT_BATCH,
): AsyncGenerator<AuditRow> {
  const where = auditWhere(filters);
  const size = Math.min(Math.max(batchSize, 1), AUDIT_EXPORT_BATCH);

  // The export's own order, in two passes: a legacy row predates the chain and is
  // written first, then the chained rows in chain order. Each pass continues from
  // the last row it returned rather than skipping a growing prefix, which is what
  // made an export of the whole range take longer the more it had written.
  let legacyCursor: { occurredAt: Date; id: string } | null = null;
  for (;;) {
    const rows: AuditRow[] = await prisma.auditEvent.findMany({
      where: {
        AND: [
          where,
          { chainIndex: null },
          ...(legacyCursor
            ? [
                {
                  OR: [
                    { occurredAt: { gt: legacyCursor.occurredAt } },
                    { occurredAt: legacyCursor.occurredAt, id: { gt: legacyCursor.id } },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: size,
      select: AUDIT_SELECT,
    });
    if (rows.length === 0) break;
    for (const row of rows) yield row;
    if (rows.length < size) break;
    const last: AuditRow = rows[rows.length - 1]!;
    legacyCursor = { occurredAt: last.occurredAt, id: last.id };
  }

  let chainAfter: number | null = null;
  for (;;) {
    const rows: AuditRow[] = await prisma.auditEvent.findMany({
      where: {
        AND: [
          where,
          { chainIndex: chainAfter === null ? { not: null } : { gt: chainAfter } },
        ],
      },
      orderBy: { chainIndex: "asc" },
      take: size,
      select: AUDIT_SELECT,
    });
    if (rows.length === 0) break;
    for (const row of rows) yield row;
    if (rows.length < size) break;
    chainAfter = rows[rows.length - 1]!.chainIndex;
  }
}
