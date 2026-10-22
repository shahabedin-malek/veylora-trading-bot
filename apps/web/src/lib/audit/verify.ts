import type { Prisma } from "@prisma/client";
import {
  AUDIT_GENESIS_HASH,
  computeAuditHash,
  type AuditChainRecord,
} from "@/lib/audit/record";

/**
 * Chain verification (phase 36).
 *
 * Three failures are distinguishable, because an operator needs to know which one
 * happened:
 *
 *  - **MODIFIED** — the stored fields no longer hash to the stored `hash`. Someone
 *    changed a payload, an actor, an outcome or a timestamp after it was written.
 *  - **LINK_BROKEN** — a row's `previousHash` does not name the row before it. A
 *    row was inserted out of order or its predecessor was replaced.
 *  - **MISSING** — a chain index has no row and no retention marker covers it.
 *
 * A retention gap is not a failure. The retention job writes an
 * `AUDIT_RETENTION_APPLIED` marker before deleting a range, and the marker carries
 * the deleted range and the tail hash, so the verifier can follow the chain across
 * the gap instead of calling an intentional deletion tampering.
 */

export const AUDIT_RETENTION_ACTION = "AUDIT_RETENTION_APPLIED";

export type AuditVerificationFailure = {
  kind: "MODIFIED" | "LINK_BROKEN" | "MISSING";
  chainIndex: number;
  id: string | null;
  message: string;
  expected: string | null;
  actual: string | null;
};

export type AuditVerification = {
  ok: boolean;
  checked: number;
  chainLength: number;
  headIndex: number;
  headHash: string | null;
  gaps: { fromIndex: number; toIndex: number; markerId: string }[];
  legacyRows: number;
  firstBroken: AuditVerificationFailure | null;
  verifiedAt: string;
};

type RetentionGap = { fromIndex: number; toIndex: number; tailHash: string; markerId: string };

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

/** The gaps declared by retention markers, keyed by the marker's own `afterJson`. */
export function retentionGapsFromRows(rows: readonly Pick<AuditChainRecord, "id" | "action" | "afterJson">[]): RetentionGap[] {
  const gaps: RetentionGap[] = [];
  for (const row of rows) {
    if (row.action !== AUDIT_RETENTION_ACTION || !row.afterJson) continue;
    try {
      const payload: unknown = JSON.parse(row.afterJson);
      if (typeof payload !== "object" || payload === null) continue;
      const record = payload as Record<string, unknown>;
      const fromIndex = numberField(record.deletedFromIndex);
      const toIndex = numberField(record.deletedToIndex);
      const tailHash = typeof record.deletedTailHash === "string" ? record.deletedTailHash : null;
      if (fromIndex === null || toIndex === null || !tailHash || toIndex < fromIndex) continue;
      gaps.push({ fromIndex, toIndex, tailHash, markerId: row.id });
    } catch {
      continue;
    }
  }
  return gaps;
}

function gapCovering(gaps: readonly RetentionGap[], index: number): RetentionGap | null {
  return gaps.find((gap) => index >= gap.fromIndex && index <= gap.toIndex) ?? null;
}

/**
 * Verify a set of already-read rows. Pure, so a test can plant a modification
 * without a database and the route can reuse the same decision the job makes.
 */
export function verifyAuditRows(
  rows: readonly AuditChainRecord[],
  options: { legacyRows?: number; now?: Date } = {},
): AuditVerification {
  const ordered = [...rows].sort((left, right) => left.chainIndex - right.chainIndex);
  const gaps = retentionGapsFromRows(ordered);
  const headIndex = ordered.length > 0 ? ordered[ordered.length - 1]!.chainIndex : 0;
  const headHash = ordered.length > 0 ? ordered[ordered.length - 1]!.hash : null;
  const byIndex = new Map(ordered.map((row) => [row.chainIndex, row]));
  const verifiedAt = (options.now ?? new Date()).toISOString();

  let checked = 0;
  let previousPresent: AuditChainRecord | null = null;
  let expectedAfterGap: string | null = null;

  for (let index = 1; index <= headIndex; index += 1) {
    const row = byIndex.get(index);
    if (!row) {
      const gap = gapCovering(gaps, index);
      if (!gap) {
        return {
          ok: false,
          checked,
          chainLength: ordered.length,
          headIndex,
          headHash,
          gaps,
          legacyRows: options.legacyRows ?? 0,
          firstBroken: {
            kind: "MISSING",
            chainIndex: index,
            id: null,
            message: `Audit chain index ${index} has no row and no retention marker explains the gap.`,
            expected: previousPresent?.hash ?? expectedAfterGap ?? AUDIT_GENESIS_HASH,
            actual: null,
          },
          verifiedAt,
        };
      }
      expectedAfterGap = gap.tailHash;
      continue;
    }

    checked += 1;
    const expectedPrevious = previousPresent?.hash ?? expectedAfterGap ?? AUDIT_GENESIS_HASH;
    if (row.previousHash !== expectedPrevious) {
      return {
        ok: false,
        checked,
        chainLength: ordered.length,
        headIndex,
        headHash,
        gaps,
        legacyRows: options.legacyRows ?? 0,
        firstBroken: {
          kind: "LINK_BROKEN",
          chainIndex: index,
          id: row.id,
          message: `Audit chain index ${index} names previousHash ${row.previousHash}, but the chain expects ${expectedPrevious}.`,
          expected: expectedPrevious,
          actual: row.previousHash,
        },
        verifiedAt,
      };
    }

    const expectedHash = computeAuditHash(row);
    if (row.hash !== expectedHash) {
      return {
        ok: false,
        checked,
        chainLength: ordered.length,
        headIndex,
        headHash,
        gaps,
        legacyRows: options.legacyRows ?? 0,
        firstBroken: {
          kind: "MODIFIED",
          chainIndex: index,
          id: row.id,
          message: `Audit chain index ${index} (${row.id}) does not hash to its stored hash; the row was modified after it was written.`,
          expected: expectedHash,
          actual: row.hash,
        },
        verifiedAt,
      };
    }

    previousPresent = row;
    expectedAfterGap = null;
  }

  return {
    ok: true,
    checked,
    chainLength: ordered.length,
    headIndex,
    headHash,
    gaps,
    legacyRows: options.legacyRows ?? 0,
    firstBroken: null,
    verifiedAt,
  };
}

type AuditDb = Pick<Prisma.TransactionClient, "auditEvent">;

const MAX_CHAIN_ROWS = 20_000;

/**
 * Read the chain and verify it. The read is bounded: a trail larger than the cap
 * returns a `MISSING`-style refusal rather than pretending to have checked the
 * whole thing.
 */
export async function verifyAuditChain(db: AuditDb): Promise<AuditVerification> {
  const [rows, legacyRows] = await Promise.all([
    db.auditEvent.findMany({
      where: { hash: { not: null } },
      orderBy: { chainIndex: "asc" },
      take: MAX_CHAIN_ROWS + 1,
      select: {
        id: true,
        chainIndex: true,
        previousHash: true,
        hash: true,
        occurredAt: true,
        actorUserId: true,
        action: true,
        objectType: true,
        objectId: true,
        outcome: true,
        redactedJson: true,
        beforeJson: true,
        afterJson: true,
        source: true,
        correlationId: true,
      },
    }),
    db.auditEvent.count({ where: { hash: null } }),
  ]);

  if (rows.length > MAX_CHAIN_ROWS) {
    const now = new Date().toISOString();
    return {
      ok: false,
      checked: 0,
      chainLength: rows.length,
      headIndex: 0,
      headHash: null,
      gaps: [],
      legacyRows,
      firstBroken: {
        kind: "MISSING",
        chainIndex: MAX_CHAIN_ROWS + 1,
        id: null,
        message: `The audit chain has more than ${MAX_CHAIN_ROWS} chained rows, so this read cannot verify it in one pass.`,
        expected: null,
        actual: null,
      },
      verifiedAt: now,
    };
  }

  const records: AuditChainRecord[] = rows.map((row) => ({
    id: row.id,
    chainIndex: row.chainIndex ?? 0,
    previousHash: row.previousHash ?? "",
    hash: row.hash ?? "",
    occurredAt: row.occurredAt,
    actorUserId: row.actorUserId,
    action: row.action,
    objectType: row.objectType,
    objectId: row.objectId,
    outcome: row.outcome,
    redactedJson: row.redactedJson,
    beforeJson: row.beforeJson,
    afterJson: row.afterJson,
    source: row.source,
    correlationId: row.correlationId,
  }));

  return verifyAuditRows(records, { legacyRows });
}
