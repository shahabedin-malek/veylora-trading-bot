# Phase 21 — the testnet order path (proof record)

What was built, what was measured on the running application, the two defects the live run
found, and what this run could not measure. No credential, cookie, session value or key
material appears here: the session secret and the credential encryption key were throwaway
values generated into `/tmp/phase20/` by the previous phase, and the testnet key used for the
evidence was a deliberately invalid string that was revoked at the end of the run.

## What the path is

The order path already existed (phase 06) and never branched on a venue: `process.ts` asks a
`OrderVenuePort` four questions — *submit*, *look up*, *cancel* — and `reconcile.ts` trusts only
the second. Phase 21 adds a real venue behind that port and moves the **choice** of venue into
`src/lib/venues/registry.ts`, so submission, cancellation and the runner's reconciliation pass
all ask one function instead of reading a module-level singleton.

- **The testnet is a venue, not a mode.** `binance-testnet` is a row in `VENUE_DESCRIPTORS`
  with `environment: "testnet"` and its own key, balances, order ids and endpoint. Live rows
  (`binance`, `coinbase-advanced`, `kraken`, `wundertrading`) now carry
  `environment: "live"` and **no `place` capability**. The order path asks the descriptor
  before it builds a client, so a live venue is refused by the same table the panel renders.
- **`venues/testnet-adapter.ts`** implements both the phase-20 read interface (`balances`,
  `orders`, `orderStatus`, `cancel`, `health`, and a `positions` refusal) and the phase-06
  `OrderVenuePort` (`submit`, `lookup`, `cancel`), so the read surface and the order path share
  one client and one vocabulary. It is the only adapter in the build that may place, and
  `createTestnetVenue` refuses to be constructed for a descriptor that is not a testnet with
  `place`.
- **Three guards, each measured:**
  1. *Endpoint* — the client is built, `setSandboxMode(true)` applied, and every API host
     compared against `testnet.binance.vision` / `testnet.binancefuture.com` before the client
     is handed back (`assertTestnetEndpoints`). It runs in the factory **and** on every
     injected transport in `withExchange`, so a client that resolved to a production URL throws
     instead of placing. A unit test proves the guard on a production URL map and prints the
     real sandbox client's hosts.
  2. *Scope* — `assertWriteAllowed` runs before a client exists, and its refusal is returned as
     a rejection carrying `READ_ONLY_CREDENTIAL` (so the order row records why, rather than the
     attempt throwing).
  3. *Routing* — `resolveOrderVenue` reads the admin switch and the account's own newest
     unrevoked testnet key, refuses a read-only key, a missing key, a live key, an unreadable
     ciphertext and unreadable settings, and finally refuses any venue whose descriptor is not
     a testnet with `place` (`orderPlacementRefusal`).
- **Admin data, not environment.** `IntegrationFeatureSettings.testnetOrdersEnabled`
  (migration `20261017190000_testnet_order_routing`) is the one switch that can move an order
  off the paper venue. Off (the default) means the paper venue; on means the signed-in
  account's own testnet key. It joins the existing admin switches on `/admin/access`, is
  audited like them, and is the only new column.
- **The record.** Every submission returns the request it sent and the response it received;
  `process.ts` writes both into the attempt row (`lastProviderResponseJson`) with the reason,
  the resulting state and the venue's own words. The venue's error classification decides
  whether an answer is definitive (`BadRequest`, `InvalidOrder`, `InsufficientFunds`,
  `BadSymbol`, auth/permission errors → recorded once, no retry) or transport-class
  (`RequestTimeout`, `NetworkError`, `ExchangeNotAvailable`, rate limits → retried under the
  phase-06 policy with the same idempotency key).
- **Reconciliation runs after submission and on every runner pass, and never asks the wrong
  venue.** After a submission the venue's answer is applied immediately; `reconcileOrders`
  walks every non-terminal order and resolves the venue **per order owner**. If the venue that
  holds an order is not the one routing selects now (the owner switched routing off, changed
  keys, or the order belongs to an account with no testnet key), the order is left alone and
  counted — asking the new venue would answer "no such order", and after the grace window that
  would close a live order as `RECONCILED`. The summary reports both counts
  (`skippedByVenueMismatch`, and rows that could not be routed at all).

**Deliberate non-changes.** Three files the plan lists were not changed, and it is written down here
rather than left to be discovered. `src/lib/orders/state-machine.ts` did not need a line: the
lifecycle already models a partial execution, a cancel that keeps what executed, and a terminal
order that refuses a cancel, which is why the new venue maps onto it rather than extending it —
`reconcile.ts` consumes it exactly as before. `src/lib/integrations/settings.ts` holds the switch
as a validated boolean in the existing closed set (`features.ts` plus one column), and the testnet
*key* stays admin data in `TradingVenueCredential` — encrypted by the phase-20 vault, listed and
revoked on the panel — rather than being written into a settings row, because a secret in a
settings table is a secret in a settings API response. The comment added there states both rules.
`src/app/api/trading/status/route.ts` is a thin uncached read; the venue answer it returns comes
from `src/lib/trading/status.ts` and the registry, and the route only gained the sentence saying
so.

Files touched: `src/lib/venues/{types,registry,testnet-adapter}.ts`,
`src/lib/orders/{venue,process,reconcile}.ts`, `src/app/api/trading/orders/route.ts`,
`src/app/api/trading/orders/[orderId]/cancel/route.ts`, `src/lib/trading/{status,credential-vault}.ts`,
`src/app/api/trading/credentials/route.ts`, `src/lib/integrations/{features,settings}.ts`,
`prisma/schema.prisma` + migration, `src/components/{orders-panel,trading-accounts}.tsx`,
`src/app/trade/page.tsx`, `tests/trading-orders.test.ts` (new), `apps/web/package.json`.

## Gates (exit statuses preserved, final tree)

| gate | status | detail |
| --- | --- | --- |
| `typecheck` | 0 | `tsc --noEmit` |
| `test` | 0 | **551/551**, up from 534 — `tests/trading-orders.test.ts` adds 17 |
| `lint` | 0 | `eslint` |
| `build` | 0 | `next build`; the pre-existing handled Prisma `DATABASE_URL` error is still logged while prerendering risk-policy pages |
| `validate_plan` | 0 | 40 phase files, 0 restriction hits, 0 warnings |
| `routes:sweep` | 0 | **93/93** with the owner session on `:3236` |

Migration: the statement (`BOOLEAN NOT NULL DEFAULT false` on `IntegrationFeatureSettings`) was
verified against the DDL Prisma derives from the schema —
`prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.dev.prisma` prints
`"testnetOrdersEnabled" BOOLEAN NOT NULL DEFAULT false` — and applied to the local SQLite
development database with `pnpm db:setup`, which is where the live readings below come from.
No Postgres is reachable from this machine, so the migration was not executed against one.

## Live evidence (dev server on `:3236`, dev SQLite, owner session)

Every line below is a curl against the running application; the JSON is quoted as received.

| step | request | observed |
| --- | --- | --- |
| A | `GET /api/trading/status` | `200`, `PAPER ORDERS` / `PAPER VENUE`, `{"id":"dev-paper","environment":"paper","testnetRoutingEnabled":false,"available":true}` |
| B | `POST /api/trading/orders` (paper) | `201`, `submitted`, `SUBMITTED`, `venueOrderId paper-36d32bec06c135020d43b7c6` |
| C | `PUT /api/admin/integrations` | `200`, `testnetOrdersEnabled: true` (audited by the existing settings path) |
| D | `GET /api/trading/status` | `TESTNET ORDERS` / `TESTNET VENUE`, `binance-testnet`, `liveExecutionEnabled false`, `testnetExecutionEnabled true` |
| E | `POST /api/trading/orders` with routing on and **no testnet key** | `409` `TESTNET_CREDENTIAL_MISSING`: *"Testnet order routing is switched on, but this account has no Binance Spot Testnet key…"*; order count 4 before and 4 after |
| F | `POST /api/trading/credentials` (`venue: binance-testnet`, invalid key) | `201`, capabilities `balances, orders, orderStatus, cancel, health, place` |
| G | `POST /api/trading/credentials/{id}/verify` | `200` with `health.ok: false`, `latencyMs 2232`, error `binance {"code":-2014,"msg":"API-key format invalid."}` — a real request to `testnet.binance.vision` |
| H | `POST /api/trading/orders` with the testnet key | `502`, `failed`, `attempts 1`, order `FAILED`, `venue binance-testnet`, reason `binance {"code":-2014,"msg":"API-key format invalid."}` |
| I | `GET /api/trading/orders` | list venue `binance-testnet`; the order's `lastAttemptReason` is *"Attempt 1: binance-testnet refused the order. binance {"code":-2014,"msg":"API-key format invalid."}"* |
| J | `POST /api/trading/orders/{failed}/cancel` | `409` *"FAILED is terminal, so it cannot be cancelled."* — the venue was not asked |
| K | `POST /api/trading/orders` with `market: NOTACOIN-USD` | `400` *"Choose a supported Coinbase USD market."* (validation, before the venue — see the limitation below) |
| L | `GET /trade` (HTML) | the order section renders `TESTNET VENUE` and *"orders then go to Binance Spot Testnet"* from the same summary the API answers |
| M | runner pass (`reconcileOrders()` as the runner calls it), routing on, testnet key present | `checked 3, corrected 0, divergences 0, unresolved 3, skippedByVenueMismatch 2` — *"3 open order(s) were not asked of any venue: 2 belong to a venue that order routing no longer selects, 1 could not be routed at all."* |
| N | restore | settings `false`, credential revoked `{"revoked":true}`, status back to `PAPER ORDERS` |

`binance-testnet`'s descriptor is also visible on the credential panel: the saved key's
capability list includes `place` and a live key's does not.

## The five failure scenarios

Four are exercised deterministically through the real adapter with a scripted venue transport
(`tests/trading-orders.test.ts`), which is where the exact observed states below come from; the
fifth (a venue that is unreachable) is additionally measured live in step H, because a bad key
produces exactly that shape of answer from the venue.

| scenario | how it is produced | observed state and record |
| --- | --- | --- |
| rejected order | venue throws `InvalidOrder` / `BadRequest` (`LOT_SIZE`, `-1100`) | order `FAILED`, `attempts 1`, attempt row `rejected` + `ORDER_REJECTED`, provider response holds `code`, the venue's message and the request (`symbol BTC/USDT`) |
| venue timeout | `RequestTimeout` on submit | the order is **looked up by client order id**, not resent: submit `201` `submitted`, `venueOrderId` learned from the lookup, `attempts 1`; a repeat submission is a replay, and the next reconcile pass applies the venue's state |
| invalid pair | `BadSymbol` from the venue; and a market that cannot be mapped (`BTC-USDT`) | `FAILED` with the venue's message; the unmappable market is rejected as `INVALID_PAIR` **without any venue call** (the transport's create count stays at 1 for `BTC-USD`) |
| insufficient venue balance | `InsufficientFunds` | `FAILED`, attempt `rejected`, code `INSUFFICIENT_VENUE_BALANCE`, the venue's sentence recorded |
| cancel after fill | cancel refused (`InvalidOrder`) and re-read returns `FILLED` | `409` refused, order `FILLED`, `filledQuantity 0.01`; a second cancel is refused by the state machine with the venue never contacted (`cancelOrder` calls stay at 1) |

Partial fill and cancel semantics are their own test: the venue reports
`PARTIALLY_FILLED 0.005` of `0.01`, reconciliation applies `PARTIAL_FILL`; the cancel then
returns `CANCELED 0.005`, `process.ts` applies the execution **before** the cancel, and the
result is `CANCELLED` with `filledQuantity 0.005`, `remainingQuantity 0.005` and a `CANCEL`
transition carrying the executed quantity. A second reconciliation changes nothing.

`no live path` is asserted four ways: live descriptors have no `place`; `createVenue("binance")`
returns an object with no `submit`/`lookup`; `orderPlacementRefusal("binance")` names it as a
live venue; and `resolveOrderVenue` refuses a credential whose venue is not a testnet even with
routing switched on.

## Defects found while verifying, and fixed

1. **The venue rejected our client order id.** The first live submission (before the fix) was
   answered `-1100 Illegal characters found in parameter 'newClientOrderId'; legal range is
   '^[a-zA-Z0-9-_]{1,36}$'` — the phase-06 idempotency key is longer than 36 characters and may
   contain `.`/`:`. The adapter now owns the translation (`testnetClientOrderId`) and records
   both spellings in the request, while the lookup uses the same function so the two cannot
   drift. Re-measured: the next live order was answered by the venue's auth error instead, with
   `attempts 1`.
2. **A definitive refusal was retried three times.** The same run showed `BadRequest` (ccxt's
   class for `-1100`) classified as "no definitive answer", so the phase-06 retry policy tried
   it three times and the order's `lastAttemptReason` read *"did not answer definitively"* about
   an answer the venue had given clearly. The classification table now treats `BadRequest`,
   `ArgumentsRequired` and generic `ExchangeError` as definitive (`ORDER_REJECTED` /
   `VENUE_REFUSED`) and reserves retries for transport failures. Re-measured live: `attempts 1`.
3. **A cancel could name another account's order.** `cancelOrder` loads by id, and phase 21 made
   the cancel route resolve the venue from the *order's* owner — which is only correct if the
   caller is that owner. The route now checks ownership and answers `404` (the same sentence a
   credential uses, so an id that is not yours is not confirmed to exist). The route sweep shows
   the new refusal on an unknown id.

## What this run could not measure

- **No funded testnet key, so no live fill.** A real Binance Spot Testnet key would have placed
  a market order and let it fill; with a deliberately invalid key the only live answer possible
  is the venue's refusal. The lifecycle, partial fill, cancel-after-partial-fill and the five
  failure scenarios are therefore proven by the deterministic tests, not by a live fill. The
  owner click-path for that reading is: save a real testnet key, switch testnet routing on,
  place a market order on `/trade`, watch `SUBMITTED → PARTIALLY_FILLED → FILLED`, then cancel a
  partially filled one and confirm the executed part stays as a trade.
- **The invalid pair cannot be produced through the HTTP route.** `validateOrderSubmission`
  accepts only the ten curated `USD_WATCHLIST` markets, and all ten exist on the testnet — checked
  against `GET https://testnet.binance.vision/api/v3/exchangeInfo`, which listed `BTCUSDT`,
  `ETHUSDT`, `XRPUSDT`, `SOLUSDT`, `DOGEUSDT`, `ADAUSDT`, `AVAXUSDT`, `LINKUSDT`, `LTCUSDT` and
  `BCHUSDT` among 1373 symbols. So the route's invalid-pair evidence is its validation refusal
  (`400`), and the venue-answered `BadSymbol` reading is the scripted one. Widening the market
  list is not this phase's job.
- **`USD` is mapped onto `USDT`.** The intent names a Coinbase product (`BTC-USD`); the testnet
  only quotes `BTC/USDT`. `testnetSymbolFor` states the mapping once and refuses anything it
  cannot map. A testnet fill proves the lifecycle, not price parity — phase 22's comparison should
  treat this as a stated difference, not evidence of equivalence.
- **Only one venue has a sandbox here.** Binance is the venue whose CCXT client supports
  `setSandboxMode`; Kraken has no testnet and Coinbase Advanced's sandbox is not configured in
  this build, so `TESTNET_VENUE_IDS` is one entry and adding another is a descriptor plus an
  adapter branch.
- **The testnet credential used for the evidence was revoked and routing switched back off**, so
  the environment is where it started (`PAPER ORDERS`, `dev-paper`). The dev database keeps the
  orders the run created (two failed testnet orders, two open paper orders, one terminal paper
  order from an earlier phase) — they are the record, not fixtures.
- **A second account's orders could not be reconciled while routing was on**, because that
  account had no testnet key: the pass refused to route it and reported it as unroutable. That is
  the intended fail-closed behaviour, measured rather than assumed.

## Rollback

Revert this phase's commit and run the migration's `DROP COLUMN`; orders fall back to the paper
venue and no money has moved at any point in the phase.
