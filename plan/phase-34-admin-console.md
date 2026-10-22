# Phase 34 — Admin console

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

One console from which the owner runs the business: users, wallets, balances, deposits,
withdrawals, strategies, venue keys, fees, limits and switches — with search, saved views, and
every action audited.

## Scope

- In: the console shell and its sections, cross-entity search, saved views, bulk-safe actions, drill-downs, the audit link per action.
- Out: CRM conversations (phase 35); audit exports (phase 36); public pages (phase 40).

## Files to touch

- `apps/web/src/app/admin/layout.tsx`, `page.tsx` (new shell), `src/components/admin/*` (new)
- existing `src/app/admin/{access,data,risk}/page.tsx` and their forms (moved under the shell)
- `apps/web/src/app/api/admin/**` (list, detail and action routes; reuse existing patterns)
- `apps/web/src/lib/admin/queries.ts`, `views.ts` (new)

## Requirements

1. Sections for users, wallets, balances and ledger, deposits, withdrawals, orders, strategies,
   venue keys, fees, limits, switches and audit — each listing with filters and column choice.
2. Cross-entity search by wallet address, transaction hash, user id and order id, returning the
   entity and its related records.
3. Saved views store filters and columns per owner; a view reloads to the same list.
4. Drill-down from any row to the full record with its ledger entries, decisions, deliveries and
   audit events in one timeline.
5. Every mutating action states what it will change before it runs, as information rather than a
   prompt, and writes an audit event with actor, target, before and after values.
6. Balances shown here are ledger-derived and reconcile to `/account` for the same user.
7. Confirmation and approval gates invented by an agent are absent: the owner's action is the
   authorisation, and an action that needs two steps does so because the data model requires it,
   not because a prompt was added.

## Acceptance criteria

- Each section lists, filters and drills down; search finds a seeded wallet, hash and order id.
- A saved view restores its filters and columns after a reload.
- An admin balance change (for example a correcting ledger entry) appears in both the console and
  `/account`, and is audited with before/after values.
- Every console action appears in the audit timeline for its target.

## Manual verification (owner click-path)

1. Sign in as the seeded owner and open `/admin`; every section renders against seeded data.
2. Search for the test user's wallet, drill into the record and read the timeline.
3. Save a filtered view, reload, confirm it restores.
4. Failure case: attempt a section without the required permission — a specific denial naming the
   permission, never a blank page.

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

- [ ] Every section lists, filters, searches and drills down against seeded data.
- [ ] Saved views persist per owner, proven by a test.
- [ ] Console balances reconcile to `/account`, asserted by a test.
- [ ] Every action is audited with actor, target and before/after values.

## Rollback

- Revert this phase's commit; the previous `/admin/access`, `/admin/data` and `/admin/risk` pages
  remain reachable on their own routes.

## Do not do

- No approval gate, consent screen or confirmation dialogue in front of an admin action.
- Do not add a second-person approval step.
- Do not show a balance the ledger cannot reproduce.
- Do not hide a console section that exists; show it or leave it out.
