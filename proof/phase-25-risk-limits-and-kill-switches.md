# Phase 25 — Risk limits and kill switches

The owner's protection as configuration they own: per-order and per-strategy notional caps, a
total open-position cap, a per-interval trade cap with its own window, a post-halt cooldown,
an allowed-venue list, and two kill switches — all editable in `/admin/risk`, all data (no
limit is a constant in the trading path), applied by one evaluation before an order is
placed on paper and live alike, and readable before they act.

Recorded on 2026-10-18 against the local development server (`:3243`, proxy `:3244`) and the
SQLite development database seeded by `pnpm db:setup`. The session was a real `AuthSession`
row minted with a throwaway secret; this record contains no session value, cookie, key or
credential.

## Acceptance criteria, with what was observed

| criterion | status | evidence |
|---|---|---|
| A per-order maximum below the order size refuses, naming the limit and the observed value | met | `PUT /api/admin/risk-policy` with `maxOrderNotionalUsd: "5"`, then a 25.00 order → `409 RISK_LIMIT_BLOCKED` with `"error": "Refused by a limit you set: Max notional per order 5.00 — this order would make it 25.00…"` and `limits: [{reason: order-notional-exceeded, limit: maxOrderNotionalUsd, cap: 5.00, observed: 25.00, scope: order}]`; the order count did not move and `ORDER_REFUSED_BY_RISK_LIMIT` was written |
| The kill switch stops decisions within one runner interval and refuses manual orders | met | the global switch refused a manual order immediately (`switch: {name: killSwitchActive, state: true, scope: account}`, `409`); the per-strategy switch, pressed on the owner's activation, made the next runner pass write `RISK_LIMIT_REACHED — "This strategy's kill switch is engaged…"` for the 15:00 window while the activation stayed `RUNNING` |
| Changing a limit updates usage display without a redeploy | met | the usage table is rendered from the settings row per request: after the `PUT` above the panel read `Max notional per order · 10.00`, `Max open positions · 2 (used 8)`, `Max trades per interval · 4 (used 5)`, `Cooldown after a halt · 15 min`, with `In effect since 2026-10-18 11:34 UTC` under the fields that changed; no restart |
| Every limit change and switch toggle appears in the audit trail | met | `RISK_LIMIT_CHANGED` per limit (only the ones that moved), `KILL_SWITCH_ENGAGED` / `KILL_SWITCH_RELEASED` for both scopes, `ORDER_REFUSED_BY_RISK_LIMIT` per refused order — each with actor, time and the limit's own figures (excerpt below) |

## The requirements, one by one

1. **Limits are data, each with an effective-from time and its own audit row.** They are
   columns on `RiskPolicySettings` (`maxOrderNotionalUsd`, `maxStrategyNotionalUsd`,
   `maxOpenPositions`, `maxTradesPerInterval`, `tradeIntervalMinutes`, `cooldownMinutes`,
   `allowedVenuesJson`), validated as a whole by `validateRiskPolicyUpdate` and written with a
   per-limit `RISK_LIMIT_CHANGED` row carrying `from`, `to` and `effectiveFrom`. The
   `limitsEffectiveFromJson` map holds the "since when" per limit, which the editor renders
   under the field.
2. **One global switch, one per strategy, both toggles, both audited.** `POST
   /api/admin/risk-policy/switch` with `{scope: "global" | "strategy", active}` — an
   immediate write, not a form save. Global writes the policy row
   (`KILL_SWITCH_ENGAGED` / `KILL_SWITCH_RELEASED`, with the actor and instant); strategy
   writes one `StrategyKillSwitch` row per activation, naming the strategy it belongs to, and
   both directions are accepted so the owner can always turn it back off.
3. **Evaluation before placement, with a specific decision.** `authoriseOrder`
   (`src/lib/risk-controls/enforcement.ts`) is one function called by both the manual route
   and the strategy runner; `evaluateOwnerLimits` returns `ALLOW` or `REFUSE` with
   `limits: [{reason, limit, cap, observed, scope}]`. Every refusal sentence is built from
   that list.
4. **A refusal is a recorded decision, never a silent skip.** The manual route answers `409`
   with the sentence and the structured limits and writes `ORDER_REFUSED_BY_RISK_LIMIT`; the
   runner writes its `StrategyDecision` (`RISK_LIMIT_REACHED` + the limit list in `inputs.risk`)
   and the same audit event, and the activation keeps running so the strategy trades again
   when the condition clears.
5. **The panel shows values, usage and the switch's effect before it is pressed.** Section 01
   renders both switches with their state, actor, time, and a sentence describing what
   pressing them now would do; section 02 is the usage table (cap, used, detail) rendered from
   the same facts the evaluator uses; section 03 is the editor with each limit's
   effective-from.
6. **Identical on paper and live.** The caps and switches do not depend on the execution
   mode: `evaluateOwnerLimits` is called by both surfaces with the same policy and the same
   usage arithmetic, and a test asserts the paper and live decisions for the same inputs carry
   the same limits.
7. **Zero is unlimited and says so.** `capIsSet(0) === false`; the panel renders
   `Unlimited`, not `0`; and a zeroed policy refuses nothing — proven live by an order that
   was refused at a 5.00 cap and accepted once the cap was set back to `0`, and by a test that
   asserts none of the phase-25 reasons fire on an all-zero policy.

## Live readings

```
A. panel renders: KILL SWITCHES, USAGE AGAINST EACH CAP, MAX NOTIONAL / ORDER (USD),
   ALLOWED VENUES, GLOBAL KILL SWITCH, Unlimited            (all present)

B. PUT maxOrderNotionalUsd=5  -> 200, effectiveFrom {"maxOrderNotionalUsd": "...11:33:49Z"}

C. order 25.00 under a 5.00 cap -> 409
   "Refused by a limit you set: Max notional per order 5.00 — this order would make it 25.00.
    Nothing was sent; the strategy keeps running and will trade again when conditions allow."
   limits [{order-notional-exceeded, maxOrderNotionalUsd, cap 5.00, observed 25.00, order}]
   order in body: None

D. global switch on -> 200 {active: true, changedByUserId: dev-owner-user, changedAt ...}
   order -> 409 "…the global kill switch is engaged…"
   switch {name killSwitchActive, state true, scope account, panel /admin/risk}
   global switch off -> 200 {active: false, cooldownUntil: null}

E. maxOrderNotionalUsd back to 0 -> 200
   panel row: "Max notional per order · Unlimited · —"
   order 25.00 -> 201 submitted

F. per-strategy switch on (activation cmvdg83…, rsi-daily-close) -> 200
   runner pass GET /api/cron/strategy-activation -> 200
   latest decision: RISK_LIMIT_REACHED | "This strategy's kill switch is engaged, so no order
   was sent. The activation stays running and resumes when the switch is released." | 15:00Z
   switch off -> 200

G. cooldown: cooldownMinutes=2, global switch engaged then released
   -> {active: false, cooldownUntil: "2026-10-18T11:41:23.233Z"}
   order -> 409 "…a cooldown after a halt is running — 2 min remaining of 2 minute(s)."
   limits [{cooldown-active, cooldownMinutes, cap 2, observed "2 min remaining", account}]
```

Audit trail (excerpt, newest first):

```
KILL_SWITCH_ENGAGED          StrategyKillSwitch  {switch: strategyKillSwitch, scope: strategy, activationId: cmvdg83…, strategyId: rsi-daily-close, from:false, to:true, changedAt: 11:33:51Z}
RISK_LIMIT_CHANGED           RiskPolicySettings  {limit: maxOrderNotionalUsd, from:"5", to:"0", effectiveFrom: 11:33:50Z}
ORDER_REFUSED_BY_RISK_LIMIT  ManualOrder         {source: manual, symbol: BTC-USD, notionalUsd:"0.25", venue: dev-paper, reasons:[kill-switch-active], limits:[…]}
KILL_SWITCH_ENGAGED          RiskPolicySettings  {switch: killSwitchActive, scope: global, from:false, to:true, changedAt: 11:33:49Z}
ORDER_REFUSED_BY_RISK_LIMIT  ManualOrder         {source: manual, notionalUsd:"25.00", reasons:[order-notional-exceeded], limits:[{cap:"5.00", observed:"25.00"}]}
RISK_LIMIT_CHANGED           RiskPolicySettings  {limit: maxOrderNotionalUsd, from:"0", to:"5", effectiveFrom: 11:33:49Z}
```

The two defects the walk found and fixed:

- A `PUT` of exactly what `GET` returned was rejected as "unsupported fields", so the panel
  could not save after loading — the server's own read-only fields are now accepted and
  ignored rather than refused, and the switch endpoint's write path was failing `503` for the
  same reason.
- `allowedVenues` was compared against the raw row (where it is `allowedVenuesJson`), so every
  save wrote a spurious `RISK_LIMIT_CHANGED` row for it; the comparison now decodes the stored
  lists first, and the effective-from map is written before the row so the response carries it.

A third was found by the last live probe: a cooldown clock from an earlier setting still
refused orders after `cooldownMinutes` was set back to `0`. Zero minutes now clears the clock
and refuses nothing.

## Gates (on the final tree)

```
cd apps/web
pnpm --config.verify-deps-before-run=false typecheck   -> 0
pnpm --config.verify-deps-before-run=false test        -> 0   (622/622)
pnpm --config.verify-deps-before-run=false lint        -> 0
pnpm --config.verify-deps-before-run=false build       -> 0
cd ../.. && node scripts/validate_plan.mjs             -> 0   (40 phases)
```

`pnpm routes:sweep` was not run this phase; the new route is in the inventory
(`POST /api/admin/risk-policy/switch`) and the inventory test now expects 80 methods, but the
sweep itself needs a running server and an owner cookie and was not part of this phase's
gate list. The route's own tests cover the 503-with-no-configuration and
refused-before-write answers.

## Tests added

`tests/risk-controls.test.ts`: zero-is-unlimited; each of the five numeric/list caps refusing
with its own name, cap and observed value; a switch refusal naming which switch; a close not
being trapped by a cap but still stopped by a switch; paper and live producing the same
limits; the manual gate evaluating the owner's limits without the armed path's rules; the
new fields' validation; the panel rows reading a zero as `Unlimited`; usage shown against a
set cap; and the cooldown clock counting up and never going negative.

`tests/strategy-runner.test.ts`: the per-strategy switch stopping the pass while the
activation keeps running; the global switch stopping all accounts; a cap refusal recorded
with the limit and value; a zeroed cap letting the same order through; and unmeasurable usage
being a refusal rather than "no limit".

`src/app/api/admin/risk-policy/route.test.ts`: a save from another origin refused before the
session is looked at, a save without a session never reaching validation or storage, and the
round-trip case for the defect above — the body `GET` answers is accepted by the save, and
the read-only metadata in it is never written from the request.

`src/app/api/admin/risk-policy/switch/route.test.ts`: the unconfigured answer, and a switch
press being refused before anything is written when nobody is signed in.

## Limitations, stated rather than papered over

- **No live order was placed.** Every order in this record is the development paper venue.
  The phase's subject is refusing orders, and the one order that was allowed after zeroing
  the caps went to `dev-paper`.
- The phase-20 daily-loss and post-arm figures are still `0` in the runner's risk input, so
  the cooldown's *daily-loss* trigger is exercised by tests rather than by a live drawdown;
  the cooldown itself was measured live through the switch-release trigger.
- `maxStrategyNotionalUsd` is measured as net filled notional in the strategy's market for
  that account, which is the position the strategy holds. An order still working is counted
  in open exposure and in the open-position cap instead.
- The migration was applied to SQLite through `db:setup`; no Postgres is reachable here.
- `/admin/risk` was read as rendered HTML and driven through its own API. The switch buttons
  were exercised over HTTP rather than by clicking in the browser; the panel's screenshots
  show the same state those calls produced.

## Files

- `apps/web/src/lib/risk-controls/policy.ts` — the caps, `evaluateOwnerLimits`, breach records.
- `apps/web/src/lib/risk-controls/settings.ts` — validation, save with per-limit audit and
  effective-from, the cooldown, both switch writes.
- `apps/web/src/lib/risk-controls/usage.ts` — the facts and the panel rows.
- `apps/web/src/lib/risk-controls/enforcement.ts` — `authoriseOrder` and `auditRefusal`, shared
  by both surfaces.
- `apps/web/src/lib/strategies/runner.ts` — the switches and caps in the loop.
- `apps/web/src/app/api/trading/orders/route.ts` — the manual gate, before anything is
  reserved or sent.
- `apps/web/src/app/api/admin/risk-policy/switch/route.ts` — the toggles.
- `apps/web/src/app/admin/risk/{page,risk-policy-form,risk-switch-panel}.tsx` — the panel.
- `apps/web/src/app/api/admin/risk-policy/route.ts` — unchanged by design: its `PUT` already
  delegates to `saveRiskPolicySettings`, which is where this phase's validation, per-limit
  audit and effective-from live. Its test was extended instead (`route.test.ts`).
- `apps/web/prisma/schema.prisma`, `prisma/migrations/20261018160000_risk_limits_and_kill_switches` —
  the columns and the `StrategyKillSwitch` table.
