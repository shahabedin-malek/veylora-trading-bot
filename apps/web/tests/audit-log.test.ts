import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import {
  AUDIT_GENESIS_HASH,
  computeAuditHash,
  recordAudit,
  type AuditChainRecord,
} from "@/lib/audit/record";
import {
  buildAuditExport,
  verifyAuditExport,
  type AuditExportSourceRow,
} from "@/lib/audit/export";
import { AUDIT_RETENTION_ACTION, retentionGapsFromRows, verifyAuditRows } from "@/lib/audit/verify";

/**
 * The audit trail's guarantees, exercised without a database.
 *
 * The writer is a fake that implements the two methods `recordAudit` uses
 * (`findFirst` for the tip, `create` to append). Everything else under test is
 * the real implementation: the hash computation, the verifier, the export and its
 * manifest. That is deliberate — the properties being asserted are about the
 * bytes written and read back, not about Prisma.
 */

type FakeRow = AuditChainRecord & { redactedJson: string };

function fakeAuditDb() {
  const rows: FakeRow[] = [];
  const db = {
    auditEvent: {
      findFirst: async (args: {
        where?: { hash?: { not?: string | null } };
        orderBy?: { chainIndex?: "asc" | "desc" };
      }) => {
        const chained = rows.filter((row) => (args.where?.hash?.not !== undefined ? row.hash !== null : true));
        if (chained.length === 0) return null;
        const ordered = [...chained].sort((left, right) =>
          args.orderBy?.chainIndex === "desc" ? right.chainIndex - left.chainIndex : left.chainIndex - right.chainIndex,
        );
        return { chainIndex: ordered[0]!.chainIndex, hash: ordered[0]!.hash };
      },
      create: async (args: { data: FakeRow }) => {
        rows.push({ ...args.data });
        return args.data;
      },
    },
  };
  return { db, rows };
}

type Writer = Parameters<typeof recordAudit>[0];

async function seedJourney(writer: Writer, correlationId = "req-seeded-journey") {
  const steps = [
    ["AUTH_SIGN_IN", "User", "user-1"],
    ["LEDGER_DEPOSIT_CREDITED", "Deposit", "deposit-1"],
    ["STRATEGY_ACTIVATED", "Strategy", "strategy-1"],
    ["ORDER_PLACED", "Order", "order-1"],
    ["WITHDRAWAL_REQUESTED", "Withdrawal", "withdrawal-1"],
  ] as const;
  for (const [action, objectType, objectId] of steps) {
    await recordAudit(writer, {
      actorUserId: "user-1",
      action,
      objectType,
      objectId,
      outcome: "SUCCESS",
      source: "test",
      correlationId,
      afterJson: { objectId },
      redactedJson: JSON.stringify({ objectId }),
    });
  }
}

function asChainRows(rows: readonly FakeRow[]): AuditChainRecord[] {
  return rows.map((row) => ({ ...row }));
}

test("a seeded journey produces one ordered, complete hash chain", async () => {
  const { db, rows } = fakeAuditDb();
  await seedJourney(db as unknown as Writer);

  assert.deepEqual(rows.map((row) => row.chainIndex), [1, 2, 3, 4, 5]);
  assert.deepEqual(rows.map((row) => row.action), [
    "AUTH_SIGN_IN",
    "LEDGER_DEPOSIT_CREDITED",
    "STRATEGY_ACTIVATED",
    "ORDER_PLACED",
    "WITHDRAWAL_REQUESTED",
  ]);
  assert.equal(rows[0]!.previousHash, AUDIT_GENESIS_HASH);
  for (let index = 1; index < rows.length; index += 1) {
    assert.equal(rows[index]!.previousHash, rows[index - 1]!.hash);
  }
  assert.ok(rows.every((row) => row.correlationId === "req-seeded-journey"));

  const report = verifyAuditRows(asChainRows(rows));
  assert.equal(report.ok, true);
  assert.equal(report.checked, 5);
  assert.equal(report.headIndex, 5);
  assert.equal(report.firstBroken, null);
});

test("editing a stored row makes the verifier name the first modified link", async () => {
  const { db, rows } = fakeAuditDb();
  await seedJourney(db as unknown as Writer);
  rows[2]!.afterJson = JSON.stringify({ objectId: "tampered" });

  const report = verifyAuditRows(asChainRows(rows));
  assert.equal(report.ok, false);
  assert.equal(report.firstBroken?.kind, "MODIFIED");
  assert.equal(report.firstBroken?.chainIndex, 3);
  assert.equal(report.firstBroken?.id, rows[2]!.id);
});

test("deleting a row behaves like a gap and names the missing index", async () => {
  const { db, rows } = fakeAuditDb();
  await seedJourney(db as unknown as Writer);
  rows.splice(1, 1);

  const report = verifyAuditRows(asChainRows(rows));
  assert.equal(report.ok, false);
  assert.equal(report.firstBroken?.kind, "MISSING");
  assert.equal(report.firstBroken?.chainIndex, 2);
});

test("a rewritten previousHash is a broken link, not a bad hash", async () => {
  const { db, rows } = fakeAuditDb();
  await seedJourney(db as unknown as Writer);
  rows[3]!.previousHash = "f".repeat(64);

  const report = verifyAuditRows(asChainRows(rows));
  assert.equal(report.ok, false);
  assert.equal(report.firstBroken?.kind, "LINK_BROKEN");
  assert.equal(report.firstBroken?.chainIndex, 4);
});

test("a retention marker turns an intentional deletion into a declared gap", async () => {
  const { db, rows } = fakeAuditDb();
  await seedJourney(db as unknown as Writer);

  const deleted = rows.splice(0, 2);
  assert.equal(deleted.length, 2);
  const tailIndex = rows[rows.length - 1]!.chainIndex;
  const marker: AuditChainRecord = {
    id: "retention-marker",
    chainIndex: tailIndex + 1,
    occurredAt: new Date(),
    actorUserId: null,
    action: AUDIT_RETENTION_ACTION,
    objectType: "AuditEvent",
    objectId: null,
    outcome: "SUCCESS",
    source: "retention",
    correlationId: "job:audit-integrity",
    beforeJson: null,
    afterJson: JSON.stringify({
      deletedCount: deleted.length,
      deletedFromIndex: deleted[0]!.chainIndex,
      deletedToIndex: deleted[1]!.chainIndex,
      deletedTailHash: deleted[1]!.hash,
    }),
    redactedJson: "{}",
    previousHash: rows[rows.length - 1]!.hash,
    hash: "",
  };
  marker.hash = computeAuditHash(marker);

  const withMarker = [...asChainRows(rows), marker];
  assert.deepEqual(
    retentionGapsFromRows(withMarker).map((gap) => [gap.fromIndex, gap.toIndex]),
    [[1, 2]],
  );
  const report = verifyAuditRows(withMarker);
  assert.equal(report.ok, true);
  assert.equal(report.gaps.length, 1);
  assert.equal(report.checked, 4);
});

test("JSON and CSV exports verify against their manifest, and a changed byte fails", async () => {
  const { db, rows } = fakeAuditDb();
  await seedJourney(db as unknown as Writer);
  const source = [...rows].reverse() as unknown as AuditExportSourceRow[];
  const range = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T23:59:59.999Z" };

  const json = buildAuditExport({ rows: source, range, format: "json", generatedAt: new Date("2026-10-20T12:00:00.000Z") });
  assert.equal(json.manifest.count, 5);
  assert.equal(json.manifest.firstChainIndex, 1);
  assert.equal(json.manifest.lastChainIndex, 5);
  const parsed = JSON.parse(json.content) as { events: { chainIndex: number | null }[] };
  assert.deepEqual(
    parsed.events.map((event) => event.chainIndex),
    [1, 2, 3, 4, 5],
    "the file is in chain order even when the query was newest-first",
  );
  assert.equal(verifyAuditExport({ content: json.content, manifest: json.manifest }).ok, true);
  assert.equal(
    verifyAuditExport({ content: json.content.replace("ORDER_PLACED", "ORDER_CANCELLED"), manifest: json.manifest }).ok,
    false,
  );

  const csv = buildAuditExport({ rows: source, range, format: "csv", generatedAt: new Date("2026-10-20T12:00:00.000Z") });
  assert.equal(csv.content.trim().split("\n").length, 6);
  assert.equal(verifyAuditExport({ content: csv.content, manifest: csv.manifest }).ok, true);
  assert.equal(verifyAuditExport({ content: `${csv.content}x`, manifest: csv.manifest }).ok, false);
});

test("only the shared writer creates audit rows, and only retention deletes them", () => {
  const root = new URL("../src", import.meta.url).pathname;
  const offenders: string[] = [];
  const deletions: string[] = [];

  function walk(directory: string) {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(path)) continue;
      const source = readFileSync(path, "utf8");
      const file = relative(new URL("..", import.meta.url).pathname, path);
      const directCreate = /auditEvent\.create\s*\(/.test(source);
      const directUpdate = /auditEvent\.(update|updateMany|upsert)\s*\(/.test(source);
      const directDelete = /auditEvent\.(delete|deleteMany)\s*\(/.test(source);
      if ((directCreate || directUpdate) && !file.endsWith("src/lib/audit/record.ts")) offenders.push(file);
      if (directDelete) deletions.push(file);
    }
  }
  walk(root);

  assert.deepEqual(offenders, [], `audit rows must only be written by record.ts, found: ${offenders.join(", ")}`);
  assert.deepEqual(deletions, ["src/lib/audit/retention.ts"], "retention is the only deletion path");
});
