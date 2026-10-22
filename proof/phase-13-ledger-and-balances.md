# Phase 13 — Ledger and balances: what was built, and what was measured

One ledger of record. Every figure a person sees is a sum of stored entries; every movement
has two sides in the same asset's minor units; every invariant that would make losing money
silent is checked against the stored rows, on the runner's cadence and on the health surface.

- **Objective (phase file):** integer-minor-unit, double-entry, auditable, with invariants
  that make losing money impossible to do silently, plus balance history and statements.
- **Status:** all four gates and the route sweep pass on the working tree; the deposit journey
  credits through the ledger, the statement and its export reconcile, a reversal compensates
  instead of editing, and a deliberately corrupted entry is caught loudly at three levels.
- **Not done, deliberately:** no automatic un-crediting of a deposit whose credited block later
  reorgs (the mechanism exists — `reverseDepositCredit` — but the reconciliation that would call
  it is phase 14 work); no fees or withdrawals (phases 14 and 16); no Postgres run of the
  migration (this machine cannot reach Postgres — see "Boundary").

## The shape of it

**`src/lib/ledger/integer-cent-ledger.ts`** holds the money and the writer. An amount is a
`MinorUnits` string of digits; every operation runs on `bigint`; `parseMinorUnits` is the single
door a value enters by, and it refuses `10.5`, `1e6`, `0x10`, `""`, `-5` and `2**53` with a typed
`LedgerAmountError` that names the offending value. `postLedgerTransaction` is the writer:
it resolves every account a posting names, refuses a transaction that does not balance, checks the
idempotency key, and inserts the transaction with its legs in one database transaction — so a
transaction row is never observable without the entries that make it balanced. A reversal is
`reversingPostings`: the same legs, each direction flipped, as a *new* transaction that references
the original.

**`accounts.ts`** is the taxonomy as data: four buckets, each owned by exactly one owner type with
exactly one normal side, and the derivation (`deriveBalances`) that turns entries into a balance on
that side. Balances are never stored. A user account is issued on first use; the platform's
`TREASURY`, `DEPOSITS_PENDING` and `FEES` accounts are issued alongside it, so every movement has a
nameable counterparty before the first movement that needs one.

**`statements.ts`** builds the statement from rows and nothing else: `opening + net === closing`
holds because all three come from the same function over different cuts of the same entries, and
every line names the accounts on the other side of its own transaction. The CSV is rendered from
the lines on screen, so "the export matches the screen" is a property of one array.

**`invariants.ts`** checks four claims against the stored book — every transaction balances, the
ledger balances per asset, no entry is orphaned, no account holder is overdrawn without an explicit
credit line — and sums in this process rather than in SQL, because a `SUM` over a text column is
exact on one engine and a float on another. `assertLedgerInvariants` is the throwing form the
runner uses (`runner/registry.ts`, `ledger-invariants`, hourly); `readLedgerHealth` is the form the
health surface reads.

**`deposits/credit.ts`** is where phase 12 meets phase 13: a credit is no longer only a durable
record that money arrived, it is a balanced movement — `DEBIT platform:treasury:<asset>` /
`CREDIT user:<userId>:<asset>:available` — posted in the same database transaction as the claim
that flips the deposit row to `CREDITED`, under the deposit's own key (`deposit:<id>:credit`).

## The acceptance criteria, and where each one is proven

| Criterion | Where it is proven |
| --- | --- |
| A balanced transaction is accepted; an unbalanced one is rejected by the writer | `tests/ledger.test.ts` — "a balanced transaction posts, with the accounts' own asset and scale on every leg" and "an unbalanced transaction is refused before anything is written" (which asserts the store is untouched, so the refusal is measured and not just returned) |
| An attempted fractional amount is rejected with a specific error | `tests/ledger.test.ts` — "an amount is an exact integer of minor units and a fractional one is refused" (`code: NOT_INTEGER`, with the offending value in the message) and "a fractional amount cannot enter the ledger at all"; `tests/ledger-deposits.test.ts` — "an amount that cannot be read exactly is named as such, both above and inside the writer" |
| The invariant check passes after the phase-12 deposit journey | click-path step 4 and step 8 above (`reachable`, all four invariants reported), and `tests/ledger-deposits.test.ts` |
| …and fails loudly when a test deliberately corrupts an entry | `tests/ledger.test.ts` — "a corrupted entry fails the check loudly, naming the row rather than reporting a healthy book" and "an entry that belongs to nothing is an orphan, and an overdrawn holder needs a credit line"; the live corruption section above, at both the health row and the runner job |
| A statement for a date range matches the sum of its entries exactly | `tests/ledger.test.ts` — "a statement names every movement with its counterparty, and its total is the sum of its own lines" and "a range that excludes the movements is empty, while the closing figure still reconciles"; click-path step 5 (the `TOTAL` row equals the sum of the lines) |
| Balances derived, never a mutable field | there is no balance column to write: `deriveBalances` is the only arithmetic, and the panel, the statement, the invariant check and the health signal all read through it |
| Reversals are compensating entries; nothing is edited or deleted | `reversingPostings` + `reverseDepositCredit`, `tests/ledger-deposits.test.ts` — "reversing a deposit compensates it…" and "a reversal is refused when there is nothing to reverse, when it already happened, and when the deposit is not yours"; click-path steps 6 and 7 |
| Statements list every entry with transaction id, timestamp, amount, asset and counterparty, filterable and exportable | click-path steps 4 and 5; `statementToCsv` renders the on-screen lines, so the two cannot disagree |

## Schema and migration

`LedgerAccount`, `LedgerTransaction`, `LedgerEntry` join `prisma/schema.prisma`, and
`prisma/migrations/20261016190000_ledger_and_balances/migration.sql` is the Postgres form: the three
tables, their indexes (unique `code`; unique `(userId, asset, bucket)`; unique
`(transactionId, sequence)`; unique `idempotencyKey`) and their four foreign keys.

The migration was compared **statement for statement** with the DDL Prisma derives from the schema
(`prisma migrate diff --from-empty --to-schema-datamodel`), because Prisma's own diff for a Postgres
migrations directory needs a shadow database this machine does not have:

```
schema statements:    18
migration statements: 18
IDENTICAL: the migration and the schema agree, statement for statement.
```

## Gates on the working tree

```
typecheck=0
test=0      (417/417, up from 386 at the end of phase 12)
lint=0
build=0
plan=0      (40 phase files, index entries 40, 0 restriction hits, 0 warnings)
```

`routes:sweep` against the click-path server, with a real owner session:

```
75 passed · 0 not swept · 0 failed (of 75)
  GET  /api/admin/health  200  125ms  pass  {reason,database,runner,ledger}
  GET  /api/ledger        200  157ms  pass  {balances,platform,statement,ledger}
  POST /api/ledger        400   38ms  pass  "The ledger accepts one action: reverse-deposit, with the id "
```

The new unit and integration suites are `tests/ledger.test.ts`, `tests/ledger-deposits.test.ts`,
`tests/support/in-memory-ledger-store.ts`, `src/app/api/ledger/route.test.ts`, plus the ledger job's
failure-is-a-failed-run case in `tests/runner-scheduler.test.ts`. The store the tests run against is
the in-memory one behind the same `LedgerStore` interface the database implements, so the arithmetic
and the refusals are exercised without a database and the Prisma half is a thin, checked translation.

## The click-path, as measured

The app on `http://localhost:3221`, on SQLite `prisma/dev.db`, sign-in configured for chain 1, one
deposit network enabled (`ethereum-mainnet`, 2 confirmations, the real USDT contract at 6 decimals),
and `ALCHEMY_ETHEREUM_MAINNET_RPC_URL` pointing at a local HTTPS stand-in that describes this chain:

```
head 100
block  99   txA   20 USDT   to our address   → 2 confirmations → CREDITED
block 100   txB    3 USDT   to our address   → 1 confirmation  → PENDING
```

A session was minted through the app's own `createSessionCookieValue` and written as a real
`AuthSession` row, so every request below was authorised by the production rule. The driver
(`/tmp/phase13/clickpath.mjs`) made only requests a browser makes, and every criterion is asserted
rather than eyeballed.

1. **`GET /api/deposits`** — 200, and it **issued** the address
   `0x212933ca0A32372bc3eC79f15Af9131D2944fDC2` (`issuance.created` one entry, `existing` empty).
2. **`POST /api/deposits`** (the run the scheduler makes) —
   `{recorded: 2, credited: 1, awaiting: 1, reverted: 0, duplicates: 0}`. The credited row is
   20 USDT; the pending row is 3 USDT at 1 of 2 confirmations.
3. **The same run again** — `{recorded: 0, credited: 0, awaiting: 1}`, and still exactly one
   credited row. The replay criterion, measured at HTTP level.
4. **`GET /api/ledger`** — the balance the panel shows is the sum of the entries, and its
   counterparty holds the other side:

   ```
   balances [USDT available 20 (1 entries)]
   platform [USDT deposits pending 0 · USDT fees 0 · USDT treasury 20]
   ledger   reachable — Every invariant holds: 2 entr(ies) across 1 transaction(s) and 4 account(s)
   statement 1 line: 2026-10-16T18:36:39.409Z 20 USDT CREDIT of USDT available from USDT treasury
   ```

   Filtering to **today** (`from=2026-10-16&to=2026-10-16`) returns that one line with its
   transaction id `cmvbb75la000qn97ra5rx4bmz`; a range the movement is not in returns none.
5. **`GET /api/ledger?format=csv`** — `text/csv` as an attachment, built from the lines above:

   ```
   occurredAt,transactionId,kind,asset,amount,direction,account,counterparty,source,memo
   2026-10-16T18:36:39.409Z,cmvbb75la000qn97ra5rx4bmz,DEPOSIT_CREDITED,USDT,20,CREDIT,user:dev-owner-user:USDT:available,platform:treasury:USDT,cmvbb75e20009n97r2ccqbj3w,USDT deposit 0xa1a1…a1#0 on ethereum-mainnet
   2026-10-16T18:36:42.689Z,,TOTAL,USDT,20,,,,,"in 20, out 0, opening 0, closing 20"
   ```

   The `TOTAL` row's `20` is the figure the screen showed.
6. **`POST /api/ledger {action:"reverse-deposit"}`** — 200, `reversed: true`, a compensating
   transaction, and the balance back to `0` in the same response. A **second** attempt on the same
   deposit is refused with 409 (`… was already reversed at …, so it was not reversed again`), which
   is what stops a second compensation from minting a negative balance.
7. **`GET /api/ledger` again** — the ledger now reads:

   ```
   2026-10-16T18:23:56.683Z DEPOSIT_CREDITED 20 USDT CREDIT on USDT available (tx cmvbaqspo000qn9l3fuc9r4zp)
   2026-10-16T18:23:57.700Z DEPOSIT_REVERSED -20 USDT DEBIT on USDT available (tx cmvbaqtci0011n9l3jlshv8cp, reversing cmvbaqspo000qn9l3fuc9r4zp)
   totals [{asset: USDT, in: 20, out: 20, net: 0, opening: 0, closing: 0}]
   ```

   Both movements are still visible, the credit is unedited, and `opening + net === closing`.
   The export reconciles to `0` as well.
8. **`GET /api/admin/health`** — the ledger as a health row: `reachable`, with all four invariants
   reported (`TRANSACTIONS_BALANCED`, `LEDGER_BALANCED`, `NO_ORPHAN_ENTRY`, `NO_OVERDRAWN_ACCOUNT`).

`CLICK-PATH OK`, exit status 0.

## The corruption, and what caught it

One extra leg was written straight into the book — a `DEBIT` of 5 USDT on an `AVAILABLE` account
with no matching credit — which is exactly the state the invariants exist to catch. Three of the
four fired, and the fourth honestly reported it was unaffected:

```
ledger: degraded | DEPOSIT_REVERSED transaction cmvbaqtci0011n9l3jlshv8cp debits 25000000 and credits 20000000 USDT minor units. (3 violation(s) across 5 entr(ies))
  TRANSACTIONS_BALANCED  false — 1 violation(s) found
  LEDGER_BALANCED        false — 1 violation(s) found  (USDT has 45 debited and 40 credited across the ledger)
  NO_OVERDRAWN_ACCOUNT   false — 1 violation(s) found  (user:dev-owner-user:USDT:available holds -5 USDT)
  NO_ORPHAN_ENTRY        true  — 5 entr(ies) checked against 2 transaction(s) and 4 account(s)
reason: LEDGER_UNBALANCED — "3 ledger invariant violation(s): …"
```

The runner job is where "fails loudly" is a status rather than a sentence, and it answers as one:

```
GET /api/cron/ledger-invariants   →   outcome: failed, jobsRan: 0, jobsFailed: 1
  heartbeat: ledger-invariants failed | Ledger invariants failed: 3 ledger invariant violation(s): … | reason: LEDGER_UNBALANCED
```

With the injected entry removed, the same job on a sound book reports work rather than silence:

```
GET /api/cron/ledger-invariants   →   outcome: worked, jobsRan: 1, jobsFailed: 0
  heartbeat: ledger-invariants worked | 4 ledger entr(ies) across 2 transaction(s) and 4 account(s) were checked; every invariant holds. | cadence: 1 hour
```

and the health row returns to `reachable — Every invariant holds: 4 entr(ies) across 2 transaction(s) and 4 account(s)`.
(The job is hourly, so the second attempt inside the same hour is honestly `not-due` rather than a
second pass; the run state was cleared to show the passing run above.)

## The owner's click-path, in a browser, and where it stopped

`/trade` was opened in Chromium, signed in as the seeded owner through a cookie set the way only a
server can set an `HttpOnly` cookie (a local sidecar's `Set-Cookie`, then a redirect to the app —
cookies are not port-scoped). The page rendered: signed in as `0x1111…1111`, with the
**04 / LEDGER — Balances and statement** section present next to `03 / FUNDING — Deposits`, and the
browser's own `GET /api/ledger` answered **200** in the page's network log.

It did not settle, and the reason is the browser pane in this session rather than the page: while
the pane was being driven it reloaded the `/trade` document 33 times in a row (they stopped — delta
0 over 20 seconds — as soon as nothing was touching the pane), and every same-origin fetch made
*from the page's own JS context* aborted at 3 seconds, including a static `/favicon.ico`:

```
["/favicon.ico → AbortError in 3000ms", "/api/auth/config → AbortError in 3001ms", "/api/ledger → AbortError in 3000ms"]
```

That is why **every** client panel — the untouched orders panel (`LOADING ORDERS`), phase 12's
deposits panel (`Reading your deposit addresses…`) and the balance panel (`Reading your ledger…`) —
sat in its loading state at the same time, and why no further screenshot could be captured
(`the preview webview is not being composited`). The ledger was therefore verified at the layer
above the pane: the same requests, with the same cookie and the same query string the component
builds, asserted over HTTP in the click-path above. What this record cannot claim is a human-visible
render of the balance figure and the reversal button in this session.

## Boundary

- **The Postgres migration was not executed.** The three `ALTER TABLE … ADD CONSTRAINT` statements
  have no SQLite form, and real Postgres is not reachable from this machine (the local server on
  :5432 needs a password, the Docker daemon refuses this user), so `prisma migrate deploy` has not
  been run. The migration was instead verified against Prisma's own derived DDL, statement for
  statement, as above. On SQLite the equivalent constraints are created by `db:setup`, which is how
  the click-path got a database with the ledger tables.
- **The chain was a local stand-in.** The deposit journey read a real JSON-RPC conversation over
  HTTPS from a server describing a two-transfer chain; no real chain was read.
- **Reorg-un-crediting is not automatic.** `reverseDepositCredit` is the mechanism and the operator
  has it; detecting a credited deposit whose block later disappeared is a fresh read this phase does
  not implement (see `deposits/credit.ts`).

## Where this differs from the phase file's list, and why

- **`balance-panel.tsx` is new, not an edit.** The phase file lists it under "files to touch"; it
  did not exist, so the surface the manual verification describes is built here, in the same shape
  as the other panels on `/trade` (phase 04/06/12 conventions) and mounted in
  `app/trade/page.tsx` as `04 / LEDGER`.
- **Both new endpoints live in one route file.** `src/app/api/ledger/route.ts` serves `GET` (the
  balance, the statement, the CSV, the book's health) and `POST` (one action, `reverse-deposit`).
  A second `POST` path for a single action would have been a second place to keep authorised.
- **The reversal endpoint is not a generic posting API.** It takes a *deposit id the caller can
  already see* rather than an account or an amount, so there is no request a caller could make that
  mints a balance — which is why it is safe to expose to the owner as the click-path's failure case.
- **`DEPOSITS_PENDING` and `FEES` are declared and unwritten.** The phase requires the platform
  accounts to exist so a movement has a counterparty; this phase's movements only reach `TREASURY`.
  Both buckets are in the taxonomy, are issued per asset, and are reported by the invariant check as
  declared and holding nothing, so phase 14 (a receipt held without being owed to an account) and
  phase 16 (fees) add writers rather than a schema change.
- **A `Store.ledger()` accessor on the deposit store.** The credit posts through the *same* database
  transaction client the claim used (`createLedgerStore(client, {inTransaction: true})`), because a
  credited deposit with no movement — or a movement with no credited deposit — is exactly the state
  the phase exists to prevent.
