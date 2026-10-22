# Veylora Web

Next.js 16 App Router foundation. The interface reports unconfigured account and market
sources as **Not connected**; it contains no fabricated balances, prices, or activity.

## Local development: install, set up, run

Three commands from a clean checkout:

```bash
pnpm install --dir apps/web
pnpm --dir apps/web db:setup
pnpm --dir apps/web dev
```

Then open <http://localhost:3000>.

`db:setup` creates a SQLite database at `apps/web/prisma/dev.db`, brings it to the current
model, and seeds it. No `.env` file, no server and no credentials are needed for this: the
development database is a file the pipeline creates and owns.

`db:reset` is the way back to a known-good state. It deletes the database file, recreates it
and reseeds, so it is the command to reach for when the data has been edited into a state you
no longer want to reason about:

```bash
pnpm --dir apps/web db:reset
```

`db:seed` reseeds the existing database and refuses to run when there is no database yet;
use `db:setup` for the first run. Every command is idempotent — running it twice leaves the
same state, not a second copy of it.

### Development mode is the most capable mode

`NODE_ENV=development` (what `next dev` sets) turns on three things that exist only there:

| affordance | what it does |
| --- | --- |
| database banner | names the database in use and lists every configuration **name** with a set/missing marker. Values are never rendered. |
| unmasked values | venue key labels show the last four characters of the key fingerprint, and a failed read appends the real error message instead of only the generic sentence. |
| seeded paper session | the PAPER strategy store starts with strategies in `DRAFT`, `PAPER` and `KILLED`, including a funded paper account with three paper transactions. |

None of it is a gate or a hidden control: the banner is a report, the values are the owner's
own data, and the seeded strategies are ordinary PAPER bots. A production build renders the
banner's component as nothing and leaves every one of these behaviours off.

### Two facts that stay true

- **Server secrets never cross into the browser bundle.** No secret gains a `NEXT_PUBLIC_`
  prefix. The RPC resolver that reads a key-bearing endpoint URL is server-only, and the
  only public variables in `.env.example` are the two project ids the wallet button needs.
- **The audit log keeps storing redacted payloads.** `AuditEvent.redactedJson` continues to
  hold redacted JSON in development exactly as it does in production, including the rows the
  local seed writes.

## The network registry

Every network the deployment can reach is discovered from the environment at runtime. There is no
network list in the code: `ALCHEMY_<NETWORK>_RPC_URL` and `ALCHEMY_<NETWORK>_API_KEY` are scanned on
startup, so setting a variable and restarting is the whole change. A network whose name is not in
the metadata catalog is still listed and still proxied — it reports its chain id as unknown rather
than disappearing.

`src/lib/rpc/networks.ts` builds the registry and `src/lib/rpc/network-catalog.ts` holds only public
metadata (display name, chain id, native asset, explorer). An entry records availability with a
reason that names the variable and never its value: "`ALCHEMY_BASE_MAINNET_RPC_URL` must be an
https URL, so base-mainnet is unavailable." A malformed variable marks that one network
unavailable; every other network keeps serving. Startup logs one line with the usable/total count
and one line per problem, and `/admin/data` section 07 shows the same facts after the fact.

Health is in-process and per network: last success, last failure, latency, consecutive failures.
After three consecutive failures a network is skipped for a 60-second cooldown and the refusal says
how long until it is retried, so one dead chain cannot fail a request another chain can answer. A
success clears the record. The registry itself is cached for 30 seconds in the process;
`invalidateNetworkRegistry()` is the explicit path after a deliberate change.

`GET /api/portfolio/networks` returns the registry to a signed-in caller (metadata and reasons, no
endpoints, no keys). `/trade` renders it as the network switcher: choosing a network verifies it
through `/api/rpc/<network>` with `eth_chainId` and `eth_blockNumber`, then asks the wallet to
switch, then reads the wallet's chain back. A wallet that resolves the switch request without
moving is reported — "the wallet reports chain 1 after the request to switch to Base (chain 8453);
it did not change" — instead of being assumed to have moved. Non-EVM families and chains whose id
is unknown stay in the list as proxy-only, with the reason the wallet cannot be switched to them.

### The aggregated portfolio

`GET /api/portfolio` reads every enabled EVM mainnet and answers with holdings, per-network totals
and an aggregate. Each holding carries the network it was read on, its chain id, the contract
address (checksummed, null for the native asset), decimals, the raw base-unit amount, the exact
formatted amount, where it was read (`providerId: "alchemy-rpc"`) and when. Nothing in it is
priced: the aggregate is exact amounts per asset plus a holding count. Phase 19 added market data
and the screener, not pricing; no phase in this plan assigns a valuation to these holdings yet, so
the aggregate stays a count of exact amounts.

Holdings come from the provider's token list, not from the allow-list, so a token the owner never
added is still listed — with its checksummed address and a "not in allow-list" marker. The same
read marks, without deleting, a symbol or name that contains a URL or a claim phrase, an unusual
symbol length, or metadata the provider could not resolve (that token is shown in raw units). A
marked token is always inspectable: its address, raw amount, decimals, source and explorer link are
in the row.

Metadata is cached in the shared `TokenMetadata` table for 24 hours. A cache read that fails (a
stopped database, a missing table) is a miss, not an error: balances are read from the chain and a
token is listed by address when its metadata could not be resolved. `?refresh=1` bypasses the
freshness window. `GET` with `Accept: text/event-stream` streams `start` (the networks that will be
read), one `network` event per settled network, then `summary` and `done`, so networks that answered
are shown first. The default JSON form is the same snapshot.

Networks are read with bounded concurrency (four) and a 12-second per-network deadline, and one
network's failure is a row with a reason, never an empty list that reads as "no holdings". The
summary's `complete` is true only when every enabled network answered; otherwise it carries
`missing` with each network's name and reason, and the panel says the aggregate is a floor rather
than presenting it as complete.

### The scope trap, made visible

The registry can only see the environment of the process it runs in, so it cannot tell you that a
network exists in Development but not in Preview. `pnpm networks:coverage` reads the names-only
manifest (`plan/ENVIRONMENT_MANIFEST.txt`) and prints the configured network set per scope, plus
every network missing from each. `--check` exits 1 on a gap; that is the check to run before a
deploy that adds a network. Adding a network means setting its variable in **all three scopes** —
unsetting it in one scope silently removes RPC there.

Key-bearing endpoint URLs are resolved only on the server. Nothing in the registry, the switcher or
any client bundle contains one, and no RPC key may ever gain a `NEXT_PUBLIC_` prefix.

## How the two datasources are kept apart

Production runs Prisma against Postgres (Neon) using `prisma/schema.prisma` and the checked-in
migration history. Development runs the same models against a local SQLite file.

Prisma cannot take its datasource `provider` from an environment variable, so the SQLite
schema is **derived** from the Postgres one by `scripts/dev-database.mjs` rather than being a
second hand-maintained copy:

- `prisma/schema.prisma` — Postgres. The source of truth for the models and for production.
- `prisma/schema.dev.prisma` — generated, git-ignored, never edited by hand. Same models,
  `provider = "sqlite"`, no `directUrl`.
- `prisma/dev.db` — the local database itself, git-ignored and disposable.

Deriving means development cannot drift from the models, and nothing has to be kept in sync
by hand. `assertSqliteCompatible` fails loudly if a model ever gains something SQLite cannot
represent, so the two schemas cannot silently diverge. Development does not replay the
Postgres migration history: it applies the model directly with `prisma db push`, because
Postgres migration SQL does not run on SQLite and a throwaway local file has no history worth
replaying.

### The scripts refuse a database that is not local

`db:setup`, `db:reset` and `db:seed` all assert their target before touching anything:

- the resolved `DATABASE_URL` must be a `file:` SQLite path inside `apps/web` (a remote host,
  a socket URL, a path outside the project and `:memory:` are all refused, exit 2);
- an env file that points development at another database is refused too, because otherwise
  the scripts would seed the local file while `next dev` read somewhere else;
- a refusal redacts credentials, so the message naming the rejected target cannot leak a
  password.

Measured, with the database file's checksum compared before and after:

| command | target | exit | database touched |
| --- | --- | --- | --- |
| `db:setup` | `postgresql://…@…neon.tech/neondb` | 2 | no |
| `db:reset` | `postgresql://user@db.example.com:5432/veylora` | 2 | no |
| `db:seed` | same | 2 | no |
| `db:setup` | `file:./dev.db` | 0 | yes, as intended |

## Foundation checks

Measured on the working tree with node v24.21.0 and pnpm 11.15.1, run from `apps/web`.
Each gate's exit status is inspected on its own, so a failure cannot hide inside a pipe.

| gate | command | result |
| --- | --- | --- |
| typecheck | `pnpm --config.verify-deps-before-run=false typecheck` | exit 0 |
| test | `pnpm --config.verify-deps-before-run=false test` | exit 0 — 526 tests, 526 pass, 0 fail, 0 skipped |
| lint | `pnpm --config.verify-deps-before-run=false lint` | exit 0 |
| build | `pnpm --config.verify-deps-before-run=false build` | exit 0 — 18 page routes, 46 API route files |
| routes:sweep | `pnpm routes:sweep` | exit 0 — 93/93 rows (owner session measured in phase 19 on :3235; the unconfigured reading rests on the phase-14 measurement) |
| db:setup | `pnpm --config.verify-deps-before-run=false db:setup` | exit 0 — schema in sync, seeded |
| db:reset | `pnpm --config.verify-deps-before-run=false db:reset` | exit 0 — twice in a row, identical seeded counts |

`prisma generate` must have run at least once before the gates; CI does it explicitly and
`pnpm db:setup` does it as part of the pipeline.

Measured inventory:

| thing | count |
| --- | --- |
| pages (`src/app/**/page.tsx`) | 18 |
| API route files (`src/app/api/**/route.ts`) | 46 (74 exported HTTP methods) |
| route-sweep inventory rows | 93 (18 pages + 74 methods, plus the `/api/cron/all` alias row) |
| test files named in the `test` script | 87 |
| Prisma models | 42 |
| migrations | 18 |
| TypeScript files under `src` | 296 |

## Walking every route: `pnpm routes:sweep`

`scripts/route-sweep.mjs` requests every route in one inventory against a running dev
server and exits non-zero unless each one answered the way it declared it would. Start the
server first, then sweep it:

```bash
pnpm --dir apps/web dev                                    # in one terminal
pnpm --dir apps/web routes:sweep                          # in another ($ROUTE_SWEEP_BASE_URL)
pnpm --dir apps/web routes:sweep -- --base-url http://localhost:3100   # if the server is elsewhere
```

The inventory lives in the script (`ROUTE_INVENTORY`) and is checked against the filesystem
before any request: every `page.tsx` and every exported HTTP method must have a row, and a
row that names a route the app does not ship fails the sweep. Add a route and the sweep stops
until you add its row — which is the point of keeping the list in one place.

### What a healthy report looks like

Every row answers one of three ways, and the summary line says how many of each:

- **`pass` / serve** — a 2xx. The route produced a real answer.
- **`pass` / gap** — a **503 whose body names the missing variable or provider**. The sweep
  checks the name: a 503 that says something vague is a failure (`unnamed-503`).
- **`pass` / refuse** — a 4xx from a mutation route. The sweep is read-only, so mutation
  routes get an intentionally invalid payload and must reject it; a 2xx there is a FAILURE,
  because it would mean the probe wrote something.

A healthy run ends with `60 passed · 0 not swept · 0 failed (of 60)` and the sentence
`Healthy report: every route in the inventory answered …`. It also prints two lists worth
reading: **MISSING CONFIGURATION** groups the 503s by the reason in their body — `0 route(s)
answered 503 naming what is missing` with a session on a configured server, and the list of
names to set when the deployment cannot authenticate anyone — and **NOT EXECUTED** names each
mutation route it deliberately did not carry out (`28 mutation route(s) answered a refusal,
so the sweep wrote nothing` in the run recorded below).

What makes it exit non-zero: any 5xx, an unexpected 404, a 3xx redirect, an unnamed 503, a
2xx from a mutation route, a refusal with an empty body, or no server at all. Each of those
was provoked rather than assumed:

| cause | how | result |
| --- | --- | --- |
| a route that throws | a temporary `GET /api/zz-sweep-fault`, swept live | `FAIL … server-error — 500 server error (status 500)`, exit 1 |
| a route that is gone | the fault route removed, its row left in place, swept live | `FAIL … unexpected-404`, exit 1 |
| no server at all | dev server killed while the sweep ran | `6 passed · 0 not swept · 49 failed`, every failure `no-response — fetch failed`, exit 1 |
| a 503 that names nothing | planted in `scripts/route-sweep.test.mjs` | `unnamed-503`, verdict `fail` |
| a 2xx from a mutation route | planted in `scripts/route-sweep.test.mjs` | `unexpected-2xx`, verdict `fail` |

### Two environments, two honest readings

The sweep reads `/api/auth/config` first and reports which environment it is in.

**Sign-in not configured** (the default: no `APP_BASE_URL`, `AUTH_EVM_CHAIN_IDS` or
`SESSION_SECRET`). Owner routes are a configuration gap, not a broken route: they answer HTTP
503 whose body names the value that is missing, and the page renders that same sentence
instead of redirecting into a sign-in that cannot work. That is a pass.

**Sign-in configured.** Owner routes need a session. Pass one and they must serve real
content:

```bash
ROUTE_SWEEP_COOKIE="veylora_session=…" pnpm --dir apps/web routes:sweep
```

Without a cookie the sweep reports those rows as `SKIP … pass --cookie` and **exits
non-zero**, because "I could not check" must not read as "it works". Measured with a seeded
owner session against a `next dev` server on `http://localhost:3130` using its own dist
directory (`VEYLORA_NEXT_DIST_DIR`, so it can run beside another session's dev server):
`60 passed · 0 not swept · 0 failed (of 60)`, exit 0 — all 14 pages serving 200, every read
API serving its real content (admin reads, the alert list, the EVM portfolio, venue
credentials, the order lifecycle, a live JSON-RPC `eth_blockNumber`), and 28 mutation routes
refusing with a 400/404 without writing.

Use an **owner** session: the sweep expects admin and owner routes to serve, so a
`VIEWER`/`TRADER` cookie makes those rows fail — correctly, because that account may not read
them.

### The read-only promise, precisely

The sweep never sends a payload a route would accept as a write, and it never carries the
session cookie to `DELETE /api/auth/session` (that would rotate the session). One honest
caveat: an authenticated sweep is the same read traffic a signed-in browser makes, so a route
that records its own audit event for a read (the overview page does) will record it. The
sweep itself writes nothing. The rows that could change state — the PAPER store, venue keys,
settings, alerts, role grants — are the ones it refuses to execute.

### Honest status in the UI

Phase 03 also removed the last places where a page hid its cause. Where the app previously
redirected a visitor into sign-in, or showed a generic "unavailable" sentence, it now renders
the reason:

- the six owner pages (`/trade`, `/research`, `/wundertrading`, `/admin/access`, `/admin/data`,
  `/admin/risk`) render a **SIGN-IN NOT CONFIGURED** panel naming the missing variable, and
  keep their shell and navigation;
- `/api/admin/*`, `/api/market-alerts`, `/api/portfolio/*`, `/api/trading/*` answer **503
  naming the variable** when no deployment could authenticate anyone (`getAuthenticationGap`
  in `src/lib/auth/access-gate.ts`), and 401 only when sign-in works and the caller is simply
  not signed in;
- `/api/cron/[job]` (the runner's only entry point; `/api/cron/market-alerts` and `/api/cron/all`
  are the same route) names `CRON_SECRET`, `/api/rpc/[network]` names `APP_BASE_URL` or
  the per-network `ALCHEMY_…_RPC_URL`, and `/api/assistant` names `AI_GATEWAY_MODEL` and
  `AI_GATEWAY_API_KEY`;
- the assistant's SEND button is no longer disabled while the gateway is unconfigured: it
  sends, and the 503's names appear in the transcript. The same applies to the bot builder's
  paper-mode button, which now says why it is waiting for a backtest.

## What happened, what it called, and why nothing happened

Phase 04 gave every run a place to answer those three questions without a console. All of it
lives in `src/lib/observability/` and none of it is a gate.

### Every request has an id, and it is in the response header

`src/proxy.ts` (Next 16's name for the file convention that used to be `middleware.ts`) mints
one id per request (`x-request-id`), puts it on the request so server code logs under it, and
echoes it on the response. An inbound `x-request-id` is used only when it looks like an id,
so a caller cannot forge a log line. A failing response in the alert panel shows the id
inline, which is the whole point: copy it, grep the server output, and every line for that
request comes back.

```bash
curl -si localhost:3100/api/trading/status | grep -i x-request-id
```

Log lines are one JSON object per line — `level`, `timestamp`, `message`, `requestId`,
`route` — written to stdout. `LOG_LEVEL` sets the floor; unset means `debug` under
`next dev` (every provider call is logged) and `info` anywhere else (only what failed).
**A redaction pass runs over every line**, on field names (`apiKey`, `ALCHEMY_API_KEY`,
`sessionSecret`, anything matching a credential word) and on value shapes (a key in a URL
path, a query parameter, a bearer header, `key: value` in a message, a 32-byte hex secret).
An EVM address is deliberately exempt: it is public identity and the owner's own data, so
masking it would hide the one thing a portfolio failure needs to name.

In development a failure keeps its stack and the provider's own body (`developmentDetail`
keeps its old behaviour, and `serializeError` extends it); in production both are dropped and
the code and message stay. The provider body is still redacted on the way out.

### Every outbound call leaves a record

`instrumentFetch({ providerId })` wraps the `fetch` a client was given, so a record is made
where the call happens — the integration cannot forget to write one for a new code path.
Instrumented today: Coinbase (quotes, candles, news), the Cointelegraph and nine further RSS
feeds, Alternative.me, the Alchemy RPC proxy and the portfolio batch reads,
WunderTrading, Tavily, SandBase and the assistant's model gateway.

Each record carries provider, method, **URL redacted**, status, duration, attempts, the
request id and route it belonged to, an outcome and, for a failure, a reason code and a safe
sentence. Records are persisted in `ProviderCallRecord` (the migration is
`20261015160000_provider_call_records`) and trimmed to the newest 1,000, so the table cannot
grow without bound. The write is fire-and-forget and its failure is logged at `debug`: an
observer that can break the thing it observes is worse than none. Persistence is registered
in `src/instrumentation.ts`, which is why a unit test or a script that imports a client
records nothing rather than writing rows it never intended to.

### The admin surface says what is up right now

`/admin/data` (owner session) renders reachability, provider health and recent failures;
`GET /api/admin/health` returns the same snapshot as JSON. Neither ever claims more than it
knows: a provider with no recorded call reads **NO EVIDENCE**, not "reachable"; a provider
whose last call did not connect reads **UNREACHABLE** with the sentence that call produced.

A stopped database is the case the whole design bends around. Sign-in reads the database, so
a database outage means nobody can be authorized — which is why the health endpoint probes
*before* it authorizes and answers **503 naming `DATABASE_URL`** rather than a 401 that would
send the owner to a door that cannot open, and why `/admin/data` renders its reachability
section (database UNREACHABLE, `DATABASE_URL` named) and withholds the catalog and provider
history instead of showing them empty. The raw driver message appears only in development;
production names the variable and stops.

```bash
curl -s localhost:3100/api/admin/health --cookie "veylora_session=…" | head -40
```

### Nothing idles without saying why

`src/lib/observability/reason.ts` is the shared reason type: a code, a specific sentence,
whether retrying could change the answer, and — when configuration is the cause — the exact
variable to set. Every code has its own default sentence, so a reason can never degrade into
"something went wrong". The alert evaluation path returns one per run (`outcome`, `reason`,
`reasons`) and maps each market-data failure through `describeMarketDataFailure`, and
`/api/market-alerts` answers the same question from the stored alert rows, which is what the
alerts panel renders. `serializeReason`/`parseReason` round-trip it across the API boundary.

### Measured, on the running app

| what | how | result |
| --- | --- | --- |
| the id in the header is the id in the logs | `POST /api/rpc/ethereum` with a seeded owner session, then `grep` the server output for the response's header value | 3 lines, all carrying `abfce9ef-…`, `route: "/api/rpc/ethereum"` |
| a forced provider failure reaches the admin surface | the Alchemy endpoint pointed at a closed port, one RPC call, then `GET /api/admin/health` | the `alchemy-rpc` row reads **UNREACHABLE** ("Last call did not connect"), and the failure is listed with provider, route, reason `VENUE_UNAVAILABLE` and the same request id |
| no key survives any of it | `grep` the log, the health JSON and the page for the key in use | 0 hits; every logged URL reads `/v2/[redacted]` |
| the sweep notices a broken provider | the same broken endpoint, swept | the RPC row `FAIL … server-error — 502`, every other row still `pass` |

### Two honest limits

- The request id reaches the server code through the middleware's headers, so a request that
  never passed through it (a script, a build-time prerender) logs with `requestId: null`
  rather than an invented one.
- `attempts` is measured by the recorder and is therefore 1 today: no client retries yet. The
  field exists because "how many attempts" is part of what a provider call must answer, and
  it will keep telling the truth when a retry policy lands.
- The sink is registered on `globalThis` at boot, because Next compiles `instrumentation.ts`
  and each route into separate module graphs: a module-level sink was set in one copy of the
  module and read as null in another, so records were built, logged and dropped. The process
  is the shared thing, and `src/lib/db.ts` caches its Prisma client the same way.

## The runner: work that runs while nothing else is open

Phase 05 added a scheduled runner, so a job runs while the browser is closed, the laptop is
shut, or a deploy lands mid-flight. Everything lives in `src/lib/runner/`.

### One entry point, one job list

`GET /api/cron/[job]` is the only endpoint the host calls. `job` is `all`, a job id, or a
comma-separated list, so `/api/cron/all` (what `vercel.json` schedules) and
`/api/cron/market-alerts` (the path the older schedule used) are the same handler. The secret
is checked first: a missing `CRON_SECRET` is **503 naming the variable**, a wrong one is
**401**, and neither executes anything. An unknown job is a **404 that names the jobs that do
exist** rather than an invocation that quietly ran nothing.

Jobs are declared once in `src/lib/runner/registry.ts` with their own interval; adding work
here is how later phases (strategies, orders, alerts) join the schedule. The list, in the
order the runner walks it:

| job | what it does | interval |
| --- | --- | --- |
| `market-alerts` | evaluates every active alert whose interval has elapsed | `MARKET_ALERT_EVALUATION_INTERVAL_MINUTES`, clamped to the daily floor |
| `market-ingest` | refreshes the stored 15m and daily candles and the RSS newswire, and records each source's health (phase 19) | 15 minutes |
| `market-backfill` | checks every maintained candle series for missing slots and restores only those ranges (phase 19) | 6 hours |
| `order-reconciliation` | reads every non-terminal order back from its venue and corrects the local row | `ORDER_RECONCILE_INTERVAL_MINUTES`, 5 minutes by default |
| `deposit-watcher` | reads every enabled network for transfers to issued deposit addresses and credits the confirmed ones | `DEPOSIT_WATCH_INTERVAL_MINUTES`, 5 minutes by default |
| `withdrawal-processor` | advances every withdrawal in flight: hold release, send, retry, settle, and the expiry that releases an unsent one | `WITHDRAWAL_PROCESS_INTERVAL_MINUTES`, 2 minutes by default |
| `ledger-invariants` | reads the book and asserts that every transaction balances, that each asset's debits equal its credits and that no account is overdrawn | 1 hour |
| `retention` | trims provider call records and invocation summaries to their ceilings | 24 hours |

Every interval above is only the gap at which a job *claims* due-ness: the host decides how
often the runner is called at all, and on the entry plan that is once a day (see below), so a
job with a 15-minute interval is delivered daily and reports `NOT_YET_DUE` in between.

Running it by hand is the same call the host makes, which is why the local click-path and the
deployed schedule cannot drift apart:

```bash
cd apps/web && pnpm db:setup && pnpm dev           # in one terminal
curl -s -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/all | python3 -m json.tool
```

The response is the invocation summary: which jobs were due, which ran, which were skipped and
the reason for each. Call it again immediately and every job reports `NOT_YET_DUE` with its
next due time, which is the point — a second call in the same slot must be cheap, not
repeated work.

### A lease, not a hope

A job is claimed with one conditional statement:

```sql
UPDATE "RunnerJob" SET leaseOwner = $1, leaseExpiresAt = $2, attempts = attempts + 1
WHERE jobId = $3 AND nextDueAt <= $4 AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= now())
```

Either it wins the row or it changes nothing, so two concurrent invocations cannot both start
the same job — including two serverless instances, which share no process memory. The due
condition is part of the same statement deliberately: deciding "is it due?" from a read and
then claiming is not enough, because another invocation can finish the job in between. The
first version of this module did exactly that and four concurrent calls to the local endpoint
ran the alert job twice (harmless there, because that job is idempotent — but not a standard
any job that places an order can be held to). `tests/runner-scheduler.test.ts` now pins both
cases: an overlapping call loses the lease race, and a stale read still cannot run a job twice
in one interval.

An invocation killed mid-job leaves its lease behind and nothing else. Once the lease lapses
(120 seconds, well inside the host's 300-second request ceiling) the next invocation reclaims
the job and `attempts` says it happened; the heartbeat marks that run `reclaimed: true`.

### The heartbeat says why nothing happened

Every invocation writes one `RunnerInvocation` row and one heartbeat per job
(`RunnerJob.lastOutcome`, `lastSuccessAt`, `lastFailureAt`, `nextDueAt`, `lastReason*`). A job
that did no work always carries a reason from the shared type — `NOT_YET_DUE` for a job whose
interval has not elapsed, `ALREADY_RUNNING` for one another invocation holds, `NO_ENTRY_CONDITION`
for one that ran and found nothing to do — and a job that threw is `failed` with a mapped
reason (`DATABASE_UNAVAILABLE` naming `DATABASE_URL`, otherwise `UNKNOWN`, whose sentence
points at the server log). One failing job does not stop the others.

`/admin/data` renders it (section **02 / RUNNER HEARTBEAT**): per job, last success, last
failure, next due, cadence, attempts and the reason its last run recorded, plus the last
invocation summary. `GET /api/admin/health` returns the same as JSON under `runner`.

### The host's real cadence, and what it cannot do

A cadence is a promise, so this was checked against Vercel's documentation before anything was
scheduled — `vercel.json` asks for exactly what the host can deliver:

| fact (Vercel docs, 2026-10) | consequence here |
| --- | --- |
| "Hobby accounts are limited to cron jobs that run once per day. Cron expressions that would run more frequently will fail during deployment." | the schedule is `0 0 * * *`. A sub-daily expression would not deploy on the entry plan. |
| paid plans schedule "once per minute" ("Per-minute" precision, against the entry plan's "Per-hour (±59 min)") | the owner can tighten `vercel.json` to `*/5 * * * *` on a paid plan and the per-job intervals take effect as written; no code changes. |
| "Cron job delivery is best effort… occasional transient network errors can prevent a request from reaching your function", and then "your function does not execute, and no runtime log is created for that scheduled run"; "Vercel will not retry an invocation if a cron job fails." | a missed tick is never silently lost: due-ness (not a tick match) decides what runs, so the next invocation picks the overdue work up, at most one cadence late. `NOT_YET_DUE` is the same mechanism seen from the other side. |
| "Cron delivery can also occasionally invoke the same scheduled run more than once." | the lease and the due condition inside the claim statement are what make a duplicate delivery safe, not an assumption that it cannot happen. |
| "Creating a new deployment will not interrupt your running cron jobs; they will continue until they finish." | a deploy therefore cannot cut a job short, and a crash or platform timeout leaves a reclaimable lease rather than a lost job. |
| 300 seconds per request on the entry plan (300 default/max; up to 800 on paid) | the route exports `maxDuration = 300` and the lease is 120 seconds, so a stuck job is cut off at a documented point and becomes reclaimable inside the same hour. |

**What cannot be met honestly on the entry plan: any cadence faster than once per day.** The
job intervals are therefore clamped to the day (`getEffectiveMarketAlertIntervalMinutes`), and
no part of this app claims sub-daily execution. Sources:
[usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing),
[managing cron jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs),
[function duration](https://vercel.com/docs/functions/configuring-functions/duration).

### Measured, on the running app

`pnpm db:setup`, `pnpm dev` with `CRON_SECRET` set, then the endpoint called by hand. `attempts`
was read back from `prisma/dev.db` after each step.

| check | how | result |
| --- | --- | --- |
| a hand run does the work | `curl -H "Authorization: Bearer $CRON_SECRET" …/api/cron/all` | `200`, `market-alerts` **worked**, `retention` **idle** (`NO_ENTRY_CONDITION`), response carries `x-request-id` |
| a second call in the same slot is cheap | the same call again | `jobsDue: 0`, both jobs `not-due` (`NOT_YET_DUE`) with their next due time |
| unauthenticated calls run nothing | no header, then a wrong secret | `401` twice; no job state changed |
| an unknown job is named | `…/api/cron/market-alert` | `404` "Known jobs: market-alerts, retention, all" |
| two (four) concurrent calls run each job once | 4 parallel authorised calls, jobs forced due first | each job's body executed **once**: one `idle` (the run), two `already-running` (lost the lease race), one `not-due` (arrived after the finish); `attempts` rose by exactly 1 per job |
| a killed run is reclaimed | lease left lapsed with `lastFinishedAt` null, then one call | `reclaimed: true`, `attempts` 4 → 5, job completed |
| a stopped database says which variable | the handler against a database with no tables | `503` `{"reason":{"code":"DATABASE_UNAVAILABLE","variable":"DATABASE_URL"}}`, nothing executed |
| the heartbeat view is real | `/admin/data` with an owner session | section rendered with `LAST SUCCESS` / `LAST FAILURE` / `NEXT DUE` / `CADENCE` / `ATTEMPTS` per job and the idle reason (`NOT YET DUE · No alert was due for evaluation…`) |

Two limits this phase does not fix. Local sign-in is closed unless `AUTH_EVM_CHAIN_IDS`,
`APP_BASE_URL` and `SESSION_SECRET` are set, so the owner view above was verified with a minted
owner session rather than through the sign-in flow (the same gap phase 04 reported). And a job
whose run fails is not retried before its next interval: with a daily host schedule, the
honest retry point is the next day, not a fast loop against a provider that is already unhappy.

## One lifecycle for every order

Phase 06 replaced a status string on a row with one lifecycle that every order — and every
long-running process — shares: a status set with legal transitions only, an idempotency key
derived from the caller's intent, a bounded retry policy that records every attempt, and a
reconciliation pass that treats the venue's record as the truth. The state machine itself is
pure (`src/lib/orders/state-machine.ts`) and takes its side effects through an injected port,
so the whole transition table is tested with no database and no venue.

### The status set, and a sentence for each

| status | what it means | terminal |
| --- | --- | --- |
| `CREATED` | The order exists locally and has not been sent to a venue. | — |
| `SUBMITTED` | The order is live at the venue and is waiting to fill or be cancelled. | — |
| `PARTIALLY_FILLED` | Part of the order has executed; the remaining quantity is still live. | — |
| `FILLED` | The whole order executed. Nothing further happens to it. | terminal |
| `CANCELLED` | The order is no longer live. Any quantity that executed before the cancel is kept. | terminal |
| `FAILED` | The venue refused the order or no attempt could succeed. The reason above is the venue's own. | terminal |
| `RECONCILED` | Reconciliation closed the order: the venue held no live record and reported neither a fill nor a cancel. | terminal |

Those sentences are `ORDER_STATUS_DETAIL`, and `/trade` renders them verbatim: a status the
panel cannot explain cannot reach the screen, and a test walks the table so adding one without
a sentence fails the suite. The set is enforced in TypeScript rather than as a database enum
on purpose — development runs the SQLite schema derived from `prisma/schema.prisma`, the
derivation refuses a schema containing an enum, and a Postgres-only enum would break
`pnpm db:setup`. The column stores the status string; this module decides which strings are
legal and `src/lib/orders/store.ts` validates every row it reads back.

### An illegal transition is refused before any side effect

`nextOrderState` answers yes or no for a (status, event) pair, and a refusal carries a code, a
sentence and no state. Callers apply the transition first and write second; the test that
proves the ordering asserts the injected write port was called **zero** times for every
illegal pair, and the same refusal shape is returned by the bot-builder's strategy machine so
a caller handles both the same way.

### The idempotency key comes from the intent, not the request

The key is a SHA-256 over the canonical intent, so an identical submission derives the
identical key; an `Idempotency-Key` header is honoured when a caller wants a deliberate
repeat. Same key and same intent → the original order comes back (`replayed`, and the same
venue order id). Same key with a different intent → `409 IDEMPOTENCY_KEY_REUSED`, because a key
that already means one operation must not quietly come to mean another.

### Retries: bounded, recorded, and never a blind resend

Three attempts, 1 second before the second and ×4 growth capped at 15 seconds. An accepted
submission and a venue refusal both stop the retrying — a refusal is an answer, not a failure
to reach the venue. A timeout is never resent on faith: the order is looked up at the venue
first, because the venue may already hold it. Every attempt writes `ORDER_ATTEMPT` with its
number, the venue's redacted answer and the reason, and the row keeps `attempts`,
`lastAttemptAt` and `lastAttemptReason`, so "why did this fail?" is answered from the row
rather than guessed.

### Reconciliation corrects local state and records both values

`order-reconciliation` is a runner job. It looks up every order that is not in a terminal
state, applies the venue's record, and writes `ORDER_RECONCILIATION` with the field, the local
value and the venue value whenever the two disagree. When the venue's record cannot be applied
legally it writes `ORDER_RECONCILIATION_DIVERGENCE` and counts the order unresolved; a venue it
cannot reach is left alone and counted unresolved too, so a pass never invents a correction.
The job claims due-ness at most once every `ORDER_RECONCILE_INTERVAL_MINUTES` (default 5;
accepted values 1, 5, 15, 30, 60, 360, 1440), and the host's cron cadence remains the real
ceiling — see the runner section above.

### A cancelled partial fill keeps what executed

Fills are cumulative: applying the venue's report twice cannot double-count it, a fill never
decreases and never exceeds the request, and cancelling a partially filled order keeps the
executed part while releasing only what remained.

### Measured, on the running app

`pnpm dev` with `SESSION_SECRET`, `CRON_SECRET`, `AUTH_EVM_CHAIN_IDS` and
`PAPER_VENUE_FILL_DELAY_SECONDS=0` set, a seeded owner session in the browser, and the runner
called by hand.

| step | how | result |
| --- | --- | --- |
| submit and watch it finish | the order panel on `/trade` | `SUBMITTED`, with the venue's acknowledgement; the next reconciliation pass reported the venue's fill and the row read `FILLED`, executed `0.001` of `0.001`, attempts `1` |
| the same order sent twice | the panel's **Send the same order again** | `replayed` — the same order id and the same venue order id, and the order count did not move (8 → 8) |
| a divergent local state | the row hand-edited to `SUBMITTED`/`0`, then a pass | corrected to `FILLED`/`0.001`; `ORDER_RECONCILIATION` carries `[{"field":"filledQuantity","local":"0","venue":"0.001","venueState":"FILLED"}]`, and `ORDER_FILLED` says "The venue reports 0.001 executed while the local record held 0." |
| the venue stopped | `PAPER_VENUE_FAILURE=unavailable`, then submit | `FAILED` after 3 bounded attempts, reason `VENUE_UNAVAILABLE` carrying the venue's own sentence — no error banner, no crash |
| cancel, and cancelling what cannot be cancelled | a resting `LIMIT` order, then a `FILLED` one | `CANCELLED`, releasing the `0.5` that never executed; the same cancel again is `replayed`; cancelling `FILLED` is refused — "FILLED is terminal, so it cannot be cancelled." |
| every step is auditable | the audit rows for one order | `ORDER_CREATED` → `ORDER_SUBMITTED` → `ORDER_ATTEMPT` → `ORDER_FILLED` → `ORDER_RECONCILIATION`, actor `dev-test-account` for the owner's own action and `system` for reconciliation, each with its reason |
| the new routes are swept | `pnpm routes:sweep` with an owner session | `GET /api/trading/orders` serves `{orders,count,lifecycle,venue}`; both mutations refuse with 400/404 and write nothing |

Limits this phase carries, stated rather than implied:

- **The venue is paper.** `dev-paper` is the only venue, the failures above are injected by an
  environment variable, and a real exchange arrives with phases 20–21.
- **The two amounts are the caller's claim.** `notionalUsdCents` and `verifiedBalanceCents` are
  stated by the caller and recorded as what they claimed, not as a verified balance; phase 25
  replaces them with a server-side valuation checked against the risk policy.
- **Reconciliation is as fast as the host's cron.** On the entry plan that is once a day, so an
  order that is wrong can stay wrong until the next pass; a paid plan's tighter schedule is the
  fix, with no code change.
- **"Force a reconciliation" means moving the job's next-due time into the past.** Due-ness is
  what decides what runs, so that is the whole of it.

## A phone wallet signs in

A wallet on a phone signs in through the same nonce, the same EIP-4361 message and the same
verification as an injected wallet — pairing only changes how the wallet is reached. The panel
below the wallet list on `/login` offers one pairing three ways (a QR a desktop scans, a deep
link a phone opens, a link copied into a wallet) and reports which stage it is in: `PAIRING NOT
STARTED`, `PREPARING PAIRING`, `WAITING FOR THE WALLET`, `PAIRED`, `SIGNING IN`, `SIGNED IN` or
`PAIRING FAILED`.

### The project id is read in exactly one place

`resolveWalletConnectProjectId` (`src/lib/auth/wallet-connect.ts`) reads
`NEXT_PUBLIC_REOWN_PROJECT_ID` first and `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` second. Both are
public by definition; neither is a secret. The same function backs the login page, the
`/admin/access` readiness checklist (`src/lib/integrations/readiness.ts`) and the development
configuration banner, so the checklist cannot call a project id ready that `/login` reports as
missing. A value that still reads as a placeholder (`replace-…`, `your-…`, `todo`) counts as unset,
which is what makes a half-filled `.env` report the variable instead of failing at the relay.

App-wide `wagmi`/RainbowKit stays mounted in `src/components/wallet-connection-provider.tsx`, but
it carries injected connectors only: a WalletConnect connector there would be a second pairing
implementation with its own modal and its own project-id precedence. There is one pairing path,
and it is the page's.

### What the page says, in every state it can be in

| situation | what `/login` shows |
| --- | --- |
| neither variable set | `PROJECT ID REQUIRED` in the status line, and the panel says "WalletConnect mobile pairing needs a project id from the Reown dashboard. Set `NEXT_PUBLIC_REOWN_PROJECT_ID` (or `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`) and restart, and the QR appears here." — a sentence, not a disabled control, and the rest of sign-in is untouched |
| served from a host that is not `APP_BASE_URL` | the same place, with the refusal: "This page is served from `127.0.0.1:3211`, but sign-in for this deployment is configured for `localhost:3211`. A wallet would be asked to trust the wrong site, so pairing is refused." Decided on the server from the request `Host`, so it is in the page's own HTML |
| the relay never issues a code | `RELAY_UNAVAILABLE`, 20 seconds, with `START PAIRING AGAIN` |
| the wallet declines | `PAIRING_DECLINED` — "The wallet declined the pairing, so no connection was made and nothing was signed." |
| the code lapses unanswered | `PAIRING_EXPIRED`, produced by the page's own countdown when the `wc:` URI states `expiryTimestamp` (nothing is invented when it does not) |
| the paired wallet is on a chain `AUTH_EVM_CHAIN_IDS` does not accept | `UNSUPPORTED_CHAIN`, naming the chain it is on and the chains sign-in accepts — read before the wallet is asked for an account or a signature |
| the relay refuses the project id | `PROJECT_ID_REJECTED`, naming the variable and the dashboard check |

Every one of those offers the same in-place retry: `START PAIRING AGAIN`, which goes back through
`PREPARING PAIRING` so a stale code is never reused. Nothing on this surface needs a page reload.

### What is not logged

A `wc:` URI carries a symmetric key, so `redactedPairingUri` (`symKey=redacted`) is the only form
meant for anywhere a human reads one, and the pairing modules do not log at all — a test walks the
three files for `console.*` and for telemetry calls. Measured on the running dev server: the two
request logs from the click-path run contain zero occurrences of `symKey`, `wc:`, the project id's
value or `veylora_session=`.

### Measured, on the running app

`pnpm dev` on `http://localhost:3211` with `APP_BASE_URL=http://localhost:3211`,
`AUTH_EVM_CHAIN_IDS=1`, a throwaway `SESSION_SECRET` and `NEXT_PUBLIC_REOWN_PROJECT_ID` set to a
public placeholder, driven from a real browser. The double that stands in for the relay is
dev-only (`window.__veyloraPairingFactory`, compiled out of production builds), so the failure
paths can be run without a phone and a relay that agrees to fail on request.

| step | what was observed |
| --- | --- |
| the port receives the configuration | `{ projectId: "dev-public-project-id", origin: "http://localhost:3211", chainIds: [1] }` — the origin is the validated `APP_BASE_URL`, not a request `Host` |
| QR, deep link and copy link | one `wc:` URI: the QR encodes it, the deep-link anchor's `href` is byte-identical to it, and **COPY LINK** writes the same value (the button becomes `LINK COPIED`) |
| the phone approves | `WAITING FOR THE WALLET` → `SIGNING IN` → `SIGNED IN`, then `/`: "Signed in as `0xBb67...3387`" — the phone's address, whose `personal_sign` result is a real signature over the nonce route's own message |
| the session it creates | `GET /api/auth/session` → `{authenticated: true, user: {address: "0xBb67CB390ABE14dDf4b73f97AfC7F1Ec33F23387", chainReference: "1"}}` |
| the signed-in path | `eth_chainId` → `eth_requestAccounts` → `personal_sign`, and then the same `POST /api/auth/nonce` / `POST /api/auth/verify` an injected wallet uses |
| decline in the wallet | `PAIRING_DECLINED` with its own sentence, `START PAIRING AGAIN` on the same page |
| the code lapses | countdown `0:08` → `PAIRING_EXPIRED`, retry in place |
| the phone paired on Base | `UNSUPPORTED_CHAIN`, "The paired wallet is on Base (chain 8453). Sign-in accepts Ethereum Mainnet. Nothing was signed." — and the wallet was asked for `eth_chainId` only |
| cancel, then start again | `CANCEL PAIRING` → `PAIRING NOT STARTED` with `START PAIRING` back, and a fresh URI |
| the real provider, with a placeholder project id | the real `@walletconnect/ethereum-provider` ran in the browser; the relay answered its socket with `code 3000 (Project not found)` for the placeholder id and never issued a pairing code, so the port's own 20-second bound produced `RELAY_UNAVAILABLE` with a retry — the real port's own timeout path, not a simulated one |
| the project id unset | `PROJECT ID REQUIRED`, the sentence naming both variables, no QR and no `wc:` anywhere in the page source; injected-wallet sign-in still completed (`3 INJECTED WALLETS DETECTED` → `SIGN IN WITH METAMASK` → signed in as `0xBb67...3387`) |
| a wrong host | the refusal sentence above, rendered in the page's own HTML |

Limits this phase carries, stated rather than implied:

- **No real phone has paired yet.** Everything above is the desktop half plus a double standing in
  for the relay, and the one run with the real provider used a placeholder project id the relay
  refuses, so a QR scanned by a real wallet on a real device against a registered project id is the
  owner's step, not a measured one. What *is* measured is that the real provider runs, meets the
  relay, and that a relay which never issues a code produces a bounded failure with a retry.
- **One relay reading, no relay success.** The relay was reached and answered the socket with
  `code 3000 (Project not found)`; a successful handshake (`display_uri` → a scanned `wc:` code)
  has not been observed here, and the relay's own refusal reached the browser console rather than
  the page, because the provider's `connect()` promise never settled and the port's 20-second bound
  fired first. A registered project id is what turns that reading into a real pairing.
- **The wallet's own screens are not exercised.** The double stands in for `EthereumProvider`; the
  pairing's screens, states and failures are the page's, and those are what the table above runs.

## A smart account signs in (EIP-1271)

An address on an EVM chain is one of two things, and the two are proved differently.

An **externally owned account** is a key pair: `ecrecover` the signer from the signature and compare
it with the address the message claims. That is a pure operation on the signature — no network, no
trust in anyone — and it is what every earlier phase verified.

A **contract wallet** — a Safe, an Argent account, an ERC-4337 smart account, a delegation account —
has no key at its address, so nothing can be recovered from a signature for it. The contract itself
decides, by implementing EIP-1271: `isValidSignature(bytes32 hash, bytes signature)` returns the
magic value `0x1626ba7e` for a signature it accepts, and reverts (or returns anything else) for one
it does not. That decision only exists on chain, so verification of a contract wallet is a network
call — and a network call can fail.

`src/lib/auth/contract-account.ts` builds that call, makes it, and turns every outcome into one of
three answers: **accepted**, **refused**, or **not checked**. The third is the one the design exists
for. A relay timeout, an unreachable node, a chain this deployment has no endpoint for, an endpoint
answering for a different chain, an address with no code at all — none of those is a signature, and
none of them is ever reported as one.

### One batched call, on the chain the signature names

`eth_chainId`, `eth_getCode` and the `isValidSignature` `eth_call` go out together in one batched
JSON-RPC request through the same key-bearing endpoint resolution every other RPC read uses
(`src/lib/rpc/networks.ts`), bounded by a five-second timeout. The batch is one round trip on
purpose: the verdict cannot come from a mixture of chains. `eth_chainId` is checked against the
chain the signed SIWE message is bound to, so an endpoint pointed at the wrong network is caught
rather than trusted; `eth_getCode` separates "there is no contract here" from "the contract said
no", because an empty `eth_call` result would otherwise read as a refusal.

`isValidSignature` returning exactly `0x1626ba7e` is the only acceptance. A longer value that merely
starts with those bytes is a refusal, and so is a revert — the standard tells implementations to
revert for a signature they do not accept, so a JSON-RPC error from that one call is the contract's
own answer and not an unavailable check.

### The refusal names, and what each one means for the person reading it

Every refusal from `POST /api/auth/verify` carries a stable `code`, a sentence, and whether the same
attempt could succeed later. The login page keeps the code and the wording and decides from
`retryable` whether to offer the retry, instead of inferring it from a status code.

| code | status | retryable | what the page says, in short |
| --- | --- | --- | --- |
| `SIGNATURE_INVALID` | 401 | no | the signature does not belong to the address it claims, and this deployment verifies key-based accounts only |
| `SIGNATURE_FORMAT` | 401 | no | the signature is not a shape a wallet could have produced; nothing was verified |
| `CHAIN_NOT_ALLOWED` | 401 | no | the message is bound to chain *n*, which this deployment does not accept — refused before any contract is asked anything |
| `CONTRACT_SIGNATURE_INVALID` | 401 | yes | the contract was asked on the named chain and refused it, with the answer it gave |
| `CONTRACT_VERIFICATION_UNAVAILABLE` | 502 | yes | the endpoint could not be reached, timed out, or answered with an error — the signature was not checked *and* not accepted |
| `CONTRACT_ACCOUNT_NOT_DEPLOYED` | 503 | no | there is no contract at that address on that chain, so it cannot be a contract wallet there |
| `CONTRACT_CHAIN_MISMATCH` | 503 | no | the endpoint is answering for a different chain, so its answer could not be trusted — a deployment misconfiguration |

Nothing is disabled for a wallet this does not support. An unsupported wallet gets a sentence naming
what is unsupported and why, and an EOA still signs in exactly as before.

### One session, and the account type on the identity

Both kinds land in the same session: the same signed cookie, the same claims, the same role
resolution, the same permission model. Nothing about authorisation depends on how the signature was
proved. What the account type changes is what is *recorded and shown*: `WalletIdentity.accountType`
is `EOA` or `CONTRACT` (a string, validated on read by `isAccountType`), the audit event for the
sign-in carries it, and `GET /api/auth/session` returns it beside the address an EOA session already
returned. Rows written before this phase default to `EOA`, which is accurate: everything signed in
before contract verification existed was verified by `recover`.

`/admin/access` shows it per wallet — "Contract wallet (EIP-1271)" or "Externally owned account
(EOA)" beside the role — worded on the server, because the module that knows the words also resolves
RPC endpoints and those carry the Alchemy key, which must never reach a client bundle.

### What is not built here

**Session keys.** An EIP-1271 account is the first account here that could be *acted for* rather than
*signed by*: an owner key can grant a scoped key that acts for the account within limits, without a
Safe's threshold of signatures for every action. That is the path on-chain strategy execution will
need, and it is deliberately not implemented in this phase — no key is stored, no delegation is
requested, and nothing acts for a user. It is recorded here and in
`proof/phase-09-eip1271-smart-accounts.md` as the follow-up that the on-chain execution phase
(after 21) will need, together with the two things it will require that do not exist yet: a place to
store a session key that is not the credential store, and a policy that bounds what it may do.

## Accounts, roles and onboarding

A signed-in account is a row (`User`) with a wallet identity, a global role, optional team
memberships and optional per-permission grants. `/admin/access` edits all of it as data, and
`/onboarding` is the first-run checklist a brand-new account finishes.

### A first sign-in writes exactly one account and one wallet

What a sign-in does to the account is decided by `planSignInProvisioning` in
`src/lib/auth/sign-in-provisioning.ts` — a pure function over four facts the route has already
read — and only then written by the transaction. The plan is what makes the acceptance criterion
countable:

| the wallet | `creates.users` | `creates.walletIdentities` | role |
| --- | --- | --- | --- |
| nobody has signed in with it | 1 | 1 | `VIEWER`, or the bootstrap's `OWNER` |
| it has signed in before | 0 | 0 | whatever it already had |
| it is revoked, or its account is not `ACTIVE` | refused 403, nothing written | | |

Every accepted sign-in refreshes the account's `lastSeenAt` (`refreshLastSeen` in the plan), which
is why a repeat sign-in *can* be seen on the record without the wallet being duplicated. The
`AUTH_SIGN_IN` audit row carries the counts (`created: { users, walletIdentities }`) and whether
the account was new, so the claim is checkable after the fact rather than only in a test.

### The development owner wallet is one address, written down once

`DEVELOPMENT_OWNER_EVM_ADDRESS` (`src/lib/auth/config.ts`) is what development falls back to when
`INITIAL_ADMIN_EVM_ADDRESS` is unset, and it is the address `prisma/seed.ts` writes as the owner
wallet. Both halves read the one constant, so a local database seeded with nothing configured and a
fresh sign-in as the documented local address agree about who the owner is. The fallback applies in
development mode only (`isDevelopmentMode`, i.e. `NODE_ENV === "development"`): a test run or a
deployment with nothing configured still grants nobody `OWNER`.

### The checklist is four records, not four checkboxes

`/onboarding` shows four steps, and each one is complete when the row behind it exists — there is no
checklist table to drift out of step with reality (`src/lib/onboarding/checklist.ts`):

| step | the record that completes it | link |
| --- | --- | --- |
| connect a wallet | the account's `WalletIdentity` | `/login` |
| see a balance | `User.lastBalanceReadAt`, written by a completed portfolio read | `/#portfolio` |
| place a paper trade | a `TradeOrder` the account created | `/trade` |
| set an alert | a live `MarketAlert` the account owns | `/#alerts` |

Deleting the row behind a step reopens that step, which is the honest behaviour for a checklist
derived from the database. The sidebar carries `ONBOARDING n/4` on every page for a signed-in
account (two bounded counts), and a brand-new sign-in lands on the checklist instead of the overview.
The one sentence the *page* adds is why a step cannot be completed yet: with no balance provider
configured, step two names `ALCHEMY_API_KEY` instead of sending someone to a surface that will
answer "not connected".

### Access changes carry a reason, and revocations exist

Every write in `/admin/access` requires a `reason` of 3–200 characters, and it is stored in the
audit row's payload next to what changed (`accessAuditPayload`). The actions are assign and
**revoke** a global role, create and **remove** a team, assign and **revoke** a team membership, and
set per-user function grants. There is no approval step and no second person, by design; the reason
is what makes the change legible afterwards.

The owner role is not assignable or revocable here — it follows the configured owner address — and
the refusal says that instead of failing silently.

### Team membership scopes what an administrator sees

`getAdminAccessDirectory` narrows its query by the viewer's scope, computed by `resolveAccessScope`:
the owner sees every account; an `ADMIN` sees the accounts in their own teams plus their own record;
and a grant of `admin.access.read.all` widens an administrator back to everything. The narrowing is
in the `where` clause rather than applied afterwards, so a scoped request never loads rows it may not
show, and the page says which scope it is rendering.

### A denial names the permission

A permission refusal is one sentence, built in one place (`missingPermissionMessage`):

> Missing permission risk.policy.manage (Manage global risk policy). An administrator grants it in Access.

The same sentence is the API body (`{ error, permissionKey }`, via `accessRefusalPayload`), the notice
a page renders in its own shell (`PermissionNotice`) instead of a 404 or a blank page, and the
text the checklist and admin pages share. A role refusal says which roles the surface needs. Every
refusal is reachable, visible and test-covered (`tests/access-control.test.ts`,
`tests/onboarding.test.ts`, `tests/sign-in-provisioning.test.ts`).

### Measured, on the running app

Fifty-one checks against a dev server on a **fresh, unseeded** SQLite database
(`prisma db push --schema prisma/schema.dev.prisma`, no seed) with `INITIAL_ADMIN_EVM_ADDRESS` set
to the owner wallet, all passing (`proof/phase-11-accounts-roles-and-onboarding.md`):

- a brand-new sign-in with the owner wallet → `OWNER` via `INITIAL_OWNER_BOOTSTRAP`, 1 account and
  1 wallet created; signing in again → 0 accounts, 0 wallets, still `OWNER`;
- a second, unrelated wallet → exactly 1 account and 1 wallet, `VIEWER`; a repeat sign-in left the
  counts unchanged and moved `lastSeenAt` from `13:11:52` to `13:11:54`;
- the checklist went `1/4` → `2/4` (a real Alchemy balance read for the wallet) → `4/4` using only
  the four linked surfaces, ending with nothing left over;
- an admin action without the permission answered `403` naming
  `risk.policy.manage (Manage global risk policy)`, the same sentence appeared on `/admin/risk` and
  `/admin/data`, granting it made the next request succeed, and revoking it stopped it again;
- a change with no reason was refused `400` with the reason rule; the owner's own role was refused
  `403` with a sentence;
- a scoped `ADMIN` in one team saw 1 account (themselves) where the owner saw 3, and granting
  `admin.access.read.all` lifted that same session back to 3;
- all seven access actions left audit rows with both an actor and a reason.

## Money arriving on chain: deposits and crediting

A deposit address per account per enabled network, transfers detected by a job that runs whether
or not a page is open, and crediting only after the confirmations the owner configured for that
chain — with a state and a sentence for every arrival that is *not* credited.

### An address per account per network, derived rather than allocated

The address is a pure function of the seed and the account's own id:

```
index   = first 4 bytes of keccak256("<userId>:<network>") mod 2^31
address = BIP-44 m/44'/60'/0'/0/<index> from DEPOSIT_ADDRESS_MNEMONIC
```

Nothing is allocated by a counter, so there is no allocation to lose: the same account and network
derive the same address on every machine, forever. The `DepositAddress` row is the *record* of that
derivation — what the watcher looks transfers up by — not the source of it, which is why deleting
the row would not change the address. Two boundaries are deliberate: this is the Ethereum path
(`m/44'/60'/…`), so it is EVM-only, and the index stops one bit short of 32 bits because BIP-32
reserves the top bit for hardened children — a larger index would be a path no wallet can spend
from.

`DEPOSIT_ADDRESS_MNEMONIC` is therefore permanent in the same way the session secret is: changing it
changes every address, and money sent to the old ones still arrives on chain but is recorded as
`UNMATCHED`, because the address is no longer one this deployment issued. The variables are listed
in `.env.example`, and the seed belongs in the same secret store as the session secret.

### The watcher is a phase 05 job, not a page

`deposit-watcher` runs every `DEPOSIT_WATCH_INTERVAL_MINUTES` (5 by default) and again whenever a
signed-in account asks for a check (`POST /api/deposits`), and it is the only thing in this phase
that credits anything. One pass is three separated steps:

1. **Scan.** One block window per network (`DEPOSIT_WATCH_BLOCKS`, 250 by default) through the same
   key-bearing Alchemy endpoint every other RPC read uses. ERC-20 transfers are read with the
   recipient filter — on `topics[2]` rather than on the deposit token's contract, which is what lets
   an arrival in a *different* token be seen at all — and blocks are read one by one, because a
   native transfer writes no log. A read that fails raises; it never comes back as "nothing
   arrived".
2. **Classify.** A pure function from one observation plus the policy to a state and a sentence.
   The order matters: an arrival we cannot attribute is unmatched whatever it is worth, a token
   that is not the enabled one is not credited however much it is worth, and the dust guard is
   applied last so the reason shown is the first thing that is wrong, not the least important one.
3. **Record.** One row per transfer, keyed by the chain's own identity for it —
   `(network, txHash, logIndex)` — so a restart, a re-read of the same window or two runners at once
   all end at the same row. A re-read of a known transfer is counted and reported, and the row's
   `evidenceJson` keeps the log it was decided from.

Then a second look re-checks every `PENDING` row: its receipt is verified against the block hash it
was recorded in, the confirmations are recomputed from the head, and it is either credited (a
conditional update from `PENDING`, so two runs cannot both credit it) or found to be gone.

### Six states, and only one of them is money

`PENDING` · `CREDITED` · `REVERTED` · `BELOW_DUST` · `TOKEN_DISABLED` · `UNMATCHED`, defined in
`src/lib/deposits/states.ts`. A reorg that removes a pending transfer moves it to `REVERTED` with
`CHAIN_REORGANIZED` and the block evidence in the reason — the pending promise is the only one this
phase makes that the chain can still break. Every other state is a decision with a reason attached,
and the next run does not re-decide it.

The confirmation count and the dust guard come from `DEPOSIT_CONFIRMATIONS_<SLUG>` and
`DEPOSIT_MIN_AMOUNT_<SLUG>` (`ethereum-mainnet` → `DEPOSIT_CONFIRMATIONS_ETHEREUM_MAINNET`), and the
token from `DEPOSIT_TOKEN_ADDRESS_<SLUG>`/`_DECIMALS_`/`_SYMBOL_` — required only where no official
deployment is known, which is the testnets. Each is shown as configured-by-you or defaulted, and a
value that cannot be read is reported as a problem rather than rounded into a different policy.

### What the owner sees, and what it refuses to say

`/trade`'s deposit section (`src/components/deposit-panel.tsx`) shows the address with copy and QR,
the network and chain id, the token with the note that says what it actually is on that chain, the
confirmations required, the dust guard, the derivation path, a per-network tab for every network in
the registry with its status, the live state of each arrival with the confirmations remaining, and a
link to the explorer page of every recorded hash. Nothing on it is decided in the browser: the
address, the counts and the totals all come from `GET /api/deposits`.

The figure at the top is labelled *credited to this account* and is the sum of the rows that reached
`CREDITED` — it is what the chain paid in, not a trading balance and not a ledger entry (phases 13
and 14 own those). A deployment that cannot derive an address answers with the variable that is
missing rather than an empty panel, a slug in `DEPOSIT_ENABLED_NETWORKS` that this build does not
know is named rather than dropped, and a network whose token is half-configured is reported as such
instead of being watched with a guess.

### Measured, on the running app

Against a local HTTPS chain stand-in (head 100, `DEPOSIT_CONFIRMATIONS_ETHEREUM_MAINNET=2`) with a
session minted for the seeded owner: `GET /api/deposits` issued one address and the second read
returned the same one; the check (`POST /api/deposits`) recorded four arrivals and produced
`credited 1`, `awaiting 1` — 20 USDT credited at 2/2 confirmations with its hash and block, 3 USDT
pending at 1/2 with "1 more before it is credited", 5 units of a token that is not the enabled one
and 0.5 native ETH both `TOKEN_DISABLED` with `TOKEN_NOT_ENABLED` and never credited; the replay
credited nothing a second time (one `DEPOSIT_CREDITED` row, total still 20 USDT); `GET
/api/deposits/<address>` served the four rows with the confirmations remaining and 404'd a
stranger's address; and the audit trail held one `DEPOSIT_ADDRESS_ISSUED`, four `DEPOSIT_DETECTED`
(two `SUCCESS`, two `REFUSED` with their reasons) and one `DEPOSIT_CREDITED`. In the browser the
panel rendered the address with its QR and `COPY` → `COPIED`, the credited total, the pending line,
the four rows with hashes, confirmations and reasons, and the run summary from its own `CHECK NOW`;
no console error and no failed request.

### What this phase does not do

- **It is not a balance.** A credited deposit is the durable record that the money arrived and is
  owed to the account. The ledger that turns it into a spendable balance is phase 13, and nothing
  here debits, moves or holds funds.
- **A credited deposit is not re-checked against a reorg.** Crediting is final in this phase, and
  un-crediting money already counted is a reconciliation decision for the ledger. That boundary is
  stated here rather than left implicit, and the `REVERTED` path covers the pending rows the chain
  can still break.
- **It is EVM-only**, for the derivation reason above, and it credits the token the owner enabled on
  that network — it does not price an arrival in US dollars or decide which chain community
  considers a bridged token authoritative.
- **A token that is not the enabled one is labelled from the log**, not from the token's own
  metadata: the row shows `UNKNOWN TOKEN` with the contract address in its reason, because reading
  `symbol()` from a contract that is by definition untrusted is a call this phase does not make.

## Money leaving: withdrawals and their failure paths

`src/lib/withdrawals/` takes a spendable balance back out to a wallet the owner names, and every
way that can go wrong is its own state with its own sentence. The path is one reservation, one
signature, one broadcast, one settlement:

| step | what it does | what it refuses to do |
| --- | --- | --- |
| request (`request.ts`) | validates network, destination (EIP-55 checksum, never lower-cased into someone else's address) and amount, resolves the fee, and reserves `amount` in the ledger **in the same database transaction as the row**, under a lock taken before the balance is read | write a withdrawal row for a refusal; reserve without a row that explains it |
| send (`execute.ts`) | allocates the nonce, signs once, stores the signed bytes and the hash on the row, then broadcasts under a compare-and-set claim | sign twice for one request, or send anything other than the stored bytes on a retry |
| settle (`confirm.ts`) | reads the network's confirmation count, marks the row `CONFIRMED` with its hash, and takes the fee out of the amount at that moment, with the transfer that earned it | mark anything complete without a confirmation, or take a fee for a transfer that did not happen |
| exit | releases the amount when a request was never sent (expiry or an immediate cancel), and offers a cancellation *attempt* for a transfer that has been silent past `WITHDRAWAL_CANCEL_AFTER_MINUTES` | leave a failure with no path forward, or promise that a sent transfer came back |

The failure taxonomy is data (`states.ts`), not scattered strings — insufficient balance, invalid
destination, invalid amount, network unsupported, RPC unavailable, nonce conflict, transaction
reverted and expired request, each with a state, a sentence, an answer to "would asking again
change this?" (`retryable`), and an audit row that names the destination.

### The only hold is the owner's own, and it is admin data

A first withdrawal to an address this account has never used can be held for a window the owner
sets on `/admin/access` (`GET`/`PUT /api/admin/withdrawals`, audited, permission-gated). The
environment value `WITHDRAWAL_NEW_ADDRESS_WINDOW_MINUTES` is the fallback for a deployment whose
row has never been written; a saved row always wins, and both the withdrawal surface and the admin
page say which of the two is in force. **Zero is a complete answer** — it holds nothing — and the
table holds that one column and nothing else: there is no approval flag, review state or switch
that could stop a withdrawal the owner asked for, which is what the phase file requires and what
`validateWithdrawalOwnerSettings` enforces by refusing unsupported fields.

Editing the number never moves a withdrawal already waiting: a held row carries its own
`holdUntil`, so the setting is a rule for new requests rather than a lever over existing ones.

### In development, every failure is reachable by hand

`WITHDRAWAL_BROADCAST_MODE=simulated` signs the **real** transfer (same calldata, same sender key,
same hash) and mines it one confirmation per check without touching a chain, marking every row
`simulated: true` so a confirmation nobody's chain produced cannot be read as money. It is refused
outside `NODE_ENV=development`. `WITHDRAWAL_SIMULATE_FAILURE` then makes a send fail a declared way:
`rpc-unavailable` and `nonce-conflict` leave the row `BROADCAST_FAILED` with the amount still
reserved and the next pass retrying it; `reverted` mines and reverts, so the row ends `FAILED` and
the amount goes back.

### Measured, on the running app

With a session minted for the seeded owner, the phase 12 chain stand-in funding the balance, a
1 USDT fee and the window set to 30 minutes: `GET /api/withdrawals` read `window 30 minutes
(deployment-default)` with one of six networks ready to send on; `GET`/`POST /api/deposits` credited
20 USDT; an invalid destination, an over-balance amount and an unknown network were refused `400
INVALID_DESTINATION`, `409 INSUFFICIENT_BALANCE` and `503 NETWORK_UNSUPPORTED` with their own
sentences and **no row and no reservation**; each of the three simulated failures left exactly the
state above; a first withdrawal of 5 USDT was `HELD` until its window, the window was then saved as
`0` through `PUT /api/admin/withdrawals` (the already-held row was not moved, and cancelled
immediately with the amount returned); and a withdrawal of `amount 20 / fee 1 / net 19` went
`RESERVED` → `BROADCAST` with `0x751cfbc3a385…3bd3e8` and the amount still reserved → `CONFIRMED 2/2`
with the same hash, leaving the balance at `0 / 0` and the platform's fees bucket holding exactly
`1 USDT`. Replaying the same request returned the same withdrawal (`created: false`); the same key
with a changed amount was refused `409 IDEMPOTENCY_KEY_REUSED`.

### What this phase does not do

- **It does not send anything on a real chain by itself.** The on-chain port is written and its
  refusals are mapped, but the measured run above used the development simulation; nothing here
  claims a funded hot wallet was drained on a live network.
- **The fee is an amount, not a policy.** `WITHDRAWAL_FEE_<ASSET>` is what is taken today; the fee
  table, its visibility before someone commits, and one truthful pricing page are phase 16.
- **A cancellation of a sent transfer is an attempt.** Taking a transfer back on a nonce-counting
  chain means sending a same-nonce replacement at a higher fee, and which one a miner takes is the
  network's answer — the response says `replacement-sent` (202) and the next pass reconciles it.
- **No venue or off-chain balance goes out through here.** Withdrawals are on-chain only; pulling
  funds out of a connected exchange is phase 20.

## What the local seed covers, and what it cannot

`prisma/seed.ts` writes, with fixed ids: the owner account at `OWNER` (keyed from
`INITIAL_ADMIN_EVM_ADDRESS`, falling back to `DEVELOPMENT_OWNER_EVM_ADDRESS` — the same constant
`shouldBootstrapInitialAdmin` resolves to in development, so the seeded owner and the sign-in
bootstrap cannot disagree about who the owner is), a local test account
with a `TRADER` role and its team membership, the three singleton settings rows, the global
risk policy matching the admin defaults, three market alerts (active, triggered and paused)
with an event, five audit events, and three local unsubmitted order records. Every value is
marked `dev-`/`test-`; nothing is copied from another database and no credential material of
any kind is written.

Two of the things this phase asks the seed for have no table to be inserted into yet, so they
are seeded where they actually live rather than faked:

- **A funded balance and transactions.** There is no cash balance or ledger table yet — phase 12
  added deposits and their crediting, and phase 13 adds the ledger and balances. Until then the
  funded balance and its three transactions are the PAPER ledger's, seeded at boot by
  `src/lib/paper-trading/dev-seed.ts`. The three order records above are the persisted half.
  Deposits are deliberately *not* seeded: an arrival is a fact about a chain, and a seeded one
  would be a fabricated row on the one surface this phase exists to keep honest.
- **Strategies in every lifecycle state.** A strategy is a PAPER bot in a process-local store,
  not a database row, so the same module seeds the draft, paper and stopped set when the dev
  server starts.

Market candles and headlines are deliberately **not** seeded. They are provider data, and
inventing them would put fabricated prices on a screen this project promises shows only real
values; the news panel reports how many feeds are actually cached instead.

## One fee table, and the page that renders it

`src/lib/fees/` holds every price the deployment charges. `table.ts` stores **versions**
rather than a mutable row: a save inserts a `FeeSchedule` row with an `effectiveFrom`,
nothing is edited or deleted, and the version in force is the latest one whose time has
passed. That is what makes a future-dated change stageable, the past readable at the price
it was charged, and the audit event a save writes point at rows that still say what they
said. `amounts.ts` is the arithmetic the panel and the server share; `apply.ts` is the
performance fee, posted by the ledger.

- **The withdrawal path and `/pricing` read the same row.** `readPricedWithdrawalPolicy`
  overlays the stored table on the deployment policy, and the pricing page renders
  `pricingRows` from the same `withdrawalFeeFor`/`networkCostFor`. There is no second list
  to update, which is why the page cannot publish a number the code does not charge.
- **Zero is a price.** `formatFeeAmount` renders it as `no fee`, and a zero fee posts no
  ledger entry. A version that names no asset charges that asset nothing — not the last
  asset's fee.
- **The fee is deducted; the network cost is disclosed.** The owner authorises a gross
  amount, arrives at gross minus fee, and the chain's gas is printed beside it as paid by
  the platform. `quoteWithdrawal` is the one function that subtracts them, and it refuses a
  fee at or above the gross before anything is reserved.
- **A performance fee is a movement, not a number.** `chargePerformanceFee` posts a
  balanced `PERFORMANCE_FEE` transaction from the owner's `AVAILABLE` account to
  `platform:fees:<asset>`, keyed by the result and carrying `sourceType`/`sourceId`;
  `reversePerformanceFee` posts the opposite legs referencing the original. A loss or a
  flat result pays nothing (floor at zero), and the percentage is parsed as basis points so
  `12.5%` is exact.
- **The page says where its numbers came from.** `/pricing` prints the version's effective
  time and reads at request time; if the table cannot be read it states no price at all
  rather than an old one.
- **Caps are table data with owners.** `fees.manage` guards the editor at `/admin/fees`;
  the default tier's venue-connection cap is enforced by the credential path today, and bot
  caps are enforced by the bot builder when it ships (phase 30).

`WITHDRAWAL_FEE_<ASSET>` survives only as the fallback for a deployment whose fee table
cannot be read at all. Once a version exists it replaces that value for every asset, so a
deployment moving to the table must save one version to keep charging.

Proof for the click-path, the audit rows and the limits of the run:
[`proof/phase-16-fees-and-pricing.md`](../../proof/phase-16-fees-and-pricing.md).

## Market data the rest of the product can trust

`src/lib/market-data/` holds the candles, the headlines, the indicators and the two services that
read them. Three surfaces consume the same numbers — the screener, the alert evaluation and the
assistant — so the phase exists mainly to stop the same figure being computed twice.

- **Ingestion is an upsert against a unique key.** `MarketCandleRecord` is unique on
  `(providerId, symbol, interval, openTime)`, so `market-ingest` writing the same window twice
  updates those rows instead of appending a second copy, and `market-backfill` overlapping a range
  that is already stored adds nothing. That is what lets both jobs be re-invoked at any cadence the
  host can deliver.
- **A gap is measured against closed candles only.** The expected slots are generated from the
  interval and the closed-candle boundary, so a candle that is still forming is never reported
  missing — otherwise every run would ask for the incomplete candle, the provider would correctly
  omit it, and the hole would be permanent. `findCandleGaps` returns non-overlapping ranges, so one
  missing candle is one request.
- **A failing source is skipped, never allowed to block a run.** Each symbol/interval and each news
  feed is an independent operation whose result is recorded, not thrown: the run summary names every
  failure with its reason, and the sources that answered are still stored. Health is kept twice and
  deliberately so — the durable `ProviderCallRecord` rows answer "calls, failures, error rate,
  latency, last success, last failure, last outcome" after a restart, while the run-local registry
  sees the failures the HTTP record cannot (a 200 with an unreadable body). Three consecutive
  failures start a 60-second cooldown, so a broken source costs one call a minute rather than one
  call per symbol per run.
- **One indicator module, imported everywhere.** `src/lib/market-data/indicators.ts` is the only
  place RSI is computed. The screener, the alert evaluation, the RSI backtester, the paper-trading
  engine, the assistant route and the market chart all import it, so a number in two places cannot
  disagree.
- **`/screener` evaluates a condition over a symbol set.** `RUN SCREEN` refreshes only the symbols
  whose stored series are missing or stale, then evaluates what is stored. The condition and
  threshold are the alert model's own (`PRICE_ABOVE`, `PRICE_BELOW`, `RSI_14_ABOVE`, `RSI_14_BELOW`),
  validated by the same module the alert endpoint uses. Every row carries its value, whether it
  matched, the observation time, the provider that supplied it and its freshness; a symbol with no
  closed candle is listed with the reason rather than dropped, and every run states its as-of time,
  the newest candle that answered it (`dataAsOf`), the providers and a `resultHash` that covers the
  condition and the rows but not the clock.
- **A saved screen is a stored definition plus its runs.** `Screener` is unique per `(userId, name)`
  and `ScreenerResult` keeps every run — a re-run is a new row, never an overwrite, and the twenty
  most recent are retained. Because a result stores its own as-of time, the view can compare the
  last two runs by hash and say "identical to the previous run" with evidence instead of prose.
  `CREATE ALERTS` turns the matches into market alerts **using the screen's own condition and
  threshold**, so a screen cannot create an alert it did not evaluate, and a symbol that already has
  the same active alert is skipped rather than duplicated. `OPEN ALERTS` lands on the alert list at
  `/#alerts`.
- **No browser is required for any of it.** Ingestion and backfill are phase 05 jobs
  (`market-ingest`, `market-backfill`), so the candles the screener reads are refreshed on the
  schedule whether the panel is open or not.

The two providers here are public and keyless — the Coinbase Exchange REST feed and the RSS
newswire — so this deployment has no market-data credential to break. The failure path is exercised
the way it actually fails (a candle source that refuses every call) and recorded in the proof below.

Proof for the click-path, the failure run and the limits of the run:
[`proof/phase-19-market-data-and-screener.md`](../../proof/phase-19-market-data-and-screener.md).

## Venues and keys: one interface, one decision per question

`src/lib/venues/` is the only place a venue's *name* decides anything. A trading path asks for
the capabilities a connection published and gets either a result or a refusal that names what was
missing — it never branches on `venue === "kraken"`.

- **One contract, four venues.** `types.ts` holds the contract and is client-safe, so the
  connected-accounts panel renders the same descriptors the server enforces. `ccxt-adapter.ts`
  implements it for Binance, Kraken and Coinbase Advanced (CCXT, spot accounts, transport
  injectable for tests) and `wundertrading-adapter.ts` for WunderTrading. `registry.ts` is the
  single switch over names and also holds the venue access policy, so a route asks "may this
  venue be used?" without learning which one it is asking about.
- **A capability that does not exist is refused before a client exists.** Spot accounts have no
  positions, so `positions` is absent from their descriptor and `readPositions()` throws
  `CAPABILITY_UNAVAILABLE` without creating an exchange. WunderTrading is a strategy platform, not
  an exchange: it claims `health` only, and its `CANNOT` list is the honest answer rather than an
  invented balance.
- **The write gate runs first, and it is counted.** Every write calls `assertWriteAllowed` before
  the transport is built, so a read-only key's refusal costs no socket, no signature and no
  request. The proof record's write attempt shows the counting fake at zero clients created and
  zero cancellations sent.
- **Permissions are stated, not guessed.** A credential records what the owner asked for
  (`requestedPermissions`) and what the venue itself reported (`reportedPermissions`). `null` is
  load-bearing: it means "this venue does not report a key's permission set", which the panel says
  in words rather than collapsing into an empty list. Binance's `account/apiRestrictions` is asked
  when the CCXT client exposes it, and a key the venue says can withdraw makes the connection
  unhealthy rather than quietly usable.
- **Withdrawal permission is refused on save.** `WITHDRAWAL_NOT_PERMITTED` names the thing the
  owner has to switch off at the venue; the scope conflicts (`SCOPE_CONFLICT`) and an unknown
  permission (`PERMISSIONS_INVALID`) are refused the same way. Nothing is encrypted or stored on
  any of those paths.
- **A check is a read, and its result is recorded either way.** `checkHealth()` returns
  `ok: false` with the venue's own sentence instead of throwing, and the route writes
  `lastCheckedAt`, `lastCheckLatencyMs` and `lastCheckError` (keeping `verifiedAt` as "the last
  time the key was *proved* to work"), so a failure the owner is not looking at is still on the
  row. A connection that has never been checked reads `NOT CHECKED YET`, not "healthy".
- **Revocation is a decision, not a filter.** `credentialAvailability` is the one function every
  credential-using path asks, so a deleted key is refused (`404`, `CREDENTIAL_REVOKED`) on the
  verify route and on the WunderTrading read route on the next request.
- **The panel says who holds the funds.** *"Funds stay at the venue. Veylora holds no custody of
  them, cannot withdraw them, and never requests withdrawal permission on a key."* Each row also
  shows the scope badge, the `CAN` / `CANNOT` capability chips, the requested and reported
  permissions, and the last check with its latency and error.

New connections default to the read-only scope, and the forms state the permission the save will
request. Nothing on this screen places, cancels or withdraws anything: the testnet order path is
phase 21, and the real-money path behind the owner's switch is phase 22.

Proof for the click-path, the refusals, the defect the walk found and the limits of the run:
[`proof/phase-20-venue-abstraction-and-keys.md`](../../proof/phase-20-venue-abstraction-and-keys.md).

## Phase 21 — the testnet order path

- **One path, two venues, one difference: configuration.** `submitOrder`, `cancelOrder` and
  `reconcileOrders` never learn a venue's name. They ask `resolveOrderVenue(userId)` in
  `src/lib/venues/registry.ts`, which returns the development paper venue or the account's own
  Binance Spot Testnet venue, or a refusal with a sentence. The order row records which venue
  holds it (`venue`), and reconciliation resolves the venue per order owner.
- **The testnet is a venue, not a mode.** `binance-testnet` has a descriptor, its own encrypted
  key, its own balances and order ids, and the only `place` capability in this build. Live
  descriptors publish no `place`, so a live venue is refused by the table the panel reads —
  `orderPlacementRefusal` is what phase 22 replaces with a switch.
- **The endpoint is checked, per client.** `createTestnetVenue` applies
  `setSandboxMode(true)` and then refuses any client whose API hosts are not
  `testnet.binance.vision` / `testnet.binancefuture.com`; the same guard runs on an injected
  transport. A ccxt change that restored a production URL would throw instead of placing.
- **Admin data, on the one switch that can move an order.**
  `IntegrationFeatureSettings.testnetOrdersEnabled` (default off, audited, edited on
  `/admin/access`) is the only way off the paper venue. Off means paper; on means the signed-in
  account's testnet key, and a missing or read-only key refuses the order with
  `TESTNET_CREDENTIAL_MISSING` / `READ_ONLY_CREDENTIAL` before a row exists rather than falling
  back to a simulation.
- **Every attempt keeps both halves.** The adapter returns the request it sent and the response
  it received, including the venue's own spelling of our client order id; `process.ts` writes
  both into the attempt row with the reason and the resulting state. A definitive refusal
  (`BadRequest`, `InvalidOrder`, `InsufficientFunds`, `BadSymbol`, auth errors) is recorded once;
  only transport failures are retried, under the same idempotency key.
- **Reconciliation never asks the wrong venue.** An open order is looked up at the venue recorded
  on its row. If routing now selects a different venue (switch off, key changed, another
  account's order), the pass leaves it alone and counts it instead of reporting "no such order",
  which after the grace window would close a live order as `RECONCILED`.

Status and the order panel say `PAPER VENUE`, `TESTNET VENUE` or `LIVE VENUE` from the same
summary, the trade page reads it per render, and `trading.liveExecutionEnabled` is `false` while
`testnetExecutionEnabled` is `true`.

Proof, including the two defects the live run found (our client id failing the venue's
`^[a-zA-Z0-9-_]{1,36}$` rule, and a definitive `BadRequest` being retried three times), the
`404` now returned when a cancel names another account's order, and the limits of the run:
[`proof/phase-21-testnet-order-path.md`](../../proof/phase-21-testnet-order-path.md).

## Phase 22 — live execution behind the owner's switch

- **The switch is owner data, and it is the whole authorisation.**
  `RiskPolicySettings.liveExecutionEnabled` (`migrations/20261018090000_live_execution_switch`,
  default `off`) sits beside the limits on `/admin/risk`, is saved through the validated
  `PUT /api/admin/risk-policy`, and is required rather than defaulted on a save. Turning it on
  writes `LIVE_EXECUTION_ENABLED`; turning it off writes `LIVE_EXECUTION_DISABLED`; both carry
  the actor and the time, beside the `RISK_POLICY_UPDATED` before/after diff. The row also keeps
  `liveExecutionChangedByUserId` / `liveExecutionChangedAt`, which the panel renders as
  "Last changed by … at …".
- **Selection, not approval.** `orderPlacementRefusal` returns `null` for a live venue only when
  the switch is on; with it off the live venue is not selected and the refusal names the switch,
  its state and the panel that edits it (`403 LIVE_EXECUTION_DISABLED`, audited as
  `ORDER_BLOCKED_BY_SWITCH` with `{switch, state}`). With it on there is no further question — no
  consent screen, confirmation or dry-run stop. There is no environment variable for this: the
  panel is the control.
- **`venues/live-adapter.ts` is Binance's real endpoint behind the same port as the testnet** —
  same pair mapping, same client-order-id translation, same classifier, same lifecycle — and it
  refuses a client whose hosts are a Binance testnet (`assertLiveEndpoints`), so a venue reported
  as live cannot be a sandbox. It does not gate: nothing of its own stands between `submit` and
  the exchange.
- **Pre-flight reports and never gates.** `orders/preflight.ts` checks the credential, the
  venue's own balance and open exposure against the configured limit, and every result —
  `INSUFFICIENT_VENUE_BALANCE`, `CREDENTIAL_UNVERIFIED`, `CREDENTIAL_CHECK_FAILING`,
  `VENUE_OUTAGE`, `EXPOSURE_ABOVE_CONFIGURED_LIMIT`, `CAPITAL_UNCONFIGURED` — is a sentence in the
  order response (`preflight`) and in the audit trail. The module has no refuse branch. When the
  venue rejects (no balance there), its answer is recorded verbatim.
- **A dry comparison is a report.** `GET /api/trading/orders/comparison?market=…` says what the
  testnet configuration would have been asked for the same order and states that nothing was
  decrypted, no venue was contacted and no order was placed. The panel shows it beside the answer
  and on demand; it is never a step in the live path.
- **Turning the switch off does not abort anything.** `resolveVenueForOrder` resolves an existing
  order's venue without the switch, so an in-flight live order reconciles at the venue and can
  still be cancelled; reconciliation continues to ask only the venue that holds the order.

Status, the order panel and `/trade` read the switch rather than a constant (`PAPER VENUE`,
`TESTNET VENUE`, `LIVE VENUE`), so the heading cannot go stale when the owner changes it.

Proof, including the live readings (a live attempt refused `403` by name with the switch off and
reaching the venue selection — refused for its read-only key — with it on), the audit rows, and
the step left to the owner because no funded trade-capable key exists here:
[`proof/phase-22-live-execution-admin-switch.md`](../../proof/phase-22-live-execution-admin-switch.md).

## Phase 24 — the strategy runner, 24/7

The one-click control from phase 23 now has something on the other side of it. The
`strategy-activation` job evaluates each account whose intent is `RUNNING` once per the
strategy's own interval — hourly for `rsi-daily-close`, independent of the job's five-minute
cadence — and either places one order through the phase-06/20/21 path or writes down why it
did not. Nothing about that path needs a browser, a signed-in session or a warm deploy hook:
the host calls the job, the job reads the database, and the record it writes is what `/trade`
shows when the owner comes back.

- **The rule is pure, the loop is the only writer.** `lib/strategies/decide.ts` turns a
  market snapshot, the open position and the working-order count into `ENTER`, `EXIT` or
  `HOLD` with the condition values it compared. `lib/strategies/runner.ts` owns every effect:
  the claim, the candle read, the risk policy, the submission and the `StrategyDecision` row.
  `lib/strategies/reasons.ts` is the taxonomy, classified as `placed`, `idle` or `error`, so
  the panel, the job summary and the tests cannot disagree about what a reason means.
- **One decision per interval is enforced three times.** `StrategyActivation.lastWindowStart`
  is taken with a single conditional `UPDATE … WHERE lastWindowStart < window`, the decision
  table is unique on `(activationId, windowStart)`, and the order's client key is
  `strategy.<activationId>.<windowStart>` so even a replayed submission resolves to the first
  order. A second invocation in the same hour answers `0 window(s) decided` and says why.
- **A gap is one row, not a wall of them.** If the last decided window is more than one
  interval behind, the pass writes a single `RUNNER_MISSED_WINDOW` decision for the skipped
  window — a deploy, a crash or a schedule that stopped delivering — and then decides the
  current one. The activation's window is never reused, so the recovery does not duplicate
  the interval it missed.
- **An idle pass is never silent.** `NO_ENTRY_CONDITION` names the RSI and the threshold it
  missed. `EXIT_CONDITION_NOT_MET` names the position, the exit and the stop it is holding.
  `POSITION_OPEN` says an order is still working. The configuration reasons are separate
  sentences with somewhere to go: `CREDENTIAL_MISSING` / `INVALID_CREDENTIAL` (the key),
  `RISK_LIMIT_REACHED` (the policy, with its own reasons quoted), `STRATEGY_DISABLED`
  (the catalog), `MARKET_DATA_UNAVAILABLE` and `RUNNER_MISSED_WINDOW` (the data and the
  schedule). `INSUFFICIENT_VENUE_BALANCE`, `VENUE_UNREACHABLE`, `RATE_LIMITED`,
  `ORDER_REFUSED` and `ORDER_FAILED` come from the order path's own answer, mapped rather
  than flattened.
- **`/trade` shows the record.** `lib/strategies/runner.ts`'s `getStrategyDecisionFeed` reads
  the last decision, the recent decisions, the next pass and the pass count, and
  `components/strategy-status.tsx` renders them with the inputs the pass used and the
  taxonomy it can report. It is the runner's verdict, not a second computation on the page —
  which is why a reason shown there is a reason stored there.
- **The risk policy is consulted, not reinvented.** Before an entry or exit is sent, the loop
  builds the policy's own input shape (symbol, notional, stop distance, open exposure, trades
  today, the kill switch) and records a refusal as `RISK_LIMIT_REACHED` with the policy's
  reasons. Daily-loss and post-arm exposure inputs are `0` until phase 25 supplies that
  accounting; the loop does not invent a drawdown it did not measure.

Proof, including the live readings (a real RSI 46.05 on 90 closed daily candles, the
same-window pass writing nothing, one recorded gap on a backdated window, and the panel
rendering it) and the limits of the run:
[`proof/phase-24-strategy-runner-24-7.md`](../../proof/phase-24-strategy-runner-24-7.md).

## Phase 25 — the limits the owner sets, and the switches that stop everything

Phase 20's policy answers "may this order exist?"; phase 25 adds the limits an owner
actually wants to tune, as data they edit in `/admin/risk`, evaluated by **one** function
before an order is placed on paper and live alike.

- **Every limit is a column, not a constant.** Per-order notional, per-strategy notional,
  open positions, trades per interval (with its own window in minutes), a post-halt
  cooldown, and an allowed-venue list. `validateRiskPolicyUpdate` checks them as a whole;
  `saveRiskPolicySettings` writes a `RISK_LIMIT_CHANGED` audit row for each one that moved,
  with `from`, `to` and the instant it took effect — and stores that instant per limit in
  `limitsEffectiveFromJson`, so the editor can say "in effect since …" under the field.
- **Zero means unlimited, everywhere.** `capIsSet(0)` is false, the panel renders
  `Unlimited`, and a zeroed cap refuses nothing — including the cooldown, whose zero clears
  a running clock. The opposite reading (a zero that reads like a limit yet refuses
  everything) is the one failure mode the phase names explicitly, so it is a test.
- **One gate, two surfaces.** `lib/risk-controls/enforcement.ts` exports `authoriseOrder`:
  the manual route and the strategy runner both call it, with the same policy row and the
  same usage arithmetic. `evaluateOwnerLimits` returns `ALLOW` or `REFUSE` with
  `limits: [{reason, limit, cap, observed, scope}]`, and the sentence in the response is
  built from exactly that list — `Max notional per order 5.00 — this order would make it
  25.00`.
- **A refusal is a record.** The manual route answers `409` with the sentence, the limits and
  the switch it names, and writes `ORDER_REFUSED_BY_RISK_LIMIT`; the runner writes its
  `StrategyDecision` (`RISK_LIMIT_REACHED`, with the limit list in `inputs.risk`) and the
  same audit event, then keeps running so the strategy trades again once the cause clears.
  An unreadable switch is treated as engaged, and unmeasurable usage is a refusal — "no
  data" is never "no limit".
- **Two switches, both toggles, both audited.** `POST /api/admin/risk-policy/switch` applies
  a press immediately (a stop that waited for a form save would not be one). The global
  switch refuses every order, manual or automatic; the per-strategy switch — a
  `StrategyKillSwitch` row keyed by the activation — stops only that strategy, leaves other
  orders alone, and can always be released.
- **`/admin/risk` says what is happening.** Section 01 is the switches with their state, the
  actor, the time and a sentence describing what pressing them now would do; section 02 is
  the usage table, rendered from the same facts the evaluator uses (cap, used, detail, with
  the limit's own `Unlimited`); section 03 is the editor with effective-from under each
  changed limit.

Proof, including the live readings (a 25.00 order refused at a 5.00 cap with the limit and
value, the global switch refusing a manual order, the per-strategy switch stopping the next
runner pass while the activation stayed `RUNNING`, a cooldown refusing for its remaining two
minutes, the audit rows, and the three defects the walk found):
[`proof/phase-25-risk-limits-and-kill-switches.md`](../../proof/phase-25-risk-limits-and-kill-switches.md).

## Phase 40 — public pages, environment parity and launch

The product is now readable by someone who has not signed in, deployable without guessing the
order of operations, and operable at 3am by one person reading
[`plan/OWNER_RUNBOOK.md`](../../plan/OWNER_RUNBOOK.md).

### The public pages read real state, or they say nothing

`src/app/(public)` is a route group, not a path prefix: `/pricing` stays `/pricing` and gets the
public shell instead of the console's sidebar. No page in it needs a session — none imports the
session helpers or reads cookies, and a test enforces that rather than trusting it.

| page | where its numbers come from |
| --- | --- |
| `/` | `src/lib/public/site.ts` (the shared copy) and the live feature state, no figures |
| `/pricing` | `readEffectiveFeeSchedule()` — the same stored table the withdrawal path charges, rendered by `pricingRows()`; a fee saved on `/admin/fees` changes this page with nothing else edited |
| `/status` | `getObservabilitySnapshot()` — the database, the runner's last invocation and each job's next-due time, the ledger's invariants, the withdrawal queue and each provider's last call. A health value that cannot be read renders as unread, never as green |
| `/docs`, `/docs/api` | the phase-32 API documentation and the MCP entry point |
| `/terms`, `/privacy`, `/risk`, `/faq` | `src/lib/public/site.ts`, which names the operator and repeats the not-statements verbatim |

The not-statements are the point: Veylora is not a broker, an exchange, a bank, an adviser or a
custodian of venue funds — the owner holds their own venue keys, and funds stay at the venue. The
copy is one constant (`NOT_STATEMENTS`) mapped into each legal page, so it cannot drift into a
stronger claim on one page than another. A test reads every public page and the shared copy and
**fails on a claim the code cannot back**: a guarantee, "insured", "segregated", a return figure, an
APY, an uptime figure or promise. A prohibited phrase is allowed only where the surrounding sentence
denies it.

`/terms` also states that no jurisdiction is named yet, because none has been chosen. That is the
owner's decision, not a placeholder to quietly fill with a plausible country.

### Environment parity: three scopes, every difference named

```bash
cd apps/web
pnpm env:parity           # report: what each scope holds and every gap
pnpm env:parity --check   # exit 1 on an undeclared gap (CI runs this)
pnpm env:parity --strict  # also exit 1 on a required name the manifest does not record
```

It reads `plan/ENVIRONMENT_MANIFEST.txt` — names only, a read of the host on 2026-10-15 — and
compares the three scopes. Development 167 names, Preview 170, Production 179. Production holds 21
names the other scopes do not, and every one of them is declared in `scripts/env-parity.mjs` with a
reason. Twenty-one differences, in four kinds:

- **Development's secrets are not in the host at all.** `SESSION_SECRET` and `CRON_SECRET` live in
  `apps/web/.env` locally and are documented in `.env.example`; `DATABASE_URL` and `DB_PROVIDER` are
  the local SQLite file `db:setup` creates.
- **One is stale.** Production holds `CREDENTIAL_ENCRYPTION_KEY`; the credential vault reads
  `TRADING_CREDENTIAL_ENCRYPTION_KEY` and has never read that name. Declared as stale so the
  mismatch stays visible instead of being quietly copied to two more scopes.
- **Preview deliberately must not run the runner.** It has no `CRON_SECRET`, because a second
  runner against the shared database would claim the same jobs and trade twice.
- **Six are configured in Production and read by nothing in this build** — `COMPLIANCE_PROVIDER`,
  `CUSTODY_PROVIDER`, `CUSTODY_KEY_ID`, `OWNER_WALLET_ADDRESSES` and the three server-side
  `WALLET_RPC_URL_*` (the browser reads the `NEXT_PUBLIC_WALLET_RPC_URL_*` pair, which all three
  scopes have). Their absence cannot change behaviour. The honest fix is to delete them from
  Production or wire them; that is the owner's call, so they are named rather than ignored.

**And the half a scope-to-scope comparison cannot see:** `REQUIRED_NAMES` lists the names the code
cannot work without, so `--strict` reports a name that is missing from *every* scope rather than
looking perfectly even. Ten are unconfirmed by the manifest — `APP_BASE_URL`, `AUTH_EVM_CHAIN_IDS`,
`TRADING_CREDENTIAL_ENCRYPTION_KEY` and `INITIAL_ADMIN_EVM_ADDRESS` in Preview and Production, plus
`DEPOSIT_ADDRESS_MNEMONIC` and `WITHDRAWAL_HOT_WALLET_MNEMONIC` in Production. Sign-in is closed
without the first two, and venue credentials and TOTP cannot be stored without the third, so
`--strict` failing here is the check to resolve **in the host's project settings** before publishing.
It is not evidence of an outage: the manifest records names, not values.

### Deploying: migrate, inspect, then build

The host runs `pnpm build:vercel`, which is `prisma migrate deploy && next build`. The order and the
`&&` are load-bearing, so a test asserts both against `package.json` rather than a comment: a failing
migration stops the deploy and the previous version keeps serving.

Measured, not assumed (2026-10-20): a deliberately broken migration
(`ALTER TABLE "NoSuchTable" …`) applied against a scratch Postgres 18 database exits **1**,
prints Prisma's `42P01` and never reaches the build; the row is left in `_prisma_migrations` with
`finished_at` null, which is what makes a redeploy refuse until it is resolved. The full transcript
is in [`proof/phase-40-public-pages-and-launch.md`](../../proof/phase-40-public-pages-and-launch.md).

Pre-publish, in order: `pnpm env:parity --strict`, the four gates, then publish and read the
migration output. Rollback is promoting the previous deployment — never rolling the schema back,
because these migrations are additive.

### What was executed, and what was not

Executed here: the parity report and its tests, the restore drill (a scratch Postgres 18 cluster,
all 18 migrations applied, seeded through the real ledger and audit writers, damaged to zero tables,
restored, and `audit:verify` green with the same head hash), the failing-migration stop, the pause
and resume of trading through the kill switch, and two runner invocations. Not executed, because
they need the hosted project: any deploy to Preview or Production, a Neon restore, and the rotation
of a live provider key. The runbook says so at each step instead of implying otherwise.
