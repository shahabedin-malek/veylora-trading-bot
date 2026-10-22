# Phase 35 — CRM and support

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

The owner can look at one user and understand everything: conversations and tickets, internal
notes, and the full event history behind them — enough context to answer "what did the system do
and why" without reading a log file.

## Scope

- In: tickets/conversations, notes, per-user event timeline, saved replies, assignment and status, search, export.
- Out: external helpdesk vendors (an owner decision if wanted later); audit retention (phase 36).

## Files to touch

- `apps/web/src/app/admin/support/page.tsx`, `src/components/support/*` (new)
- `apps/web/src/app/api/admin/support/**` (tickets, notes, replies) (new)
- `apps/web/src/lib/support/timeline.ts`, `tickets.ts` (new)
- `apps/web/prisma/schema.prisma` (`SupportTicket`, `TicketMessage`, `UserNote`, `SavedReply`) and a migration

## Requirements

1. A ticket has a subject, status, priority, assignee and a message thread with timestamps and
   authors; status changes are audited.
2. Internal notes are separate from messages a user could see, and are marked as internal in the
   data model, not only in the UI.
3. The user timeline merges, in time order: sign-ins, deposits, withdrawals, trades, strategy
   decisions, alert deliveries, admin actions and support messages, each linking to its record.
4. Saved replies with placeholders for user and account details.
5. Search across tickets, notes and user timeline content, and an export of a ticket thread.
6. A ticket can be linked to the domain record that caused it — an order, a withdrawal or a
   strategy — and the link is visible from both sides.
7. Nothing in a ticket, note or export contains a credential or a secret value.

## Acceptance criteria

- The timeline shows a seeded user's deposit, withdrawal, trade and sign-in in correct order.
- An internal note is not returned by any user-facing endpoint, proven by a test.
- A saved reply inserts the correct user details.
- Ticket export contains the thread and no secret material.

## Manual verification (owner click-path)

1. Open `/admin/support`, create a ticket for the test user and add a message and an internal note.
2. Open the user timeline and confirm the ticket, note and their trades appear in order.
3. Link the ticket to a deposit and confirm the link shows from the deposit record too.
4. Failure case: attempt to read a ticket without support permission — a specific denial naming
   the permission.

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

- [ ] Tickets, messages, notes and replies stored and searchable.
- [ ] The per-user timeline merges every event type in order.
- [ ] Internal notes unreachable from user-facing endpoints, proven by a test.
- [ ] Exports contain no credential material.

## Rollback

- Revert this phase's commit and drop the four tables; the admin console loses its support
  section and nothing else changes.

## Do not do

- No approval gate or confirmation dialogue in front of a ticket action.
- Do not treat a note as private in the UI only; enforce it in the data layer.
- Do not surface a secret in a timeline, a note or an export.
- Do not hide a support section that exists.
