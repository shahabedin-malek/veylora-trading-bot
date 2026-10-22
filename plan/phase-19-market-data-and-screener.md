# Phase 19 — Market data and screener

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

Market data the rest of the product can trust — candles, news, indicators and watchlists with
provider health and gap backfill — plus a screener surface that turns the same data into saved
screens a human can read.

## Scope

- In: candle/news ingestion and backfill, indicator reuse, provider health, watchlists, the
screener surface with saved screens and alerts entry points.

- Out: alert delivery (phase 29); backtesting (phase 28); AI research (phase 26).

## Files to touch

- `apps/web/src/lib/market-data/{service,cache,indicators,provider,coinbase-service,cointelegraph-service,rss-feeds,watchlist,year-report}.ts`
- `apps/web/src/lib/runner/scheduler.ts` (register ingestion and backfill jobs)
- `apps/web/src/app/screener/page.tsx`, `src/components/screener-panel.tsx`
- `apps/web/src/app/api/screener/route.ts` (new)
- `apps/web/prisma/schema.prisma` (`Screener`, `ScreenerResult` caches) and a migration

## Requirements

1. Candle ingestion upserts by symbol and interval, and a gap check enqueues a backfill for
   missing ranges; a backfill never duplicates a stored candle.
2. Provider health per source (last success, last failure, latency, error rate) is recorded and
   visible; a failing provider is skipped rather than blocking an ingest run.
3. Indicators used by the screener, the backtester and the assistant come from one module, so a
   number in two places cannot disagree.
4. The screener evaluates conditions across a symbol set with the same condition model as
   market alerts, and returns per-symbol results with the values that matched.
5. Saved screens persist with their parameters and can be re-run and compared, and a screen can
   create a market alert from its conditions.
6. Results state their as-of time and which provider supplied them.
7. Nothing in this phase requires a browser to be open.

## Acceptance criteria

- A deliberately deleted candle range is restored by a backfill with no duplicates, proven by a
  test.
- With one provider failing, other sources still ingest and health shows the failure.
- A saved screen re-runs to the same results for the same data and as-of time.
- Indicator values match the shared module's tests.

## Manual verification (owner click-path)

1. Open `/screener`, run a condition across the watchlist — matching symbols list with values.
2. Save the screen, reload, re-run it — identical results and the saved parameters visible.
3. Create an alert from the screen and confirm it appears in the alerts list.
4. Failure case: break the candle provider key and run an ingest — the run reports the provider
   failure and the screener still evaluates on existing data.

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

- [ ] Upsert and backfill idempotency covered by tests.
- [ ] Provider health recorded and displayed per source.
- [ ] One indicator module shared by screener, backtest and assistant.
- [ ] Screens save, re-run and convert to alerts, all verified in the UI.

## Rollback

- Revert this phase's commit; the existing market-data service and `/markets` page keep working
  and `/screener` disappears.

## Do not do

- No approval gate or confirmation step before a screen runs.
- Do not cache a result without its as-of time.
- Do not let one provider failure hide the data another provider can still supply.
- Do not leave a screener control that does nothing; every control must act.
