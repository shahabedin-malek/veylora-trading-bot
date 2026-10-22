# Phase 34 — admin console

One console from which the owner runs the business: thirteen sections that list, filter and drill
down; one search box across wallets, hashes, user ids and order ids; saved views per owner; and one
money action that states its effect before it runs and is audited with actor, target and
before/after values.

The readings below come from the production build at `http://127.0.0.1:3341`, reached through a
local header proxy that added the seeded owner's session cookie, and from the API the same pages
call. The session was minted as a real `AuthSession` row with a throwaway secret. No cookie,
secret, key or credential appears in this record.

## What is there

- `apps/web/src/app/admin/page.tsx` is the shell: thirteen named sections, the cross-entity search
  and the links to the existing `/admin/access`, `/admin/risk`, `/admin/fees`, `/admin/data` and
  `/admin/models` pages. Those pages keep their own routes and render under
  `apps/web/src/app/admin/layout.tsx`, which is what keeps the phase's rollback true.
- `apps/web/src/components/admin/admin-console.tsx` is the client surface: section tabs, filters,
  column choice, saved views, the drill-down and the correction form. It prints the action's effect
  as information beside the button; there is no confirmation dialogue, consent screen or
  second-person step anywhere in the console.
- `apps/web/src/lib/admin/views.ts` owns the section vocabulary, filter/column parsing, saved-view
  storage contract, search classification, timeline merge, correction validation and audit payload.
  `queries.ts` is the database half (bounded reads, the timeline, saved-view persistence);
  `actions.ts` is the one mutating action.
- `apps/web/src/app/api/admin/console/{route,search,record,correction}.ts` and
  `apps/web/src/app/api/admin/views/route.ts` expose those reads and that action behind
  `admin.console.read` / `admin.console.operate`, with the same origin and permission patterns as
  the earlier admin routes.
- `prisma/migrations/20261019190000_admin_console/` adds `AdminSavedView`, unique per
  `(userId, section, name)`.

Every section has at least one filter and a column set larger than its default:

| Section | Filters | Columns | Shown by default |
| --- | ---: | ---: | ---: |
| users | 3 | 6 | 5 |
| wallets | 3 | 5 | 5 |
| balances | 2 | 6 | 5 |
| ledger | 5 | 9 | 7 |
| deposits | 3 | 8 | 7 |
| withdrawals | 3 | 8 | 7 |
| orders | 3 | 8 | 7 |
| strategies | 2 | 7 | 6 |
| venue keys | 2 | 7 | 6 |
| fees | 1 | 5 | 4 |
| limits | 1 | 4 | 4 |
| switches | 1 | 5 | 5 |
| audit | 5 | 7 | 6 |

Against the seeded database, every section answered with rows and no error:

```
users 4 · wallets 3 · balances 2 · ledger 15 · deposits 1 · withdrawals 2 · orders 24
strategies 2 · venue-keys 2 · fees 18 · limits 7 · switches 4 · audit 300 (the list cap)
```

## Search, saved views, drill-down

- **Wallet.** `0x2222222222222222222222222222222222222222` was read as `wallet` and returned two
  matches: the wallet identity for `dev-test-account` and, beside it, the account record itself
  ("Account record and its timeline"). Clicking either opened the account's record.
- **Transaction hash.** The seeded `0xphase151a1471d9e77` was read as an `identifier` (it is not a
  64-hex hash) and returned the one deposit whose `txHash` matches: `20 USDT · CREDITED`.
- **Order id.** `cmvfkcbb2000cn9jzl2if2bpm` returned four matches: the order itself
  (`BTC-USD SUBMITTED`) and its three audit events (`ORDER_CREATED`, `ORDER_SUBMITTED`,
  `ORDER_ATTEMPT`).
- **Saved view.** The owner's `Traders only` view stores `{role: "TRADER"}` and six columns. Below
  the tab it is a button; pressing it navigates to
  `/admin?section=users&role=TRADER&columns=wallet,role,status,lastSeenAt,createdAt,userId`, the
  role select reads `TRADER`, the column box shows all six checked, and the table says `1 row(s)`
  with `dev-test-account`. A full reload of that URL produced the same one row and the same six
  columns. The view is per owner: the same name saved by another owner is a separate row, and a
  delete naming another owner's id deletes nothing (asserted by
  `tests/admin-console.test.ts`).
- **Drill-down.** The `dev-test-account` record showed its status, wallet, ledger-derived balance
  (`0.03` available, `0.03` total), `RECONCILES WITH /account`, the correction form, and a merged
  timeline of **29 events**: 2 ledger, 3 decisions, 0 deliveries, 24 audit, newest first. The
  first two entries were the correction's audit event and its ledger movement.

## The action, the audit and `/account`

A correction of **+0.02 USDT** was posted to `dev-test-account` with the reason
`Phase 34 audit-target correction`:

```
before: available 0.01, total 0.01
after:  available 0.03, total 0.03
message: Posted +0.02 USDT. Available 0.01 → 0.03; total 0.01 → 0.03.
```

- The console's **LEDGER** section then showed `ADMIN_CORRECTION · 0.02 USDT` (not `20000`), and
  the target's timeline showed `ADMIN_CORRECTION · CREDIT 0.02 USDT` with the reason and the
  account code.
- The console's drill-down balance and the **AUDIT** section both read `0.03` for the target, and
  its reconciliation reported `ok: true` with no differences.
- `/api/account`, the data behind `/account`, read the same ledger for `dev-test-account`:
  `available 0.03`, `total 0.03`, two entries. The account page is client-rendered, so the
  reconciliation reading is the API the page calls plus the shared `assetBalanceViews` path the
  test compares directly.
- The audit row names the actor and the target and carries both balances:

```json
{
  "actor": { "type": "User", "id": "dev-owner-user" },
  "target": { "type": "User", "id": "dev-test-account", "label": "0x2222…2222" },
  "amount": "0.02",
  "direction": "CREDIT",
  "reason": "Phase 34 audit-target correction",
  "ledgerTransactionId": "cmvfpxs9a0001n9wbw8fbgmr0",
  "accounts": { "available": "user:dev-test-account:USDT:available", "treasury": "platform:treasury:USDT" },
  "before": { "available": "0.01", "total": "0.01" },
  "after": { "available": "0.03", "total": "0.03" }
}
```

A retry with the same idempotency key returns the original transaction with `alreadyCompleted:
true` and posts nothing; a debit larger than the available balance is refused with both figures
before anything is written. Both paths are in `lib/admin/actions.ts`; the validation and balanced
legs are covered by the pure tests, and the button is disabled while a submission is in flight.

## Failure case

A signed-in trader (no `admin.console.read`) opened `/admin` and `/admin/fees`. Neither was blank:

```
/admin       PERMISSION REQUIRED · The admin console needs the admin.console.read permission ·
             REFUSED · Missing permission admin.console.read (Read the admin console).
             An administrator grants it in Access. · Missing permission key: admin.console.read
/admin/fees  PERMISSION REQUIRED · The fee table needs the fees.manage permission · REFUSED ·
             Missing permission fees.manage (Manage the fee table and pricing) ·
             Missing permission key: fees.manage
```

`GET /api/admin/console?section=users` with the same session answered `403` with the same
sentence and `permissionKey: "admin.console.read"`.

## Defects found and fixed

1. **Money was printed in minor units.** The ledger list and timeline rendered
   `entry.amountMinor` as if it were whole units — the 0.01 correction appeared as
   `CREDIT 10000 USDT`, and the earlier 1.00 correction as `1000000`. Withdrawal `net` and `fee`
   cells and the withdrawal record title had the same fault, and the search result label for a
   withdrawal printed `netMinor`. Each now converts at the account's or row's own `decimals`
   through `minorToDecimal`; the 0.02 correction reads `0.02 USDT`, the ledger-entry record title
   reads `ADMIN_CORRECTION · 0.02 USDT`, and the seeded withdrawals read `net 1` / `fee 1` and
   `net 4` / `fee 1`.
2. **A correction's audit event was on the operator's timeline, not the target's.** It pointed at
   the `LedgerTransaction`, and the target's timeline query matches `actorUserId` and `objectId`
   against the user. The owner saw the event (as actor); the account whose balance changed did
   not. The event now points at the `User` (`ledgerCorrectionAuditObject`), with the
   transaction id kept in the payload. The first correction after the fix appears at the top of
   the target's timeline (`AUDIT ADMIN_LEDGER_CORRECTION · User dev-test-account · SUCCESS`), and
   the test asserts the object the action uses. The earlier 0.01 correction predates the fix and
   remains as originally written; audit rows are append-only and were not rewritten.

## Gates

```
typecheck 0
test      0 — 751/751, including 7 in tests/admin-console.test.ts
lint      0
build     0
plan      0 — 40 phase files, 40 index entries, 0 restriction hits, 0 warnings
```

The full suite includes the saved-view round trip and owner isolation, the correction validation
and balanced legs, the actor/target/before/after payload and audit object, and the console balances
being the same `assetBalanceViews` rows `/account` renders after a correction.

## Limits

- The migration and the saved-view table ran on the development SQLite database through
  `prisma db push`; no Postgres was reachable from this machine.
- The seeded transaction hash is a short development string, so search classifies it as an
  `identifier` rather than a `transaction`; it still finds the deposit. A 64-hex hash takes the
  transaction branch.
- Search and lists are bounded (250 rows per section, 300 audit rows, 1,500 ledger entries before
  the in-process filter); the console says when a list is truncated rather than implying a total.
- The two 0.01/1.00 corrections from the verification run are development ledger movements. They
  are real, balanced and audited; they were not reversed, because the ledger's own rule is that a
  correction is another entry, not a deletion.
- The browser half ran against the production build; the development server was not used for the
  click-path because a concurrent `next build` replaced its chunks mid-run.

Screenshots: `proof/screenshots/phase34-console-top.png`, `phase34-saved-view.png`,
`phase34-console.png`.
