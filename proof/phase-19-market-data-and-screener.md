# Phase 19 — Market data and the screener

## Objective

Candles, headlines and indicators that every other surface can trust — with provider health, gap
backfill and one shared indicator module — plus a screener that turns the same stored data into
conditions a person can run, save, replay and convert into market alerts.

## What exists

- `src/lib/market-data/ingest.ts` — `runMarketIngest` / `runMarketBackfill`, `closedCandleWindow`,
  `findCandleGaps`, `ingestCandleSeries` and `backfillCandleGaps`. Every symbol/interval and every
  news feed is an independent operation; a failure is recorded in the summary, never thrown.
- `src/lib/market-data/candle-store.ts` — the Prisma store. Candles upsert on
  `(providerId, symbol, interval, openTime)`; news on `(providerId, url)`. That key is what makes
  ingestion and backfill safe to re-run.
- `src/lib/market-data/health.ts` — the run-local registry: successes, failures, consecutive
  failures, average latency, error rate, last outcome/reason and a 60-second cooldown after three
  consecutive failures. `MarketDataHealthRegistry.isCoolingDown` is what makes a dead source cost
  one call a minute instead of one per symbol per run.
- `src/lib/market-data/indicators.ts` — the only RSI in the tree. Imported by
  `src/lib/screener/evaluate.ts`, `src/lib/alerts/evaluate.ts`, `src/lib/backtesting/rsi-backtester.ts`,
  `src/lib/paper-trading/engine.ts`, `src/app/api/assistant/route.ts` and
  `src/app/markets/market-chart.tsx`.
- `src/lib/screener/{model,evaluate,service,payload}.ts` — the condition model (shared with market
  alerts), the evaluation, the saved-screen/run/alert translation, and the page payload.
- `src/app/api/screener/route.ts` — `GET` (public: watchlist, saved screens, provider health) and
  `POST` (`evaluate`, `ingest`, `save`, `run`, `create-alerts`, `delete`) plus `DELETE`. Every write
  requires a session and a same-origin request; `evaluate` is not gated by any confirmation step.
- `src/app/screener/page.tsx`, `src/components/screener-panel.tsx`, styles in `src/app/globals.css`.
- `prisma/schema.prisma` gained `Screener` (unique on `userId` + `name`) and `ScreenerResult`
  (every run kept, `@@index([screenerId, asOf])`), with
  `prisma/migrations/20261017150000_screener/migration.sql`.
- `src/lib/runner/registry.ts` gained `market-ingest` (15 minutes) and `market-backfill` (6 hours),
  so nothing in this phase needs a browser open.
- `scripts/route-sweep.mjs` gained `GET /screener`, `GET /api/screener`, `POST /api/screener` and
  `DELETE /api/screener`.

## Automated verification (measured, exit statuses preserved)

```
cd apps/web
pnpm --config.verify-deps-before-run=false typecheck   → typecheck=0
pnpm --config.verify-deps-before-run=false test        → test=0    526/526
pnpm --config.verify-deps-before-run=false lint        → lint=0
pnpm --config.verify-deps-before-run=false build       → build=0   18 pages, 46 API route files (74 methods)
pnpm routes:sweep --base-url http://localhost:3235      → sweep=0   93 passed · 0 not swept · 0 failed
cd ../.. && node scripts/validate_plan.mjs             → plan=0    40 phases, 0 restriction hits
```

The 11 tests in `tests/market-screener.test.ts` are the phase's own acceptance:

| test | the acceptance criterion it proves |
| --- | --- |
| a deleted candle range is restored exactly and a second backfill asks for nothing | a deliberately deleted range is restored with no duplicates |
| ingesting the same window twice updates rows instead of duplicating them | the upsert key, not a table-wide count, is the guarantee |
| gap detection groups consecutive slots and ignores a still-forming candle | a forming candle is never reported missing |
| one failing provider does not block another, and the run names the failure | one source failing leaves the others ingesting and the failure named |
| a repeatedly failing source cools down and is skipped on the next run | a failing provider is skipped rather than blocking a run |
| retained provider calls produce average latency and error rate | the durable health record answers calls/failures/rate/latency |
| a screen evaluates the same data and as-of time to the same rows and hash | a saved screen re-runs to the same results |
| the screener's RSI comes from the shared indicator module | one indicator module, no second implementation |
| a screen definition uses the alert condition model and refuses what the alert endpoint refuses | the same condition model as market alerts |
| only matched symbols become alert inputs, with the screen's own condition | a screen creates alerts from its own conditions |
| a result hash is stable across row order and changes with the condition | comparison is evidence, not prose |

The Postgres migration was compared with Prisma's own derived DDL rather than executed (no Postgres
is reachable from this machine): `prisma migrate diff --from-empty --to-schema-datamodel` produces
the identical `Screener` / `ScreenerResult` table bodies, indexes and foreign keys. The local SQLite
development database was brought to the same model with `db push`, and the live click-path below
exercised both tables.

## Owner click-path (measured, on `:3235`)

Setup: the seeded owner signed in with a real `AuthSession` row minted with the dev server's own
secret (a throwaway value generated into `/tmp/phase19/`, never committed). The dev server ran
against the local SQLite database with 15m and 1d candles already stored by the runner. No cookie,
secret or session value is reproduced here.

1. **Run a condition across the watchlist.** `/screener` with `Price at or above` / `100` and all ten
   markets selected answered **4 MATCHED / 10 CHECKED**, `AS OF 2026-10-17 12:37 UTC`, `DATA AS OF
   12:30 UTC`, `PROVIDER coinbase-exchange`, `INTERVAL 15m`, `RESULT HASH 136effbdb166`. Each row
   carried its value, `MATCH` / `NO MATCH`, the observation time, the provider and `FRESH` —
   e.g. `BTC-USD $81433.63 MATCH 12:15 coinbase-exchange FRESH`, `XRP-USD $1.2993 NO MATCH 12:30`.
   Symbols with no closed candle are listed with their reason rather than dropped; none were on this
   run.
2. **Save, reload, re-run.** Saving the same definition as “Clickpath above $100 all markets”
   survived a page reload with its parameters visible (`Price at or above $100 · BTC-USD, ETH-USD,
   XRP-USD, SOL-USD, DOGE-USD, ADA-USD, AVAX-USD, LINK-USD, LTC-USD, BCH-USD`). `RE-RUN` produced
   **the same hash `136effbdb166`**, 4 matched of 10, `AS OF 12:39 UTC` over `DATA AS OF 12:30 UTC`:
   same stored data, same result. The earlier screen “Above $100 majors” (3 symbols) renders the
   comparison line itself — “identical to the previous run (2026-10-17 12:30 UTC)” — because it has
   two recorded runs to compare.
3. **Create alerts from the screen, and see them in the alert list.** `CREATE ALERTS` on the
   saved screen answered “Created 1 alert(s) from "Clickpath above $100 all markets" at 2026-10-17
   12:39 UTC; 3 symbol(s) already had the same active alert or the limit was reached.” The three
   skipped symbols were the ones the earlier screen had already created; `BCH-USD` was new.
   `/#alerts` (the target of `OPEN ALERTS`) then listed **4 ALERTS** — `BCH-USD`, `SOL-USD`,
   `ETH-USD`, `BTC-USD`, each `Price at or above $100 · ACTIVE · WAITING FOR FIRST CHECK`.
4. **The failure case.** Both market-data providers on this deployment are public and keyless
   (Coinbase Exchange REST and the RSS newswire), so there is no key to break; the honest equivalent
   is a candle source that refuses every call. The real `CoinbasePublicMarketDataProvider` class was
   driven by a fetcher that throws, through a temporary in-process route that ran the ordinary
   `runMarketIngest` against the ordinary database, and was removed after the run. It answered:
   - `coinbase-exchange` failed four operations (`BTC-USD 15m`, its backfill, `ETH-USD 15m`, its
     backfill) with `provider-error`, then `SOL-USD` was **skipped** — “cooling down after repeated
     failures” — because three consecutive failures start the cooldown. The run did not stop.
   - All nine news feeds still ingested: **183 headlines stored**, `successCount: 1` each.
   - Health showed the failure in both records. Run-local: `coinbase-exchange` 9 ok / **4 failed** /
     4 consecutive / **30.8%** error rate / cooldown until 12:47, every RSS row `ok`. Durable
     `ProviderCallRecord`: `coinbase-exchange` 420 calls / **4 failures** / 0.9% / last failure
     12:46 / `network-error · VENUE_UNAVAILABLE`, while the nine feed rows stayed `ok`. Both tables
     are sections **04 / PROVIDER HEALTH** of `/screener`.
   - The screener still evaluated on stored data: `RUN SCREEN` immediately afterwards answered
     **4 MATCHED / 10 CHECKED** with its as-of time, `DATA AS OF`, provider and hash. A `SYNC STORED
     CANDLES` after the cooldown expired stored 576 candle rows again, so the pipeline recovered on
     its own.

## Defects the walk found, and their repairs

- **`OPEN ALERTS` was a dead control.** The screener's link went to `/#market-alerts`, an anchor
  that does not exist anywhere in the app (the alert panel's section id is `alerts`;
  `#market-alerts-title` is only the heading). The link now goes to `/#alerts`, which is the same
  target `/onboarding` already uses for “Set a market alert”; measured from `/screener` it lands on
  `http://localhost:3235/#alerts` with the alert list showing **4 ALERTS**.
- **One test file had never run.** `src/app/api/cron/[job]/route.test.ts` was listed in the `test`
  script as that literal path, and the test runner treats its arguments as globs — `[job]` is a
  character class matching one of `j`, `o`, `b`, so the path matched **no files** and the runner
  reported `tests 0` while the suite still exited 0. Its stale assertion (known jobs
  `market-alerts, retention`) would have failed had it run, because the registry has carried more
  jobs since phase 12 — including this phase's two. The script now names
  `src/app/api/cron/*/route.test.ts` (5 tests, all passing) and the assertion derives the expected
  list from `RUNNER_JOB_IDS` instead of repeating it.

## Limitations

- No market-data credential exists here to break. The failure path was measured with a refusing
  candle source inside the running app, not by corrupting a real key, and the temporary route used
  for it is not part of the repository.
- The run-local health registry is per process and lost on restart by design; only the durable
  `ProviderCallRecord` rows survive. The two tables on `/screener` therefore answer different
  questions and can legitimately disagree after a restart.
- The host delivers one invocation a day on the entry plan, so `market-ingest`'s 15-minute interval
  is a claim of due-ness, not a delivery promise; the panel's `SYNC STORED CANDLES` is the on-demand
  path and uses the same ingestion function.
- The screener evaluates 15m candles only. The daily series is stored (and backfilled) but no
  condition reads it yet, so `dataAsOf` is always a 15m boundary.
- The saved-screen comparison needs two recorded runs; a screen saved and run once says “no recorded
  run yet” / shows only its last run until it is run a second time.
- **Anchor scrolling on this app is approximate on client-side navigation.** A fresh load of
  `http://localhost:3235/#alerts` scrolls the alert section into view (`scrollY 2486`, section top
  359). Arriving by `<Link>` from another page stops short (`scrollY 915`, section top 1930) because
  the overview's later sections expand after hydration and move the target. This is not specific to
  the screener: the pre-existing `/onboarding` link to `/#alerts` lands at exactly the same offset.
  The fragment is correct and the page is the right one; the short-fall is an app-wide anchor
  behaviour worth its own change, not something this phase reworked in a shared panel.
- The Postgres migration was verified against Prisma's derived DDL, not executed against Postgres.
- The alert evaluation itself is unchanged by this phase: a screen creates alert rows, and their
  delivery belongs to phase 29.

## Plan inconsistency recorded, not fixed here

`apps/web/README.md` and `proof/phase-18-portfolio-aggregation.md` both said “phase 19 owns
valuation”. This phase's own plan (`plan/phase-19-market-data-and-screener.md`) is market data and
the screener, with no valuation in or out of scope, and no later phase file claims it. The portfolio
therefore remains unpriced, and the README now says so instead of pointing at a phase that does not
price it. Whoever schedules valuation should add it to a phase file rather than rely on that
sentence.

## Rollback

Revert this phase's commit and drop `Screener` and `ScreenerResult`; `/screener` disappears, the two
runner jobs stop being registered, and the existing market-data service and `/markets` page keep
working. Stored candles, news and provider-call rows are untouched by the rollback — they were
written by the same ingestion path the runner already used, and nothing else reads the screener
tables.
