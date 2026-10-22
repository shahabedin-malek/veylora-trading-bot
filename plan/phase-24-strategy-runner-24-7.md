# Phase 24 — 24/7 strategy runner

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

Activated strategies make decisions while the browser is closed, the laptop is shut and a
redeploy lands — every pass recorded, every idle explained, and every failure classified so the
owner can see why nothing happened.

## Scope

- In: the strategy loop on the phase-05 runner, decision records, idling reasons, resume after deploy, per-account scheduling.
- Out: the start control (phase 23); limits (phase 25); the AI that writes strategies (phase 28).

## Files to touch

- `apps/web/src/lib/strategies/runner.ts`, `decide.ts`, `reasons.ts` (new)
- `apps/web/src/lib/runner/scheduler.ts`, `claim.ts` (register the strategy job)
- `apps/web/src/lib/risk-controls/policy.ts` (inputs to decisions)
- `apps/web/src/components/strategy-status.tsx` on `/trade`
- `apps/web/prisma/schema.prisma` (`StrategyDecision`) and a migration

## Requirements

1. The runner picks up every active strategy on schedule, evaluates its entry and exit
   conditions against current data, and either places an order through the phase-06/20/21 path
   or records why it did not.
2. Every pass writes a decision record: timestamp, strategy, inputs used, the condition results,
   the outcome, and the reason when the outcome is "no action".
3. The failure taxonomy is complete and specific: insufficient venue balance, invalid or revoked
   credential, no entry condition met, venue unreachable, rate limited, risk limit reached,
   strategy disabled, runner missed its window. Each is visible per strategy.
4. A deploy, a crash or a missed window does not lose a decision: the next pass records the gap
   and continues, and no condition is evaluated twice within its own interval.
5. Only one order per strategy per interval can be placed, enforced by the idempotency key and a
   claim on the strategy row.
6. The UI shows, per strategy: running state, last decision with its time and reason, next
   expected pass, and a run count — enough to answer "is it working" without logs.
7. Trading keeps running when the user's browser is closed and when no user is signed in.

## Acceptance criteria

- With the browser closed for a full interval, decisions accumulate and are visible on return.
- A redeploy mid-interval produces one recorded gap and no duplicated decision.
- Each reason in the taxonomy is reachable in development and displayed per strategy.
- Two concurrent runner passes produce one decision per strategy, proven by a test.

## Manual verification (owner click-path)

1. Activate a strategy, then close the browser for two intervals.
2. Reopen `/trade`: last decision time, reason and run count are visible and current.
3. Force a venue outage and confirm the strategy shows "venue unreachable" and resumes after
   recovery without intervention.
4. Failure case: revoke the venue credential — the strategy reports "invalid credential" and
   keeps running so it recovers when a valid key is added.

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

- [ ] Every pass records a decision with its inputs, outcome and reason.
- [ ] Full failure taxonomy visible per strategy.
- [ ] Single-decision-per-interval proven by a concurrency test.
- [ ] Survival across a redeploy demonstrated and recorded.

## Rollback

- Deactivate strategies through the phase-23 control, then revert this commit and drop the
  decision table; orders already placed remain reconciled.

## Do not do

- No approval gate, confirmation dialogue or dry-run step inside the loop.
- Do not stop trading because the browser is closed, the user is signed out, or a deploy lands.
- Do not leave an idle pass unexplained.
- Do not evaluate a strategy twice for the same interval and place two orders.
