# Phase 38 — Performance and load

Measurements taken with `apps/web/scripts/bench.mjs` against the seeded development data, copied to
`prisma/bench.db` so the owner's own database is never touched. Every run prints the volume it used,
so a fast number can never be mistaken for a real one.

## The volume and the host

| | |
| --- | --- |
| Ledger entries | 100,004 |
| Ledger transactions | 50,002 |
| Audit events | 50,014 |
| Orders | 20,003 |
| Strategy decisions | 20,001 |
| Running strategies | 26 |
| Database | SQLite (`prisma/bench.db`, a copy of `prisma/dev.db`, schema pushed from `schema.prisma`) |
| Server | `next start` (production build), heap capped at `--max-old-space-size=512` |
| Host | AMD FX-6100 (6 cores), Node v24.21.0, Linux |

Method: each surface is warmed once (a cold route is a compile fact, not a steady state) and then
timed over five requests; each query is timed over five runs and the median is reported, with
`EXPLAIN QUERY PLAN` captured for the same statement. `--indexes without` drops exactly the four
indexes this phase adds and nothing else, so the before/after pair differs only by those indexes.

Raw runs: `proof/bench/phase38-before.json`, `phase38-after.json`, `phase38-empty.json`,
`phase38-heap192.json`. Reproduce the comparison with:

```bash
cd apps/web
node scripts/bench.mjs --label before --indexes without
node scripts/bench.mjs --label after
node scripts/bench.mjs --compare before after
```

## Surfaces — before and after

| Surface | Before | After | Change |
| --- | --- | --- | --- |
| `/` | 77 ms | 69 ms | −10% |
| `/trade` | 1459 ms | 1305 ms | −11% |
| `/account` | 38 ms | 38 ms | 0% |
| `/admin` | 39 ms | 36 ms | −8% |
| `/api/ledger` | 991 ms | 885 ms | −11% |
| `/api/trading/orders` | 17 ms | 14 ms | −18% |
| `/api/admin/audit` | 19 ms | 21 ms | +11% (noise) |
| `/api/ledger?format=csv&from=2025-10-21&to=2026-10-20` (6.9 MB) | 11,000 ms | 7,751 ms | −30% |
| `/api/admin/audit/export?format=csv` (7.1 MB) | 7,116 ms | 7,009 ms | −2% |

`/api/admin/audit` moves by 2 ms in the wrong direction; no index it reads was touched (the audit
candidates were rejected — see below), so that is run-to-run noise, not a regression. The two
surfaces that read the ledger improve because the ledger index does.

## Queries — before and after

| Query | Rows | Before | After | Change |
| --- | --- | --- | --- | --- |
| `ledger-statement-window` (a year of one account's legs) | 50,000 | 1343 ms | 1399 ms | +4% (no gain expected: the row count is the cost) |
| `ledger-balance-aggregate` | 1 | 116 ms | 96 ms | −17% |
| `ledger-statement-page` (newest 500 in 30 days) | 500 | 120 ms | 80 ms | −33% |
| `ledger-range-in-window` (30 days, all rows) | 3,749 | 200 ms | 139 ms | −30% |
| `audit-newest-page` (200 newest, 90 days) | 200 | 17 ms | 9 ms | −47% (noise: unchanged plan) |
| `audit-source-page` (200 newest of one source) | 200 | 16 ms | 16 ms | 0% |
| `orders-open-for-market` | 0 | 9 ms | 7 ms | −22% |
| `orders-list-for-account` (100 newest) | 100 | 7 ms | 8 ms | +14% (noise) |
| `decisions-for-account` (100 newest) | 100 | 4 ms | 11 ms | +175% (noise: same plan, no index change) |

The last three are sub-15 ms queries where a single scheduler tick moves the median by more than the
change under test; the plans for `decisions-for-account` and `audit-newest-page` are byte-identical
before and after, which is the check that they are noise rather than a regression.

## Indexes — what was kept, and what was measured and rejected

Kept (migration `20261020130000_phase38_performance_indexes`):

| Index | What it serves | Measured |
| --- | --- | --- |
| `LedgerEntry(accountId, transactionId)` | every statement read and the balance aggregate, which walk one account's legs in transaction order | aggregate 116 → 96 ms; page 120 → 80 ms; 30-day range 200 → 139 ms; the full-range CSV 11.0 → 7.8 s |
| `LedgerTransaction(occurredAt)` | the ledger integrity check, which reads the whole book in time order | 671 → 550 ms for 100k transactions; the plan drops `USE TEMP B-TREE FOR ORDER BY` |
| `TradeOrder(userId, status, createdAt)` | the orders list's account-plus-status filter | 4 → 3 ms, and the plan switches from the global status index to this one |
| `TradeOrder(userId, market, status)` | the runner's per-activation open-order count, where it is a covering index | 3 → 1 ms per call; with 26 strategies that is the difference the cadence section records |

Rejected, with the number that rejected it:

| Candidate | Why not |
| --- | --- |
| `AuditEvent(action, occurredAt)` | the audit filter is `contains` (foreign `LIKE '%…%'`), which cannot use a B-tree prefix, so the index is never chosen. |
| `AuditEvent(source, occurredAt)` | the plan changes from a scan to a search, but the page is bounded at 200 rows either way: 4 ms with, 4 ms without (and 16 ms vs 16 ms in the bench). No gain, so no index. |
| `StrategyDecision(userId, outcome, evaluatedAt)` | no query filters on `outcome`; the existing `(userId, evaluatedAt)` index already serves the feed and the planner ignored the wider one (4 ms without, 11 ms with — noise, same plan). |

The first draft of this phase shipped all of them; the measurements above are what removed two of the
three audit/decision candidates and kept the schema honest. Adding an index that is never chosen is a
write cost with no read benefit.

## Statements and exports stream rather than accumulate

- `src/lib/audit/query.ts` exposes `iterateAuditEvents`, an async generator that pages by
  `(occurredAt, id)` cursor in two passes (unchained legacy rows, then chained rows in chain order).
  `auditExportManifest` and `auditExportChunks` each consume a fresh iterator, so the hash pass and the
  body pass are both bounded; the route wraps the chunk generator in a `ReadableStream`.
- `src/lib/ledger/statements.ts` reads through `iterateEntriesForAccountsChronological` when the store
  offers it, folding every entry into the totals while keeping only a bounded page of display lines;
  `truncated` and the total line count say what the page is not showing.
- The export of the seeded volume completes twice (ledger CSV 6.9 MB, audit CSV 7.1 MB) with the
  server's heap capped at 512 MB.
- Stronger evidence: `node scripts/bench.mjs --heap 192 --samples 1` against the same 100k/50k
  volume, with the server's heap capped at **192 MB**, completed both exports with `200` in 8.3 s and
  6.7 s (`proof/bench/phase38-heap192.json`). A range materialised in memory at that volume would not
  fit in that heap.

Server RSS rises from ~156 MB to ~611 MB across a run that includes both exports. RSS is not heap —
it grows even on the empty-volume run (~156 → 380 MB) where there is nothing to hold — so it is
recorded here as an observation, not as evidence about the export. The 192 MB heap run is the
evidence.

## Runner cadence

One cron pass of `strategy-activation` with 26 running strategies and 20,001 decisions took
**985 ms against a 300 s interval** — 0.33% of the interval, **299 s of headroom** (`jobsRan 1,
jobsFailed 0`). The same pass took 638 ms in the before run and 750 ms under the 192 MB heap. The
cadence is not the constraint here; the open-order count the runner makes per activation is why its
covering index was kept.

## Cache correctness

`MarketDataService.cacheKey` is `JSON.stringify([provider.id, kind, request, floor(now / ttlMs)])`:

- the provider id is the network the value came from, so two feeds never share an entry;
- the request carries the as-of (`to` for candles, `since` for news), so two questions about different
  moments are two entries;
- the freshness window is part of the key, so a value written in one window is not returned in the
  next even if a clock or a TTL edit would let it survive.

Asserted by `tests/market-data.test.ts`: *"a cached market value is tied to its provider, its as-of and
its freshness window"* (same question in the same window is one call; at `now + ttl` it is a second
call; a different candle `to` is a third).

## Still slow, with the number and a proposal

| Surface | Measured | Why | Proposal |
| --- | --- | --- | --- |
| `/trade` | 1305 ms | it reads a **365-day** account view; the fold covers 50,000 entries at 1399 ms, and the page's own quote/candle reads are small beside it. | Default the workbench to a 90-day window (its panels already offer ranges), or read the closing balance from a stored per-transaction balance instead of folding a year on every render. |
| `/api/ledger` | 885 ms | same fold, over the range the route asks for. | Same: range default plus a stored running balance, or serve the totals from a materialised daily aggregate. |
| Ledger CSV of a full year | 7751 ms | it streams, but folds 50,000 entries and formats them one at a time. | Accept it (streaming is the requirement) or gzip the response and raise the batch size; the CPU cost is formatting, not I/O. |
| Audit CSV of everything | 7009 ms | two passes over 50,000 rows (hash, then body), each paged. | Keep the two-pass manifest for verifiability; it can be halved only by buffering, which would break the memory property. |

The host meets the required cadence (299 s of headroom) and every page and endpoint answers inside
the measured budget except `/trade`, which is named above with its cause rather than described as
"fast enough".

## Manual verification

1. `node scripts/bench.mjs --label after` prints the table above and stores `phase38-after.json`.
2. `/trade` at 1305 ms and `/account` at 38 ms match the script: the trade page folds a year of
   ledger lines before it renders, which is visible as the one slow navigation.
3. Both full-history exports (6.9 MB ledger CSV, 7.1 MB audit CSV) complete with `200` and the
   manifest header the phase 36 route attaches; under a 192 MB heap as well. (The manifest's
   re-verification is phase 36's test; this phase measures that the body is produced within budget.)
4. `node scripts/bench.mjs --volume empty` reports `Volume: 4 ledger entries, 14 audit events, 3
   orders, 1 decisions, 1 running strategies` — the volume line travels with every result, so the
   11 ms and 53 ms it then measures cannot be read as a real result.

## Gates

```text
typecheck=0   (tsc --noEmit)
test=0        (766 passing, 0 failing)
lint=0        (eslint, no warnings)
build=0       (next build)
plan=0        (validate_plan.mjs: 40 phase files, 0 restriction hits)
```

## Limits

- The database is SQLite, as every earlier phase recorded; the Postgres migration is the same four
  statements but was not executed against a Postgres server here.
- One host, one process, no CDN or edge cache. These are single-process numbers.
- Medians move by ±10% run to run; the sub-15 ms queries move more than that, and are called out as
  noise where the plan did not change.
- The empty-volume run still contains the development seed, not literally zero rows: it reports what
  it found.
