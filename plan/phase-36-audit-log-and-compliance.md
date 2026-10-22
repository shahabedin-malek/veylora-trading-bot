# Phase 36 — Audit log and compliance trail

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

One append-only audit trail covering authentication, money, strategies and admin actions, with
exports, retention windows and evidence that a record was altered or removed — the operator-side
record that none of the researched competitors publish.

## Scope

- In: audit event model and writers, the audit view with filters, export, retention, tamper evidence, per-entity timelines.
- Out: legal text (phase 40); CRM content (phase 35).

## Files to touch

- `apps/web/src/lib/audit/record.ts`, `verify.ts`, `export.ts` (new)
- `apps/web/src/app/api/admin/audit/route.ts`, `export/route.ts` (new), `src/app/admin/audit/page.tsx` (new)
- `apps/web/src/lib/runner/scheduler.ts` (register the integrity check job)
- `apps/web/prisma/schema.prisma` (`AuditEvent` extension: hash chain columns) and a migration

## Requirements

1. Every auth, money, strategy, credential, limit, fee and admin event writes exactly one audit
   event with actor, target, action, before/after values, source and correlation id.
2. Events are append-only: no code path updates or deletes one, and the table's grants reflect
   that.
3. Each event carries a hash chained to its predecessor; a verification job detects a modified or
   missing record and reports the first broken link.
4. The audit view filters by actor, target, action, date range and correlation id, and follows a
   correlation id across services.
5. Export produces JSON and CSV for a filter range, with a manifest that includes the range and a
   hash so an exported file can be checked later.
6. Retention windows are admin data with a stated effect; deletion at the end of a window is
   logged as its own audit event.
7. The per-entity timeline from phase 35 renders from this same store, so there is one source of
   truth.

## Acceptance criteria

- A seeded journey (sign-in, deposit, strategy start, order, withdrawal) produces a complete,
  ordered audit chain.
- Editing a row directly in the database makes the integrity job report the first broken link.
- An export re-verifies against its manifest hash.
- No API or UI path can update or delete an audit event.

## Manual verification (owner click-path)

1. Run the seeded journey, then open `/admin/audit` and read the chain in order.
2. Filter by the correlation id of one withdrawal — every related event is listed.
3. Export a range and verify the manifest hash.
4. Failure case: modify an audit row by hand, run the integrity job — it names the broken link
   and exits non-zero.

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

- [ ] One writer path used by every subsystem, asserted by tests.
- [ ] Hash chain verified by a scheduled job and by a test that plants a modification.
- [ ] Exports carry a verifiable manifest.
- [ ] Retention is admin data and its deletions are themselves audited.

## Rollback

- Revert this phase's commit; existing audit rows remain (the added columns are nullable) and the
  previous audit behaviour returns without the integrity checks.

## Do not do

- No approval gate or confirmation step before an audit event is written.
- Do not allow an update or delete path on audit rows.
- Do not let a subsystem write its own incompatible event shape; use the one writer.
- Do not store a secret value in an audit payload.
