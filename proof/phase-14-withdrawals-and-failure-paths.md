# Phase 14 — Withdrawals and failure paths: what was built, and what was measured

The owner's balance goes back out to a wallet they name, and every way that can go wrong is a
state with its own name, its own sentence, its own answer to "will asking again help?", and its
own audit row. Nothing in front of a withdrawal the owner asked for: the only hold is the
new-address window they configure themselves, and zero is a complete answer to it.

- **Objective (phase file):** request, execute on chain, confirm, the failure taxonomy, retries,
  the owner-configured new-address control, and the point at which the fee is taken.
- **Status:** all four gates and the route sweep pass on the working tree. The click-path below
  was driven end to end against the real app: funded by the phase 12 deposit route, held by the
  owner's own window, a withdrawn 20 USDT settled in a wallet with its hash, and each simulated
  failure kind left the row in the state the taxonomy names.
- **Not done, deliberately:** no approval gate, review step or second code prompt in front of a
  withdrawal (the phase file forbids it, and a step-up here would be exactly that); no fee policy
  of its own beyond the per-asset amount phase 16 will set; no venue or off-chain balance
  (phase 20); no automatic un-sending of a transaction the network has already mined — a
  cancellation of a sent transfer is an *attempt*, and the response says which kind it was.

## The shape of it

`src/lib/withdrawals/` is the whole path, and each file answers one question.

**`request.ts`** is what a request does before anything is signed: it validates the network, the
destination (EIP-55 checksum, and an address that fails the checksum is refused rather than
lower-cased into someone else's), and the amount; it resolves the fee for the asset and computes
`net = amount - fee`; it reserves the amount in the ledger in the *same database transaction* as
the row it creates, under a per-account lock (`LedgerAccountLock`) taken before the balance is
read, so two requests that both see the same spendable balance cannot both reserve it. The hold
is decided from the address book and nothing else:

```
known = addresses.find(user, network, destination)
hold  = windowMinutes > 0 && known === null      // a first send to an unseen address, and only that
```

**`chain.ts`** is the port: `sender`, `prepare`, `prepareCancel`, `broadcast`, `observe`. The
on-chain implementation talks JSON-RPC (nonce allocation, `eth_estimateGas`, `eth_gasPrice`,
signing, `eth_sendRawTransaction`, receipt reads) and maps a node's refusal text onto the
taxonomy's reason codes — a nonce already used becomes `NONCE_CONFLICT`, anything else becomes
`NETWORK_UNAVAILABLE`, each carrying the node's own words. `createSimulatedWithdrawalChain` is the
development port: it signs the **real** transfer with the same `erc20TransferData` calldata, mines
it one confirmation per check, and reports `simulated: true` so a confirmation nobody's chain
produced can never be read as money. `readWithdrawalPolicy` refuses `simulated` outside
`NODE_ENV=development`, so a stray environment value cannot leave a deployment sending pretend
transactions.

**`execute.ts`** signs once and broadcasts once: the signed bytes and their nonce are written to
the row before the send, the send is claimed with a compare-and-set, and a retry re-sends **the
same bytes** — which is what makes one request one transaction, on a chain that deduplicates by
hash and in a test that counts distinct payloads. A signature is never made twice for one row.

**`confirm.ts`** follows the network's confirmation count, settles the row to `CONFIRMED` with the
hash, and takes the fee at that moment — the settlement debits the reserved bucket for the whole
amount and credits the treasury with the net and the fees bucket with the fee, in one balanced
transaction with the transfer that earned it. It also owns the exit paths: a request that was never
sent expires (or is cancelled) and gives the amount straight back, and a sent transfer that has been
silent past `WITHDRAWAL_CANCEL_AFTER_MINUTES` offers a cancellation *attempt* — a same-nonce
replacement at a higher fee, reported as `replacement-sent` (202) rather than as a promise.

**`states.ts`** is the taxonomy as data: which transitions are legal, what each state is called on
screen, and for every reason code whether asking again could change the answer. **`addresses.ts`**
is the book of destinations this account has used, per network. **`store.ts`** is the only file
that knows Prisma; every rule above is written against the store interface, which is why the whole
path is exercised in tests against an in-memory store. **`service.ts`** is the pass (release holds,
send what is queued, read confirmations, reconcile cancellations), the owner's view, and the health
signal. **`policy.ts`** reads the environment, purely, and reports every value it could not use
rather than dropping it.

**`settings.ts`** is the follow-on the phase file's requirement 6 asks for: the new-address window
as *admin data*. The environment value became the fallback for a deployment whose row has never
been written, a stored row always wins, and every read reports which of the two is in force. The
table holds one column, there is deliberately no approval flag beside it, and a settings read that
fails falls back to the deployment's value rather than refusing a withdrawal or inventing a window.

**`src/lib/ledger/accounts.ts`** gained the withdrawal buckets the reservation uses
(`withdrawal-reserved`, on the hold side, released by the same function that posts it), so a held
amount is a real movement in the book rather than a number kept beside it.

The surfaces: `GET`/`POST /api/withdrawals` (the view; a request; and `{"action":"check"}` to run
one pass on demand), `POST /api/withdrawals/[id]` (a cancellation attempt, `GET` for one row),
`GET`/`PUT /api/admin/withdrawals` (the owner's window), and `components/withdraw-panel.tsx`,
mounted on `/trade` as `05 / WITHDRAWALS`. The panel decides nothing: it has no sending wallet, no
confirmation count and no success state of its own, and it re-mints the idempotency key whenever
the network, destination or amount changes so a resubmitted request resolves to the same
withdrawal while a genuinely different one is a different request.

## The acceptance criteria, and where each one is proven

1. **20 USDT minus the configured fee lands in a wallet and is confirmed with a hash.** In the
   click-path: the fee in force was `1 USDT`, the request was `amount 20 / fee 1 / net 19`, the
   pass that sent it left the row `BROADCAST` with
   `0x751cfbc3a385c12dad9f0e0b3490f2d7e7e89b01e3133a04cd4b48eca03bd3e8` and the amount still
   reserved, the next check settled it `CONFIRMED 2/2` with the same hash, and the ledger's fees
   bucket holds exactly `1`. The unit tests decode the signed calldata and assert the recipient and
   the net amount are in it (`the simulated chain signs the real transfer`).
2. **Two concurrent requests for more than the balance: one succeeds, one fails on insufficient
   balance.** `two concurrent requests for more than the balance: one reserves, one is refused on
   insufficient balance` runs both against one store and asserts one `RESERVED` row, one
   `INSUFFICIENT_BALANCE` refusal, one reservation in the book, and the refusal audited with the
   destination.
3. **A retried failed broadcast produces one transaction, proven by a test.** `a retried failed
   broadcast re-sends the signed bytes and produces one transaction` counts the payloads handed to
   `broadcast`: the first pass fails, the second succeeds, `sent.length === 1` **distinct** payload,
   and `prepare` was called once.
4. **Each failure in the taxonomy is reachable in development and shows its own message.**
   `every failure in the taxonomy is reachable with its own state, message, retryability and audit
   event` drives all eight (the seven named plus an invalid amount), and
   `every simulated failure kind lands in the state the taxonomy names` runs whole processor passes
   with `WITHDRAWAL_SIMULATE_FAILURE` set to each kind. The three simulated kinds were also driven
   over HTTP below, one server each, on a funded balance.

The seven requirements, in the same order as the phase file: (1) the reservation is the same
transaction as the row and is taken under a per-account lock; (2) the idempotency key is unique on
the row, the same key with a changed amount is `IDEMPOTENCY_KEY_REUSED`, and a retry re-sends the
same bytes; (3) confirmation follows the network's own count from the deposit policy and the hash
stays on the row; (4) the taxonomy is `states.ts` data with a retryability answer each; (5) a
partial or delayed confirmation keeps the amount reserved, shows the hash, and offers a
cancellation attempt after the configured timeout; (6) the window is admin data, its length and
reason are on screen, and zero holds nothing; (7) every state change writes an audit event naming
the reason and the destination.

## Schema and migration

Two migrations, both verified against Prisma's own derived DDL rather than executed (this machine
has no reachable Postgres — see Boundary):

- `prisma/migrations/20261016200000_withdrawals_and_failure_paths` — `Withdrawal` (the row: three
  exact integer amounts, the destination, the state, the reason, a unique idempotency key, the
  nonce with a unique index on `(network, fromAddress, nonce)`, the signed bytes and the cancel
  bytes, the hold/expiry/timeout timestamps), `WithdrawalAddress` (the destinations this account has
  used), and `LedgerAccountLock` (the per-account mutex a reservation takes). **13 statements on
  each side, identical after whitespace normalisation.**
- `prisma/migrations/20261016210000_withdrawal_owner_settings` — `WithdrawalSettings`, one column.
  **3 statements on each side, identical.**

```
$ node /tmp/phase14/migration-diff.mjs
schema statements:    13
migration statements: 13
IDENTICAL: the migration and the schema agree, statement for statement.
$ node /tmp/phase14/settings-diff.mjs
schema statements:    3
migration statements: 3
IDENTICAL: the migration and the schema agree, statement for statement.
```

The development database (`prisma db push` via `pnpm db:reset`) carries all four tables — that is
how the click-path got a database with the withdrawal tables, and how the SQLite shapes stand in
for the Postgres constraints the migration file creates.

## Gates on the working tree

```
pnpm typecheck  → 0
pnpm test       → 0   439 tests, 439 pass, 0 fail   (21 of them in tests/withdrawals.test.ts)
pnpm lint       → 0   (3 warnings introduced during the phase were fixed, not suppressed)
pnpm build      → 0   both /api/withdrawals routes in the route manifest
node scripts/validate_plan.mjs → 0   40 phase files, 0 restriction hits, 0 warnings
pnpm routes:sweep --base-url http://localhost:3231 --cookie …  → 0
   81 passed · 0 not swept · 0 failed (of 81)   [15 pages, 65 exported API methods]
   GET  /api/withdrawals        → 200
   POST /api/withdrawals        → 400 "A withdrawal needs a network, a destination address and an amount."
   GET  /api/withdrawals/[id]   → 404 "No withdrawal route-sweep-probe is visible to this account."
   POST /api/withdrawals/[id]   → 404 (the probe names no withdrawal, so it is refused by id)
   GET  /api/admin/withdrawals  → 200
   PUT  /api/admin/withdrawals  → 400 (the probe names no window)
```

The route inventory grew by four methods to 65, and `scripts/route-sweep.test.mjs` asserts the
count — a new route that is not in the inventory still fails the suite.

## The click-path, as measured

`next dev` on :3231 with a real session cookie minted by the app's own `createSessionCookieValue`
for the seeded owner, `WITHDRAWAL_BROADCAST_MODE=simulated`, a `1 USDT` fee, a `30 minute`
deployment default for the window, and the phase 12 chain stand-in over TLS for the deposit that
funds the balance. Every request below is one the panel itself makes; the transcript is
`/tmp/phase14/clickpath.log`.

**1. The surface, before anything moves** — `GET /api/withdrawals` → 200, `configured: true`,
sending from `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`, `window 30 minutes
(deployment-default)`, `fee USDT 1`, six networks listed of which exactly `ethereum-mainnet` is
ready to send on (the other five are named, not hidden, and refused by name if asked for).

**2. Funding** — `GET /api/deposits` issued `0x212933ca0A32372bc3eC79f15Af9131D2944fDC2`, then
`POST /api/deposits` credited one transfer and left the other awaiting its second confirmation:
`USDT available 20 / held 0`.

**3. The refusals decided before anything is signed** — three attempts, each refused with its own
code and sentence, none touching the balance:

```
400 INVALID_DESTINATION  "The destination \"0x9F2c…3344\" is written in mixed case and its
                          capitalisation is not a valid EIP-55 checksum, so it may have a
                          transposed character; copy it again from the wallet."
409 INSUFFICIENT_BALANCE "The account can spend 20000000 of 50000000 USDT minor units requested,
                          so the withdrawal was refused and nothing was held."
503 NETWORK_UNSUPPORTED  "This deployment does not know a network called \"solana-mainnet\", so
                          there is nothing to send on."
```

…with `available 20 / held 0` afterwards, **no withdrawal row created by a refusal**, and one audit
row per refusal.

**4. Each simulated failure kind, on a funded balance** — one server restart each (a fresh
database per mode, the window turned off through the admin route first so the attempt reaches the
send):

```
rpc-unavailable  BROADCAST_FAILED  NETWORK_UNAVAILABLE  retryable
                 "The simulated network is configured to be unreachable
                  (WITHDRAWAL_SIMULATE_FAILURE), so nothing was sent."
                 amount still reserved (available 15 / held 5) → cancelled by the owner → 20 / 0
nonce-conflict   BROADCAST_FAILED  NONCE_CONFLICT       retryable
                 "The simulated network refused the send because the nonce was already used
                  (WITHDRAWAL_SIMULATE_FAILURE): {\"code\":-32000,\"message\":\"nonce too low\"}"
                 amount still reserved (available 15 / held 5) → cancelled by the owner → 20 / 0
reverted         FAILED            TRANSACTION_REVERTED terminal
                 "Transaction 0x5d15…bd3e8 was mined and reverted, so the transfer did not
                  happen and 5000000 USDT minor units went back to the balance. The fee the
                  network charged for it is not refundable."
                 amount released on the same pass → 20 / 0, nothing held
```

Every one of them was reachable by setting one development value, and none of them left the amount
neither settled nor released.

**5. The owner's own window** — the admin read before anything was saved:
`{newAddressWindowMinutes: 30, source: "deployment-default", deploymentDefaultMinutes: 30,
stored: false}`. A first withdrawal of 5 USDT to `0x9f2c…3344` was **HELD**:

```
201 HELD until 2026-10-16T20:49:10.886Z
"This is the first withdrawal to 0x9f2c7B1A4e5D6f7089AABbccddeeFf0011223344 on Ethereum
 Mainnet, so it is held for 30 minutes before it is sent."
available 15 / held 5
```

**6. …and it is the owner's to turn off** — `PUT /api/admin/withdrawals
{newAddressWindowMinutes: 0}` → 200 `{0, source: "owner-setting", stored: true}`, and the
withdrawal surface then reads `no hold: a first withdrawal to a new address sends immediately
(owner-setting)`. Two things worth recording: the request already inside its window was **not**
moved by the new number (it carries its own `holdUntil`, and the pass said so: `AWAITING_CONFIRMATIONS
— 1 withdrawal(s) are either inside the owner's new-address window or waiting for confirmations`),
and it was then cancelled immediately — a request the chain never took gives the amount straight
back (`200 cancelled`, `available 20 / held 0`). A `PUT` carrying an extra field
(`approvalRequired: true`) was refused 400: there is nowhere to put a gate, which is the point.

**7. Withdrawing 20 USDT, from request to confirmation**

```
request   201 RESERVED hold=none net=19 fee=1        (a first send to 0x1111…0000, nothing held)
replay    200 created=false id=cmvbeoz9x001nn9ajlaituu9o
reused    409 IDEMPOTENCY_KEY_REUSED "The idempotency key \"click-journey-send\" already names a
                                      different withdrawal, so this request was refused rather than
                                      answered with it."
check      {broadcast:1, confirmed:0, pending:1} → BROADCAST hash=0x751cfbc3a385…3bd3e8
           available 0 / held 20   (the hash is visible, the amount stays reserved)
check 2    CONFIRMED 2/2 — the same hash, confirmedAt recorded
           available 0 / held 0
```

**8. The ledger says where it went** — eight statement lines for the journey, ending in the
settlement, which is one balanced transaction naming both the destination's share and the fee's:

```
DEBIT -20 USDT   USDT withdrawal reserved → USDT treasury, USDT fees
platform [DEPOSITS_PENDING 0, FEES 1, TREASURY 1]
```

The settlement's memo carries the hash and the destination, the book's invariants report
`reachable`, and the fees bucket holds exactly the `1 USDT` the transfer earned.

Every phase above printed `PASS` and the runner exited 0 with `phases that failed: 0`.

## Boundary

- **The chain was the development simulation.** The transfer is signed for real — the same
  ERC-20 calldata, the same sender key, the same hash the node would compute — but no chain was
  contacted: `WITHDRAWAL_BROADCAST_MODE=simulated` mines the transfer one confirmation per check
  and marks every row `simulated: true`. **What this record therefore cannot claim is that 20 USDT
  arrived in a real wallet.** The on-chain port is written and its refusals are mapped, but the
  broadcast leg against a funded hot wallet on a real network is not something this session
  observed.
- **The Postgres migrations were not executed.** As in phase 13, the local server on :5432 wants a
  password and the Docker daemon refuses this user, so both migration files were verified against
  Prisma's derived DDL statement for statement instead. The click-path ran on the SQLite dev
  database, built by `prisma db push`.
- **The browser pane was not driven this time.** The owner's click-path was driven over HTTP with a
  real session cookie — the same interface the panel uses, one layer below the pane — because
  `/trade` needs a session the browser cannot be given (the cookie is `HttpOnly`, which is
  correct) and phase 13 recorded this session's pane failing to settle the client panels anyway.
  What is not in this record is a human-visible render of the withdrawal panel's states.
- **A cancellation of a sent transfer is an attempt, not a promise.** The response says
  `replacement-sent` (202) because which of the two transactions a network mines is the network's
  answer; the next pass reconciles it.
- **The fee amount is deployment configuration until phase 16.** `WITHDRAWAL_FEE_<ASSET>` is what
  the owner sets today and what the settlement takes; the fee *policy* — one table, visible before
  someone commits — is phase 16's, and this phase deliberately did not invent it.
- **Editing the window never moves a withdrawal already waiting.** A row inside its window keeps the
  `holdUntil` it was created with, so the number is a rule for new requests rather than a lever over
  existing ones. That is deliberate; an owner who wants a held withdrawal out sooner cancels it, and
  a request that was never sent gives the amount back immediately.

## Where this differs from the phase file's list, and why

- **`WithdrawalSettings`, a second migration, `/api/admin/withdrawals` and an admin form** were
  added. Requirement 6 says the new-address control is *owner-configured admin data*, and in this
  app admin data means a stored row with a permission-gated route and a form — the environment
  value alone would have been configuration, not something the owner can change. The environment
  value stayed as the fallback, and both are reported.
- **`WITHDRAWAL_REQUEST_EXPIRY_HOURS` was renamed `WITHDRAWAL_REQUEST_EXPIRY_MINUTES`.** The
  constant was read as minutes and documented as hours (default "168" against a real default of
  10080); the name now says what the code does, and `.env.example` says it too.
- **`execute.ts`, `confirm.ts`, `chain.ts`, `store.ts`, `states.ts`, `service.ts` and
  `withdrawals/settings.ts`** carry most of the logic the file list only sketched under
  `request.ts` and `execute.ts`: a port, a state taxonomy, a store, a service and an admin setting
  are what the seven requirements are actually made of.
- **One simulation defect was fixed rather than worked around:** `WITHDRAWAL_SIMULATE_FAILURE=nonce-conflict`
  used to report the conflict from `observe`, which left the row `BROADCAST` with a reason and no
  path forward. A node refuses `eth_sendRawTransaction` when the nonce is spoken for, so the
  simulation now refuses the *send* — `BROADCAST_FAILED`, retryable, cancellable — which is both
  what the real port does and what requirement 4 means by "reachable in development".
- **The simulated confirmation step went from four per check to one**, so the states between a send
  and a settlement are states a person can watch: the pass that sends leaves the row `BROADCAST`
  with its hash and the amount reserved, and the next check confirms it.
- **`src/lib/ledger/accounts.ts`** was touched as the file list said, adding the withdrawal
  hold/release buckets.
