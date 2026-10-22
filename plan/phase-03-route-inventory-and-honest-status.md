# Phase 03 — Route inventory and honest status labels

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

Every page and API route answers on a seeded local database, and every unfinished capability
says plainly what it does instead of hiding behind a dead or hidden control. After this
phase the whole app is walkable and nothing pretends to work.

## Scope

- In: the 14 pages and 27 API routes; honest status copy; a repeatable route sweep script.

- Out: new features; new routes; visual redesign.

## Files to touch

- `apps/web/src/app/**/page.tsx` (the 14 pages)
- `apps/web/src/app/api/**/route.ts` (the 27 API routes)
- `apps/web/src/components/session-readiness.tsx` and sibling status components
- `apps/web/scripts/route-sweep.mjs` (new)
- `apps/web/package.json` (`routes:sweep` script)
- `apps/web/README.md`

## Requirements

1. Every route in the dev-mode inventory responds on a seeded local database: `/`, `/login`,
   `/trade`, `/backtest`, `/bots`, `/markets`, `/screener`, `/research`, `/assistant`,
   `/chaingpt`, `/wundertrading`, `/admin/access`, `/admin/data`, `/admin/risk`, and the API
   routes under `/api/admin/*`, `/api/assistant`, `/api/auth/*`, `/api/backtest`, `/api/bots`
   (including `[botId]/kill`, `[botId]/paper`, `[botId]/paper-cycle`), `/api/cron/market-alerts`,
   `/api/market-alerts`, `/api/portfolio/*`, `/api/research/tavily/*`, `/api/rpc/[network]`,
   `/api/trading/*`.
2. No route returns a 500, an empty body or a silent 404 for a reason a developer can fix.
3. A route whose configuration is missing returns HTTP 503 with a body naming the missing
   variable or provider, and its page still renders with that message instead of a crash.
4. No control in any page is disabled, hidden or labelled "coming soon" because a later phase
   owns it. Unfinished work is labelled honestly, for example "order placement is not
   available yet", and the control stays present and testable.
5. The sweep script requests every route in the inventory against a running dev server,
   records status, response time and a short body fingerprint, and exits non-zero on a 5xx or
   an unexpected 404. It is read-only: it never writes to the database.
6. `pnpm routes:sweep` prints a table of route, status and time, and states which routes
   answered with a missing-configuration 503 and what each one needs.
7. The inventory lives in one place in the script so a new route must be added there, and
   phase files that add routes update it in the same phase.
8. `apps/web/README.md` documents the sweep and what a healthy report looks like.

## Acceptance criteria

- The sweep reports every route in the inventory with a 2xx or an explicit 503, exit 0.
- No page renders blank or with a client-side error at `http://localhost:3000`.
- Each missing-configuration 503 names a specific variable or provider.
- A deliberately broken route (a thrown error) makes the sweep exit non-zero.

## Manual verification (owner click-path)

1. With a seeded local database and `dev` running, open each page in the sidebar in turn.
2. On `/research` and `/screener`, confirm the page renders and states which provider or
   variable it is missing when it cannot fetch.
3. Press every visible control on `/trade` and `/bots`; nothing is inert, and anything
   unfinished says so.
4. Failure case: stop the dev server mid-sweep — the script reports connection failures and
   exits non-zero rather than claiming a pass.

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

- [ ] Every route in the inventory answers, and the sweep proves it with exit 0.
- [ ] No dead, hidden or deferred control remains in the UI.
- [ ] Each missing-configuration response names the variable or provider.
- [ ] The sweep fails on a 5xx and on an unexpected 404, proven by a planted fault.

## Rollback

- Revert this phase's commit; the sweep script is additive and the app runs without it.

## Do not do

- No approval gate, permission gate, consent step or confirmation dialogue in any route.
- Do not keep a button disabled, or a page hidden, because a later phase will finish it.
- Do not replace a missing value with a plausible sample, and do not mask the owner's own
  data in development.
- Do not swallow a provider error into a generic message; name the cause.
