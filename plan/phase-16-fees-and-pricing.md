# Phase 16 — Fees and pricing

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

One fee table the owner edits as data — trading, performance, withdrawal and network cost —
applied by the ledger, visible before the user commits, and described on exactly one pricing
page with no number contradicting another.

## Scope

- In: fee configuration, application at withdrawal and on strategy results, fee reporting,
the pricing page, tier caps.

- Out: subscription billing and card payments (an owner/vendor decision, not this phase).

## Files to touch

- `apps/web/src/lib/fees/table.ts`, `apply.ts` (new)
- `apps/web/src/lib/withdrawals/execute.ts` (deduct) and `src/lib/ledger/accounts.ts` (fee account)
- `apps/web/src/app/api/admin/fees/route.ts`, `src/app/admin/fees/page.tsx` (new)
- `apps/web/src/app/pricing/page.tsx` (new)
- `apps/web/prisma/schema.prisma` (`FeeSchedule`) and a migration

## Requirements

1. The fee table holds: withdrawal fee per asset, network cost, a percentage on profitable
   strategy results, and per-tier caps on bots and venue connections — all editable in the
   admin panel with an effective-from time and an audit event per change.
2. Fees are applied by the ledger as explicit entries with their own account, so every fee is
   traceable and reversible.
3. Withdrawal screens show the fee, the network cost and the exact amount that will arrive
   before the owner acts.
4. A fee percentage applies only to a profitable result, never to a loss.
5. The pricing page renders from the same table the code uses; a change in the table changes
   the page, so the two can never disagree.
6. Fee history is reportable per period in `/account` exports.
7. A fee of zero is a valid configuration and must render as free, not as a missing value.

## Acceptance criteria

- Setting a withdrawal fee changes both the deducted amount and the pricing page with one save.
- A profitable and a losing strategy result produce a fee and no fee respectively, proven by
  tests.
- Every fee entry links to its originating action.
- Setting a fee to zero removes the charge and states "no fee".

## Manual verification (owner click-path)

1. In `/admin/fees`, set a withdrawal fee and save; the audit trail records it.
2. On `/trade`, request a withdrawal — the fee and the arriving amount are shown up front.
3. Open `/pricing` — the same numbers, with no contradiction anywhere on the site.
4. Failure case: set a fee larger than the balance — the withdrawal is rejected with a specific
   message before anything is reserved.

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

- [ ] Fee table editable in the admin panel with effective-from and audit per change.
- [ ] Fees post as ledger entries with their own account.
- [ ] Pricing page renders from the same source of truth, asserted by a test.
- [ ] Zero-fee configuration renders as free.

## Rollback

- Revert this phase's commit; fees stop being applied and the pricing page is removed. Set the
  table back to zero first if any fee entry should be reversed.

## Do not do

- No approval gate or confirmation step before a fee applies.
- Do not take a fee on a losing result.
- Do not publish a price on the page that the code does not charge.
- Do not hide a fee until after the user commits.
