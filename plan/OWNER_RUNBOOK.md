# Veylora owner runbook

Written to be followed at 3am by one person, without reading the code. Every command below was run
once on 2026-10-20 and its output is in [`proof/phase-40-public-pages-and-launch.md`](../proof/phase-40-public-pages-and-launch.md);
where a step could not be run here (anything that needs the hosted project), it says so instead of
pretending.

Placeholders: `$APP` is a checkout of this repository, `$SITE` is `https://<the production host>`.
Nothing in this file prints a secret value. If a step needs one, it lives in the host's secret
store and is read by name.

---

## 0. The first two minutes of any incident

1. **Is it us or them?** `GET $SITE/api/health` (the readiness endpoint) and, in a browser,
   `${SITE}/status`. The status page renders the same health data `/admin` shows: the database,
   the runner's last invocation and every job's next-due time, the ledger's invariants, the
   withdrawals queue, and each outbound provider's last call. A red row names the variable or the
   provider; that name is the answer to this step.
2. **Do the providers think they are down?** The table in §6 has each provider's status page.
3. **Write down the time.** Every action below writes an audit row; the time you started is how you
   find them afterwards.

If money is moving wrongly, go to §3 (pause trading) first and diagnose afterwards. Everything else
can wait until you know what it is.

---

## 1. Restart the runner

The "runner" is not a process you own. It is `POST /api/cron/all`, delivered by the host's schedule
(`vercel.json`, once a day) and protected by `CRON_SECRET`. "Restarting" means: make sure it is
being called, and make sure nothing is stuck holding a job's lease.

1. **Check it is being called at all.** `${SITE}/admin` → the runner section, or
   `GET $SITE/api/admin/health` with an OWNER session. It reports `lastInvocation` (id, owner,
   started/finished, jobs due/ran/skipped/failed, outcome) and every job's `nextDueAt`. A job that
   says `NOT_YET_DUE` is healthy and idle; a job with no invocation at all means the schedule is not
   reaching the route.
2. **If nothing has run for longer than the cadence**, call it by hand:

   ```bash
   curl -sS -X POST "$SITE/api/cron/all" \
     -H "Authorization: Bearer $CRON_SECRET" | jq '{outcome, jobsDue, jobsRan, jobsSkipped, jobsFailed}'
   ```

   The same call answers `503` and names `CRON_SECRET` when the variable is not set — that is the
   configuration answer, not an outage.
3. **If a job answers "another invocation holds this job's lease"**, nothing is wrong: the lease
   expires on its own (`DEFAULT_LEASE_MS`). Do not delete the row. Two runners claiming the same job
   is the failure the lease exists to prevent, and a stranded lease clears itself.
4. **Confirm it came back.** Re-read `GET $SITE/api/admin/health`: a new invocation id, and the jobs
   that were due now showing `nextDueAt` in the future.

Measured on the development database: two invocations, `3c1eac6c…` and `c7883665…`, both `idle`
with `jobsDue: 0, jobsSkipped: 11`, each job printing its own `nextDueAt` — the honest "alive and
nothing is due" reading.

---

## 2. Pause trading during an incident

The switch is data, not a deploy, and it is the same switch `/admin/risk` renders.

1. Open `${SITE}/admin/risk` and press the **global kill switch**. It applies immediately (it does not
   wait for a form save) and writes `KILL_SWITCH_ENGAGED`.
2. Nothing new is placed: the manual order route and the strategy runner both call the same
   `authoriseOrder`, and an engaged switch refuses there.
3. Existing positions are **not** closed by the switch. Closing is a separate, deliberate action:
   reduce exposure first if that is the intent, then leave the switch engaged.
4. Tell whoever needs to know, in the incident log, that the switch is engaged — with the time from
   step 1.
5. **Releasing it** is `KILL_SWITCH_RELEASED` and is equally immediate. If the policy has a cooldown
   set, the cooldown clock starts at the *halt*, not the release; check the remaining minutes on the
   panel before assuming trading resumes.
6. **Do not** pause by removing a credential, changing the venue, or editing the environment: those
   take a redeploy, and a redeploy during an incident is a second incident.

Measured on the development database: `killSwitchActive false → true → false`, with
`KILL_SWITCH_ENGAGED` at chain index 11 and `KILL_SWITCH_RELEASED` at chain index 13, both attributed
to the acting account with a timestamp.

---

## 3. Check the audit chain

```bash
cd $APP/apps/web
pnpm audit:verify            # the deployment's database
# or, against a copy you restored somewhere else:
DATABASE_URL=postgresql://… pnpm audit:verify
```

It prints `ok`, `checked`, `chainLength`, `headIndex`, `headHash`, gaps, and — when it fails — the
**first** broken link with the row it is on, which is the only part that matters at 3am. Exit status
is non-zero on a break, so it is safe to run under `set -e` or a monitor.

The scheduler runs the same check as the `audit-integrity` job; the status page shows its last result.
If the chain is broken: treat the audit log as evidence, do **not** rewrite rows to make it pass, and
follow §6 to the database provider before doing anything else. A break is either a writer bug (two
writers racing the chain) or a change made outside this application; both need the head hash you
wrote down before anything else moves.

Measured: `ok: true, checked: 5, chainLength: 5, headHash ce7e14ca…` on a scratch database before and
after a dump/restore round trip (§5), identical both times.

---

## 4. Rotate a key

Two different rotations wear the same word. Know which one you are doing.

**a) A provider key (Alchemy, Reown, Resend, Telegram bot token, ChainGPT, Tavily, a venue API key).**

1. Create the new key at the provider. Leave the old one valid.
2. Put the new value into the host's secret store for **Production and Preview** (the parity report
   in §7 lists both scopes; a key set only in Production is a Preview that silently loses the
   feature). `plan/ENVIRONMENT_MANIFEST.txt` records names, never values.
3. Redeploy, or restart, so the new value is read.
4. Verify: `${SITE}/status` shows that provider's last call green, then force one real call (a market
   read, an alert test send, a credential verify).
5. Only then revoke the old key at the provider.

A venue API key is *not* this: it is encrypted at rest with `TRADING_CREDENTIAL_ENCRYPTION_KEY` and is
re-entered through `/admin/access` (or the user's own credentials panel) rather than put in the
environment. Rotating it at the venue invalidates the stored one; the panel names the venue whose
verification now fails.

**b) `TRADING_CREDENTIAL_ENCRYPTION_KEY` (the key that encrypts secrets at rest).**

There is no re-encryption script, and this runbook will not pretend there is one. The stored
ciphertexts — venue keys, TOTP secrets, signal tokens, webhook secrets — are bound to the old key.
So a rotation is:

1. Generate 64 hex characters.
2. Set it in Production (and Preview) beside the old one under a temporary name, so nothing is lost
   while you work.
3. Re-enter every affected secret with the new key in force: each venue credential through
   `/admin/access`, each user's TOTP by re-enrolling, each signal token and webhook secret by
   reissuing it. Anything not re-entered stops decrypting — visibly, with a named error, never
   silently.
4. Remove the old key. Confirm `${SITE}/status` and one venue verification per venue.

Do this in a window with no live strategy running: **engage the kill switch first (§2)**.

---

## 5. Restore the database from backup

The database is Postgres (Neon in the hosted project; any Postgres for a drill). The procedure below
was executed against a scratch Postgres 18 cluster on 2026-10-20, including destroying the database
first and bringing it back.

1. **Take a backup before touching anything**, even during an incident:
   ```bash
   pg_dump -Fc -f "$HOME/veylora-$(date -u +%Y%m%dT%H%M%SZ).dump" "$DATABASE_URL"
   ```
   The restore below is proven with exactly this format.
2. **Restore into a new database first** — never over the one that is serving:
   ```bash
   createdb veylora_restore_drill
   pg_restore -d veylora_restore_drill --no-owner --exit-on-error veylora-….dump; echo "restore=$?"
   ```
   `--exit-on-error` is the point: a restore that half-worked must fail loudly, not leave a database
   that looks alive.
3. **Verify the restored copy before pointing anything at it:**
   ```bash
   cd $APP/apps/web
   DATABASE_URL=postgresql://…/veylora_restore_drill pnpm audit:verify
   ```
   `ok: true` and the same `headHash` as before the loss is the proof that the restore is the same
   database, not merely a database. Write the head hash down before and after.
4. **Swap only when step 3 passes.** On the host, point `DATABASE_URL` (pooled) and
   `DATABASE_URL_UNPOOLED` (direct) at the restored database and redeploy. Migrations run before the
   build and a failed migration stops the deploy (see §7), so a restored database that is one
   migration behind is safe to point at.
5. **Prove the app agrees**: `${SITE}/status` (database green, ledger invariants green), then one
   balance read and one statement export.
6. **If the deployment is serving from a database you destroyed**, step 2's target is that database
   and there is no step 3 to compare against — use the most recent dump whose `audit:verify` passes.

Measured: 69 tables, 2 users, 4 ledger accounts, 1 balanced transaction (2 entries, 250000000 debit
= 250000000 credit) and 5 audit events; dropped to **0 tables**; `pg_restore --exit-on-error` exit 0;
identical counts, identical balance, `ok: true` and head hash `ce7e14ca…` again.

---

## 6. Who to contact

The owner holds the accounts. For each provider: what it does, where its status is, and where the
credential lives. The account holder's own support thread is the escalation path; the runbook lists
the entry point, not an invented address.

| provider | what stops without it | status | credential |
| --- | --- | --- | --- |
| Vercel | the deployment itself | https://www.vercel-status.com | project `veylora-fintech-ai-trading` (team `shahabedinmalek-4518s-projects`) |
| Neon (Postgres) | accounts, ledger, runner heartbeats, audit chain | https://status.neon.tech | `DATABASE_URL`, `DATABASE_URL_UNPOOLED` |
| Alchemy | every chain read: deposits, withdrawals, portfolios | https://status.alchemy.com | `ALCHEMY_API_KEY`, `ALCHEMY_<NETWORK>_RPC_URL` |
| Reown (WalletConnect) | mobile wallet pairing only; injected wallets keep working | https://status.reown.com | `NEXT_PUBLIC_REOWN_PROJECT_ID` |
| Resend | the email alert channel | https://status.resend.com | `RESEND_API_KEY`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO` |
| Telegram | the Telegram alert channel | no public status page; the delivery log names the failure | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| ChainGPT | the ChainGPT model route | https://status.chaingpt.org | `CHAINGPT_API_KEY` |
| Tavily | research search and extract | https://status.tavily.com | keyless at this tier |
| a venue (WunderTrading, an exchange's own API) | orders on that venue only; paper stays up | the venue's own status page | the user's credential, encrypted at rest |

Severity rule: **database or deployment** → everything is down, §5 and §6 are the whole answer.
**One provider** → that feature is down and the status page says which; everything else keeps
running, and the product is designed to say so rather than to fail silently.

---

## 7. Deploying, and the order that matters

```bash
cd $APP/apps/web
node scripts/env-parity.mjs --strict   # required names present, every difference declared
pnpm typecheck && pnpm test && pnpm lint && pnpm build
```

Then publish. The host runs `pnpm build:vercel`, which is
`prisma migrate deploy && next build`: **the migration runs first, and a failed migration stops the
build**, so a broken deploy never serves. Read the migration output rather than assuming — a failed
migration leaves a row in `_prisma_migrations` with `finished_at` null, and Prisma refuses to move
until it is resolved (`prisma migrate resolve --rolled-back <name>`).

Rollback: the platform keeps the previous deployment; promote it, and do **not** roll the schema
back with it — migrations in this project are additive.

The launch checklist (the four gates, the E2E suite, the plan validator, the secret audit, a restore
verified by an actual restore, and the owner's explicit go-ahead) is in
[`plan/PROJECT_TODO.md`](PROJECT_TODO.md).

---

## 8. When `env-parity --strict` fails: the unconfirmed names

`--strict` exits 1 today with **ten names the code cannot run without** and the manifest does not
record: `APP_BASE_URL`, `AUTH_EVM_CHAIN_IDS`, `TRADING_CREDENTIAL_ENCRYPTION_KEY` and
`INITIAL_ADMIN_EVM_ADDRESS` in Preview and Production, and `DEPOSIT_ADDRESS_MNEMONIC` plus
`WITHDRAWAL_HOT_WALLET_MNEMONIC` in Production.

This is not a code defect and cannot be fixed in the repository: `plan/ENVIRONMENT_MANIFEST.txt`
is a **names-only snapshot of the host read on 2026-10-15**, so a name that was set after that date,
or set in a scope the snapshot did not read, shows as unconfirmed. Only the host can settle it.

1. Open the host project → Settings → Environment Variables. For each of the three scopes, check the
   ten names are present, scoped to that environment, and not marked *Sensitive* in a way that hides
   them from the build (`APP_BASE_URL` and `AUTH_EVM_CHAIN_IDS` are read at request time; the two
   mnemonics and the encryption key are read when the feature that needs them is used).
2. Set `APP_BASE_URL` and `AUTH_EVM_CHAIN_IDS` first: without them `/api/auth/config` reports sign-in
   closed, and the login page says so in its own HTML.
3. Re-read the host's variable names into `plan/ENVIRONMENT_MANIFEST.txt` (names only, never values),
   then `node scripts/env-parity.mjs --strict` again. It must print `Required names: 0 unconfirmed`
   and exit 0 before anything is published.
4. If a name is genuinely absent by design, that is a code decision, not a host one: remove it from
   `REQUIRED_NAMES` in `apps/web/scripts/env-parity.mjs` in the same change that removes the read,
   so the gate keeps meaning "the code can start".

Until step 3 passes, a preview deploy starts and serves the public pages, but sign-in, deposits,
withdrawals and stored venue credentials refuse with the missing name stated. That is the intended
behaviour, not a bug to work around.

## 9. Stop outbound money, and credit a token the network does not configure

Two controls were added for the custodial launch. Both are admin data, both are audited, and neither
is an approval step in front of an individual request.

### 9.1 Pause every withdrawal

**Where:** `/admin/access` → *Withdrawals* → **PAUSE WITHDRAWALS** (`POST /api/admin/withdrawals/pause`
with `{"paused": true}`).

**What it does, exactly:**

- every new `POST /api/withdrawals` is refused with `WITHDRAWALS_PAUSED` and nothing is held;
- the processor does not send a `RESERVED` or `BROADCAST_FAILED` row while the pause is in force;
- a transfer already broadcast is still confirmed and settled, because leaving it unconfirmed would
  leave the book unable to say where the money went;
- `/api/admin/withdrawals` and the admin page report the state and when it last changed.

**Audit:** `WITHDRAWALS_PAUSED` / `WITHDRAWALS_RESUMED`, with the actor and both states.

**Release it** only after the reason for the pause is understood and a reconciliation has run
(`audit:verify`, the ledger invariants on `/status`, and a statement read for the affected account).

### 9.2 Credit an arrival in any token

Any ERC-20 or BEP-20 transfer to an issued deposit address is recorded. The network's configured
token is credited automatically at its confirmation count. Anything else — another token, the
native coin — lands in **`/admin/data` → *Deposits awaiting a valuation*** with its symbol, amount,
contract and transaction hash.

1. Open the row and check the token contract on the chain's explorer before doing anything else.
2. Enter the **USDT value** in the box and press **CREDIT**. Up to six decimals, strictly above zero.
3. The service claims the row (`AWAITING_VALUATION` → `CREDITED`), posts the USDT movement to the
   account's ledger balance, and writes one `DEPOSIT_CREDITED_MANUALLY` audit event holding the
   original token, its raw amount and the owner's figure, in one transaction.
4. A second click cannot credit it twice: the claim fails and the answer says the deposit has
   already been credited. The ledger's idempotency key is the deposit's own.

There is deliberately no automatic price for these rows: a quote read at credit time is how a
worthless token becomes a real balance. The owner's figure is the only valuation the code trusts.
