# Verification of `plan/PROJECT_TODO.md` — 2026-10-20

This file answers one question: **for every item the ledger claims, is the claim still true on this
tree, and where is the evidence?** It was written after re-running the project-wide gates and the
browser suite on the final files, and it names the items that are **not** finished, why they cannot be
finished from this machine, and the exact fix for each.

Everything below is a command that ran or an output that was read. Nothing is inferred from memory.

---

## 1. What "the todo" is

The ledger is [`plan/PROJECT_TODO.md`](../plan/PROJECT_TODO.md): 40 phase prompts in `plan/`, one
verification record per phase in `proof/`, and a launch checklist in §4. Each phase file enumerates
its work items with an acceptance criterion; the ledger's §4 summarises them.

| Claim in the ledger | Checked how | Result |
| --- | --- | --- |
| 40 phase files | `ls plan/phase-*.md \| wc -l` | **40** |
| 443 work items · 1,290 steps | the `awk` recount printed in the ledger's header | **work items: 443, steps: 1290** — the header is accurate |
| Index matches the files, no restriction copy | `node scripts/validate_plan.mjs` | exit **0**: `OK — 40 phase file(s), index entries 40, 0 restriction hit(s), 0 warning(s)` |
| One verification record per phase | `ls proof/phase-*.md` | **33 of 40** — see §6.1, seven are missing |

The ledger's own evidence chain is therefore complete for 33 phases and has a documented gap for
seven. That gap is a record-keeping gap, not a code gap: every one of the seven has running code and
a test file (named in §6.1), and those tests passed in the 788-test run recorded here.

---

## 2. Phase 40's twelve work items, item by item

Phase 40 is the phase that was in flight, so it is checked in the most detail. The ledger's summary
of it is in §4 "Phase 40".

| # | Work item (ledger wording) | State | Evidence |
| --- | --- | --- | --- |
| 1 | Public landing, pricing, docs and status pages | **done** | nine routes in the `(public)` group; production build served `/`, `/pricing`, `/status`, `/docs`, `/docs/api`, `/terms`, `/privacy`, `/risk`, `/faq` — all **200**, no cookie sent |
| 2 | Terms, cookie policy, risk disclosures, FAQs written with the owner | **done in code, owner sign-off open** | pages read one shared copy in `src/lib/public/site.ts`; `/terms` states no jurisdiction is named. The owner has not signed the wording off (§6.6) |
| 3 | Pricing cannot drift from the fee table | **done** | `pricingRows(readEffectiveFeeSchedule())`, asserted by test both ways (change a stored fee → row moves) and measured live in phase 40: `1.5 USDT / 0.5 USDT / 20%` with `OWNER-SET TABLE`, back to `FREE DEFAULTS` when the version was deleted |
| 4 | Status page is the health snapshot | **done** | `/status` renders `getObservabilitySnapshot()`, including each job's last-ran and next-due; the headline was corrected to "Core services reporting, some parts not configured" because the runner is unconfigured |
| 5 | No claim the code cannot back | **done, test-enforced** | `tests/public-pages.test.ts` scans every public page plus the shared copy for seven prohibited phrases and allows them only where the same sentence negates them |
| 6 | Console home moved off `/` | **done** | `/` is the landing page; `/terminal` is the console; `terminal-shell` navigation points at `/terminal`; `CONSOLE_HREF` is the single source for that path |
| 7 | Environment parity report | **done** | `pnpm env:parity --check` exit **0**: `Parity: OK`; Development 167, Preview 170, Production 179 names; the 21 Production-only names are all declared with a reason |
| 8 | Required names a scope comparison cannot see | **open — host action** | `pnpm env:parity --check --strict` exit **1**, `Required by the code and unconfirmed by the manifest: 10` (§6.2) |
| 9 | The deploy stops on a bad migration | **done** | `build:vercel` is `migrate deploy && next build`; `tests/deploy-procedure.test.ts` asserts the order; the phase-40 record has the deliberately broken migration exiting 1 before `BUILD-STARTED` |
| 10 | Owner runbook, executed once | **done** | `plan/OWNER_RUNBOOK.md` §0–§7 were run in phase 40 (restore, failing deploy, kill switch, runner); §8 was added in this verification for the strict gate |
| 11 | Launch checklist | **partly open** | four of seven lines done; see §3 |
| 12 | Nothing published before the owner says go | **held** | no deployment was created or promoted by any agent; nothing was committed either |

---

## 3. The launch checklist, line by line

| Line | State | Evidence (exit status where a command) |
| --- | --- | --- |
| typecheck, test, lint, build green on the final tree | **done** | `typecheck` **0** · `lint` **0** · `test` **0**, 788 pass / 0 fail · `build` **0**, `Compiled successfully in 37.3s`, 32 page routes and 82 API routes |
| `node scripts/validate_plan.mjs` clean | **done** | **0**, 0 restriction hits, 0 warnings |
| secret audit: no environment file in git, `.env.example` placeholders only | **done** | `git ls-files \| grep -E '(^\|/)\.env($\|\.)'` → nothing; `apps/web/.env` is ignored by `apps/web/.gitignore:38` |
| backups verified by an actual restore, audit chain intact | **done** | phase 40: dump → restore → `ok: true`, head hash `ce7e14ca…`; database destroyed to zero tables and restored to 69 tables with the same head hash |
| public pages need no session, no unbackable claim | **done** | `tests/public-pages.test.ts`; production build served the nine pages 200 with no cookie |
| parity report names every difference between the three scopes | **done** | `--check` **0** |
| `env:parity --strict` clear in the host | **open** | `--strict` **1**, ten names; host-only (§6.2) |
| the E2E suite green | **done locally** | `pnpm e2e` **0**, 5 passed (2.4 min), run twice from different `.next` states |
| the same journey on the deployment that will be published | **open** | the suite owns its server, database and mock chain, so it cannot be pointed at a hosted URL (§6.3) |
| the owner's explicit go-ahead | **open** | owner action (§6.5) |

---

## 4. What this verification found, and what was repaired

Three defects, all introduced by the phase-40 route move or exposed by running the suite the way CI
runs it. All are fixed and covered.

### 4.1 Sign-in sent a returning account to the public landing page

`login-form.tsx` navigated to `"/"`, which stopped being the console when `/` became the landing
page. A person who signed in landed on marketing copy with no navigation into the application.

**Repaired:** the destination is `CONSOLE_HREF` (`/terminal`), the same constant the landing page's
"Open the console" link uses. New accounts still go to `/onboarding`.

### 4.2 The login page's "back" link pointed into the console

`href="/terminal"` labelled "← Back to overview". A visitor on `/login` has no session, so the
console bounced them back to `/login`: a link that appeared to do nothing.

**Repaired:** `href="/"`, labelled "← Back to the front page".

### 4.3 The browser suite asserted the old console path

`e2e/journey.spec.ts` waited for `…/` and a `TRADE` link. After the move it timed out — the first
`pnpm e2e` run failed exactly there, with the other four specs passing:

```
1 failed
  [chromium] › e2e/journey.spec.ts:37:7 › canonical journey …
    Error: expect(locator).toBeVisible() failed
    Expected: visible   Received: element(s) not found
    waiting for getByRole('link', { name: /TRADE/i }).first()
4 passed (2.7m)
```

**Repaired:** the step asserts `/terminal` and its `TRADE` link, with a comment saying why the
destination matters.

### 4.4 The suite could inherit a stale dev build and fail every spec

A run started beside the production `.next` with the previous run's `.next/dev` cache in place failed
**all five** specs at sign-in with `waiting for "…/login" navigation to finish`, and the server log
showed `/login` recompiling and reloading in a loop while the page stayed on `CHECKING AUTH STATUS`.
Clearing `.next` made the same tree pass 5/5, and the loop was reproducible from the stale cache.

**Repaired:** `e2e/server.ts` removes `.next/dev` before starting Next, leaving the production build
untouched. Verified by running the suite with a production `.next` present: **5 passed**.

This matters beyond a flaky local run: CI runs `Build` and then `Browser end-to-end` in that order, so
the stale-cache path was on the CI route.

### 4.5 The regression is now a test, not a promise

`tests/public-pages.test.ts` gained "sign-in lands in the console, and the console is not reachable
from the public side by accident": it asserts the form navigates via `CONSOLE_HREF`, that it does not
replace with `"/"`, and that the login page's back link is `/` and says so. That is the 788th test.

---

## 5. Commands re-run on the final files

| Command | Where | Exit | Result |
| --- | --- | --- | --- |
| `node scripts/validate_plan.mjs` | repo root | **0** | 40 files, 40 index entries, 0 restriction hits, 0 warnings |
| `pnpm typecheck` | `apps/web` | **0** | no output |
| `pnpm lint` | `apps/web` | **0** | no output |
| `pnpm test` | `apps/web` | **0** | `tests 788 · pass 788 · fail 0` |
| `pnpm build` | `apps/web` | **0** | `Compiled successfully in 37.3s`; 32 page routes, 82 API routes |
| `pnpm e2e` | `apps/web` | **0** | `5 passed (2.4m)` — clean `.next`, then again with a production `.next` present |
| `pnpm env:parity --check` | `apps/web` | **0** | `Parity: OK`, 21 declared differences |
| `pnpm env:parity --check --strict` | `apps/web` | **1** | 10 required names unconfirmed (host) |
| `next start -p 3210` + `curl` | production build | — | nine public pages and `/login` **200**; `/terminal`, `/account` **200** rendering the console chrome with every panel unconnected; `/admin` **200** rendering the access notice `SIGN-IN NOT CONFIGURED` with the sentence naming `AUTH_EVM_CHAIN_IDS`; `/api/account`, `/api/ledger`, `/api/deposits`, `/api/admin/health` **503** naming the same variable; `/api/trading/status` **200** public |

One reading worth stating plainly: on the production build, `/terminal` and `/account` answer **200**
to a request with no cookie. The HTML contains the console's own chrome and placeholder panels
("Live figures appear only when verified sources are connected", "Not connected", `0 / 8 networks`) and
**no account data**, and every data-bearing API behind them refuses with 503/401. That is the
documented phase-03 behaviour for pages ("the route answered, and it says what is missing") rather
than a leak — but whether the console should refuse to render at all without a session is a product
decision, not something this verification changed. It is listed for the owner in §6.7.

---

## 6. Not finished — why, and the fix

### 6.1 Seven phases have no verification record

`proof/` holds 33 phase records. **01, 02, 03, 04, 05, 15 and 23** have none.

*Why:* those phases were executed before this repository started writing a proof file per phase, and
their evidence was left in `.progress/SESSION_LOG.md` instead. Writing a record now would mean
describing a session that is not observable any more; writing "measured" numbers that were not
measured would be worse than the gap.

*What does exist:* the code and the tests, all passing in this run —
`tests/dev-mode.test.ts`, `tests/seed-plan.test.ts`, `scripts/dev-database.test.mjs` (02);
`scripts/route-sweep.test.mjs`, `tests/terminal-states.test.ts` (03);
`tests/observability-redaction.test.ts`, `-reason`, `-provider-call` (04);
`tests/runner-scheduler.test.ts`, `src/app/api/cron/[job]/route.test.ts` (05);
`tests/fund-visibility.test.ts`, `/api/account/export` (15);
`tests/strategy-activation.test.ts`, and the E2E step that starts trading and reads a higher run count
after the browser is closed (23).

*Fix:* one sitting per phase, re-running that phase's own acceptance commands and writing
`proof/phase-NN-….md` from the output, exactly as phases 06–40 did. Phase 01's record is the cheapest:
the four gates and the secret audit are the same commands re-run above.

### 6.2 `env:parity --strict` fails on ten names the host holds

```
Required by the code and unconfirmed by the manifest: 10
  Preview, Production   APP_BASE_URL, AUTH_EVM_CHAIN_IDS,
                        TRADING_CREDENTIAL_ENCRYPTION_KEY, INITIAL_ADMIN_EVM_ADDRESS
  Production            DEPOSIT_ADDRESS_MNEMONIC, WITHDRAWAL_HOT_WALLET_MNEMONIC
```

*Why it cannot be finished here:* `plan/ENVIRONMENT_MANIFEST.txt` is a **names-only snapshot of the
host read on 2026-10-15**. A name set after that date, or set in a scope the snapshot did not read,
shows as unconfirmed. No agent can read or set the host's values, and none should.

*Fix:* `plan/OWNER_RUNBOOK.md` **§8** (added by this verification) gives the four steps: check the names
in each scope, set `APP_BASE_URL` and `AUTH_EVM_CHAIN_IDS` first, re-read the names into the manifest,
re-run `--strict` until it prints zero. Sign-in, deposits, withdrawals and stored venue credentials stay
closed until then, naming the missing variable — which is the intended behaviour, not a bug.

### 6.3 The browser suite cannot verify a hosted deployment

*Why:* `e2e/server.ts` resets a SQLite database, starts a loopback mock chain, seeds candles and
starts `next dev` on 127.0.0.1. It refuses a port that already answers, precisely so it never tests a
database it did not seed. Pointing it at a preview URL would defeat every one of those guards, and the
journey it drives moves money.

*Fix:* a second, read-only spec — sign-out reachable, the nine public pages 200, `/api/auth/config`
reporting sign-in configured, one data API refusing a signed-out request, and the deployed commit
visible — run with `E2E_BASE_URL` against the preview, kept out of the journey's project. The full
journey stays local, because that is the only place its fixtures are honest.

### 6.4 A fresh-clone install was not re-run

*Why:* the working tree carries **454** uncommitted entries (counted after this report was written). A clone of `HEAD` would test an older
tree, and installing into it would prove nothing about these files.

*Fix:* commit, then `git clone` to a temporary directory, `pnpm install --frozen-lockfile`,
`pnpm db:setup`, `pnpm dev`, and read `/` and `/terminal`. That is the ledger's definition-of-done item
3 and the only line of it that has not been exercised on this tree.

### 6.5 Publishing needs the owner

*Why:* the ledger's own rule, and the last line of the checklist. Nothing was published, promoted or
committed by this verification.

*Fix:* the owner's go-ahead, after §6.2 and §6.3.

### 6.6 Legal and risk wording needs the owner's sign-off

*Why:* the pages exist, deny the claims they cannot back and name no jurisdiction; whether that is
sufficient for the operator's jurisdiction is a legal judgement, not an engineering one.

*Fix:* the owner reads `/terms`, `/privacy`, `/risk`, `/faq` and either accepts them or supplies the
entity name, jurisdiction and contact route, which are single-line edits in `src/lib/public/site.ts`
(the operator name and contact) and the terms page.

### 6.7 Two owner decisions this verification surfaced

1. **Console chrome without a session.** `/terminal` and `/account` render their shells (no data) to a
   signed-out request. Decide whether that stays, or whether the pages redirect to `/login` the way
   the APIs refuse. Changing it would need the E2E journey's first assertion updated with it.
2. **The three exposed provider keys are still not rotated, and the history purge is still pending.**
   Both are the owner's actions recorded in phase 39; neither was taken by an agent, and no history
   was rewritten. The rotation table with dates to fill is in
   [`phase-39-security-hardening.md`](phase-39-security-hardening.md).

### 6.8 Owner resources that were never exercised

A Neon restore, a live venue order and a real live-execution switch-on were not performed: this
machine holds no funded key, no Neon project and no owner consent to place a real-money order. Each is
recorded as such in phases 15, 21, 22 and 40 rather than claimed. The scratch-Postgres restore in
phase 40 is the closest honest substitute, and it is labelled as one.

---

## 7. Release pass — 2026-10-22

This section covers the release the tree had not yet had: one commit per logical area, the `v0.9.0`
tag, and the same gates re-run against a clone of that tag rather than against the working tree.

| Gate | Working tree | Fresh clone of `v0.9.0` |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | (already installed) | exit **0** |
| `pnpm db:setup` | exit **0**, seeded (14 audit events, 3 orders, 1 deposit) | exit **0**, same seed |
| `pnpm typecheck` | exit **0** | exit **0** |
| `pnpm test` | exit **0**, **821/821** | exit **0**, **821/821** |
| `pnpm lint` | exit **0** | exit **0** |
| `pnpm build` | exit **0**, 98 pages | exit **0**, 98 pages |
| `pnpm e2e` | exit **0**, **10 passed** (5.8 m) | exit **0**, **10 passed** (3.6 m) |
| `node scripts/validate_plan.mjs` | exit **0**, 40 phases, 0 restriction hits | — |

Four defects were found by running the gates the way a recipient would rather than the way this
machine does, and each is fixed:

1. **The secret ignore rules hid source.** `*credential*` and `*api-key*` matched
   `src/app/api/admin/api-keys/route.ts` and three migrations
   (`20261015150000_retire_credential_approval_state`, `20261017080000_credential_read_only`,
   `20261017180000_credential_scope_and_health`), so the panel's own endpoint and three tables were
   absent from every commit. Narrow negations put them back; `git ls-files --others --ignored` is the
   check that found them.
2. **pnpm refused to install.** `pnpm-workspace.yaml` still carried the literal placeholder
   `set this to true or false` for four dependencies, which makes `pnpm install` exit 1 with
   `ERR_PNPM_IGNORED_BUILDS` — the first thing a clone or CI does. Each now has an answer.
3. **Typecheck needed generated types.** `PageProps` and `RouteContext` live in `.next/types`, so
   `tsc --noEmit` failed on a checkout that had never been built. `typecheck` now runs
   `next typegen` first, and `tsconfig.json` includes only the current `.next` directories instead of
   24 per-phase build directories.
4. **One test depended on this machine.** `inspectEnvFiles` checked `existsSync` before asking its
   reader, so the remote-database test passed only where `apps/web/.env` exists and failed in a clone.
   The reader is now asked for every name and a missing file is the `ENOENT` already skipped.

Not done, and why:

- **The tag was not pushed at first.** The checkout had no configured remote, so the commits and the
  tag stayed local until the owner supplied one. They are now on `origin`
  (`git@github.com:shahabedin-malek/veylora-trading-bot.git`): `refs/heads/main` and the annotated
  `refs/tags/v0.9.0` both resolve to `f847731`, verified with `git ls-remote --heads --tags origin`.
  The correction you are reading is a later commit; the tag still points at `f847731`.
- Everything in §6 still stands: no rotation, no history purge, no hosted deploy, no legal sign-off.

## 8. Where the evidence is

- The ledger and its checklist: [`plan/PROJECT_TODO.md`](../plan/PROJECT_TODO.md) §4, Phase 40.
- The phase record this verification extends: [`phase-40-public-pages-and-launch.md`](phase-40-public-pages-and-launch.md).
- The strict-gate procedure: [`plan/OWNER_RUNBOOK.md`](../plan/OWNER_RUNBOOK.md) §8.
- The tests that hold the repairs: `apps/web/tests/public-pages.test.ts`,
  `apps/web/e2e/journey.spec.ts`, `apps/web/e2e/server.ts`.
- Raw gate output from this run was written to `/tmp/v41-*.log` and is reproducible with the commands
  in §5; nothing in this file depends on a value that is not printed above.
