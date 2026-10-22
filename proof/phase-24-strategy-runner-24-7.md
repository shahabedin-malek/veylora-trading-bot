# Phase 24 — 24/7 strategy runner

This record is what the phase ran, what it read while running, and what it could not do here.
The readings come from the development server on `:3240` against the local SQLite database
(`apps/web/prisma/dev.db`) with `CRON_SECRET` set for the run. No session value, cookie,
credential or key appears in this file.

## What was built

- **One loop.** `src/lib/strategies/runner.ts` is the only code that reads market data, asks
  the risk policy, submits an order and writes a decision. It runs on the phase-05 runner as
  the `strategy-activation` job, which phase 23 registered.
- **A pure rule.** `src/lib/strategies/decide.ts` owns the entry/exit/stop rule, the interval
  and the gap arithmetic. It takes facts and returns a decision: no clock, no database, no
  network.
- **A closed taxonomy.** `src/lib/strategies/reasons.ts` names every reason a pass can carry
  and classifies each as `placed`, `idle` or `error`, so a surface renders the same list a
  test enumerates.
- **The record.** `StrategyDecision` (migration `20261018140000_strategy_decisions`) stores
  one row per strategy per interval with its inputs, condition values, outcome, reason and
  order id. `StrategyActivation.lastWindowStart` is the claim a pass takes before evaluating.
- **The panel.** `src/components/strategy-status.tsx` on `/trade` shows the running state, the
  last decision with its reason and condition table, the next pass, the pass count, the recent
  history and the taxonomy the runner can report.

## Gates on the final tree

| gate | command | result |
|---|---|---|
| typecheck | `pnpm typecheck` | 0 |
| test | `pnpm test` | 0 — **601/601** (phase 23 ended at 578; `tests/strategy-runner.test.ts` adds 23) |
| lint | `pnpm lint` | 0 |
| build | `pnpm build` | 0 |
| plan | `node scripts/validate_plan.mjs` | 0 — 40 phases, 0 restriction hits |

`pnpm db:setup` applied the new table and column to the local SQLite database without losing
the existing rows (the seed's counts were reported, then the run continued against the same
database).

## Live readings

**A pass decides and records the inputs it used.** The first invocation answered `200` with
`1 activation(s): 1 window(s) decided, 0 order(s) placed, 1 idle, 0 error, 0 missed window(s)
recorded`, and the stored row read:

```
window 2026-10-18 10:00:00 | NO_ACTION | POSITION_OPEN | BTC-USD
inputs: rsi 46.052050970900716, rsiClosedAt 2026-10-18T00:00:00.000Z, candles 90,
        lastClose "81378.21", lastClosedAt 2026-10-18T00:00:00.000Z,
        venue {connectedCount 2, placeableCount 1}, openOrderCount 2,
        position {quantity "0.00100000", entryPrice "50000.00", stopLossPrice null},
        routing "paper", killSwitchActive false
conditions: entry-rsi 46.05 < 30 met=false; exit-rsi 46.05 > 70 met=false
```

The RSI is real: 90 closed daily BTC-USD candles were stored through the ingestion path and
the newest close is `2026-10-18T00:00:00.000Z`. The reason is real too — two paper orders from
earlier phases are still `SUBMITTED` for BTC-USD, and requirement 5 forbids a second order
while one is working, so the pass said so instead of placing.

**One window, one decision.** A second invocation in the same hour answered `200` with
`0 window(s) decided` and the reason *“Every running activation's current interval was already
decided, so this pass wrote nothing.”*

**A redeploy gap is recorded once and the loop continues.** The second seeded account
(`dev-test-account`) was started through the phase-23 control — `200`, `changed: true`,
`STRATEGY_TRADING_STARTED`, state `idle` naming `NO_VENUE_CONNECTED` — its window was
backdated by three hours, and the job was run again:

```
2 activation(s): 2 window(s) decided, 0 order(s) placed, 2 idle, 0 error, 1 missed window(s) recorded
2026-10-18 09:00:00 | NO_ACTION | RUNNER_MISSED_WINDOW
  1 evaluation window(s) passed without a runner invocation — a deploy, a crash or a missed
  schedule. The loop continued with this window's decision.
2026-10-18 10:00:00 | NO_ACTION | CREDENTIAL_MISSING
  No exchange key is connected for this account, so the Smart RSI · daily close entry was
  not sent. The activation stays running and will act once a key is added.
```

The owner's account was in the same pass and wrote nothing: its current window already had a
decision, and the unique `(activationId, windowStart)` index refused a second one.

**The panel renders the record, not a second opinion.** `/trade` answered `200` (103,524 bytes
of server HTML) and contained the `Strategy runner` block, `RUNNING 24/7`, `PASSES RECORDED 4`,
`NEXT PASS 2026-10-18 10:59:12.451Z`, the last decision `NO ACTION · An order is still open`
with its sentence, the condition table (`RSI-14 below 30 — 46.05 — 30 — NO`), the recent
decisions table and `Reasons this runner can report`.

## What the tests prove that the run could not

- **Single decision per interval, concurrently.** Two passes started with `Promise.all` over
  one activation produce one decision and one submission; the loser's claim returns false.
- **The real order path, not a stand-in.** A decision is submitted through `submitOrder` with
  `createMemoryOrderStore`, `createMemoryIdempotencyStore` and a scripted venue: the venue is
  contacted once, one order exists with `BTC-USD` / `BUY` / `0.00041667` / stop `58800.00`,
  and the decision's `orderId` names it. The order's client key is
  `strategy.<activationId>.<windowStart>`, so a replay resolves to that order rather than a
  second one.
- **Every reason is reachable.** The taxonomy test walks all codes; the order-path mapping is
  asserted for invalid credential, insufficient balance, rate limit, venue down, a refused
  order and an unmapped failure; and the loop is driven into risk refusal, missing credential,
  venue failure and the gap with injected facts.
- **Decisions accumulate while nobody looks.** Three passes at three consecutive windows leave
  three decisions, each keyed to its own hour.

## Limits of this run

- **No live order was placed by the loop.** The real signal was RSI 46.05 against a 30 entry,
  and a position with two working orders from earlier phases, so the honest decision was
  `POSITION_OPEN`. The placement path is proven through the real order path against a scripted
  venue in the test suite; a live fill would need an oversold daily close and a flat account.
- The daily-loss and post-arm exposure inputs to the risk policy are `0` in this phase: they
  are phase 25's accounting, and the loop reports the facts it has instead of inventing a
  drawdown. The policy *does* gate on its own kill switch, approved symbols and limits, and a
  refusal is recorded as `RISK_LIMIT_REACHED` with the policy's reasons quoted.
- The migration was applied to the SQLite development database through `db:setup`. No
  Postgres is reachable from this machine, so the Postgres migration file is verified by
  Prisma's derived schema rather than executed.
- The `/trade` page was read as the server's HTML with the owner's cookie. The hydrated
  client panel was not driven in this run; its data is the same view the server rendered.
- `pnpm routes:sweep` was not run for this phase; no route was added — the runner is a job and
  the panel is a server component.
- Two paper orders for BTC-USD (`SUBMITTED`, from phases 21/22) were left untouched: cancelling
  another phase's evidence to make this phase's entry path fire would have been a fabricated
  reading, not a demonstration.

## Recreate

```bash
cd apps/web
node scripts/dev-database.mjs setup
SESSION_SECRET=$(cat <throwaway secret>) TRADING_CREDENTIAL_ENCRYPTION_KEY=$(cat <throwaway key>) \
  APP_BASE_URL=http://localhost:3240 CRON_SECRET=phase24-local-runner-secret PORT=3240 \
  pnpm --config.verify-deps-before-run=false dev
curl -H "Authorization: Bearer phase24-local-runner-secret" \
  http://localhost:3240/api/cron/strategy-activation
```

Then open `/trade` with the owner's session. The store, the route, the decision table and the
panel are what the readings above came from; `/tmp/phase24/` holds the raw JSON and HTML.
