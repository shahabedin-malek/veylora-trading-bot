# Phase 18 — Portfolio aggregation

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

One view of everything the owner holds across every configured network: native balances, token
balances, positions and totals, each figure carrying the network and provider it came from and
degrading honestly when a provider is down.

## Scope

- In: aggregation, token metadata and spam handling, positions, provenance, caching, the
portfolio UI.

- Out: ledger balances (phase 13 owns platform money); market pricing (phase 19).

## Files to touch

- `apps/web/src/lib/portfolio/aggregate.ts`, `tokens.ts`, `positions.ts` (new)
- `apps/web/src/lib/portfolio/ethereum.ts`, `ethereum-token-allowlist.ts` (reuse and extend)
- `apps/web/src/lib/rpc/networks.ts` (phase 17 registry)
- `apps/web/src/app/api/portfolio/route.ts`, `src/components/portfolio-panel.tsx`
- `apps/web/prisma/schema.prisma` (a `TokenMetadata` cache) and a migration

## Requirements

1. Aggregation runs across every available network concurrently with a bounded concurrency and
   a per-network timeout; a slow network never blocks the whole response.
2. Each holding records network, token address where applicable, decimals, raw amount,
   formatted amount and the provider it came from.
3. Token metadata is cached with a freshness window and refreshed on demand; unknown tokens are
   still listed with their address rather than dropped.
4. Spam handling uses the existing allow-list plus heuristics that mark rather than delete, and
   a marked token is always inspectable.
5. The total is presented per network and in aggregate, and a partial result states which
   networks are missing rather than showing a total that pretends to be complete.
6. The view loads progressively: networks that answered appear first.
7. Nothing here reads or displays a secret; addresses are checksummed for display.

## Acceptance criteria

- With one network deliberately dead, the portfolio still renders and names the missing network.
- A token not in the allow-list appears with its address and a "not in allow-list" marker.
- A repeat load within the freshness window does not re-fetch metadata.
- Totals equal the sum of the per-network rows, asserted by a test.

## Manual verification (owner click-path)

1. Open the portfolio panel with several networks configured; holdings appear per network and
   in aggregate.
2. Turn off one network's key and reload — that network is named as unavailable, the rest render.
3. Inspect an unknown token — shown with its address and marker, not hidden.
4. Failure case: stop the database — the metadata cache misses and the panel still lists live
   chain holdings.

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

- [ ] Per-network provenance on every holding, asserted by a test.
- [ ] Partial results state what is missing; no fake completeness.
- [ ] Unknown tokens are listed, never silently dropped.
- [ ] Metadata caching respects its freshness window.

## Rollback

- Revert this phase's commit and drop the metadata cache table; the existing Ethereum portfolio
  panel behaviour returns.

## Do not do

- No approval gate or confirmation step to read a portfolio.
- Do not hide a network whose read failed.
- Do not present a partial total as complete.
- Do not drop a token because a list does not contain it.
