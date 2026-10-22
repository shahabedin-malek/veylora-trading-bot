# Phase 22 — live execution behind the owner's switch (proof record)

What was built, what was measured on the running application, and the one step this record
deliberately leaves to the owner. No credential, cookie, session value or key material appears
here: the session was minted as a real `AuthSession` row with the throwaway secret the previous
phase left in `/tmp/phase22/`, and the driver scripts live outside the repository.

**The switch is left off.** It was turned on for the length of one measurement and turned back
off by the same call path the panel uses; `GET /api/trading/status` and `/admin/risk` both read
`liveExecutionEnabled: false` at the end of the run.

## What the path is

Phase 21 built the testnet as a *venue*. Phase 22 adds its other endpoint and the one thing that
decides whether it may be used — an owner-owned boolean, stored as data.

- **The switch is a column, not a gate in code.** `RiskPolicySettings.liveExecutionEnabled`
  (migration `20261018090000_live_execution_switch`), default `false`, edited on `/admin/risk`
  beside the limits, carried through the same validated `PUT /api/admin/risk-policy` that already
  saved the policy. It is **required** rather than defaulted in `validateRiskPolicyUpdate`, so a
  save that omits it is refused instead of quietly turning real-money execution off (or on) —
  and the same row records `liveExecutionChangedByUserId` / `liveExecutionChangedAt`.
- **Two audit rows per flip, not one.** Every save writes the usual `RISK_POLICY_UPDATED` with
  the before/after policy, and — only when the switch actually moved — a dedicated
  `LIVE_EXECUTION_ENABLED` / `LIVE_EXECUTION_DISABLED` row carrying
  `{switch, from, to, changedAt}`. "Who turned real-money execution on, and when" is answerable
  without reading a diff blob.
- **Selection, not approval.** `orderPlacementRefusal(id, settings)` in
  `venues/registry.ts` returns `null` for a live venue **only** when the switch is on. With it
  off the live venue is simply not selected and the refusal names the switch, its state and the
  panel that edits it. When it is on there is no further question: no consent screen, no
  confirmation step, no dry-run stop, no environment variable — the plan's "Do not do" list is
  honoured by construction, because the only thing between a live order and the exchange is the
  boolean the owner set.
- **`venues/live-adapter.ts`** is Binance's real endpoint behind the same `OrderVenuePort` the
  testnet implements: the same `BTC-USD` → `BTC/USDT` mapping, the same client-order-id
  translation, the same error classifier, the same lifecycle. What it *refuses* is the sandbox:
  `assertLiveEndpoints` rejects a client whose API hosts are `testnet.binance.vision` /
  `testnet.binancefuture.com`, so a venue reported as live cannot be a simulation. It
  deliberately does **not** gate a live order — no balance, health or risk evaluation stands
  between `submit` and the exchange.
- **`orders/preflight.ts` reports and never refuses.** Three checks — credential verified,
  venue balance against what the order needs, open notional against the configured exposure
  percentage — each produce a sentence or an "could not be evaluated" reading. There is no
  `refuse` branch in the module. The report travels in the order response (`preflight`) and into
  the audit trail; the venue's own answer is what decides.
- **A dry comparison, as a report.** `GET /api/trading/orders/comparison?market=…` answers what
  the testnet configuration would have been asked for the same market, and says so: *"A
  comparison only: nothing was decrypted, no venue was contacted and no order was placed."* It
  is displayed in the order panel beside the answer and on demand, and it is never a step in the
  live path.
- **Reconciliation is unchanged and unblocked.** `resolveVenueForOrder` resolves the venue that
  holds an order with `permitLivePlacement`, so turning the switch off does not turn an open
  live order's reconciliation into a refusal: the order finishes at the venue and is recorded.

## What the running application measured

A `next dev` server on `:3236` against the development database, an owner session, and
`/tmp/phase22/run.sh` + `run2.sh` driving the real routes. Every reading below is HTTP, not a
unit test.

| Step | What was sent | What came back |
| --- | --- | --- |
| Status, switch off | `GET /api/trading/status` | `PAPER ORDERS` / `PAPER VENUE` / `liveExecutionEnabled: false` |
| Policy, before | `GET /api/admin/risk-policy` | `liveExecutionEnabled: false`, `liveExecutionChangedByUserId: null` |
| Live attempt, switch **off** | `POST /api/trading/orders` with `execution: "live"` | `403 LIVE_EXECUTION_DISABLED`, `switch: {name: "liveExecutionEnabled", state: false, panel: "/admin/risk"}`, `order: null` — **order count unchanged** |
| Switch on | `PUT /api/admin/risk-policy` | `200`, `liveExecutionEnabled: true`, changed by `dev-owner-user` at `2026-10-18T03:22:50.611Z` |
| Status, switch on | `GET /api/trading/status` | `LIVE ORDERS` / `LIVE VENUE`; venue `binance`, `environment: live`, `paper: false`, `liveExecutionEnabled: true`, `testnetExecutionEnabled: false` |
| Live attempt, switch **on** | `POST /api/trading/orders` with `execution: "live"` | `409 READ_ONLY_CREDENTIAL` — *"The Binance key \"Binance read-only\" is stored as read-only, so it cannot place an order…"* — the live path was **reached** and the account's own key was the thing that could not place, before a row existed |
| Switch off | `PUT /api/admin/risk-policy` | `200`, `liveExecutionEnabled: false`, changed at `2026-10-18T03:22:51.250Z` |
| Status, restored | `GET /api/trading/status` | `PAPER ORDERS`, `liveExecutionEnabled: false` |
| Dry comparison | `GET /api/trading/orders/comparison?market=BTC-USD` | `200`: mappedPair `BTC/USDT`, `testnetKeyLabel: null`, `wouldPlaceOnTestnet: false`, *"…this account has no testnet key, so it would be refused there."* — nothing decrypted, no venue contacted |
| Dry comparison, no market | `GET /api/trading/orders/comparison` | `400 "market must be an uppercase BASE-QUOTE product id…"` |

The audit trail carried all three acts, with actor and time:

```
LIVE_EXECUTION_ENABLED   SUCCESS  dev-owner-user  {"switch":"liveExecutionEnabled","from":false,"to":true,"changedAt":"2026-10-18T03:22:50.611Z"}
RISK_POLICY_UPDATED      SUCCESS  dev-owner-user  {"policyVersion":"veylora-risk-v1","before":{…},"after":{… "liveExecutionEnabled":true}}
ORDER_BLOCKED_BY_SWITCH  REFUSED  dev-owner-user  {"code":"LIVE_EXECUTION_DISABLED","requested":"live","switch":"liveExecutionEnabled","state":false}
LIVE_EXECUTION_DISABLED  SUCCESS  dev-owner-user  {"switch":"liveExecutionEnabled","from":true,"to":false,"changedAt":"2026-10-18T03:22:51.250Z"}
```

The two owner-facing surfaces agreed with the data, read as server HTML:

- `/admin/risk` rendered `LIVE ORDERS OFF`, the sentence `REAL-MONEY EXECUTION IS OFF`, and
  `Last changed by 0x1111…1111 at 2026-10-18T03:22:51.250Z, recorded in the audit trail on every change.`
- `/trade` rendered `PAPER VENUE` with the registry's own detail: *"Orders go to the development
  paper venue. No exchange is contacted and no real funds move. Switch testnet routing on in
  Access & Integrations, or live execution in /admin/risk, to place elsewhere."*

Route sweep with the owner session: **94 passed · 0 not swept · 0 failed (of 94)**, including the
new `GET /api/trading/orders/comparison` row.

## What the tests prove, and what only the owner can

`tests/live-execution.test.ts` (13 tests) drives the **production** `createLiveVenue` through a
scripted transport — the script stands in for Binance's server, not for our code:

- the live descriptor carries `environment: live` and `place`, and a real key is refused by the
  sandbox guard but not by the production guard;
- with the switch off a live request is refused **by name** and no key is read (the credential
  reader is never called);
- with the switch on routing selects the live venue and reports it with its key;
- an order that is already open resolves to its own venue **even with the switch off**;
- a live order is submitted with the venue's own spelling of our client id, and both halves of
  the exchange (request and response) are recorded on the attempt;
- the venue's refusal is recorded once, in the venue's own words, and the order fails;
- a timeout is not a refusal: the venue is asked whether it holds the order;
- turning the switch off mid-flight lets an open live order reconcile and cancel;
- the pre-trade report notices everything and stops nothing (a short balance, a failing key, an
  unreachable balance read and exposure above the limit all appear; the order is still sent);
- the dry comparison says what the testnet would have been asked and places nothing;
- the routing summary reports all three environments and admits when the switches cannot be read;
- the status surface says live from the switch, not from a constant;
- a submission may name the venue it wants, and only the four known words.

**The owner's own first live order has not been placed, and cannot be by this run.** Phase 22's
requirement 6 puts that act in the owner's hands, and it needs two things this machine does not
have: funds at a venue and a trade-capable key for them. The account here holds
`Binance read-only`, which the live path refused by name — evidence that the path is reachable
and that the refusal is the key's, not an agent's. Steps 2–4 of the plan's click-path (a small
real order reaching a terminal state, `/account` and the audit trail showing it, and the venue's
own rejection of an order it cannot fund) are therefore **open**, with the switch left off so
nothing can move while they are.

## Gates on the final tree

```
typecheck=0   test=0 (565/565, up from 551)   lint=0   build=0
plan=0        (40 phase files, 0 restriction hits)
routes:sweep  94/94 with the owner session on :3236
```

`pnpm exec next typegen` is required before `typecheck` (the route's `RouteContext` types), and
`prisma generate` after the migration, exactly as the last two phases recorded.

## Limits this record carries

- No real-money order was placed (above). Nothing in the live adapter was exercised against
  Binance's production endpoint; its guards, mapping, classifier and lifecycle were exercised
  through the same code with a scripted transport.
- The dev database is SQLite. The migration was applied to it by `scripts/dev-database.mjs`; real
  Postgres is still unreachable from this machine, so `prisma migrate deploy` has not run.
- The switch's database half (who, when, the audit rows) is proved on the running application, as
  the test file's own docblock says it must be: a unit test can prove the behaviour that reads the
  switch, not the row.
- The browser was not driven this time: `/admin/risk` and `/trade` were read as server HTML with
  the owner's cookie, and the panel's client-only surfaces (the pre-trade notices, the on-demand
  comparison) are covered by the API readings above and by the shared component's own logic.

## Deliberate non-changes

Two files the plan lists were not changed, and it is recorded here rather than left to be
discovered:

- `src/app/api/admin/risk-policy/route.ts` already reads and writes the whole policy through
  `getRiskPolicySettings` / `saveRiskPolicySettings` / `validateRiskPolicyUpdate`, so the switch
  travelled through it without a line changing — which is the property that matters: the panel's
  `PUT` is the same route, the same permission (`risk.policy.manage`), the same same-origin check
  and the same audit write as the limits beside it. No second endpoint exists that could enable
  real money.
- `src/lib/orders/state-machine.ts` did not need a line either: the lifecycle already has the
  states a real fill produces (`SUBMITTED`, `PARTIALLY_FILLED`, `FILLED`, `CANCELLED`, `FAILED`),
  and the live adapter maps onto them exactly as the testnet adapter does. A live order needs no
  new state to be honest about.

## Files touched

`prisma/schema.prisma` + `migrations/20261018090000_live_execution_switch`,
`src/lib/risk-controls/{settings,policy}.ts`, `src/app/admin/risk/{page,risk-policy-form}.tsx`,
`src/lib/venues/{types,registry,binance-shared,live-adapter,testnet-adapter}.ts`,
`src/lib/orders/{venue,preflight,process,reconcile,api}.ts`,
`src/app/api/trading/orders/route.ts`, `src/app/api/trading/orders/comparison/route.ts`,
`src/app/api/trading/status/route.ts`, `src/lib/trading/status.ts`,
`src/lib/integrations/features.ts`, `src/components/orders-panel.tsx`, `src/app/page.tsx`,
`src/app/trade/page.tsx`, `scripts/route-sweep.{mjs,test.mjs}`,
`tests/{live-execution,risk-controls,trading-orders}.test.ts`.
