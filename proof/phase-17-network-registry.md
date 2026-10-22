# Phase 17 — Network registry across every configured chain

## Objective

Every network the environment configures is usable, discovered at runtime rather than listed in
code, with chain switching, per-network health, and the cross-scope trap made visible.

## What exists

- `src/lib/rpc/networks.ts` is the registry. It scans `ALCHEMY_<NETWORK>_RPC_URL` and
  `ALCHEMY_<NETWORK>_API_KEY`, excluding `*_BEACON_RPC_URL` (consensus endpoints, not JSON-RPC).
  Each entry carries the variable, display name, chain id, native asset, explorer, kind
  (`evm` / `non-evm` / `unknown`), testnet flag, token-allow-list status, availability, configuration
  source and a reason. An endpoint value never enters an entry. The registry is cached for 30 seconds
  for `process.env`; `invalidateNetworkRegistry()` is the explicit path, and a caller supplying its
  own environment always gets a fresh answer.
- `src/lib/rpc/network-catalog.ts` holds public metadata for testnets, additional EVM mainnets and
  the non-EVM families; `src/lib/portfolio/evm-mainnets.ts` gained explorer URLs. Discovery does not
  depend on this catalog: an unlisted network is still listed and proxied, with a null chain id.
- `resolveRpcEndpoint` now resolves a per-network `_API_KEY` through a known Alchemy host, after the
  per-network URL and before the shared `ALCHEMY_API_KEY` fallback.
- `src/instrumentation.ts` validates the registry once at startup and logs the usable/total count
  plus one line per problem — variable names and reasons only.
- `src/lib/rpc/health.ts` records in-process per-network success, failure, latency, consecutive
  failures and last problem. After three consecutive failures a network is skipped for a 60-second
  cooldown with the wait stated; a success clears the record. `/api/rpc/[network]` and the portfolio
  read both use the decision, so one dead chain cannot fail a request another answers.
- `GET /api/portfolio/networks` returns the registry, totals and health to a signed-in caller.
  `/trade` renders it as the network switcher: a selection is verified through the proxy
  (`eth_chainId` and `eth_blockNumber`), the wallet is asked to switch, and the wallet's chain is read
  back and compared with the request. `/admin/data` section 07 shows totals, every unavailable
  network with its reason, and per-network health.
- `scripts/network-coverage.mjs` (`pnpm networks:coverage`) compares the `ALCHEMY_*` network set of
  Development, Preview and Production from the names-only manifest; `--check` exits 1 on a gap.

## Gates (measured, exit statuses preserved)

```
typecheck=0
test=0       499/499 (27 new for this phase)
lint=0
build=0
validate_plan=0 (40 phases, 0 restriction hits, 0 warnings)
routes:sweep=0 (89/89 — 18 pages, 70 exported API methods, including the new GET registry row)
networks:coverage=0
```

`networks:coverage` reports **154 distinct networks in each of Development, Preview and Production,
no gaps**, and 3 beacon variables ignored.

## Owner click-path, on the running server (`localhost:3235`)

**1. The registry is the environment.** The live registry reported `discovered 154, available 154,
evm 89, listedForPortfolio 29`; 77 entries are testnets, 21 identified non-EVM and 44 without a
confident chain id. The JSON contained neither `g.alchemy.com` nor `/v2/` — no endpoint or key is
exposed. Startup printed `[rpc] 154/154 configured network(s) usable` and the three beacon ignores.

**2. A bad key marks one network, not the deployment.** The server was restarted with
`ALCHEMY_ROUTE_SWEEP_PROBE_RPC_URL=http://insecure.invalid` and no other change. Startup printed
`[rpc] 154/155 … usable` and `route-sweep-probe: ALCHEMY_ROUTE_SWEEP_PROBE_RPC_URL must be an https
URL, so route-sweep-probe is unavailable.` The registry then reported 155 discovered / 154 available;
the probe entry carried `problem: "insecure"` and that reason; Base, Arbitrum and Solana stayed
available. `POST /api/rpc/arb-mainnet` answered `200` with `0xa4b1` (42161) while
`POST /api/rpc/route-sweep-probe` answered `503`. Removing the variable and restarting returned the
registry to 154/154 with the probe gone.

**3. The switcher lists exactly the registry, and reconciles the wallet.** In the browser, the select
rendered **155 options** (the same 155 entries the API returned, grouped 89 wallet-switchable EVM and
66 proxy-only). With no injected wallet, choosing Base still verified the RPC — `VERIFIED · chain
8453 · block 52,721,930 · 617 ms round trip` — and said `No injected wallet is available … the
selection is remembered and its RPC endpoint still works.` With a stand-in EIP-1193 provider, choosing
Base requested 8453 and read back 8453 (wallet chain field updated, no notice). Choosing OP Mainnet
while the provider was made to resolve the request without moving produced the mismatch sentence:
`The wallet reports chain 42161 after the request to switch to OP Mainnet (chain 10); it did not
change. Open the wallet, switch to OP Mainnet, then retry.` Choosing the unavailable probe network
showed one notice naming `ALCHEMY_ROUTE_SWEEP_PROBE_RPC_URL`, and no wallet request was made.

**4. Admin.** `/admin/data` answered 200 with the session and rendered `07 / RPC REGISTRY`,
`Configured networks`, `PER-NETWORK HEALTH` and the beacon-ignore note.

## Defects the check found and fixed

- **One network, two health keys.** The portfolio allow-list names Ethereum `eth-mainnet` while the
  registry and proxy name it `ethereum-mainnet`, so health was recorded under both. Added
  `canonicalNetworkSlug()` and keyed portfolio health through it; a test pins the alias.
- **The same sentence twice.** Selecting an unavailable network rendered its reason in the facts block
  and again as a notice. The selection path now returns without duplicating it.
- **A stale label.** The health field said "HEALTH" while showing the page-load snapshot; it now says
  "HEALTH AT LOAD", with the live round trip shown in the verified line.

## Limitations recorded, not hidden

- Chain ids are asserted only where the metadata is certain: 89 of 154 entries are EVM with a chain
  id, 21 are identified non-EVM, and 44 are `unknown` — listed and proxied, but not wallet-switchable
  and without a native asset or explorer. They appear in the switcher with the reason, not omitted.
- The switcher's wallet path was driven by a stand-in EIP-1193 provider in the browser; no browser
  extension was installed in this run. Real wallet behaviours (user rejection, unknown chain) are
  classified by the existing `wallet-errors` / `eip1193` code and unit-tested, not exercised against
  an extension here.
- Health is process-local and resets on restart; it is evidence about this process's calls, not a
  durable claim about the chain. The admin panel shows only networks with recorded traffic.
- The 30-second cache and explicit invalidation govern `process.env` reads. Editing a `.env` file
  still requires the process to reload its environment; "set the variable and restart" remains the
  operational change.
- The coverage report is only as current as the checked-in names-only manifest; it does not query the
  host's environment API.
- The portfolio token allow-list remains the 29 mainnets phase 13 defined. Dozens more networks are
  now reachable over RPC; aggregating balances across them is phase 18.
- `next build` logs Prisma errors while statically generating pages when `DATABASE_URL` is absent from
  the build shell (exit 0, unchanged from earlier phases). The click-path server ran with the
  development environment; the build was the gate command as written, without it.

## No secrets

The record contains no session value, cookie, RPC key or endpoint. The session used for the
click-path was a real `AuthSession` row minted with the deployment's own secret and a throwaway
development key; the stand-in wallet provider lived only in the browser page.
