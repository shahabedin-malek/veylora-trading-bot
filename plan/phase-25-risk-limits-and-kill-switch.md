# Phase 25 — Risk limits and kill switches

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

The owner's protection is configuration they own: per-account limits, exposure caps, cooldowns
and cooldown-scoped kill switches — all editable in the admin panel as data, applied by the
execution path, and readable before they act.

## Scope

- In: the limit model, exposure computation, kill switches, the admin editor, pre-trade evaluation, audit.
- Out: the venue's own limits; the owner's broader account permissions (phase 11).

## Files to touch

- `apps/web/src/lib/risk-controls/policy.ts`, `safety-core.ts`, `settings.ts`
- `apps/web/src/app/api/admin/risk-policy/route.ts` and `route.test.ts`
- `apps/web/src/app/admin/risk/page.tsx`, `risk-policy-form.tsx`
- `apps/web/src/lib/strategies/decide.ts` (consume), `src/lib/orders/state-machine.ts` (record)
- `apps/web/prisma/schema.prisma` (`RiskPolicySettings` extension) and a migration

## Requirements

1. Limits are data: per-order maximum, per-strategy maximum, total exposure cap, maximum open
   positions, per-interval trade cap, drawdown cooldown, and allowed pairs/venues. Each has an
   effective-from time and its own audit event on change.
2. One kill switch stops every strategy and refuses new orders immediately, and one per strategy
   stops only that strategy; both are toggles in the admin panel with actor and time recorded.
3. Evaluation happens before an order is placed and returns a specific decision: allowed, or
   refused with the limit that refused it and the current value against the cap.
4. A refused order is recorded as an audited decision with the reason, never as a silent skip,
   and the strategy keeps running so it can trade again when conditions change.
5. The UI shows the current values, the current usage against each cap, and the effect of each
   switch before it is pressed.
6. Limits apply identically to paper and live execution, so a setting tested in paper holds
   when live.
7. Zero or unset means "no limit" and is displayed as unlimited, not as a broken value.

## Acceptance criteria

- Setting a per-order maximum below the order size produces a refusal naming that limit and the
  observed value.
- The kill switch stops decisions within one runner interval and refuses manual orders.
- Changing a limit updates usage display without a redeploy.
- Every limit change and switch toggle appears in the audit trail.

## Manual verification (owner click-path)

1. In `/admin/risk`, set a per-order maximum and a total exposure cap; the usage figures update.
2. Place or simulate an order above the maximum — refused with the limit named.
3. Press the global kill switch, then attempt an order — refused, with the switch as the reason.
4. Failure case: set a limit to zero and confirm it reads "unlimited" and does not refuse
   everything.

## Automated verification

```bash
cd apps/web
pnpm --config.verify-deps-before-run=false typecheck; echo "typecheck=$?"
pnpm --config.verify-deps-before-run=false test;      echo "test=$?"
pnpm --config.verify-deps-before-run=false lint;      echo "lint=$?"
pnpm --config.verify-deps-before-run=false build;     echo "build=$?"
cd ../.. && node scripts/validate_plan.mjs; echo "plan=$?"
```

Extend `tests/risk-controls.test.ts` and the risk-policy route test.

## Definition of done

- [ ] Every limit is admin data with usage shown against it.
- [ ] Refusals name the limit and the observed value, and are audited.
- [ ] Kill switches stop work within one interval, proven in development.
- [ ] Zero reads as unlimited and refuses nothing.

## Rollback

- Revert this phase's commit and the policy table's extra columns; shipping strategy behaviour
  returns to the phase-24 baseline with no limits.

## Do not do

- No approval gate or confirmation dialogue before a limit change.
- Do not hard-code a limit in the trading path; every limit must be owner-editable.
- Do not refuse an order without recording which limit refused it.
- Do not make a kill switch that cannot be turned back off by the owner.
