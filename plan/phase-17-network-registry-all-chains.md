# Phase 17 — Network registry across every configured chain

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

Every network the owner has already configured is usable: discovered from the environment at
runtime, never hard-coded, with chain switching, health per network, and the cross-scope trap
documented so a network cannot silently lose RPC in one environment.

## Scope

- In: the registry, discovery, validation, per-network health, switching UI, the scope-coverage
report.

- Out: portfolio aggregation itself (phase 18); deposits (phase 12, consumes this registry).

## Files to touch

- `apps/web/src/lib/rpc/networks.ts` (extend into a registry), `src/lib/portfolio/evm-mainnets.ts`
- `apps/web/src/app/api/portfolio/networks/route.ts`, `src/app/api/rpc/[network]/route.ts`
- `apps/web/src/lib/rpc/rpc-proxy.ts` (per-network health and rate limiting)
- `apps/web/src/components/network-switcher.tsx` (new)
- `apps/web/README.md`, `plan/ENVIRONMENT_MANIFEST.txt` (coverage notes, names only)

## Requirements

1. Networks are discovered by scanning environment variables for the documented patterns
   (`ALCHEMY_<NETWORK>_RPC_URL`, `ALCHEMY_<NETWORK>_API_KEY`); a list is never hard-coded.
2. Each entry carries chain id, display name, native asset, explorer and the token allow-list
   status, and is validated at startup: a malformed or missing key marks that network
   unavailable with the reason, without breaking the others.
3. The registry is cached per process with an explicit invalidation path so a config change is
   picked up without a redeploy where possible.
4. Chain switching in the UI is driven by the registry; the wallet's chain is reconciled with
   the selected network on every action.
5. Per-network health records last success, last failure and latency, surfaced in the admin
   panel and used to skip a dead network rather than failing the whole request.
6. A coverage report names which networks exist in each of Development, Preview and Production,
   so a network missing from one scope is visible before it breaks (see phase 40 for the fix).
7. Adding a network needs no code change: set the variable, restart, and it appears.

## Acceptance criteria

- A newly added `ALCHEMY_*` variable appears in the registry without a code edit, proven in
  development.
- A network with a bad key is marked unavailable, and the others still answer.
- The switcher lists exactly the registry's networks and switching reconciles the wallet chain.
- The coverage report lists per-scope differences.

## Manual verification (owner click-path)

1. Open `/markets` or `/trade` and use the network switcher; each listed network can be
   selected and reflects its own data.
2. Break one network's key in `.env.local`, reload — that network shows unavailable with the
   variable name and the rest keep working.
3. Run the coverage report and read the per-scope list.
4. Failure case: select a network whose RPC is down — a specific, retryable message, not a
   blank panel.

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

- [ ] Registry discovered at runtime; no hard-coded network list remains.
- [ ] Unavailable networks degrade individually with names and reasons.
- [ ] Switching reconciles the wallet chain, tested.
- [ ] Coverage report shows the three scopes side by side.

## Rollback

- Revert this phase's commit; the previous static mainnet list is restored and portfolio reads
  continue for those networks.

## Do not do

- No approval gate or confirmation step before switching networks.
- Do not hide a configured network because it is not in a code list.
- Do not fail a whole request when one network is down.
- Do not put an RPC key in client-side code or a `NEXT_PUBLIC_` variable.
