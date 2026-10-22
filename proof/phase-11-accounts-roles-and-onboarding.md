# Phase 11 — accounts, roles and onboarding

This record covers the phase 11 owner click-path: the gates as they were run with their exit
statuses, the walk performed over the real HTTP routes and a real SQLite database, and the
limitations the record carries. It contains no session value, no private key, no cookie and no
credential. The wallets below are named by address only; every session was minted by a real SIWE
signature from a throwaway key created for this run and never committed.

## What the phase adds

- `src/lib/auth/sign-in-provisioning.ts` — `planSignInProvisioning`, the pure decision a successful
  sign-in makes before anything is written: how many users and wallet identities to create (one and
  one, or none and none), which role the session runs as, whether the development bootstrap applies,
  whether the stored account type has to be rewritten, whether this is a brand-new account, and that
  every accepted sign-in refreshes the account's last-seen.
- `src/lib/onboarding/checklist.ts` — the four steps, each derived from a row the action leaves
  behind, plus `buildOnboardingChecklist` over four signals (`walletAddress`, `lastBalanceReadAt`,
  `paperOrders`, `alerts`). `src/lib/onboarding/signals.ts` is the server reader and
  `recordBalanceRead`, which the portfolio read calls when a balance was actually read.
- `src/app/onboarding/page.tsx` — the checklist page, with the four links and the reason a step is
  still open when the deployment cannot read a balance.
- `src/components/session-readiness.tsx` — the sidebar's `ONBOARDING n/4` (`OnboardingProgress`),
  beside `TradingReadiness` because it is the same thing: one line in the shell's SESSION block
  saying what this session has and what it still owes. It is in the persistent shell, so the
  checklist is on every page, and the nav entry lives in `src/components/terminal-shell.tsx`.
  `src/app/login/login-form.tsx` sends a brand-new account to `/onboarding` instead of the overview
  (the `newAccount` field on the verify response).
- `src/lib/auth/access-control.ts` — the catalog gained `admin.access.read.all` (the widening grant),
  and `sitePermissionLabel` / `describePermission` / `missingPermissionMessage` /
  `readAccessReason` / `accessAuditPayload`. `src/lib/auth/access-gate.ts` gained
  `accessRefusalPayload`, and both the refusal and `PageAccess` now carry the permission key.
- `src/lib/auth/access-directory.ts` — `resolveAccessScope` (pure) and a directory whose narrowing is
  in the query, plus each account's `lastSeenAt`.
- `src/app/api/admin/access/route.ts` — a required `reason` on every action, the new
  `revoke-role`, `revoke-team-membership` and `remove-team` actions, and reasons in every audit row.
- `src/app/admin/access/access-management-form.tsx` — the reason field, the revoke controls, the
  per-account last sign-in, the scope notice, and no disabled controls: an account that already holds
  every function gets a sentence explaining why there is nothing to grant instead of dead checkboxes.
- `src/components/permission-notice.tsx` — what a page shows instead of a 404 or a blank render.
- `src/components/market-alerts-panel.tsx` gained `id="alerts"`, so the alert step's link lands on
  the form that completes it instead of on the audit stream's neighbouring anchor (found in the
  browser pass below).
- `User.lastSeenAt` and `User.lastBalanceReadAt`
  (`prisma/migrations/20261016160000_account_onboarding`).
- `DEVELOPMENT_OWNER_EVM_ADDRESS` in `src/lib/auth/config.ts`, read by both `getInitialAdminEvmAddress`
  and `prisma/seed.ts`.

## Gates on the working tree

```
$ pnpm --config.verify-deps-before-run=false typecheck   -> 0
$ pnpm --config.verify-deps-before-run=false test        -> 0   (354 tests, 0 failures)
$ pnpm --config.verify-deps-before-run=false lint        -> 0
$ pnpm --config.verify-deps-before-run=false build       -> 0   (15 page routes, 35 API route files)
$ node scripts/validate_plan.mjs                         -> 0   (40 phase files, 0 warnings)
$ pnpm routes:sweep --base-url http://localhost:3221 --cookie … -> 0  (70 passed · 0 not swept · 0 failed)
$ pnpm routes:sweep --base-url http://localhost:3222            -> 0  (70 passed · 0 not swept · 0 failed)
```

The suite grew from 336 to 354: `tests/onboarding.test.ts` (7 tests after the browser pass added two),
`tests/sign-in-provisioning.test.ts` (5 tests), five additions to `tests/access-control.test.ts`, one
to `src/app/api/admin/access/route.test.ts`, and the route-inventory test now expects 15 pages.

`prisma generate` had to be run before the gates, because the two new columns change the generated
client: `./node_modules/.bin/prisma generate --schema prisma/schema.prisma`. `pnpm db:setup` does it
as part of its own pipeline.

## The owner click-path

Served by `next dev` on `http://localhost:3221` with `AUTH_EVM_CHAIN_IDS=1`, a throwaway
`SESSION_SECRET`, `INITIAL_ADMIN_EVM_ADDRESS` set to the owner wallet below, and a **fresh, unseeded**
SQLite database created by `prisma db push --schema prisma/schema.dev.prisma --skip-generate`. The
database started at `0 users / 0 wallet identities`, which is what makes the first row of the table
below a count rather than a claim. Three throwaway keys provided the wallets; each sign-in was a real
nonce, a real signature over the message the server built, and a real cookie.

`/tmp/phase11/clickpath.mjs` — **51 checks, 51 passed, 0 failed**:

| # | Step | Observed |
|---|---|---|
| 1 | The database at the start | `0 users / 0 wallet identities` |
| 2 | Brand-new sign-in with the owner wallet (`INITIAL_ADMIN_EVM_ADDRESS`) | `200`, `newAccount:true`, `role:OWNER` |
| 3 | The bootstrap's audit row | `INITIAL_OWNER_BOOTSTRAP` on `RoleAssignment`, actor = the signing-in account |
| 4 | Rows after that first sign-in | `1 user / 1 wallet identity` |
| 5 | The owner signs in again | `1/1` still, `role:OWNER`, `newAccount:false` |
| 6 | A second, unrelated wallet signs in | `200`, `newAccount:true`, `role:VIEWER` |
| 7 | Rows after that first sign-in | `1→2 users`, `1→2 wallet identities` |
| 8 | That wallet signs in a third time | counts unchanged at `2/2` |
| 9 | Its `lastSeenAt` across the two sign-ins | `13:11:52.421Z` → `13:11:54.203Z` |
| 10 | `/onboarding` for the new account | `1 / 4 COMPLETE`, four steps, four links, `NEXT: SEE A BALANCE` |
| 11 | `GET /api/portfolio/ethereum` (the linked surface) | `200`, `status:"available"` — a real Alchemy read |
| 12 | `User.lastBalanceReadAt` after that read | `2026-10-16T13:11:58.936Z` |
| 13 | `/onboarding` again | `2 / 4 COMPLETE`, step two `DONE` |
| 14 | `POST /api/trading/orders` (the ticket's endpoint) | `201`, `outcome:submitted` |
| 15 | `POST /api/market-alerts` (the alerts endpoint) | `201` |
| 16 | `/onboarding` at the end | `4 / 4 COMPLETE`, `NOTHING LEFT` |
| 17 | `PUT /api/admin/risk-policy` without the permission | `403`, `permissionKey:"risk.policy.manage"`, "Missing permission risk.policy.manage (Manage global risk policy). An administrator grants it in Access." |
| 18 | `GET /admin/risk` in the same state | `200` and the same sentence in the page's own shell — not a 404, not a blank page |
| 19 | Owner grants `risk.policy.manage` (with a reason) | `200` |
| 20 | The same `PUT` on the next request | `400` (body validation) — no longer `403`; the grant took effect immediately |
| 21 | Owner revokes it (with a reason) | `200` |
| 22 | The same `PUT` again | `403` naming `risk.policy.manage` |
| 23 | `GET /admin/data` without `admin.data.read` | the page names `admin.data.read (Read project data catalog)` |
| 24 | Owner grants `admin.data.read` | `200`, and the next `GET /admin/data` renders the real catalog with no restart |
| 25 | A change with no reason | `400`, "Every access change needs a reason of 3–200 characters, so the audit trail answers why and not only what." |
| 26 | A second wallet signs in (for scoping) | `200`, a separate account |
| 27 | Owner assigns it `ADMIN` and creates the team `scoped desk`, then joins it | `200` / `201` / `200` |
| 28 | `GET /api/admin/access` as that scoped administrator | `scope.kind:"teams"`, `teamNames:["scoped desk"]`, **1** account (itself) |
| 29 | The same request as the owner | `scope.kind:"all"`, **3** accounts |
| 30 | The owner grants that administrator `admin.access.read.all` | `200`, and the same request now answers `scope.kind:"all"` with **3** accounts — the "unless granted otherwise" half of the rule |
| 31 | `/admin/access` rendered for the owner | shows each account's last sign-in and the required reason field |
| 32 | create team → assign membership → revoke membership → remove team → revoke role | `201` / `200` / `200` / `200` / `200` |
| 33 | Revoking the **owner's** role | `403`, "The owner role follows the configured owner address and cannot be revoked here." |
| 34 | The audit trail for all seven actions | every row has an actor **and** a reason (1–4 rows per action, checked mechanically) |

A sample audit payload, verbatim:

```json
{"reason":"Onboarding: letting the new account read and edit the risk policy","address":"0x3C44CdDd…","before":[],"after":["risk.policy.manage"],"granted":["risk.policy.manage"],"revoked":[]}
```

### The seeded owner and the bootstrap are the same address

Requirement 5 is "a brand-new sign-in with the seeded owner address receives OWNER in development".
Rows 2–5 above prove the bootstrap half on a database where nothing had ever signed in. The
seed/configuration half was checked separately, on a seeded database with
`INITIAL_ADMIN_EVM_ADDRESS` **unset**:

```
$ DATABASE_URL="file:./phase11-clicks.db" node -e '…walletIdentity.findUnique({where:{id:"dev-owner-wallet"}})…'
dev-owner-wallet: {"addressCanonical":"0x1111111111111111111111111111111111111111","proofType":"SEED_LOCAL_DEV"}
$ grep "DEVELOPMENT_OWNER_EVM_ADDRESS = " src/lib/auth/config.ts
export const DEVELOPMENT_OWNER_EVM_ADDRESS = "0x1111111111111111111111111111111111111111";
```

Before this phase the seed held its own copy of that address while `getInitialAdminEvmAddress`
returned `null` when the variable was unset, so a local database seeded with no configuration
recorded an owner that the sign-in bootstrap would never have granted. Both halves now read the one
constant, and the fallback is development-only: a test run or a deployment with nothing configured
still grants nobody `OWNER`.

### The route sweep, in both readings

- **Configured** (`APP_BASE_URL`, `AUTH_EVM_CHAIN_IDS=1`, `SESSION_SECRET` set, an OWNER session
  passed with `--cookie`): `70 passed · 0 not swept · 0 failed`. The onboarding page is a new row in
  the inventory (`auth: true`), and it served.
- **Unconfigured** (a second dev server with those three names unset, no cookie):
  `70 passed · 0 not swept · 0 failed`, with the owner rows answering the 503 that names the missing
  variable.

## The owner click-path in a browser

The 51 checks above are HTTP requests. The manual verification names four clicks, so the same working
tree was also walked in Chromium (the desktop app's preview tab) against `next dev` on
`http://localhost:3223`: the same `AUTH_EVM_CHAIN_IDS=1`, the same throwaway `SESSION_SECRET`, and a
seeded SQLite database (`prisma/schema.dev.prisma` via `prisma db push`, then the project's own dev
seed). There is no wallet extension in that browser, so the session cookie was placed after a real
SIWE sign-in minted it — the signature is real and the session is the server's own row; nothing about
the walk is a stand-in for the server.

Two accounts: the owner wallet (`0x7099…79C8`, `INITIAL_ADMIN_EVM_ADDRESS`, so `OWNER`), and a second
wallet signed in for the grant (`0x3C44…93BC`, `VIEWER`).

| # | Step | Observed in the browser |
|---|---|---|
| 1 | `/onboarding` for the new account | `1 / 4 COMPLETE`, four steps with their links, `NEXT: SEE A BALANCE`, sidebar `ONBOARDING 1/4` |
| 2 | Its own `Open the portfolio` link (`/#portfolio`) | the panel's read ran; back on the checklist: `2 / 4 COMPLETE`, step 2 `DONE`, "A balance was read on 2026-10-16T13:53:22.791Z", sidebar `ONBOARDING 2/4` |
| 3 | `Open the order ticket` (`/trade`), `Submit paper order` | `1 ORDER(S) · PAPER VENUE`, `paper-0ef920cf47329918570293c9`, `submitted`, `attempts 1`, a `Cancel order` control, `3 / 4` |
| 4 | `Set a market alert`, `BTC-USD` / `PRICE ABOVE` / `70000`, `CREATE ALERT` | `1 ALERTS`; `/onboarding` then `4 / 4 COMPLETE`, `NOTHING LEFT`, every step `DONE`, sidebar `ONBOARDING 4/4` |
| 5 | `/admin/access` as the owner | `2 ACCOUNTS`, `0 TEAMS`, the reason field, and per-user grants showing `admin.data.read` and `risk.policy.manage` with a checkbox each — `crm.support.read`, `crm.support.manage`, `payments.read`, `payments.operate` read `MODULE NOT BUILT, so there is nothing to grant yet` with no control at all |
| 6 | `CREATE TEAM` with the reason field empty | refused in place: "Add a reason of at least 3 characters; every access change records one." |
| 7 | `CREATE TEAM` with a reason | `1 TEAMS`, "Access change saved and audited.", the team appears in the `TEAM` select and `ASSIGN TEAM` becomes enabled |
| 8 | `ASSIGN TEAM` → `REVOKE MEMBERSHIP` → `REMOVE TEAM` | each answers "Access change saved and audited."; the account row goes `0 teams` → `1 teams` → `0 teams`, and the team row lists its member with `(MEMBER)` between the two |
| 9 | Grant `admin.data.read` to the viewer (with a reason) → `SAVE FUNCTION GRANTS` | "Access change saved and audited.", the row reads `1 function grants`; re-reading the account shows the box stored as ticked |
| 10 | The viewer's own `/admin/data` | the **Project data catalog** renders — reachability, runner heartbeat, the runner details |
| 11 | Revoke it as the owner → the viewer's `/admin/data` again | `PERMISSION REQUIRED` · "The project data catalog needs the admin.data.read permission" · "Missing permission admin.data.read (Read project data catalog). An administrator grants it in Access." · "Missing permission key: admin.data.read" — not a 404, not a blank page, not a dead control |
| 12 | The audit trail for the two browser grants | `ACCESS_PERMISSIONS_UPDATED` twice, actor = the owner account, with the reasons typed into the form and `before`/`after`/`granted`/`revoked` — verbatim: `{"reason":"Browser walk: letting the viewer read the project data catalog","address":"0x3C44CdDd…","before":[],"after":["admin.data.read"],"granted":["admin.data.read"],"revoked":[]}` |

Two details of the walk, for anyone reproducing it: the team assignment was first attempted with a
member wallet typed but no team chosen, and the server refused it in place with "Department team was
not found." rather than creating a membership; the team was then chosen in the `TEAM` select through
the DOM (a native `select` cannot be typed into by the driver, though every button and text field in
the table was clicked or typed as a user would) and the same button succeeded. The browser session's
cookie was likewise placed by the driver after the real sign-in above issued it, because this
browser has no wallet extension to click.

A defect the browser found, and the repair: the alert step linked to `/#activity`, which is the
*audit stream's* anchor, so "Set a market alert" landed on "Recent activity" with the create-alert
form a section below it. The Market alerts panel now carries `id="alerts"` and the step links to
`/#alerts`; clicking it puts the form in the viewport (measured: the Market alerts panel's top edge
at 627px in a 900px viewport, where before the change the page landed on "Recent activity" with the
form below the fold). Two tests in `tests/onboarding.test.ts` now hold the contract the defect broke
— the four step hrefs are pinned, and the panel's `id="alerts"` is asserted, since a container test
suite that renders no DOM would otherwise let the anchor vanish without a word. Both were checked for
teeth: putting `/#activity` back in the model fails the pinned test (`fail 1`, exit 1), and the
assertion is reverted in the same working tree.

Two readings the browser added, which the HTTP checks could not have made:

- On `/admin/access` **3 of 59 controls are disabled before anything is selected** — `ASSIGN TEAM`,
  `REVOKE MEMBERSHIP` and `SAVE FUNCTION GRANTS`. Each is gated on its own inputs and not dead: all
  three were observed enabling as soon as their selection existed (a team, a membership, an account),
  and all three then performed their action. Nothing an owner can do is behind a permanently disabled
  control.
- The sidebar's `ONBOARDING n/4` line sits in `.sidebar-bottom`, which the shell's own mobile media
  query hides along with `.sidebar-label` and the paper-orders copy. At 441px it is in the DOM but not
  rendered; at 1440px it is visible (169×14 at y=774, amber, `ONBOARDING 2/4`). The checklist page and
  its nav entry stay visible at both widths.

## Findings, and what was not fixed

**An unseeded database answers `503` for the risk policy, without naming a variable.** On the fresh,
unseeded click-path database, `GET /api/admin/risk-policy` answered
`503 {"error":"Risk policy storage is unavailable."}`, which the sweep reported as
`unexpected-503 ... 503 is not a declared answer for this row`. The cause is
`getRiskPolicySettings()`, which throws when the singleton row does not exist, and the route turning
that into a storage refusal. Nothing is unsafe — the order evaluator is fail-closed until the row
exists — but the sentence is wrong for the situation (the policy is not *unavailable*, it has never
been saved) and the sweep's declared answers do not include it. It is a phase 04/25-shaped gap in a
module this phase does not own, so it is recorded here rather than changed: the phase 11 sweep
reading above was measured on a **seeded** database (as development runs, via `pnpm db:setup`), where
the row exists and all 70 rows pass.

**`next dev` refuses a second server for the same project.** The unconfigured reading cannot be
measured against a second port while the first server is running — Next 16 answers
"Another next dev server is already running". The configured server was stopped first, so the two
readings come from the same database but not from two servers at once.

**No browser was used for the 51 checks above.** Every one of them is an HTTP request or a database
read; the pages were asserted by fetching their HTML and matching the sentences they render (with
React's text-node separators stripped), not by looking at them. A separate browser pass (below)
ow covers the four surfaces the manual verification names, on the same code and a seeded database.

**The permission-gated refusal body was extended on three routes, not all of them.** `accessRefusalPayload`
now supplies `permissionKey` on `GET/PUT /api/admin/risk-policy`, `GET/PUT /api/admin/security-policy`
and `GET /api/admin/health` — the three surfaces behind a *site permission*. The routes behind
`requireUser`/`requireAdmin` still compose their own body; they have no permission key to carry, and
their refusals already name the role they need.

## Rollback

There is no phase commit to revert — like phases 06–10, this work is on the working tree. Rolling it
back means reverting the files listed under "What the phase adds", dropping the two `User` columns
(`prisma db push` from the reverted schema, or the `ALTER TABLE`s in reverse), and removing
`/onboarding` from the route inventory and the `test` script. Sign-in and roles then fall back to the
pre-existing access-control behaviour, and the checklist page disappears with the nav entry.
