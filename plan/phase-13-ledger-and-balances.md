# Phase 13 — Ledger and balances

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

One ledger of record: integer-minor-unit, double-entry, auditable, with invariants that make
losing money impossible to do silently, plus balance history and per-account statements.

## Scope

- In: ledger entries and accounts, balance derivation, invariants, history, statements.

- Out: deposit detection (phase 12, already written to the ledger); withdrawals (phase 14);
fees (phase 16).

## Files to touch

- `apps/web/src/lib/ledger/integer-cent-ledger.ts` (extend the existing helper)
- `apps/web/src/lib/ledger/accounts.ts`, `statements.ts`, `invariants.ts` (new)
- `apps/web/src/lib/deposits/credit.ts` (writer from phase 12)
- `apps/web/prisma/schema.prisma` (`LedgerAccount`, `LedgerEntry`, `LedgerTransaction`) and a migration
- `apps/web/src/app/api/ledger/route.ts`, `src/components/balance-panel.tsx`

## Requirements

1. Balances are derived from entries, never stored as a mutable field that can drift.
2. Every transaction is balanced: sum of debits equals sum of credits in minor units.
3. Amounts are integers in the asset's minor unit; no floating point anywhere in the money
   path, and a test proves a fractional input cannot enter.
4. Per-asset accounts per user, plus platform accounts for deposits pending, fees and
   treasury — so every movement has a counterparty.
5. Invariant checks run in the runner and are exposed as a health signal: total debits equal
   total credits, no negative user balance without an explicit credit line, no orphan entry.
6. Statements list every entry with transaction id, timestamp, amount, asset and counterparty,
   filterable by date range and exportable.
7. A reversal is a compensating transaction that references the original; entries are never
   edited or deleted.

## Acceptance criteria

- A balanced transaction is accepted; an unbalanced one is rejected by the database or the
  writer, proven by a test.
- An attempted fractional amount is rejected with a specific error.
- The invariant check passes after the phase-12 deposit journey and fails loudly when a test
  deliberately corrupts an entry.
- A statement for a date range matches the sum of its entries exactly.

## Manual verification (owner click-path)

1. After a phase-12 deposit, open the balance panel; the balance equals the ledger sum.
2. Open the statement, filter to today — the deposit appears with its transaction id.
3. Export the statement and confirm the total matches the screen.
4. Failure case: ask for a reversal of the deposit — a compensating entry appears and the
   balance returns to zero, with both entries still visible.

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

- [ ] Double-entry invariants enforced and test-covered.
- [ ] Balances derived, never a mutable field.
- [ ] Statements and exports reconcile to the entries.
- [ ] Reversals are compensating entries; nothing is edited or deleted.

## Rollback

- Revert this phase's commit; deposits stop crediting because the writer is removed, and the
  three new tables are dropped by the migration's down path.

## Do not do

- No approval gate or confirmation step before a ledger entry posts.
- Do not use floating point for money.
- Do not mutate or delete a posted entry to fix a mistake.
- Do not show a balance the ledger cannot reproduce.
