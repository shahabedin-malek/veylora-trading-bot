# Phase 06 — order and process state machine: what was run, and what it showed

Recorded on 2026-10-15 against the working tree, with the development server, the local SQLite
database (`apps/web/prisma/dev.db`) and the development paper venue. No credentials, session
values or key material appear here; the sessions used were minted for the seeded local accounts
with the application's own cookie format (`src/lib/auth/session-token.ts`) and a throwaway
secret.

## What the phase added

| file | role |
| --- | --- |
| `apps/web/src/lib/orders/state-machine.ts` | the status set, the legal transition table, the refusal shape, and a sentence for every status |
| `apps/web/src/lib/orders/idempotency.ts` | a key derived from the canonical intent, and the conflict rule |
| `apps/web/src/lib/orders/retry.ts` | the bounded backoff policy and the attempt record |
| `apps/web/src/lib/orders/reconcile.ts` | the venue-is-truth pass, and the divergence record |
| `apps/web/src/lib/orders/process.ts`, `store.ts`, `venue.ts`, `api.ts` | the port (`OrderVenuePort`), the durable rows, the development paper venue, the request/response contract |
| `apps/web/src/app/api/trading/orders/route.ts`, `[orderId]/cancel/route.ts` | the submission and cancel endpoints |
| `apps/web/src/components/orders-panel.tsx` | the panel on `/trade`: submit, watch, cancel, and every status explained |
| `apps/web/prisma/schema.prisma` + `migrations/20261015180000_order_lifecycle_and_idempotency` | the lifecycle columns, the idempotency key, the attempt record |
| `apps/web/src/lib/runner/registry.ts` | the `order-reconciliation` job |

`src/lib/bot-builder/state-machine.ts` returns the same refusal shape for strategy transitions,
and `src/app/api/trading/status/route.ts` reports the lifecycle, the retry policy and the
reconciliation cadence alongside the rest of the trading status.

## Automated gates (verbatim results)

| gate | command (from `apps/web`) | result |
| --- | --- | --- |
| typecheck | `pnpm --config.verify-deps-before-run=false typecheck` | exit 0 |
| test | `pnpm --config.verify-deps-before-run=false test` | exit 0 — `tests 271 / pass 271 / fail 0 / skipped 0` |
| lint | `pnpm --config.verify-deps-before-run=false lint` | exit 0 |
| build | `pnpm --config.verify-deps-before-run=false build` | exit 0 — 14 page routes, 30 API routes, 39 prerendered pages |
| plan | `node scripts/validate_plan.mjs` | exit 0 — 40 phase files, 0 restriction hits, 0 warnings |
| routes:sweep | `ROUTE_SWEEP_COOKIE=… pnpm routes:sweep -- --base-url http://localhost:3130` | exit 0 — `60 passed · 0 not swept · 0 failed (of 60)` |

The six test files this phase added — `state-machine`, `idempotency`, `api`, `process` and
`reconcile` under `src/lib/orders/`, plus `src/app/api/trading/orders/route.test.ts` — report
`tests 52 / pass 52 / fail 0` on their own; the rest of the rise is the lifecycle assertions
added to `tests/trading-status.test.ts` and `src/lib/bot-builder/state-machine.test.ts`.

The swept rows for the new surface, in the owner-session run:

```
GET /api/trading/orders                          200  pass  1645B {orders,count,lifecycle,venue}
POST /api/trading/orders                         400  pass    51B "Choose a supported Coinbase USD market."
POST /api/trading/orders/[orderId]/cancel        404  pass   231B {outcome,attempts,idempotencyKey,reason}
```

## Manual verification (owner click-path), as run

Development server on `http://localhost:3130` with `AUTH_EVM_CHAIN_IDS=1`, `APP_BASE_URL`,
`SESSION_SECRET`, `CRON_SECRET`, `PAPER_VENUE_FILL_DELAY_SECONDS=0`, and a seeded owner session
set in the browser. The runner was called the way the host calls it:
`GET /api/cron/all?jobs=order-reconciliation` with `Authorization: Bearer $CRON_SECRET`.

### 1. Submit, and watch the status reach a terminal state on `/trade`

The order panel submitted `BTC-USD · BUY · MARKET · 0.001`:

```
SUBMITTED — dev-paper accepted the order as paper-d7ea34bd00c7dfdb30373dc0, and it is SUBMITTED.
row: BTC-USD · BUY · MARKET | SUBMITTED | requested 0.001 | executed 0 | still live 0.001 | attempts 1
```

The next reconciliation pass reported the venue's fill, and the panel's Refresh showed:

```
heartbeat: worked | 2 open order(s) were checked: 1 corrected, 1 disagreed with the venue, 1 left alone.
row: BTC-USD · BUY · MARKET | FILLED | requested 0.001 | executed 0.001 | still live 0 | attempts 1
detail: The whole order executed. Nothing further happens to it.
```

### 2. The same order submitted twice returns the first order

The panel's **Send the same order again** re-sent the identical body with the identical key:

```
notice: The same order was sent again with the same key (replayed). This exact intent was
        already submitted, so the original order was returned instead of a second one being placed.
state:  8 ORDER(S) · PAPER VENUE        (8 before the resend, 8 after)
venue order id on the row: paper-d7ea34bd00c7dfdb30373dc0 — the same one
```

The API-level form of the same check, from the earlier run of this click-path:

```
POST (identical) -> 200  outcome=replayed  sameOrderIdAsFirst=true  sameKeyDerivedFromIntent=true
order count before/after: 7 -> 7
```

And a key reused for a *different* intent is refused rather than replayed:

```
POST (same explicit key, different quantity) -> outcome=refused  reason=IDEMPOTENCY_KEY_REUSED  status=409
```

### 3. A hand-edited local state is corrected, and both values are recorded

The local row was set to `SUBMITTED` / `0` with the venue order id above — the venue still held
a collected fill — and the job's next-due time was moved into the past:

```
hand-edited: FILLED 0.001 -> SUBMITTED 0 | next pass due at 2026-10-15T17:48:08.167Z
heartbeat: worked | 2 open order(s) were checked: 1 corrected, 1 disagreed with the venue, 1 left alone.
detail: {"checked":2,"corrected":1,"divergences":1,"unresolved":1,"changedOrderIds":"cmv9u0qhg0003n9zr58zps6c7"}
local row after the pass: FILLED | executed 0.001
```

The audit chain for that order, newest last:

```
17:48:00  ORDER_CREATED          actor=dev-test-account -->CREATED
            reason: The order intent was submitted from the trading page.
17:48:00  ORDER_SUBMITTED        actor=dev-test-account CREATED->SUBMITTED
            reason: Attempt 1 of 3 was sent to dev-paper.
17:48:00  ORDER_ATTEMPT          actor=dev-test-account -->-
            reason: Attempt 1: dev-paper accepted the order.
17:48:16  ORDER_FILLED           actor=system SUBMITTED->FILLED
            reason: The venue reports 0.001 executed while the local record held 0. The paper
                    venue reports the order complete.
17:48:16  ORDER_RECONCILIATION   actor=system -->-
            reason: The venue's record disagrees with the local row on filledQuantity; both
                    values were recorded and the local state was corrected where the lifecycle allows it.
            divergences: [{"field":"filledQuantity","local":"0","venue":"0.001",
                           "venueState":"FILLED","recordedAt":"2026-10-15T17:48:16.076Z"}]
17:49:15  ORDER_FILLED           actor=system SUBMITTED->FILLED   (the second forced pass)
17:49:15  ORDER_RECONCILIATION   actor=system -->-               (again, with both values)
```

### 4. Failure case: the venue cannot be reached

The server was restarted with `PAPER_VENUE_FAILURE=unavailable` (the same session stayed valid)
and an order was submitted from the panel:

```
notice:  FAILED — The paper venue is set to refuse connections (PAPER_VENUE_FAILURE=unavailable),
         so attempt 3 reached nothing.
reason:  VENUE_UNAVAILABLE + that sentence
row:     BTC-USD · BUY · MARKET | FAILED | requested 25 | executed 0 | still live 25 | attempts 3
browser error banner: none        the page rendered; nothing crashed
```

### Extra, beyond the four steps

| check | how | result |
| --- | --- | --- |
| a resting limit order cancels and keeps the unexecuted part | `POST /api/trading/orders/{id}/cancel` on a `LIMIT` order at a price it cannot reach | `CANCELLED`, `filled 0`, `remaining 0.5` released, reason "Requested 0.5, filled 0, cancelled 0.5 unexecuted." |
| the same cancel twice is the same cancel | the identical cancel again | `replayed` — "This cancel was already applied, so its original result was returned." |
| cancelling a terminal order is refused | cancel a `FILLED` order | `refused`, `ORDER_REJECTED` — "FILLED is terminal, so it cannot be cancelled." |
| the panel is not shown to a visitor | `GET /trade` with and without the session | owner: the orders section and the panel render; visitor: no panel, a sign-in link instead |

## Limitations this record carries

1. **The venue is paper.** Every result above is against `dev-paper`; its failures are injected
   with `PAPER_VENUE_FAILURE`. A real venue arrives with phases 20–21.
2. **The divergence in step 3 was produced by editing the local row.** That is the only way to
   make a paper venue hold a truth the local row lacks, and it is what "force a reconciliation"
   means here.
3. **The unconfigured sweep reading could not be re-measured today.** `next dev` aborted with an
   internal Turbopack panic (`task TaskId … is missing in memory or persistent storage`) partway
   through the second sweep run, after which every remaining row failed with `no-response —
   fetch failed`. That is a Next.js/Turbopack bug, not an application failure: the same rows
   passed in the configured owner-session run minutes earlier. The configured reading
   (`60 passed · 0 not swept · 0 failed`) is the measured one; the unconfigured reading in
   `apps/web/README.md` still rests on the earlier measurement.
4. **The seeded order rows are display-only.** `prisma/seed.ts` writes three unsubmitted order
   records with their audit events so `/trade` is not empty on a fresh clone; they are marked
   `dev-` and are not claims about a venue.
