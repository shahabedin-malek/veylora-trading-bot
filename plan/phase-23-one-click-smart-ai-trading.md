# Phase 23 — One-click "start smart AI trading"

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

One visible control that starts automated trading for the signed-in account and one that stops
it, with live state on screen — running, idle with a reason, stopped, error — and nothing that
cannot be pressed and observed.

## Scope

- In: the control and its state model, wiring to the phase-05 runner, per-account activation, state persistence, the honest failure surface.
- Out: the strategy decision logic (phase 24); limits (phase 25); live venue choice (phase 22).

## Files to touch

- `apps/web/src/lib/bot-builder/state-machine.ts` (extend states)
- `apps/web/src/lib/strategies/activation.ts` (new)
- `apps/web/src/app/api/strategies/activate/route.ts`, `src/app/api/strategies/[id]/route.ts` (new)
- `apps/web/src/components/smart-trading-control.tsx` on `/trade`
- `apps/web/prisma/schema.prisma` (`StrategyActivation`) and a migration

## Requirements

1. One control starts smart AI trading for the account; one stops it. Both are always enabled
   and always answer, in every state including "not configured".
2. Activation persists immediately and survives a reload, a redeploy and a closed browser.
3. The control shows the live state and, when not running, the specific reason — paused by the
   owner, no venue connected, no strategy selected, risk limit reached, runner not scheduled.
4. Stopping is immediate and idempotent: a second press does nothing harmful, and an in-flight
   order is allowed to finish and reconcile rather than being abandoned.
5. Starting when configuration is incomplete does not fail silently: it activates and shows the
   missing piece, or states exactly why it cannot start and what to set — never a dead button.
6. The state change writes an audit event with actor and reason, and appears in the admin
   console per account.
7. The control works with live execution off: it activates, the runner reports that placement is
   off, and the reason is visible — the phase-22 switch is the only thing that changes that.

## Acceptance criteria

- Pressing start persists across a reload and a redeploy, proven in development.
- Pressing stop and immediately pressing start again leaves exactly one activation.
- Every non-running state shows a specific, human-readable reason.
- The audit trail contains start and stop events with actor and time.

## Manual verification (owner click-path)

1. On `/trade`, press the start control; the state becomes running and the runner's heartbeat
   shows its next pass.
2. Close the browser, wait, reopen — still running, with elapsed time shown.
3. Press stop; the state becomes stopped with the reason "stopped by owner".
4. Failure case: with no venue connected, press start — it activates and states that no venue is
   connected, and the order path reports it rather than failing silently.

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

- [ ] Start and stop are idempotent, covered by tests.
- [ ] State persists across reload and redeploy.
- [ ] Every idle state names its reason.
- [ ] Start/stop events are audited per account.

## Rollback

- Revert this phase's commit and drop the activation table; trading stops because the runner
  finds no activation.

## Do not do

- No approval gate, consent step or confirmation dialogue before start or stop.
- Do not render the control disabled because something is unconfigured; say what is missing.
- Do not hide the stop control while running.
- Do not let a stop abandon an in-flight order without reconciliation.
