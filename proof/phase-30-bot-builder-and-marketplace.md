# Phase 30 — bot builder and strategy marketplace (proof record)

What was built, what was measured on the running application, the two defects the browser walk
found and fixed, and what this run could not measure. No credential, cookie, session value or key
material appears here: the session was minted as a real `AuthSession` row with a throwaway secret
generated into `/tmp/verify30/`, and every reading below comes from a **copy** of the development
SQLite database (`/tmp/verify30/verify.db`), so the checkout's `prisma/dev.db` gained no rows.

## What the path is

The builder produces something the runner executes, without a hand-edited config:

- **Builder → definition.** `src/lib/bot-builder/publish.ts` maps the builder's form
  (`BotConfig`) onto the phase-28 `StrategyDefinition`, validates it with
  `validateStrategyDefinition` — the same schema the runner and the backtester execute — and maps
  every schema sentence back to the form field it belongs to (`fieldForIssue`). A refusal is a
  list of `{field, message}`, so the panel can point at the box rather than print a paragraph.
- **Publishing.** `publishBot` (`src/lib/bot-builder/repository.ts`) creates an immutable strategy
  version through phase 28's `ensureStrategyVersion`, then points the bot row at it in the same
  transaction as its `BOT_PUBLISHED` audit row. A second publish answers `alreadyPublished` and
  writes no second version; a deleted bot cannot be published.
- **The runner's view.** `runnerStrategyForBot` gives a published bot a `bot:<id>` strategy id, a
  1 440-minute (daily-close) interval and the form's own entry/exit/stop/budget values.
  `resolveBotRunnerStrategy` refuses anything that is not `PUBLISHED` with `deletedAt: null`, which
  is what makes a deleted bot stop being scheduled on the next pass.
- **Templates and the marketplace.** `templates.ts` ships three built-in templates as code and
  stores shared ones as `StrategyTemplate` rows (a snapshot: config, definition text and JSON,
  author label, source bot). `cloneTemplate` copies the snapshot into a new draft and records the
  template slug on it. Performance comes only from recorded `BacktestRun` rows matching the
  template's exact rules; with none, the card says so — no figure is computed or invented here.
- **Caps.** The bot and venue-connection caps are the owner-editable fee-tier columns
  (`maxBots`, `maxVenueConnections`) already used by `/admin/fees`, read through
  `readEffectiveFeeSchedule`. A refusal is one sentence built in one place
  (`botCapMessage`): the cap, the tier, the usage, and where to change it. The create control is
  never disabled for a cap.
- **Deleting.** `deleteBot` marks the row `DELETED` (history stays readable) and, in the same
  transaction, stops a `RUNNING` activation that names it, writing `BOT_DELETED` and
  `STRATEGY_TRADING_STOPPED`.

The phase file names `src/app/api/bots/*`; that path is the phase-29 paper lab, so the managed-bot
routes live at `/api/bot-builder` (plus `/api/bot-builder/[botId]/publish|share`) and the catalog at
`/api/marketplace`. `/api/bots` was left untouched and still answers the paper lab.

## Gates

Run from `apps/web` unless stated; exit statuses are the commands' own.

```
pnpm --config.verify-deps-before-run=false typecheck   -> 0
pnpm --config.verify-deps-before-run=false test        -> 0   (708 tests, 708 pass)
pnpm --config.verify-deps-before-run=false lint        -> 0
pnpm --config.verify-deps-before-run=false build       -> 0
node scripts/validate_plan.mjs                         -> 0   (40 phase files, 0 hits, 0 warnings)
```

## The two defects the click-path found, and their repairs

Both were invisible to the API-level driver that had been used earlier, because that driver sent
`strategyId` itself and re-read the caps after a reload.

1. **A published bot could not be started from `/trade`.** The control started
   `view.strategy?.id ?? view.strategyCatalog[0]?.id`, and nothing rendered the catalog. Once an
   account had any selection, every press re-started *that* strategy: pressing START with a
   freshly published bot on screen started the previous one (`STRATEGY: Verify 30 stop · v1`).
   The `/bots` row's `START ON TRADE PAGE` link led to that same control.
   **Repair:** `SmartTradingControl` now renders `STRATEGY TO START` from the server's catalog,
   sends the selected id, and says which strategy a press will move the account to when the
   selection differs from the running one. The two rules behind it —
   `strategyChoices` (the selected strategy plus the catalog, once each, never empty) and
   `defaultStrategyId` (running strategy, then first offered, then null) — are pure functions in
   `src/lib/strategies/state.ts` with four new tests in `tests/strategy-activation.test.ts`.
2. **The caps readout went stale after a delete.** `/bots` updated the usage only from the create
   response, so deleting a bot left `10 of 10 bots in use` and the cap alert on screen while the
   server had a free slot. **Repair:** `ManagedBotsPanel` re-reads the list and the caps after
   every mutation, falling back to the row the action returned if the re-read fails.

## Owner click-path (real browser, hydrated development server, production build for the API)

The browser half ran against `http://127.0.0.1:3332` (the production build started with
`NODE_ENV=development` so the http origin, and therefore the same-origin write check, is exercised
as a real browser would); the scripted half ran against `http://127.0.0.1:3331`, a cookie proxy in
front of `next start -p 3240`.

1. **Build in the UI.** Filled the managed-bot form: `Phase 30 UI bot`, market `SOL-USD`, entry
   `28`, exit `72`, per-entry budget `18`, a description. `SAVE AS DRAFT` answered
   *“Draft “Phase 30 UI bot” saved. Publish it to make it startable.”*, the row appeared as
   `DRAFT`, and the caps line moved to `5 of 10 bots in use`.
2. **Publish.** `PUBLISH` answered *“Published … now appears in the trade page's strategy list.”*;
   the row read `PUBLISHED · STARTABLE | v1`, with `START ON TRADE PAGE`, `SHARE TO MARKETPLACE`
   and the honest `NO BACKTEST RECORDED FOR THESE RULES — NO FIGURE SHOWN`.
3. **Start it from `/trade`.** The picker listed `Verify 30 stop · v1`, `Phase 30 UI bot · v1`,
   `Verify 30 clone edited · v1`, `My ETH copy · v1`. Choosing the new bot showed
   *“Pressing start moves this account from Verify 30 stop · v1 to Phase 30 UI bot · v1.”*; the
   press answered *“Smart trading started for this account with Phase 30 UI bot · v1; the runner
   will pick it up on its next pass.”* and `STRATEGY` read `Phase 30 UI bot · v1`.
4. **Decisions from phase 24.** A runner invocation (`GET /api/cron/strategy-activation`) returned
   `2 activation(s): 1 window(s) decided … 0 error`; its detail was
   *“The RSI-14 (38.82) is not below the 28 entry, so nothing was opened. The close was 103.99.”* —
   the bot's own 28 threshold on its own market. `/trade` then listed the decision
   (`2026-10-19 13:20:58.956Z`, window `2026-10-19 00:00`, `NO ACTION · No entry condition met`,
   with the same sentence) and the feed's heading read `1440 minutes on SOL-USD`.
5. **Clone a template.** On `/marketplace`, a built-in card showed author, description, rules and
   `NO BACKTEST RECORDED · NO FIGURE SHOWN`. `CLONE INTO A DRAFT` answered *“Cloned “SOL deep
   value” into your draft “SOL deep value copy”. It is independent of the template; edit and publish
   it from the bot builder.”* The draft appeared on `/bots` as `DRAFT | FROM sol-deep-value`, and
   publishing it produced `PUBLISHED · STARTABLE | v1 | FROM sol-deep-value` with its own
   definition id while the template still read `25 / 75` and still had no performance figure.
   Independence with an actual edit was measured separately (step 5 below): the edited clone
   published as version 1 of its own definition (`entryRsiBelow 22`) and the source bot kept `30`.
6. **Cap failure.** At `10 of 10`, the panel showed the named cap *before* any press:
   *“This account is at its bots cap on the Standard tier: 10 of 10 bots in use. Delete one or raise
   the cap in Admin → Fees (tier caps). Nothing was created.”* The create control stayed enabled;
   pressing it with a new name repeated the sentence, no row appeared, and the count stayed 10.
   The same sentence came from `CLONE INTO A DRAFT` at the cap, and the API answered `409` with it
   while the count stayed 10.
7. **Delete.** Deleting `Cap fill 5` answered *““Cap fill 5” is deleted. Its history stays readable.”*,
   the row stayed with `DELETED` and its published rules behind a disclosure, and the caps line
   moved `9 → 8` without a reload (repair 2). Deleting a bot that an activation names stops the
   activation in the same call: `stoppedActivation: true`, intent `STOPPED`, and the bot leaves the
   resolver. It remains in the catalog with a `(deleted)` label and the detail *“This bot was
   deleted, so the runner records that there is nothing to evaluate.”* — the row is history, and the
   start path refuses it (`400`, *“Choose a built-in strategy or one of your published bots.”*) while
   `isStartableStrategy` returns false.

## Scripted readings (the same build, same copy of the database)

| Reading | Result |
| --- | --- |
| Builder config with `entryRsiBelow: "abc"` | `400`, `problems[0].field = entryRsiBelow` |
| Builder config `entryRsiBelow: 150`, exit `70` | `400`, field `entryRsiBelow`, *“The entry threshold (150) must be below the exit threshold (70)…”*, nothing created |
| Publish a valid draft | `200`, `PUBLISHED`, `definition.version = 1`, rules listed |
| `/api/strategies/activate` catalog | `bot:<id>` with label `… · v1` |
| Start it | `200`, intent `RUNNING`, `auditAction STRATEGY_TRADING_STARTED` |
| Stop it (`DELETE /api/strategies/<activationId>`) | `200`, `STOPPED`, `auditAction STRATEGY_TRADING_STOPPED`; a second stop answers `changed: false` |
| Delete a running bot | `200`, `DELETED`, `stoppedActivation: true`, decision count unchanged on the next pass, decisions kept |
| Over-cap create | `409` with the named cap and usage; bot count unchanged |
| Clone | `201`, `DRAFT`, `templateSlug` recorded, `BOT_CLONED`; edit + publish → `version 1` of its own definition |
| Audit rows for one bot | `BOT_CREATED`, `BOT_PUBLISHED`, `BOT_STARTED`, `BOT_STOPPED`, `BOT_DELETED` (plus `STRATEGY_TRADING_STARTED/STOPPED` on the activation) |
| Template performance | from `BacktestRun` only; a seeded run shows `1.9992% / 7.8140% / 7 trades` on `/bots`, an unmeasured template shows no figure |

## Data and migration

`prisma/migrations/20261019120000_bot_builder_marketplace` adds `Bot` (state, config, definition
pointer and version, template slug, published/deleted timestamps) and `StrategyTemplate` (snapshot
columns, author, source bot). The tier caps were already columns on the fee schedule
(`maxBots`, `maxVenueConnections`), so the cap path needed no new table. Applied to SQLite through
`db:setup` for this run, not Postgres.

## Limits

- The database is a **copy** of `prisma/dev.db`; nothing here was driven against Postgres. The
  migration was applied by the development bootstrap, not `prisma migrate deploy`.
- To observe a decision for the newly started bot, the scratch copy's daily window was reset (the
  today's-window decision row for that activation removed and `lastWindowStart` rewound) and the
  runner job's `nextDueAt` cleared. That is phase 24's idempotency working as designed — one
  decision per window — not a defect; a freshly started bot therefore decides from the next window.
- The API readings used `APP_BASE_URL=https://verify30.local` (a placeholder origin) because the
  production runtime requires an https origin for secure cookies; requests carried that `Origin`
  header. The browser half used the development-mode runtime on a loopback origin so the same-origin
  write check was exercised for real.
- Placement is the paper venue throughout: live execution is off in `/admin/risk` and no
  trade-capable exchange key exists on this machine. No order, and therefore no fill, is part of
  this record.
- `/bots` keeps the phase-29 paper lab below the managed bots. Under `next start` in this
  environment the paper store reports `Paper session data is unavailable.` (its process-local
  runtime is a development-mode surface); the managed-bot half of the page is unaffected.
- The screenshot records below are from the hydrated browser run; the values in them are the
  readings quoted above.

## Files to inspect

`src/lib/bot-builder/{publish,templates,repository}.ts`, `src/app/api/bot-builder/**`,
`src/app/api/marketplace/route.ts`, `src/components/{managed-bots-panel,smart-trading-control}.tsx`,
`src/lib/strategies/{state,activation}.ts`, `tests/strategy-activation.test.ts`,
`prisma/migrations/20261019120000_bot_builder_marketplace/`.

Screenshots: `proof/screenshots/phase30-bots-published.png` (caps and the create form),
`phase30-bot-rows.png` (published rows, `v1`, `FROM <template>`), `phase30-trade-picker.png`
(the picker with the bot selected), `phase30-cap-message.png` (the named-cap message at 10 of 10).
