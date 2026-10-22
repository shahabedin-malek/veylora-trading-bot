# Phase 18 — Portfolio aggregation

## Objective

One view of everything the owner holds across every configured network: native balances, token
balances, positions and totals, each figure carrying the network and provider it came from and
degrading honestly when a provider is down.

## What exists

- `src/lib/portfolio/ethereum.ts` gained two reads that return **raw** facts:
  `readEvmRawBalances` (native balance plus `alchemy_getTokenBalances` discovery, with allow-listed
  contracts the provider did not report read directly through `balanceOf`) and
  `readAlchemyTokenMetadata` (symbol, name and decimals per contract). Both accept a caller signal,
  relay it into the fetch, and never format an amount.
- `src/lib/portfolio/tokens.ts` is the metadata cache and the marker vocabulary.
  `resolveTokenMetadata` serves a row younger than 24 hours without a provider call, asks only for
  the rest, writes answers back, falls back to a stale row when a refresh fails, and falls back to
  the checksummed address when nothing is known. A cache read that throws is a miss
  (`cache-unavailable`); a cache write that throws is a warning. `assessToken` adds markers — `not
  in allow-list`, URL, claim phrase, over-long symbol/name, missing symbol/decimals — and sets
  `suspectedSpam` without removing anything.
- `src/lib/portfolio/positions.ts` builds holdings and totals. A holding carries network, chain id,
  contract address (checksummed, null for native), decimals, raw amount, exact `formatUnits`
  amount, provider, read time and explorer URL. Sums use `decimal.js`, never a float. A token with
  unresolved decimals is shown in raw units with a marker. `summarizePortfolio` aggregates only the
  answered rows and lists every missing network with its reason; `complete` is a fact about
  coverage.
- `src/lib/portfolio/aggregate.ts` reads networks with a four-wide bounded pool and a 12-second
  per-network deadline. The deadline aborts the signal the fetches carry, and the timed-out row is
  `status: "timeout"` rather than an absent row. `onNetwork` fires as each row settles, which is
  what the stream consumes.
- `src/lib/portfolio/token-metadata-store.ts` is the Prisma implementation of the cache store.
- `prisma/schema.prisma` gained `TokenMetadata` (shared, no user id, no balance) and
  `prisma/migrations/20261017140000_token_metadata/migration.sql` creates it.
- `GET /api/portfolio` returns the snapshot, or — with `Accept: text/event-stream` — `start`, one
  `network` per settled network, `summary`, `done`. `?refresh=1` bypasses the freshness window. One
  audit row records the read, and losing that write does not fail the read.
- `src/components/portfolio-panel.tsx` replaces the Ethereum-only panel on `/`. It shows coverage
  and missing networks above the totals, failed networks first, per-network holdings with marker
  chips and an `Inspect` disclosure (raw amount, contract, read time, source, explorer), the
  aggregate totals, and a collapsed allow-list manager for enabling networks and adding/removing
  contracts. `src/app/globals.css` carries the styles.
- `scripts/route-sweep.mjs` gained the `GET /api/portfolio` row (71 methods total).

## Automated verification (measured, exit statuses preserved)

```
cd apps/web
pnpm --config.verify-deps-before-run=false typecheck   → typecheck=0
pnpm --config.verify-deps-before-run=false test        → test=0    510/510 (11 new)
pnpm --config.verify-deps-before-run=false lint        → lint=0
pnpm --config.verify-deps-before-run=false build       → build=0
cd ../.. && node scripts/validate_plan.mjs             → plan=0   40 phases, 0 restriction hits
```

Route inventory: `scripts/route-sweep.test.mjs` 12/12 after adding the row.

The new Postgres migration's statement was compared with Prisma's own generated DDL
(`prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma`): the
`TokenMetadata` table matches column for column. No Postgres is reachable from this machine, so the
migration was not executed there; the local SQLite development database was brought into sync with
`db push` from the derived schema, and the live read exercised the table.

The 11 new tests (`tests/portfolio-aggregation.test.ts`) assert: totals equal the sum of the
per-network rows; every holding carries network and provider; an unknown token is listed with its
checksummed address and `not in allow-list`; a dead network is named and the rest render; a slow
network times out without blocking the others; a repeat load within the freshness window makes no
reader call; a failing cache still lists live chain holdings; an unresolved metadata answer stays
listed in raw units; rows are emitted as networks settle; bounded concurrency keeps its width and
order; and `withDeadline` aborts its signal.

## Owner click-path (measured)

Setup: the seeded owner (`0x1111111111111111111111111111111111111111`) had Ethereum enabled, then
Base was enabled through `POST /api/portfolio/networks`. A second `next dev` on port 3236 was
started with `ALCHEMY_BASE_MAINNET_RPC_URL=https://127.0.0.1:9/` and `ALCHEMY_API_KEY=""`, so
Ethereum used the real endpoint while Base was deliberately dead. A real `AuthSession` row was
minted with the server's own secret; no cookie or secret is reproduced here.

1. **Holdings per network and in aggregate.** `GET /api/portfolio` answered `200` in 2.15 s:
   Ethereum `available`, **89 holdings** (native `5.71818055799281732` ETH, 88 tokens), 86 metadata
   rows cached and 3 contracts resolved only to an address. Every token row carried
   `allowListed: false` and the `not in allow-list` marker; five were also marked as possible spam.
   Example: `COW` / "Cowboy.Finance" carried `not in allow-list` and `name or symbol contains a
   URL`, with contract `0x0ca83A3c9E6be900B857e107eE168dB6E9f96f0b`. The aggregate was complete for
   the one enabled network at that point, and its totals were the row's totals.
2. **One network deliberately dead.** On the 3236 server the same request answered `200` with
   `status: "partial"`: Base `unavailable` with reason "Base did not answer." and no provider,
   Ethereum `available` with 89 holdings, `summary.complete: false`,
   `missing: [{ networkName: "Base", reason: "Base did not answer." }]`, and the aggregate ETH total
   still `5.71818055799281732`. The panel rendered **Base · CHAIN 8453 · UNAVAILABLE · NO ANSWER**
   first, then Ethereum · ANSWERED, with the sentence "Partial: 1 of 2 networks did not answer, so
   this total is a floor, not a complete portfolio." and Base named above the totals.
3. **Unknown token inspected.** With the panel open, a token not in the allow-list showed its name,
   symbol, formatted amount, `not in allow-list` chip and an `Inspect` disclosure that opened to
   RAW AMOUNT, CONTRACT `0x0E5125c02417729055f4D9816dA68125dB29391a`, READ AT, `alchemy-rpc ·
   chain 1`, and an "open on explorer" link. Nothing was hidden.
4. **Repeat load within the freshness window.** A direct check against the live provider and the
   real cache: first `resolveTokenMetadata` for USDC returned `source: "provider"`, `cache: "miss"`;
   the second returned `source: "cache"`, `cache: "hit"`, and the reader had been called **once**.
   Across two full portfolio loads the `TokenMetadata` table stayed at 86 rows.
5. **Progressive load.** The event stream arrived in the order
   `start → network → network → summary → done`; the dead Base row was emitted first
   (`unavailable/0`), Ethereum second (`available/89`), and the summary named Base as missing.
6. **Refresh on demand.** Pressing `REFRESH METADATA` issued `GET /api/portfolio?refresh=1`, logged
   by the server as `200 in 1254ms`.

## Failure case: a cache that cannot be read

Stopping the whole database is not a usable failure probe here, because session resolution itself
reads the database: a stopped database refuses the request before any portfolio code runs. The
cache-specific failure was therefore measured where it exists — the aggregation with a store whose
`read` throws. The row is `cache-unavailable`, the provider resolves metadata, native and token
holdings are listed, and the 89-holding live read is unaffected. `test("a cache that cannot be read
still lists live chain holdings")` asserts exactly that. A missing `TokenMetadata` table has the
same shape: the read throws, becomes a miss, and balances are still read from the chain.

## Limitations

- No prices: the aggregate is exact amounts per asset and a holding count, because valuation is
  phase 19. Nothing in this phase is a currency figure.
- Three live contracts answer with no metadata at all; they are listed by address in raw units, and
  because there is nothing to cache they are re-asked on the next load. The stored 86 rows are not
  re-fetched; a negative cache for unresolvable contracts would remove the remaining calls.
- The per-network timeout was exercised with a hanging fake provider in tests and with a refused
  endpoint live; a network that hangs in production is ended by the same abort path.
- Next 16 permits one `next dev` per project, so the dead-network reading required stopping the
  healthy server and starting the proof server; both were local and disposable.
- Modifying an existing CSS rule was not picked up by the dev server's CSS chunk without a restart;
  the stylesheet was verified in the browser after restarting (`max-height: 264px` / `360px`
  computed).
- The proof session was a directly minted `AuthSession` row for the seeded owner; no wallet was in
  the room. The session secret was generated into `/tmp/phase18/` and never committed.

## Rollback

Revert this phase's files and drop `TokenMetadata`; the Ethereum-only panel returns. Metadata is
re-read from the provider on the next load, and no holding or total depends on a cached row.
