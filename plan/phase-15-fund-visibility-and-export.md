# Phase 15 — Fund visibility and export

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

One place that answers "where is my money": balances, positions, P&L, full transaction history,
meaningful exports, and read-only venue imports for people who will not hand over trade keys.

## Scope

- In: an account overview page, P&L computation from the ledger, history filters, CSV/JSON
export, read-only venue import path, report-style summaries.

- Out: tax filing logic; market pricing sources (phase 19).

## Files to touch

- `apps/web/src/app/account/page.tsx` and `src/components/account-overview.tsx` (new)
- `apps/web/src/lib/ledger/statements.ts` (reuse), `src/lib/portfolio/pnl.ts` (new)
- `apps/web/src/app/api/account/route.ts`, `src/app/api/account/export/route.ts`
- `apps/web/src/lib/trading/credential-vault.ts` (read-only key flag)
- `apps/web/src/lib/wundertrading/client.ts` (read-only import)

## Requirements

1. Balances per asset with ledger provenance, positions with cost basis, and realised and
   unrealised P&L computed from ledger entries plus current prices — never from a stored total.
2. History lists every ledger entry and every deposit and withdrawal with filters for asset,
   type and date range, and a search by transaction hash.
3. Export produces CSV and JSON that reconcile exactly to the on-screen totals for the same
   filter, with a column per field the owner needs for their own record-keeping.
4. A read-only import path accepts venue credentials labelled read-only, shows imported
   balances and trades as external (clearly distinguished from platform balances), and refuses
   to use them for trading with an explicit message.
5. Report-style summaries: per-period inflow, outflow, trading result and fees, comparable to a
   tax-style summary.
6. Every figure on the page states its source and its as-of time, so a stale import is obvious.

## Acceptance criteria

- Screen totals equal ledger sums for the selected filter, asserted by a test.
- An export re-imported by a script reconciles to the same totals.
- A read-only key cannot be used to place an order — the attempt is rejected by name.
- External imported balances never appear as spendable platform balances.

## Manual verification (owner click-path)

1. Open `/account`; balances, positions and P&L are shown with as-of times.
2. Filter history to today and export CSV; the totals match the screen.
3. Connect a read-only venue key and confirm imported balances appear as external and are not
   spendable.
4. Failure case: attempt to place an order with the read-only key — a specific rejection saying
   the key is read-only.

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

- [ ] Screen, ledger and export reconcile, proven by a test.
- [ ] External balances are visibly separate and never spendable.
- [ ] Every figure states its source and as-of time.
- [ ] Read-only keys are refused for trading with a named reason.

## Rollback

- Revert this phase's commit; the page and routes disappear and no stored data changes.

## Do not do

- No approval gate or confirmation step on an export.
- Do not present an estimated or cached figure as a live one.
- Do not hide a stale provider behind a plausible number.
- Do not treat an imported external balance as money the platform can move.
