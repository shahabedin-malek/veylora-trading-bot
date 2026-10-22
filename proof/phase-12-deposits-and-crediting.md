# Phase 12 — deposits and crediting

**Status: done.** A human deposits 20 USDT, sees it pending, then credited, with the hash recorded —
and every way an arrival can fail to be money has its own state, sentence and audit event.

Everything below was measured on this working tree. The chain in the click-path is a **local HTTPS
JSON-RPC stand-in** (`/tmp/phase12/rpc-stub.mjs`, not part of the repository); the application was
not modified for it, and the stand-in exists because `src/lib/rpc/networks.ts` refuses a non-`https`
RPC endpoint — a rule that was kept rather than relaxed. No key, session value or secret appears in
this record.

## What was built

- `apps/web/src/lib/deposits/` — `registry.ts` (the networks and what each deposit token actually
  is), `policy.ts` (every owner-decided number as data, with the variable that fixes each gap),
  `addresses.ts` (the derivation and the exactly-once issuance), `chain.ts` (the four chain reads,
  through the instrumented fetch every other RPC read uses), `watcher.ts` (scan → classify → record,
  plus the reconciliation pass), `credit.ts` (the one transition that makes an arrival money),
  `service.ts` (one run, and the view an owner reads), `store.ts` (the Prisma half, behind the
  interfaces the rest of the module is written against), `states.ts` (the six states), `api.ts`
  (request validation) and `sign-in.ts` (issuance on sign-in).
- `apps/web/src/app/api/deposits/route.ts` (`GET` the surface, `POST` a check) and
  `apps/web/src/app/api/deposits/[address]/route.ts` (one address's deposits).
- `apps/web/src/components/deposit-panel.tsx` and its section on `/trade`.
- `DepositAddress`, `Deposit` and `DepositScanCursor`
  (`migrations/20261016180000_deposits_and_crediting`), the `deposit-watcher` job in
  `src/lib/runner/registry.ts`, the three routes in the sweep inventory, and the deposit variables in
  `.env.example`.

## Requirements, each with its evidence

| Requirement | How it is met | Evidence |
| --- | --- | --- |
| 1. An address per enabled network, deterministic and stored once | `index = keccak256("<userId>:<network>")[0..4] mod 2^31`, address = `m/44'/60'/0'/0/<index>`; the row is the record, not the source | two reads returned `0x212933…44fDC2` (`issuance.created` then `issuance.existing`); `tests/deposits.test.ts` |
| 2. Detection with hash, network, amount, block; idempotent per hash and log index | unique `(network, txHash, logIndex)`, and `insertDepositOnce` returning "not created" *is* the duplicate answer | 4 arrivals → 4 rows; the replayed range reported `duplicates 0 / recorded 0` with the cursor rewound and credited nothing twice |
| 3. Credit only after the owner's confirmation count, visible while pending | `creditDeposit` claims the row with a conditional update from `PENDING`; `describePendingConfirmations` states the count | 20 USDT at 2/2 → `CREDITED`; 3 USDT at 1/2 → `PENDING`, "1 more before it is credited." |
| 4. Reconciliation: late, reorg, dust, unenabled token, unknown address | five refusals, five sentences, all in `classifyObservation`/`reconcilePendingDeposits` | `TOKEN_DISABLED` for a different token and for native ETH; `BELOW_DUST`, `UNMATCHED`, `REVERTED` by test |
| 5. Every state change audited, with the raw chain evidence kept | the row's `evidenceJson`, and the audit event written in the same transaction as the change | one `DEPOSIT_ADDRESS_ISSUED`, four `DEPOSIT_DETECTED`, one `DEPOSIT_CREDITED`; the credited row keeps the log's topics |
| 6. The UI shows address, copy, QR, network, token, live status, confirmations remaining | `deposit-panel.tsx`, all values read from the server | browser pass below, with `COPY` → `COPIED` and the pending sentence on screen |
| 7. Nothing depends on a browser being open | the crediting path is `runDepositWatcher`, called by the cron job and by `POST /api/deposits` alike | the credited row was created by a request with no page involved; the job is registered in the phase 05 runner |

## Gates on the working tree

```
cd apps/web
pnpm --config.verify-deps-before-run=false typecheck; echo "typecheck=$?"   # 0
pnpm --config.verify-deps-before-run=false test;      echo "test=$?"        # 0  (386 tests, up from 354)
pnpm --config.verify-deps-before-run=false lint;      echo "lint=$?"        # 0
pnpm --config.verify-deps-before-run=false build;     echo "build=$?"       # 0
cd ../.. && node scripts/validate_plan.mjs;           echo "plan=$?"        # 0
```

`pnpm exec next typegen` runs before `typecheck`, exactly as CI does — the per-address route types
its context with `RouteContext<"/api/deposits/[address]">`, which next generates. The suite grew by
32 tests: 14 for the policy/derivation/view half, 15 for the watcher, 3 for the routes'
fail-closed answers.

### The migration itself, checked against Prisma and executed

The three tables were new DDL, and no gate above reads a `.sql` file, so the migration was
checked twice over:

```
node node_modules/prisma/build/index.js migrate diff \
  --from-empty --to-schema-datamodel prisma/schema.prisma --script   # the schema's own DDL
node /tmp/phase12/migration-diff.mjs <migration.sql> <generated.sql>
#   phase-12 migration statements: 13
#   prisma-generated statements:  13
#   IDENTICAL: every statement for these three tables matches Prisma exactly.   (rc 0)
node /tmp/phase12/migration-execute.mjs <migration.sql>
#   10 statements executed verbatim, 7 named indexes, 3 tables             (rc 0)
```

Identical to Prisma's own generator means the migration and the schema cannot drift: the same three
`CREATE TABLE`s, the same seven indexes, the same three foreign keys, character for character after
whitespace normalization. Prisma's script is the authority on what `schema.prisma` means, so this is
the strongest available statement that the hand-written file says the same thing.

The ten `CREATE TABLE`/`CREATE INDEX` statements were then **executed** against a SQLite stand-in
(the same engine the development database uses), where every one ran and the three unique keys were
exercised with the conflicts this phase's correctness rests on — a second address for one account on
one chain, the same address issued to two accounts, and the same transfer observed twice. Each was
rejected by the constraint the migration declares, and a `NULL userId` row with `logIndex = -1`
(an arrival that cannot be attributed) was accepted, as the design argues it must be.

**Boundary:** the three `ALTER TABLE … ADD CONSTRAINT` statements have no SQLite form, so they were
not executed — they were verified by the Prisma comparison instead. Real Postgres is not reachable
from this machine (the local server on :5432 requires a password, and the Docker daemon refuses this
user), so `prisma migrate deploy` has **not** been run against a Postgres database. That is the one
check this record cannot claim.

## The click-path, as measured

Local app on `http://localhost:3217` (its own dist directory), SQLite `prisma/dev.db`, sign-in
configured for chain 1, deposits configured for `ethereum-mainnet` with
`DEPOSIT_CONFIRMATIONS_ETHEREUM_MAINNET=2`, and `ALCHEMY_ETHEREUM_MAINNET_RPC_URL` pointing at the
local HTTPS stand-in, which describes this chain at head 100:

```
block 99   txA  20 USDT (the real USDT contract, 6 decimals)   → 2 confirmations
block 100  txB   3 USDT                                        → 1 confirmation
block 100  txC   5 units of 0x4444…4444 (not the enabled token) → refused
block 100  txD   0.5 native ETH to the same address             → refused
```

A session was minted for the seeded owner as a real `AuthSession` row. The driver
(`/tmp/phase12/clickpath.mjs`) made only requests a browser would make:

1. **`GET /api/deposits`** — 200, `configured: true`, and it **issued** the address:
   `0x212933ca0A32372bc3eC79f15Af9131D2944fDC2`, `issuance.created` one entry, `skipped` empty. The
   network row carried `USDT · Tether USD` at `0xdAC17F958D2ee523a2206206994597C13D831ec7`, 6
   decimals, "credited after 2 confirmations", minimum 1 USDT, derived at
   `m/44'/60'/0'/0/232545392`.
2. **The same read again** — the same address, `issuance.created` empty and `issuance.existing` one.
3. **`POST /api/deposits`** (the same run the scheduler makes) —
   `{networks: 1, scanned: 1, observations: 4, recorded: 4, duplicates: 0, credited: 1, reverted: 0,
   awaiting: 1, worked: true}` and, per row:

   | amount | state | confirmations | block | reason |
   | --- | --- | --- | --- | --- |
   | 20 USDT | **CREDITED** | 2/2 | 99 | — |
   | 3 USDT | PENDING | 1/2 | 100 | `AWAITING_CONFIRMATIONS` |
   | 5 UNKNOWN TOKEN | TOKEN_DISABLED | 0/2 | 100 | `TOKEN_NOT_ENABLED` |
   | 0.5 ETH | TOKEN_DISABLED | 0/2 | 100 | `TOKEN_NOT_ENABLED` |

   `creditedTotals: [{tokenSymbol: "USDT", amount: "20"}]`.
4. **Asked again** — `recorded 0`, `credited 0`, and the reason is the honest one: the cursor was at
   the head of the chain (`NOT_YET_DUE`, "the chain is at 100, so there is no new block to read").
   Still exactly **one** credited row and still 20 USDT. This is the replay criterion, measured
   again at HTTP level.
5. **`GET /api/deposits/<address>`** — 200 with the four rows and the confirmations remaining
   (`0.5 ETH` 2, `5 UNKNOWN TOKEN` 2, `3 USDT` 1, `20 USDT` 0).
6. **`GET /api/deposits/0x9999…9999`** — 404, "That address is not a deposit address issued to this
   account." An address is public on chain, so it is a lookup key and never an authorization.
7. **The audit trail**, read from the database:

   ```
   15:21:44.520  DEPOSIT_CREDITED   SUCCESS  ethereum-mainnet  20 USDT          0xtxA
   15:21:44.482  DEPOSIT_DETECTED   REFUSED  ethereum-mainnet  0.5 ETH   state=TOKEN_DISABLED  0xtxD  reason=TOKEN_NOT_ENABLED
   15:21:44.468  DEPOSIT_DETECTED   REFUSED  ethereum-mainnet  5 UNKNOWN TOKEN  state=TOKEN_DISABLED  0xtxC  reason=TOKEN_NOT_ENABLED
   15:21:44.449  DEPOSIT_DETECTED   SUCCESS  ethereum-mainnet  3 USDT    state=PENDING  0xtxB  reason=AWAITING_CONFIRMATIONS
   15:21:44.433  DEPOSIT_DETECTED   SUCCESS  ethereum-mainnet  20 USDT   state=PENDING  0xtxA  reason=AWAITING_CONFIRMATIONS
   15:21:43.916  DEPOSIT_ADDRESS_ISSUED SUCCESS ethereum-mainnet 0x212933ca0A32372bc3eC79f15Af9131D2944fDC2
   counts: ADDRESS_ISSUED 1, DETECTED 4, CREDITED 1
   ```

### The owner's click-path, in a real browser

Chromium at the same origin, with the minted session: `/trade`'s **03 / FUNDING → Deposits** section
rendered the credited total (`20 USDT`), the cadence sentence, a tab per registry network with its
status (`Ethereum Mainnet READY`, the rest `DISABLED`), the address with its **QR** and a `COPY`
button that flipped to `COPIED`, the facts block (network and chain id, `USDT · Tether USD`, the
token contract, `2 confirmations`, `1 USDT — below this it is recorded and never credited`, and the
derivation path), the pending summary, and all four rows with their hash, log index, block,
`n / 2 confirmations`, the credited timestamp and the reason sentence. Pressing its own **CHECK NOW**
produced the run summary in the page — `Scanned 0 of 1 network(s) · … · 1 still confirming`, why
(`1 pending deposit(s) are on chain and still short of their confirmation count`) and the skipped
network's own sentence — from a real `POST /api/deposits`. No console error, no failed request; the
only `4xx` anywhere in this phase is the intentional 404 above.

## What the click-path found, and what it changed

- **A derivation index that could not be spent from.** The first implementation took the hash modulo
  `0xffffffff`, and `viem` refused every index above `0x7fffffff`: in BIP-32 the top bit marks a
  hardened child, so `m/44'/60'/0'/0/<index>` only addresses 31 bits. The unit suite caught it as a
  thrown `Invalid index` on the first test run, and the bound is now `0x7fffffff` with the reason
  written down in `addresses.ts` — this matters beyond deposits, because withdrawals derive from the
  same paths.
- **A slug the registry does not know was silently dropped.** `enabledSlugs` checked the slug's
  *shape*, so `DEPOSIT_ENABLED_NETWORKS=dogecoin` produced no network and no explanation — a typo
  that looks exactly like a deployment meaning what it typed. Unknown slugs are now reported, once,
  against the list (`policy.problems`), and the panel renders them.
- **A checked-but-unuseful run summary.** `Scanned 0 of 1` with nothing else read like a failure
  when a check arrived between blocks. The panel now renders the skipped network's own sentence, and
  the check-path screenshots show it.

## Where this differs from the phase file's list, and why

- **`rpc-proxy.ts` was not reused.** The phase file names it for chain reads, and the *decision*
  behind that is honoured: every chain read resolves its endpoint through `src/lib/rpc/networks.ts`
  and goes out through the same `instrumentFetch` provider-call recorder, so the key-bearing URL is
  redacted identically. `rpc-proxy.ts` itself is a browser-facing route (`handleNetworkRpcPost`) that
  requires a same-origin request and rate-limits by caller; a server-side job calling its own HTTP
  route to read a block would add an origin check and a rate limit that do not apply to it. The
  sharing that matters — endpoint resolution, instrumentation, no key in a log — is what is shared.
- **The watcher job is registered in `runner/registry.ts`, not `runner/scheduler.ts`.** The registry
  is the job list the scheduler enumerates (`RUNNER_JOBS`), so registering it there is what makes the
  scheduler run it; scheduler.ts is the executor and needed no change. `tests/runner-scheduler.test.ts`
  covers the executor, and the job appears in the phase 05 job list.
- **A `DepositScanCursor` table beyond the two the phase names.** The plan asks for `DepositAddress`
  and `Deposit`; a third row per network records how far the watcher has read so a run continues where
  the last one stopped instead of re-reading a fixed window forever. It is written in the same
  transaction as the deposits found in that range, and re-reading is safe regardless — the cursor is
  an efficiency, not a correctness requirement.
- **The unsupported-token case reports `TOKEN_DISABLED`, not `UNMATCHED`.** The manual verification
  describes sending an unsupported token and seeing it "never credited"; the state set separates that
  from a transfer to an address this deployment never issued (`UNMATCHED`, covered by test), because
  the two need different sentences and only one of them can be attributed to an account.
- **A reversion was proven by test, not watched live.** The click-path observed issuance, detection,
  crediting and the refusal states against a running server; `REVERTED` with its `CHAIN_REORGANIZED`
  reason and its `DEPOSIT_REVERTED` audit row is asserted in `tests/deposits-watcher.test.ts`
  (receipt replaced by a different block), not in the walk.

## Boundaries this phase did not cross

- **No approval gate, and none added.** Nothing between a transfer and its credit asks a human
  anything: the confirmations the owner configured are the whole gate.
- **No balance was invented.** The panel shows the sum of credited rows, labelled as what the chain
  paid in, and says in the same breath that it is not a ledger entry. When the chain cannot be read
  the run reports the failure and credits nothing — `ChainReadError` on an unreachable endpoint, and
  `readLogs` refusing a response it cannot read rather than returning fewer logs.
- **No silent fallback for a half-configured token**, and no invented testnet USDT: the four testnets
  ship with `token: null` and name `DEPOSIT_TOKEN_ADDRESS_<SLUG>` instead.
- **No claim of a real chain.** The accepted path was measured against a local stand-in; the refused
  and unreadable paths are also covered by the unit suite (`/tmp` has the stub, it is not committed).
- **`plan/PROJECT_TODO.md` was not edited**: it carries no per-phase status field, and phases 08–11
  recorded their status here and in `README.md` instead. `.progress/SESSION_LOG.md` carries the
  entry.
