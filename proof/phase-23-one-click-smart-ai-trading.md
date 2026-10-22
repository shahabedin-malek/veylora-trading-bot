# Phase 23 — one-click smart AI trading: what exists, and what was measured

One control starts automated trading for the signed-in account, one stops it, both always answer,
and the screen shows the server's own state and the specific reason whenever it is not placing.

- **Objective (phase file):** a visible start/stop pair with a live state model — running, idle with
  a reason, stopped, error — wired to the runner and persisted per account.
- **Status:** implemented, with the acceptance criteria asserted by the named tests below. The gates
  were re-run on 2026-10-22 (821/821 tests, typecheck, lint, build, browser suite, plan validator,
  and the read-only hosted smoke spec), after the Next.js security upgrade recorded in
  `.progress/SESSION_LOG.md`.
- **What this record is not:** the browser press described in the phase's manual click-path was not
  performed in this pass. The evidence is the state model's own tests plus the routes that call it;
  no screenshot of the running control accompanies this record. That is a gap in this record, not a
  claim that the control does not render.

## The shape of it

- `src/lib/strategies/state.ts` derives the view the control renders: `intent` (the owner's saved
  intent), `reason` (one code and one sentence), `blockers` (everything missing, each with where to
  fix it), `lastChange` (who and when), `lastPass` (the runner's own outcome), and `elapsedMs`.
  State and intent are separate vocabularies, so "stopped by the owner" cannot be confused with
  "running but blocked".
- `src/lib/strategies/activation.ts` is the only writer. Start persists the intent, ensures the
  runner job exists, and writes `STRATEGY_TRADING_STARTED`; stop writes `STRATEGY_TRADING_STOPPED`.
  A press that changes nothing writes nothing.
- `src/app/api/strategies/activate/route.ts` — `GET` reads the view, `POST` starts.
- `src/app/api/strategies/[id]/route.ts` — `GET` reads one activation, `DELETE` stops it. Ownership
  is part of the lookup: another account's id is a 404, never a hint.
- `src/components/smart-trading-control.tsx` on `/trade` renders the server's state, polls it, keeps
  the stop control visible while running, and shows blockers with their fix location. It has no
  disabled state for "unconfigured"; an unconfigured account gets a sentence, not a dead button.
- `StrategyActivation` is a table, so the intent survives a reload, a closed browser and a redeploy —
  the property is the row, not process memory.

## Acceptance criteria, and the tests that hold them

All in `apps/web/tests/strategy-activation.test.ts`:

| Criterion (phase file) | Evidence |
| --- | --- |
| The owner's intent wins, then blockers, then a failed pass | "the lifecycle rule puts the owner's intent first, then blockers, then a failed pass" |
| A never-started account reads as not started and both controls are available | "a never-started account reads as not started, and both controls are available" |
| Running with live execution off says placement is off and stays running | "a running activation with live execution off says placement is off, and stays running" |
| Live and testnet placements name the switch that authorises them | "a live placement is labelled live and names the switch that authorises it"; "a testnet placement names the switch that is off" |
| Every idle state names its reason and where to fix it | "every idle state names its reason and where to fix it" |
| A failed pass shows the pass's own words | "a running activation whose last pass failed shows the error state with the pass's own words" |
| A stop names the owner and time and says open orders keep reconciling | "a stopped activation names the owner and the time, and says open orders keep reconciling" |
| Start and stop are idempotent; only the opposite transition writes | "start and stop are idempotent by rule, and only the opposite transition writes"; "a stop-then-start pair leaves one activation by rule, and the second press writes nothing" |
| Naming a different published bot switches rather than no-ops | "a start naming a different published bot switches the activation instead of answering that it is already running" |
| The picker offers the selected built-in and every published bot once | "the picker offers the built-in that is selected plus every published bot, once each" |

The routes are covered separately in `src/app/api/strategies/route.test.ts` and
`src/app/api/strategies/activate/route.test.ts`; the runner's use of the same activation row is
covered in `tests/strategy-runner.test.ts`, which is what makes "close the browser and it keeps
running" a property of the database rather than of the tab.

## What was run in this pass

```
pnpm typecheck                    0
pnpm test                         0 — 821 tests, 821 pass
pnpm lint                         0
pnpm build                        0 — 98 pages
pnpm e2e                          0 — 10 passed
node scripts/validate_plan.mjs    0
E2E_BASE_URL=… pnpm e2e:smoke     0 — 5 passed (against a local production build)
```

## Limits this record carries

- The four manual steps (press start, close and reopen, press stop, press start with no venue) were
  not re-performed here. Steps two and four are properties the tests assert (the row and the reason
  text); step one and three are the same handlers the routes expose, but rendering was not observed.
- "Survives a redeploy" is true because the intent is a database row and the runner re-registers its
  jobs on start; a redeploy was not performed in this pass, so it rests on the design and the
  runner test rather than on an observed deploy.
- No order is placed by any of the above. Placement is phase 24's decision path and phase 21/22's
  venue path; this control only records intent and reports state.
