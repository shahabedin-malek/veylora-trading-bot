# Phase 21 — Testnet order path

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

The exact order path proven on a testnet venue first: submit, fill, partial fill, cancel and
failure, over the phase-20 venue interface and the phase-06 state machine, with the evidence
recorded before any real-money switch exists.

## Scope

- In: testnet venue adapter configuration, order submission and lifecycle, partial fills, cancel, failure evidence.
- Out: real-money placement (phase 22); the strategy that decides orders (phase 24); UI polish (phase 33).

## Files to touch

- `apps/web/src/lib/venues/testnet-adapter.ts` (new), `registry.ts`
- `apps/web/src/lib/orders/state-machine.ts`, `reconcile.ts` (consume)
- `apps/web/src/app/api/trading/orders/route.ts` (new), `src/app/api/trading/status/route.ts`
- `apps/web/tests/trading-orders.test.ts` (new)
- `apps/web/src/lib/integrations/settings.ts` (testnet credentials as admin data)

## Requirements

1. The testnet adapter implements the same interface as a live venue, so the path taken by a
   testnet order and a live order is identical code with a different venue selected.
2. Order submission records the request, the venue response, the resulting state and the
   reason for any rejection, and is idempotent per key.
3. Partial fills are handled: the filled quantity is an executed trade, the remainder is
   visible, and cancel keeps the filled portion.
4. Reconciliation runs after submission and after every runner pass until the order reaches a
   terminal state, correcting local state from the venue's truth.
5. Failure modes are exercised and recorded as evidence: rejected order, venue timeout, invalid
   pair, insufficient venue balance, and cancel-after-fill.
6. The evidence file for this phase records, per scenario, the command, the observed states and
   the venue's response, so phase 22 can compare behaviour rather than assume parity.
7. Nothing in this phase can place a real-money order: the live venue path is unreachable until
   the phase-22 switch exists.

## Acceptance criteria

- A testnet order completes the full lifecycle with the hash or venue id recorded.
- A cancel after a partial fill leaves the filled quantity intact, proven by a test.
- All five failure scenarios are reproducible in development with their messages.
- No code path in this phase can route to a live venue.

## Manual verification (owner click-path)

1. With testnet credentials configured, place an order from `/trade` and watch it move to filled.
2. Cancel a partially filled order and confirm the filled portion remains as a trade.
3. Place an order for an invalid pair — a specific rejection with the venue's reason.
4. Failure case: stop the venue connection mid-submission — the order lands in a failed state
   with the error recorded, and reconciliation resolves it on the next pass.

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

- [ ] One code path serves testnet and live venues, differing only by configuration.
- [ ] Partial fill and cancel semantics covered by tests.
- [ ] Five failure scenarios recorded as written evidence.
- [ ] No reachable path to a live venue exists yet.

## Rollback

- Revert this phase's commit; testnet orders stop and no money has moved at any point.

## Do not do

- No approval gate, confirmation dialogue or dry-run stop in the order path.
- Do not add a code path that can reach a live venue in this phase.
- Do not treat a testnet pass as proof of live behaviour without recording the evidence.
- Do not hide a failed order; give it a state, a reason and a recovery.
