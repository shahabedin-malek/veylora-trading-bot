# Phase 36 — Audit log and compliance trail

One append-only record for auth, money, strategy, credential, limit, fee and admin events, with a
hash chain that detects a changed or missing row, verifiable JSON/CSV exports and retention that
explains its own deletions.

The readings below come from the development server at `http://127.0.0.1:3360` (SQLite `dev.db`,
seeded paper data) with a throwaway owner session. No secret or cookie value is reproduced here.

## What is there

- `apps/web/src/lib/audit/record.ts` — the one writer. It takes the tip's `chainIndex` and `hash`,
  computes the next link, and creates the row. `source` and `correlationId` default from the action
  and the request context; `beforeJson`/`afterJson` are normalised here. It has no update or delete
  function.
- `apps/web/src/lib/audit/verify.ts` — the pure verifier distinguishes `MODIFIED`, `LINK_BROKEN` and
  `MISSING`, names the first broken link, accepts declared retention gaps, and reports legacy rows.
- `apps/web/src/lib/audit/query.ts` — validated filters (actor, target, action, source, correlation,
  date range), a bounded read and export limit.
- `apps/web/src/lib/audit/export.ts` — chain-ordered JSON/CSV with a manifest whose `contentHash` is
  SHA-256 over the exported events (JSON) or the whole file (CSV).
- `apps/web/src/lib/audit/retention.ts` — admin retention data, with the marker and deletion in one
  transaction.
- `apps/web/src/components/audit/audit-log.tsx` and `apps/web/src/app/admin/audit/page.tsx` — the
  filtered view, chain report, retention control and export links.
- Routes: `GET/POST /api/admin/audit`, `GET /api/admin/audit/export`.
- `apps/web/scripts/audit-integrity.ts` (`pnpm audit:verify`) — the same verifier with a non-zero
  exit status, which is what the manual failure case calls.
- `prisma/migrations/20261020120000_audit_log_chain/migration.sql` — nullable chain columns, unique
  `chainIndex`/`hash`, correlation index and `AuditRetentionPolicy`. Existing rows stay null and are
  reported as the legacy prefix.

## The chain as rendered

The page reported, after three chained events and 719 legacy rows:

```
CHAIN INTACT
3 events verified through link 3.
Head 17b76b681f…3508f2 · 719 rows predate hashing · no gaps.
```

The three events, read newest first:

```
3  SUPPORT_TICKET_CREATED          correlation 891ad936-d7c7-46c1-80b5-d1b331e81821
2  SUPPORT_TICKET_CREATED          correlation —
1  AUDIT_RETENTION_POLICY_CHANGED   correlation —
```

The first two predate the change that resolves a correlation id from the request headers; the third
carries the middleware's request id. Filtering by that id returned exactly one event.

## A modified row is named

A byte-identical copy of the database was made and one chained action was changed directly in SQL.
`DATABASE_URL=file:./dev-audit-tamper.db pnpm audit:verify` exited `1` and printed:

```
Audit chain is broken at index 3: MODIFIED
Audit chain index 3 (a4d1f0c8-…) does not hash to its stored hash; the row was modified after it was written.
```

The unmodified database verified with exit `0`, `checked: 3`, `headIndex: 3`, `legacyRows: 719`.

## Export and manifest

`GET /api/admin/audit/export?format=json&action=SUPPORT` answered 200 with:

```
content-type: application/json; charset=utf-8
content-disposition: attachment; filename="audit-2026-10-19.json"
cache-control: no-store
x-audit-content-hash: 726424c3…
x-audit-manifest: <base64url manifest>
```

Recomputing SHA-256 over the exported `events` array matched both the manifest's `contentHash` and
the header. The file is in chain order (legacy first, then `chainIndex` ascending), even though the
view queries newest-first, so the manifest's `firstChainIndex`/`lastChainIndex` describe the range it
names. Changing one action in the file failed the same check in the test.

## Retention is admin data and its deletions are events

Saving a 365-day window through `POST /api/admin/audit` (`{"action":"retention","windowDays":365}`)
returned the stored setting and wrote chain link 1, `AUDIT_RETENTION_POLICY_CHANGED`. The UI shows
`365 DAYS`, the last save time and the owner. A deletion run writes `AUDIT_RETENTION_APPLIED` with
the deleted range and tail hash in the same transaction; the verifier treats that gap as declared
rather than tampering.

## Permission surface

`audit.read` renders the page and allows the filtered read and export; `audit.manage` is required for
the verify and retention POST. Both are active site permissions, so an administrator can grant them
from Access. The page reports the same `PermissionNotice` key when the account lacks `audit.read`.

## Gates

```
typecheck 0
test      0 — 765/765, 7 in tests/audit-log.test.ts
lint      0
build     0 — /admin/audit and both audit API routes in the manifest
plan      0 — 40 phase files, 0 restriction hits
```

The audit tests cover a five-step seeded journey producing links `1..5`, tampering naming index 3,
a deleted row naming index 2, a rewritten `previousHash` reported as `LINK_BROKEN`, a retention
marker explaining a gap, JSON/CSV manifest verification and a source scan proving `record.ts` is the
only creator and `retention.ts` the only deleter.

## Screenshot

- `proof/screenshots/phase36-audit-log.png` — `/admin/audit` after the chain read: `CHAIN INTACT`, the
  per-event correlation id, the retention window and the filtered export controls.

## Limits

The live deposit and withdrawal paths were not driven in this pass because the development
environment has no `DEPOSIT_ADDRESS_MNEMONIC` or `WITHDRAWAL_HOT_WALLET_MNEMONIC`; both answered
with the named configuration gap instead of writing. Their audit calls are covered by the writer
test and by the existing subsystem tests, not by an end-to-end money movement here.

## Rollback

Revert this phase and drop the added columns, indexes, `AuditRetentionPolicy` and the two audit
routes. Existing audit rows remain; rows written by this phase keep their hash values but nothing
reads them, and the previous audit behaviour returns.
