# Phase 30 — Bot builder and strategy marketplace

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

The bot builder produces something runnable: a strategy built in the UI publishes to the runner
without hand-edited config, templates can be cloned and shared, and per-tier caps limit bots and
venue connections as owner-editable data.

## Scope

- In: builder → definition publishing, validation, templates/marketplace, per-tier caps, cloning and versioning.
- Out: the AI generation path (phase 28); live placement rules (phases 21/22).

## Files to touch

- `apps/web/src/components/bot-builder-panel.tsx`, `src/app/bots/page.tsx`
- `apps/web/src/lib/bot-builder/state-machine.ts`, `publish.ts` (new), `templates.ts` (new)
- `apps/web/src/app/api/bots/route.ts`, `[botId]/paper/route.ts`, `[botId]/kill/route.ts`
- `apps/web/src/app/marketplace/page.tsx` (new), `src/app/api/marketplace/route.ts` (new)
- `apps/web/prisma/schema.prisma` (`StrategyTemplate`, tier columns) and a migration

## Requirements

1. Publishing validates a built strategy against the phase-28 definition schema and only then
   makes it runnable; a failure names the missing or invalid field.
2. A published strategy appears in `/bots` and on `/trade` with its state, and can be started
   through the phase-23 control.
3. Templates can be cloned into an editable copy; the clone records which template it came from
   and its own version history.
4. The marketplace lists templates with author, description and performance sourced from real
   backtests — never a fabricated return figure.
5. Tier caps on live bots and venue connections are admin data: exceeding a cap produces a
   specific message naming the cap and the current usage rather than a hidden failure.
6. Every bot action — create, publish, clone, start, stop, delete — writes an audit event.
7. A deleted bot stops being scheduled immediately while its history stays readable.

## Acceptance criteria

- A strategy built entirely in the UI publishes, starts and runs, verified end to end.
- An invalid strategy is refused with the offending field named.
- Exceeding a bot cap produces the named-cap message and creates nothing.
- Deleting a bot removes it from the runner while its trades remain in history.

## Manual verification (owner click-path)

1. Build a strategy in the builder and publish it; it appears in `/bots` with a state.
2. Start it from `/trade`, confirm decisions appear from phase 24.
3. Clone a marketplace template, edit and publish — the copy is independent.
4. Failure case: at the bot cap, press create — the message names the cap and the usage.

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

- [ ] Builder output publishes and runs without hand-edited config.
- [ ] Validation refuses an invalid strategy with the field named.
- [ ] Caps are admin data with named-cap messages, covered by tests.
- [ ] Every bot lifecycle action is audited.

## Rollback

- Revert this phase's commit and drop the template table; existing bots keep their rows and stop
  being scheduled if the publish path is removed.

## Do not do

- No approval gate or confirmation dialogue before publishing or deleting a bot.
- Do not disable the create control when a cap is reached; state the cap and the usage.
- Do not publish a performance figure that no real backtest produced.
- Do not leave a deleted bot scheduled.
