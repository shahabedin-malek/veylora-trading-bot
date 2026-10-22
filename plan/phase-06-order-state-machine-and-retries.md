# Phase 06 — Order and process state machine

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

One lifecycle shared by every order and long-running process — created, submitted, filled,
partially filled, cancelled, failed, reconciled — with retries, idempotency keys and
reconciliation against the venue, and every transition written to the audit trail.

## Scope

- In: the state machine, retry policy, idempotency, reconciliation, audit transitions.
Reuses the `TradeOrder` model.

- Out: venue-specific placement (phase 20/21); strategy decisions (phase 24).

## Files to touch

- `apps/web/src/lib/orders/state-machine.ts`, `idempotency.ts`, `reconcile.ts` (new)
- `apps/web/prisma/schema.prisma` (`TradeOrder` status enum, idempotency key, attempt columns) and a migration
- `apps/web/src/lib/bot-builder/state-machine.ts` (align naming and error shapes)
- `apps/web/src/app/api/trading/status/route.ts`

## Requirements

1. A single status set with legal transitions only; an illegal transition throws and is
   rejected before any side effect occurs.
2. Every mutating operation carries an idempotency key derived from the caller's intent, so a
   retried request returns the original result instead of placing a second order.
3. Retries use bounded backoff and stop on a terminal state; each attempt records its reason
   and its provider response.
4. Reconciliation looks up the venue's truth for any order not in a terminal state and
   corrects local state, recording both values when they disagree.
5. Every transition writes an audit event with actor, previous state, next state and reason.
6. The state machine is pure and unit-testable without a database or a venue; the side effects
   live behind an injectable interface.
7. A partially filled order that is cancelled keeps the filled portion as an executed trade —
   quantity is never silently lost or double-counted.

## Acceptance criteria

- Two identical submissions with the same idempotency key create one order.
- A simulated venue timeout followed by a retry produces one order and one audit chain.
- After reconciliation against a venue claiming a fill the local state was missing, local
  state matches the venue and the discrepancy is recorded.
- Illegal transitions are rejected with a test proving no side effect ran.

## Manual verification (owner click-path)

1. In development, submit a paper order through the trading status path and watch the status
   advance to a terminal state on `/trade`.
2. Submit the same order twice with the same key — the second returns the first order.
3. Force a reconciliation with the local database edited to a wrong state — the next runner
   pass corrects it and the audit trail shows both values.
4. Failure case: stop the provider, submit — the order lands in a failed state with the
   provider error as its reason, not a crash.

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

- [ ] Legal/illegal transition table covered by tests.
- [ ] Idempotency proven by a duplicate-submission test.
- [ ] Reconciliation corrects a divergent local state and records both values.
- [ ] Every transition is auditable with actor and reason.

## Rollback

- Revert this phase's commit; the migration down path removes the added columns and enums.
  No money moves in this phase, so rollback is safe at any point.

## Do not do

- No approval gate or confirmation step before an order transitions.
- Do not add a status the UI cannot display or explain.
- Do not retry a money operation without an idempotency key.
- Do not leave an order in a state no code can resolve or reconcile.
