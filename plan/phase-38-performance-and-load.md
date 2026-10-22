# Phase 38 — Performance and load

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

The product stays fast as data accumulates: measured page and query times, indexes that match the
real access patterns, a runner that keeps its cadence under load, and before/after numbers
recorded rather than impressions reported.

## Scope

- In: measurement of the critical pages and queries, index and query work, runner throughput, caching, connection handling, recorded evidence.
- Out: new features; infrastructure migration (an owner decision if the host cannot cope).

## Files to touch

- `apps/web/prisma/schema.prisma` (indexes on ledger, audit, orders, decisions) and a migration
- `apps/web/src/lib/ledger/statements.ts`, `src/lib/audit/export.ts`, `src/lib/runner/scheduler.ts`
- `apps/web/src/lib/market-data/cache.ts`, `src/lib/db.ts` (connection handling)
- `apps/web/scripts/bench.mjs` (new)

## Requirements

1. Measure, with a script, the response time of `/`, `/trade`, `/account`, `/admin` and the
   list endpoints for ledger, orders and audit against a database seeded with a realistic volume
   (at least 100k ledger entries, 50k audit events, 20k orders).
2. Identify the slowest queries with `EXPLAIN ANALYZE` and add indexes that match the real filter
   and sort patterns; record each change with the before and after timing.
3. Statement and export queries must page or stream rather than loading everything into memory;
   an export of the seeded volume completes without exhausting memory.
4. Runner throughput: with a realistic number of active strategies, the scheduler completes a
   pass inside its interval, and the measured headroom is reported.
5. Cache correctness under load: a cache key includes the network and as-of time, so a stale
   value cannot be served as fresh.
6. Record every measurement and improvement in this phase's report, including anything that is
   still slow and why.
7. If the host cannot meet the required cadence or response budget, say so explicitly with the
   measured numbers and propose what can be met.

## Acceptance criteria

- Every measured page and endpoint has a recorded before and after number.
- The seeded-volume export completes without a memory error.
- A scheduler pass completes inside its interval with the seeded strategy count.
- Each added index is justified by a before/after measurement in the report.

## Manual verification (owner click-path)

1. Run `bench.mjs` against the seeded volume and read the table of results.
2. Open `/trade` and `/account` with the seeded volume and confirm they feel responsive, with the
   timings from the script matching the experience.
3. Trigger an export of the full history and watch it complete.
4. Failure case: run the benchmark against an empty database — it reports the volume it used, so a
   misleadingly fast result cannot be mistaken for a real one.

## Automated verification

```bash
cd apps/web
pnpm --config.verify-deps-before-run=false typecheck; echo "typecheck=$?"
pnpm --config.verify-deps-before-run=false test;      echo "test=$?"
pnpm --config.verify-deps-before-run=false lint;      echo "lint=$?"
pnpm --config.verify-deps-before-run=false build;     echo "build=$?"
cd ../.. && node scripts/validate_plan.mjs; echo "plan=$?"
```

## Definition of done

- [ ] Measurements taken at a stated, realistic volume and recorded with before/after values.
- [ ] Indexes justified by measurement, not intuition.
- [ ] Exports and statements stream or page.
- [ ] Any remaining bottleneck named with its measured number and a proposal.

## Rollback

- Revert this phase's commit; the added indexes can remain (they are additive) or be dropped by
  the migration's down path.

## Do not do

- No approval gate or confirmation step added while optimising.
- Do not claim an improvement without a measurement on representative data.
- Do not weaken a correctness check to make something faster.
- Do not silently reduce a cadence the requirement needs; report the limit and propose options.
