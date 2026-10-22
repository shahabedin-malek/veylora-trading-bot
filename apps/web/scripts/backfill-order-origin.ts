#!/usr/bin/env tsx
/**
 * Fill in `TradeOrder.origin` for orders written before the column existed.
 *
 * The origin column was added after orders had already been placed, so every older
 * row reads `manual` — the column's default. The account's assistant
 * paper-performance block selects on that column, so earlier assistant orders are
 * missing from it until this runs.
 *
 * The evidence is the `ORDER_CREATED` audit event each order was written with: its
 * payload carries the caller's source note as `reason`, and each submission path
 * writes a note that begins with a marker exported by `src/lib/orders/origin.ts`.
 * The classification itself is in `src/lib/orders/origin-backfill.ts`, which refuses
 * to guess: a fallback note, a missing event, an unreadable payload or two events
 * naming different paths leave the row exactly as it is and are reported.
 *
 * Usage:
 *
 *   pnpm orders:backfill-origin                  # report only, writes nothing
 *   pnpm orders:backfill-origin --apply          # write, one transaction per order
 *   DATABASE_URL=file:./dev.db pnpm orders:backfill-origin
 *
 * Every write is a compare-and-set (`origin` must still be `manual`) and commits with
 * an `ORDER_ORIGIN_BACKFILLED` audit event naming the previous origin, the next one
 * and the note the decision rests on, so the trail says why a row changed. The script
 * is idempotent: a second run skips the rows it already moved.
 *
 * A retention window can remove the creation event for a very old order. That is
 * reported as `no-event`, not treated as evidence of anything.
 */
import { auditCreate } from "@/lib/audit/record";
import { prisma } from "@/lib/db";
import { DEFAULT_ORDER_ORIGIN, type OrderOrigin } from "@/lib/orders/origin";
import {
  ORDER_CREATED_AUDIT_ACTION,
  planOrderOriginBackfill,
  type OriginBackfillAuditEvent,
  type OriginBackfillOrder,
  type OriginBackfillPlan,
} from "@/lib/orders/origin-backfill";

const BATCH_SIZE = 500;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function emptyPlan(): OriginBackfillPlan {
  return { candidates: 0, updates: [], skipped: [], unknownNotes: [] };
}

function merge(into: OriginBackfillPlan, part: OriginBackfillPlan): void {
  into.candidates += part.candidates;
  into.updates.push(...part.updates);
  into.skipped.push(...part.skipped);
  const notes = new Map(into.unknownNotes.map((entry) => [entry.note, entry.count]));
  for (const entry of part.unknownNotes) notes.set(entry.note, (notes.get(entry.note) ?? 0) + entry.count);
  into.unknownNotes = [...notes.entries()]
    .map(([note, count]) => ({ note, count }))
    .sort((left, right) => right.count - left.count || left.note.localeCompare(right.note));
}

function countBy<T extends string>(values: readonly T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

async function plan(): Promise<OriginBackfillPlan> {
  const orders = (await prisma.tradeOrder.findMany({
    where: { origin: DEFAULT_ORDER_ORIGIN },
    orderBy: { createdAt: "asc" },
    // The client order id is searched beside the row id: the seed recorded its
    // creation events against the former, and a backfill that ignored them would
    // report "no evidence" where the trail actually has some.
    select: { id: true, origin: true, clientOrderId: true },
  })) satisfies OriginBackfillOrder[];

  const result = emptyPlan();

  for (const batch of chunk(orders, BATCH_SIZE)) {
    const events = (await prisma.auditEvent.findMany({
      where: {
        action: ORDER_CREATED_AUDIT_ACTION,
        objectType: "TradeOrder",
        objectId: {
          in: batch.flatMap((order) => (order.clientOrderId ? [order.id, order.clientOrderId] : [order.id])),
        },
      },
      orderBy: { occurredAt: "asc" },
      select: { objectId: true, action: true, redactedJson: true, occurredAt: true },
    })) satisfies OriginBackfillAuditEvent[];

    merge(result, planOrderOriginBackfill({ orders: batch, events }));
  }

  return result;
}

async function apply(planResult: OriginBackfillPlan): Promise<{ applied: number; raced: number }> {
  let applied = 0;
  let raced = 0;

  for (const update of planResult.updates) {
    const now = new Date();
    const moved = await prisma.$transaction(async (transaction) => {
      // Compare-and-set: another writer (or a previous run) may have moved the row.
      const written = await transaction.tradeOrder.updateMany({
        where: { id: update.orderId, origin: DEFAULT_ORDER_ORIGIN },
        data: { origin: update.to, updatedAt: now },
      });
      if (written.count === 0) return false;

      await auditCreate(transaction, {
        data: {
          actorUserId: null,
          action: "ORDER_ORIGIN_BACKFILLED",
          objectType: "TradeOrder",
          objectId: update.orderId,
          outcome: "SUCCESS",
          redactedJson: JSON.stringify({
            orderId: update.orderId,
            previousOrigin: update.from,
            nextOrigin: update.to,
            evidence: "ORDER_CREATED audit reason",
            reason: update.evidence,
          }),
          beforeJson: JSON.stringify({ origin: update.from }),
          afterJson: JSON.stringify({ origin: update.to }),
          // A data migration is its own source rather than "money", so the trail
          // separates this one-off change from the order path's own events.
          source: "migration",
          occurredAt: now,
        },
      });
      return true;
    });

    if (moved) applied += 1;
    else raced += 1;
  }

  return { applied, raced };
}

async function main() {
  const applyChanges = process.argv.includes("--apply");
  const planned = await plan();

  const report: Record<string, unknown> = {
    mode: applyChanges ? "apply" : "dry-run",
    candidates: planned.candidates,
    plannedUpdates: planned.updates.length,
    byOrigin: countBy<Exclude<OrderOrigin, "manual">>(planned.updates.map((update) => update.to)),
    skipped: countBy(planned.skipped.map((entry) => entry.reason)),
    // Truncated for the console only: the note is already in the audit trail, and a
    // decision message can be long. The planner keeps the whole sentence.
    unknownNotes: planned.unknownNotes.map((entry) => ({ note: entry.note.slice(0, 200), count: entry.count })),
  };

  if (!applyChanges) {
    report.orders = planned.updates.slice(0, 50).map((update) => ({
      orderId: update.orderId,
      from: update.from,
      to: update.to,
    }));
    if (planned.updates.length > 50) report.ordersTruncated = planned.updates.length - 50;
    report.note = "Nothing was written. Re-run with --apply to update these orders.";
  } else {
    const outcome = await apply(planned);
    report.applied = outcome.applied;
    report.skippedBecauseTheRowMoved = outcome.raced;
  }

  console.log(JSON.stringify(report, null, 2));
  await prisma.$disconnect();
  process.exitCode = 0;
}

void main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  await prisma.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});
