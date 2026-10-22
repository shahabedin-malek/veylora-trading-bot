# Phase 35 — CRM and support

One desk where the owner can open a conversation, read the whole account's story in time order, and
leave a note that the account can never read. Tickets, threads, notes and saved replies are stored
rows with their own routes; the timeline merges ten event sources; every status change is audited
with before and after; and an export carries the thread with credential material redacted.

The readings below come from the development server at `http://127.0.0.1:3442` (SQLite `dev.db`,
seeded paper data), driven by headless Chrome with a minted owner session. The session and cookies
were throwaway values. No key, secret or cookie value appears in this record.

## What is there

- `apps/web/src/lib/support/tickets.ts` is the rulebook with no database: status/priority/visibility
  vocabularies, draft validation, the credential patterns, the placeholder set, the account view,
  the audit payload and the export builder.
- `apps/web/src/lib/support/repository.ts` is the database half. Every status change writes its
  `SUPPORT_TICKET_STATUS_CHANGED` audit row in the same transaction as the update.
- `apps/web/src/lib/support/timeline.ts` merges sign-ins, deposits, withdrawals, trades, strategy
  decisions, alert deliveries, ledger entries, admin audit events, ticket messages and notes, each
  carrying the `record` a panel can open.
- `apps/web/src/components/support/support-desk.tsx` and
  `apps/web/src/app/admin/support/page.tsx` are the operator surface behind `crm.support.read`.
- Routes: `/api/admin/support/{tickets,tickets/[ticketId],tickets/[ticketId]/messages,tickets/[ticketId]/export,notes,replies,replies/[replyId],replies/preview,search}`
  plus the account's own `/api/support/tickets`.
- `prisma/migrations/20261020100000_crm_and_support/` adds `SupportTicket`, `TicketMessage`,
  `UserNote`, `SavedReply`, their indexes and foreign keys. `visibility` is a column on the message,
  and `UserNote` has no visibility column at all.

## Timeline, in order

Reading `dev-test-account` through `/api/admin/console/record?type=user&id=dev-test-account`
returned 50 items before the click-path wrote its own note and 51 after, newest first, with every
source present:

```
ledger 5 · decisions 4 · deliveries 1 · audit 24 · signins 5 · deposits 1 · withdrawals 1 · trades 3 · support 6
```

The first entries were the browser sign-in that drove this verification, the note just written, the
internal ticket message, the public reply, then the earlier admin correction and its ledger entry.
Timeline categories observed in the rendered page:

```
signin · note · support · audit · ledger · decision · withdrawal · delivery · trade · deposit
```

Every item has a `record`: a sign-in links to its `session`, a deposit to its `deposit`, a
withdrawal to its `withdrawal`, a trade to its `order`, a decision to its `strategy`, a support
message to its `ticket`. Audit rows link when their object type is one the console can open.

## Bidirectional domain link

A ticket created for `dev-test-account` on the seeded `dev-deposit-seed` deposit answered:

```
deposit dev-deposit-seed · 25 USDT · CREDITED
```

The deposit's own record answered with a `Support tickets` field naming the same ticket:

```
Deposit credited but balance still zero (PENDING) · cmvfuo8m60001n92455oraeb3
```

The field also names an older seeded ticket (`dev-ticket-latency`), so the link is read from the
ticket rows rather than from a flag on the deposit.

## Internal notes and messages

The thread for the ticket contains one PUBLIC message and one INTERNAL message. The operator's
detail showed both, with the internal row labelled `INTERNAL · not sent to the account` and styled
apart. The account's own endpoint, called with a minted `dev-test-account` session, returned the
ticket with the public message and neither the internal body nor any note:

```
GET /api/support/tickets → 200
public message present: true
internal marker/body present: false
```

Notes live in `UserNote`; the user-facing query never selects that table, and
`listTicketsForUser` additionally selects `visibility: "PUBLIC"` in SQL before `userTicketView`
filters again. `tests/support-crm.test.ts` asserts the second filter directly on a mixed thread.

## Saved replies

A saved reply named `deposit status` rendered for the open ticket as:

```
Hi 0x2222222222222222222222222222222222222222, we have your ticket cmvfuo8m60001n92455oraeb3.
Your ledger shows: 20.03 USDT available / 25.03 total. We are checking now and will reply here.
```

Every value came from the ticket's account, the ledger and the signed-in operator — not from the
form. The preview also returned the placeholder map (`user.label`, `user.id`, `user.role`,
`user.wallet`, `account.summary`, `ticket.id`, `ticket.subject`, `operator.label`). An unknown
placeholder is refused when the reply is saved, and a missing value renders as an em dash rather
than literal braces.

## Status changes are audited

Moving the ticket from `OPEN` to `PENDING`, assigning `dev-owner-user` and giving a reason wrote:

```json
{
  "actor": { "type": "User", "id": "dev-owner-user" },
  "target": { "type": "SupportTicket", "id": "cmvfuo8m60001n92455oraeb3", "label": "Deposit credited but balance still zero" },
  "previousStatus": "OPEN",
  "nextStatus": "PENDING",
  "priority": "HIGH",
  "assigneeUserId": "dev-owner-user",
  "reason": "waiting on the ledger check"
}
```

## Search and export

`/api/admin/support/search?q=internal+retry` returned one hit, the internal note, with its excerpt.
`deposit` returned tickets, messages, notes and timeline groups; `ADMIN_LEDGER_CORRECTION` returned
three timeline rows. The rendered search panel said `1 result(s) for internal retry.`

The export is raw Markdown with `text/markdown; charset=utf-8` and an attachment filename:

```
status 200 · attachment; filename="ticket-cmvfuo8m60001n92455oraeb3-deposit-credited-but-balance-still-zero.md"
has "## Thread": true · internal message labelled: true · secret material: false
```

A legacy row was inserted directly with `password=hunter2` and `api_key=abcd1234efgh5678` to test
the export path that predates the write refusal. The export returned both as
`[redacted: assigned credential]` and contained neither value. The write path refuses a new message
containing `sk_live_abcdefghijklmnop1234` with a 400 that names `payment key` but does not echo it.
The short-password case exposed a real gap in the first pattern (it required eight characters); the
pattern now starts at four and the regression is asserted in `tests/support-crm.test.ts`.

## Permission failure

A minted `dev-test-account` (TRADER) session calling the admin support routes received the same
specific refusal from all three:

```
GET /api/admin/support/tickets
GET /api/admin/support/search?q=deposit
GET /api/admin/support/tickets/<id>

403 {"error":"Missing permission crm.support.read (Read customer support records). An administrator grants it in Access.","permissionKey":"crm.support.read"}
```

The page renders `PermissionNotice` with the same key instead of a blank or a generic denial.

## Gates

```
typecheck 0
test      0 — 758/758, 6 in tests/support-crm.test.ts
lint      0
build     0 — /admin/support and all ten support routes in the manifest
plan      0 — 40 phase files, 0 restriction hits
```

The migration was applied to the local SQLite database through the project's `prisma db push` setup
path; `prisma migrate status` cannot read the local file because the Prisma schema's provider targets
PostgreSQL, so the SQL migration was not replayed against Postgres here.

## Screenshots

- `proof/screenshots/phase35-support-page.png` — the desk: search, ticket list, create form, saved
  replies.
- `proof/screenshots/phase35-ticket-detail.png` — one open ticket: public and internal messages,
  linked deposit, controls, notes and the start of the timeline.
- `proof/screenshots/phase35-ticket-timeline.png` — the account timeline below the thread.
- `proof/screenshots/phase35-support-search.png` — `internal retry` returning the note.

## Rollback

Revert this phase's commit and drop `SupportTicket`, `TicketMessage`, `UserNote` and `SavedReply`
(with the `AuditEvent` index). The admin console loses its Support section; no other table changes.
