# Phase 22 — Live execution behind the owner's switch

Paste this whole file into DeepSeek Freebuff. It is self-contained. **This phase spends real
money once the owner turns it on. It is gated by an owner decision, not by an agent's judgement.**

## Objective

Real-money execution becomes reachable — and only through a switch the owner controls and edits
as data in the admin panel, after the testnet phase proved the identical path. The switch is
product configuration, never a code-level restriction invented by an agent.

## Scope

- In: the live venue selection, the admin switch and its state, pre-flight checks that report rather than block, audit of every live order.
- Out: strategy decisions (phase 24); risk limits (phase 25, which supplies inputs to pre-flight).

## Files to touch

- `apps/web/src/lib/venues/registry.ts`, `live-adapter.ts` (new; may wrap the CCXT adapter)
- `apps/web/src/lib/risk-controls/settings.ts`, `policy.ts` and the `RiskPolicySettings` model
- `apps/web/src/app/admin/risk/page.tsx`, `risk-policy-form.tsx`
- `apps/web/src/app/api/admin/risk-policy/route.ts` (existing pattern to reuse)
- `apps/web/src/lib/orders/state-machine.ts` (actor becomes the live venue)

## Requirements

1. A single boolean owned by the owner — stored as data, editable in `/admin/risk` — enables
   real-money order placement. Default off. Its current state, who changed it and when appear
   in the admin panel and the audit trail.
2. When the switch is off, live submission is unreachable and the attempt is recorded with the
   reason. When it is on, live submission works with no additional prompt of any kind.
3. Everything a pre-trade evaluation notices is **reported, never gating**: insufficient venue
   balance, unverified credential, venue outage and exposure above the configured limit all
   appear in the order response and the audit trail. The owner's instruction is what authorises
   the order, so no evaluation cancels, delays or drops an order the owner placed. Where the
   venue itself rejects (no balance at the venue), its response is surfaced verbatim.
4. Every live order records the venue, pair, side, size, price, the resulting state and the
   venue's response, and is reconciled like any other order.
5. A dry comparison is available as a *report* — the same order evaluated against the testnet
   configuration — displayed to the owner, never a step inserted into the live path.
6. The first live order is placed by the owner personally, with the evidence recorded in this
   phase's notes, and the switch is left in the owner's chosen state afterwards.
7. Position sizing, caps and kill switches come from phase 25 where they exist; this phase must
   not invent its own limits.

## Acceptance criteria

- With the switch off, no live order can be placed and the attempt is audited as blocked by the
  switch itself, naming its state.
- With the switch on, a small real order reaches a terminal state and appears in the ledger and
  the trade history.
- Flipping the switch off mid-flight lets an in-flight order finish or reconcile; it never
  aborts one silently.
- The switch change appears in the audit trail with actor and time.

## Manual verification (owner click-path)

1. With the switch off, place an order from `/trade` — the response states that live execution
   is off and names the switch; nothing is sent to a venue.
2. Turn the switch on in `/admin/risk`; place a small real order and watch it fill.
3. Check `/account` and the audit trail for the order, its fee-free state and the switch change.
4. Failure case: leave the switch on and remove the venue balance — the venue's own rejection
   is shown verbatim and the order lands in a failed state.

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

- [ ] The switch is admin data, default off, audited on every change.
- [ ] With the switch off no live order can be sent, proven by a test.
- [ ] With the switch on the owner's own order completes and is reconciled.
- [ ] No agent-authored gate, prompt or refusal was added anywhere in the live path.

## Rollback

- Turn the switch off, then revert this phase's commit. Open positions must be reconciled and
  closed by the owner first; the phase notes list any order still in flight.

## Do not do

- Do not add an approval gate, consent screen, confirmation dialogue or dry-run stop in front
  of a live order — the owner's switch and instruction are the only authorisation.
- Do not make the switch impossible to turn off while an order is in flight; let it reconcile.
- Do not silently cancel or refuse an order because a pre-flight check was unhappy; report it
  and let the venue answer.
- Do not leave the switch in a state the owner did not choose, and never enable it on their behalf.
