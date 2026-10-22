Verify all of these todo steps should be done. if something is not done yet then do it and also at the end create a .md file as a report of all finished steps and if you could not finish something then inside of the report clearly mention which parts you could not finish and why? and what is the solution?

# PROJECT_TODO — Veylora: from today's code to the finished product

This is the single ledger. One line per work item, one file per phase. Status changes go
in this file only. The companion files are `phase-01-…` through `phase-40-…`, each a
self-contained, paste-ready prompt for DeepSeek Freebuff, and `COMPETITOR_RESEARCH.md`, the
market research behind the product decisions.

**How to run it**

```bash
node scripts/validate_plan.mjs          # structure + restriction-copy check
node scripts/validate_plan.mjs --json   # same, machine-readable
# recount the estimates below (expect: work items 443, steps 1290)
grep -oE '^Work items: [0-9]+|· steps: [0-9]+' plan/PROJECT_TODO.md \
  | sed 's/^Work items: /wi /; s/^· steps: /st /' \
  | awk '{if($1=="wi") w+=$2; else s+=$2} END{print "work items:", w, "steps:", s}'
```

Work one phase at a time, in order, finishing its definition of done before starting the
next. Re-count the estimates at any time with the `awk` line above.

---

## 1. Current state (measured, not remembered)

Measured on the working tree today:

- **App:** Next.js 16.4 App Router, React 19.3, pnpm 11, at [`apps/web`](../apps/web) —
  194 TypeScript files, 25,330 lines under `src` (re-measured after phase 07).
- **Routes:** 14 pages and 30 API route files, all listed in
  [`PROJECT_PLANNING_PROMPT.md`](../PROJECT_PLANNING_PROMPT.md) §10.
- **Data:** Prisma 6.19.3 against Neon Postgres in production (`build:vercel` runs
  `prisma migrate deploy` first), with a local SQLite `prisma/dev.db` for development.
  **20 models**: User, WalletIdentity, RoleAssignment, TeamMembership,
  UserPermissionGrant, DepartmentTeam, AuthNonce, AuditEvent, TradeOrder,
  TradingVenueCredential, RiskPolicySettings, MarketAlert, MarketAlertEvent,
  MarketCandleRecord, MarketNewsRecord, EvmPortfolioNetwork, EvmTokenAllowlistEntry,
  ChainGPTFeatureSettings, WunderTradingFeatureSettings, IntegrationFeatureSettings.
- **Working today:** SIWE wallet sign-in over the browser's injected EIP-1193 providers
  (MetaMask, Rabby, Coinbase Wallet and any other injected provider), with chain detection and a
  verified switch, a distinct message per failure and a session that survives a reload; role/permission
  grants; Alchemy EVM portfolio reads across configured networks plus a token allow-list;
  Coinbase candles/spot, news over RSS, fear-and-greed, indicators and a market cache;
  market alerts with condition evaluation, a cron route and an alert panel; RSI
  backtesting; a bot-builder state machine; **dev-only, process-local paper trading**; a
  risk-control policy layer with an admin form; the WunderTrading client plus settings;
  ChainGPT settings/features; Tavily research with rate limiting; an integer-cent ledger
  helper; an admin project-state summary export.
- **Tests:** 64 test files on disk, 64 entries in the `test` script (re-measured after phase 07;
  the suite reports 289 tests, all passing). CI runs `typecheck`, `test`, `build`.
- **Not built at all:** deposits (**zero** references under `src`), a balance/ledger
  surface, withdrawals (only 4 incidental mentions), fees and pricing, a background
  strategy runner beyond a single cron route, live venue order placement, CRM/support,
  audit export, a public API or MCP surface, browser E2E automation (no Playwright
  installed), TOTP/2FA or passkeys, and any dev-data seeding (one `seed` reference,
  no `prisma.seed`).
- **Exposed credentials, quarantined:** the repository-root file `https www chaingpt org.txt`
  held three live keys in plaintext and was committed in `b26ace8 Initialize Veylora
  workspace`. It has been moved outside the repository, so neither the working tree nor the
  index carries it, and `https*.txt` is now ignored — that pattern only takes effect once
  the removal is committed, because git ignores files that the index still tracks. Two
  steps remain owner actions: **rotate the keys at their providers** (ChainGPT rotation
  blocks phase 27, WunderTrading rotation blocks phase 20) and decide whether to **purge the
  file from git history**, which is never done without an explicit instruction. Nothing
  else proceeds on those credentials until they are rotated. Values are never printed,
  pasted or committed — see §3 rule 9 and §9 of the brief.

  **Phase 39 record (2026-10-20).** The security review scanned every path ever present in any
  commit and found no other file carrying a secret value; the hits in the current tree are
  fixtures and identifiers. Two owner actions remain open and neither has been taken by an
  agent: the three exposed keys are **not yet rotated**, and the history purge is **pending the
  owner's explicit instruction** — no history has been rewritten, and the file's deletion in the
  working tree is still uncommitted. The rotation table (names, providers, dates to fill in),
  the findings with their evidence and the accepted exceptions are in
  [`proof/phase-39-security-hardening.md`](../proof/phase-39-security-hardening.md).

---

## 2. Estimates

| Metric | Count |
| --- | --- |
| Phases (one prompt file each) | **40** |
| Top-level work items | **443** |
| Verifiable steps (edit + command + check) | **≈1,290** |
| Phases that change money-handling | 9 (12–16, 21–23, 25) |
| Phases gated by an owner decision | 8 (marked ⚑ below) |

"A step" is one verifiable action: a file edited, a command run, a value observed. A
phase is sized for one agent in one sitting; anything larger was split.

**Dependency shape:** `01 → 02 → 03 → 04 → 05 → 06` is the spine. Money (`12 → 13 → 14 →
15 → 16`) does not depend on venues. Venue work (`20 → 21 → 22`) depends on the durable
runner (`05`) and the order machine (`06`). Nothing after `21` may place a real order
until `22` is done, and `22` requires the owner's explicit switch, not an agent's.

---

## 3. Phase index

| # | File | Goal | Work items | Depends on |
| --- | --- | --- | --- | --- |
| 01 | `phase-01-baseline-verification.md` | Prove the current tree is green and rotate the committed keys | 9 | — |
| 02 | `phase-02-dev-mode-local-data.md` | Local database, seeded data, one-command reset, unmasked dev values | 12 | 01 |
| 03 | `phase-03-route-inventory-and-honest-status.md` | Every route answers; no dead or hidden control | 9 | 02 |
| 04 | `phase-04-observability-and-error-surfacing.md` | Real logs, provider request records, errors visible in the admin panel | 10 | 03 |
| 05 | `phase-05-durable-runner-heartbeats.md` | A server-side runner that survives the browser and a deploy | 12 | 04 |
| 06 | `phase-06-order-state-machine-and-retries.md` | One order/process lifecycle with retries, idempotency, reconciliation | 11 | 05 |
| 07 | `phase-07-wallet-signin-injected.md` | Injected wallets, chain switching, sign-in parity | 10 | 03 |
| 08 | `phase-08-walletconnect-mobile-pairing.md` | Mobile wallets by QR, deep link and WalletConnect/Reown | 10 | 07 |
| 09 | `phase-09-eip1271-smart-accounts.md` | Contract wallets and smart accounts can sign in and act | 9 | 07 |
| 10 | `phase-10-account-security-2fa-sessions.md` | Scoped 2FA, sessions and devices, sign-out everywhere | 12 | 07 |
| 11 | `phase-11-accounts-roles-and-onboarding.md` | User records, roles/permissions as admin data, onboarding | 12 | 10 |
| 12 | `phase-12-deposits-and-crediting.md` | Deposit → credited balance, with an audit trail | 14 | 06 |
| 13 | `phase-13-ledger-and-balances.md` | One ledger of record with invariants and history | 12 | 12 |
| 14 | `phase-14-withdrawals-and-failure-paths.md` | Withdraw to the wallet, including rejection and failure | 13 | 13 |
| 15 | `phase-15-fund-visibility-and-export.md` | Balances, P&L, history, exports, read-only imports | 11 | 13 |
| 16 | `phase-16-fees-and-pricing.md` | Fees as admin data, one truthful pricing page | 10 | 14 |
| 17 | `phase-17-network-registry-all-chains.md` | Every configured network usable, discovered at runtime | 10 | 04 |
| 18 | `phase-18-portfolio-aggregation.md` | Portfolio across all networks, positions and tokens | 12 | 17 |
| 19 | `phase-19-market-data-and-screener.md` | Market data health plus a screener/analytics surface | 12 | 17 |
| 20 | `phase-20-venue-abstraction-and-keys.md` | Venue layer for exchange keys, read-only first | 12 | 06 |
| 21 | `phase-21-testnet-order-path.md` | The full order path proved on testnet | 11 | 20 |
| 22 | `phase-22-live-execution-admin-switch.md` | Real-money execution behind an owner switch — ⚑ owner | 10 | 21 |
| 23 | `phase-23-one-click-smart-ai-trading.md` | The one visible start/stop control with live state | 10 | 21 |
| 24 | `phase-24-strategy-runner-24-7.md` | Strategies run 24/7 offline, with a failure taxonomy | 13 | 23 |
| 25 | `phase-25-risk-limits-and-kill-switch.md` | Limits, exposure caps and kill switches as admin data | 11 | 24 |
| 26 | `phase-26-assistant-tools.md` | An assistant that answers with real portfolio and market data | 11 | 18 |
| 27 | `phase-27-ai-providers-and-metering.md` | ChainGPT/Gateway/Tavily routing and per-request accounting | 10 | 26 |
| 28 | `phase-28-nl-strategy-and-backtest.md` | Plain English → inspectable strategy → tick-level backtest | 12 | 19 |
| 29 | `phase-29-alerts-and-notifications.md` | Alerts delivered in-app, by email and Telegram | 11 | 19 |
| 30 | `phase-30-bot-builder-and-marketplace.md` | Bot builder plus strategy templates and tier caps | 12 | 24 |
| 31 | `phase-31-signals-and-webhooks.md` | Inbound TradingView signals and outbound webhooks | 10 | 24 |
| 32 | `phase-32-public-api-and-mcp.md` | Public API with keys, docs, and an MCP server — ⚑ owner | 12 | 30 |
| 33 | `phase-33-terminal-ux-and-mobile.md` | Terminal-level UX and usable mobile layouts | 11 | 24 |
| 34 | `phase-34-admin-console.md` | The owner's console for users, funds, strategies and switches | 13 | 15 |
| 35 | `phase-35-crm-and-support.md` | Tickets, notes, event history, support tooling | 11 | 34 |
| 36 | `phase-36-audit-log-and-compliance.md` | A complete audit trail with exports and retention | 10 | 34 |
| 37 | `phase-37-e2e-automation.md` | Browser automation over the canonical journey | 10 | 24 |
| 38 | `phase-38-performance-and-load.md` | Pages, queries and cron under load | 9 | 34 |
| 39 | `phase-39-security-hardening.md` | Security review, key rotation, secret purge, dependencies | 12 | 36 |
| 40 | `phase-40-public-pages-and-launch.md` | Public pages, legal text with the owner, deployment parity — ⚑ owner | 12 | 39 |

---

## 4. Work items by phase

Bullets are the top-level items in order; the phase file enumerates each one as a numbered
requirement with its own acceptance criterion.

### Phase 01 — `phase-01-baseline-verification.md`
Work items: 9 · steps: 26
- Run `typecheck`, `test`, `lint`, `build` from `apps/web` and record every result verbatim.
- Rotate the three credentials exposed in the tracked root text file; move the file out of the repository.
- Confirm no other file under version control carries a secret value.
- Record the current route/test/model inventory into this file if it has drifted.
- Leave the tree green and committed by its owner.

### Phase 02 — `phase-02-dev-mode-local-data.md`
Work items: 12 · steps: 34
- `db:setup` / `db:reset` scripts against the local database only.
- Deterministic seed: owner at OWNER role, one funded test account, strategies in each state, policy and integration rows, alerts, audit events.
- A dev-only banner naming the database in use.
- Unmasked values in development, with the two architectural exceptions documented.
- Three-command fresh clone in `apps/web/README.md`.

### Phase 03 — `phase-03-route-inventory-and-honest-status.md`
Work items: 9 · steps: 28
- Every page and API route answers on a seeded local database.
- Missing configuration produces a specific, honest body naming the variable.
- No control is disabled, hidden or "coming soon" because a later phase owns it.
- An automated route sweep so drift is visible.

### Phase 04 — `phase-04-observability-and-error-surfacing.md`
Work items: 10 · steps: 26
- Structured server logs with request ids.
- One record per outbound provider call: URL (key redacted), status, duration.
- Failures surfaced to the owner in the admin panel, not only to the console.
- The "why did nothing happen" answer available for every process.

### Phase 05 — `phase-05-durable-runner-heartbeats.md`
Work items: 12 · steps: 38
- A scheduled runner that does not depend on a browser or a dev process.
- Heartbeat, last-run, next-run and resume-after-deploy, all visible.
- Idempotent jobs with a durable claim/lock.
- Verify against the real host's limits and state a cadence it can actually meet.

### Phase 06 — `phase-06-order-state-machine-and-retries.md`
Work items: 11 · steps: 32
- One state machine for orders and long-running processes.
- Retry with backoff, idempotency keys, reconciliation against the venue.
- Every transition written to the audit trail.

### Phase 07 — `phase-07-wallet-signin-injected.md`
Work items: 10 · steps: 30
- MetaMask, Rabby, Coinbase Wallet and generic injected providers.
- Chain detection, switching and mismatch handling.
- Session continuation across reloads.

### Phase 08 — `phase-08-walletconnect-mobile-pairing.md`
Work items: 10 · steps: 30
- WalletConnect/Reown pairing with QR, deep links and mobile return.
- Pairing state and failure messages a human can act on.
- No secret material in the browser bundle.

### Phase 09 — `phase-09-eip1271-smart-accounts.md`
Work items: 9 · steps: 26
- EIP-1271 signature verification for contract wallets.
- Smart-account sign-in path end to end.
- Session keys noted as the future on-chain execution path.

### Phase 10 — `phase-10-account-security-2fa-sessions.md`
Work items: 12 · steps: 34
- TOTP enrolment with backup codes; separable scopes for sign-in, trading and funding.
- Session list with device, IP and revocation; sign out everywhere.
- Passkey groundwork recorded as an owner decision.

### Phase 11 — `phase-11-accounts-roles-and-onboarding.md`
Work items: 12 · steps: 36
- User records, departments/teams and permission grants edited as data.
- An onboarding path a first-time user finishes without help.
- KYC-style flags as admin data, never as code-level refusals.

### Phase 12 — `phase-12-deposits-and-crediting.md`
Work items: 14 · steps: 44
- Deposit address per supported network, with the 20-USDT journey local-first.
- Credit only on the confirmations policy the owner sets.
- Reconciliation for late, partial and unmatched deposits.

### Phase 13 — `phase-13-ledger-and-balances.md`
Work items: 12 · steps: 36
- One ledger of record, integer-cent, double-entry, with invariants.
- Balance history and per-account statements.
- Property-style tests proving the ledger cannot silently lose money.

### Phase 14 — `phase-14-withdrawals-and-failure-paths.md`
Work items: 13 · steps: 40
- Withdraw to the wallet, confirmed on-chain, with idempotency.
- Rejection, failure, retry and partial paths, each with its own state.
- New-address lock as an owner-configured control.

### Phase 15 — `phase-15-fund-visibility-and-export.md`
Work items: 11 · steps: 30
- Balances, positions, P&L and full transaction history in one place.
- CSV/JSON export, plus read-only venue imports for users who will not hand over trade keys.
- Report-style views comparable to tax-style summaries.

### Phase 16 — `phase-16-fees-and-pricing.md`
Work items: 10 · steps: 28
- One fee table as admin data: trading, performance, withdrawal, network.
- Fees applied by the ledger, visible before the user commits.
- One truthful pricing page; no contradictory numbers anywhere.

### Phase 17 — `phase-17-network-registry-all-chains.md`
Work items: 10 · steps: 30
- Networks discovered from the environment at runtime; nothing hard-coded.
- Every enabled network reachable for reads, deposits and switching.
- The Vercel-scope trap documented: a network missing from one scope silently loses RPC there.

### Phase 18 — `phase-18-portfolio-aggregation.md`
Work items: 12 · steps: 34
- Portfolio across all configured networks with per-network provenance.
- Positions, token metadata and spam handling.
- Reads that degrade honestly when one provider is down.

### Phase 19 — `phase-19-market-data-and-screener.md`
Work items: 12 · steps: 34
- Candle/news pipelines with provider health and gap backfill.
- Indicators reused by screener, backtest and assistant.
- A screener/analytics surface with saved screens.

### Phase 20 — `phase-20-venue-abstraction-and-keys.md`
Work items: 12 · steps: 36
- One venue interface over CCXT-style exchanges and WunderTrading.
- Keys stored encrypted, read-only first, withdrawals never requested, revocable per key.
- A plain statement in the UI: the venue holds the funds and we cannot withdraw them.

### Phase 21 — `phase-21-testnet-order-path.md`
Work items: 11 · steps: 34
- The identical order path against a testnet venue end to end.
- Order lifecycle visible: submitted, filled, partially filled, cancelled, failed.
- Evidence recorded before any real-money switch exists.

### Phase 22 — `phase-22-live-execution-admin-switch.md`
Work items: 10 · steps: 30 ⚑ **owner decision**
- Real-money placement only behind an owner-controlled admin switch, stored as data.
- Refuses nothing beyond that switch; no agent-invented gate.
- The switch state, its author and its time in the audit trail.

### Phase 23 — `phase-23-one-click-smart-ai-trading.md`
Work items: 10 · steps: 28
- One visible control that starts and stops smart AI trading, with live state.
- Nothing in the UI that cannot be pressed and observed.
- The control's effect on the runner proven by a click-path.

### Phase 24 — `phase-24-strategy-runner-24-7.md`
Work items: 13 · steps: 40
- Strategies run with the browser closed, the laptop shut and after a redeploy.
- Heartbeat, last decision, next decision and the reason for idling at all times.
- The failure taxonomy: insufficient balance, invalid key, no entry condition, venue down.

### Phase 25 — `phase-25-risk-limits-and-kill-switch.md`
Work items: 11 · steps: 30
- Per-account limits, exposure caps and cooldowns as admin data.
- Kill switches that stop everything immediately and write an audit event.
- The risk policy readable by the owner before it acts.

### Phase 26 — `phase-26-assistant-tools.md`
Work items: 11 · steps: 32
- The assistant reads real portfolio, market and research data through tools.
- Answers cite what they used; no invented numbers.
- Streaming, errors and rate limits handled.

### Phase 27 — `phase-27-ai-providers-and-metering.md`
Work items: 10 · steps: 28
- ChainGPT, AI Gateway and Tavily behind one provider interface with fallback.
- Per-request metering and cost visibility, mirroring metered AI products.
- Settings stay admin data.

### Phase 28 — `phase-28-nl-strategy-and-backtest.md`
Work items: 12 · steps: 36
- Plain English becomes a strategy definition the owner can read and edit.
- Tick-level backtest with spread, slippage and fees; results comparable side by side.
- No black-box output: every generated rule is inspectable.

### Phase 29 — `phase-29-alerts-and-notifications.md`
Work items: 11 · steps: 30
- Alert rules evaluated on the schedule without a browser.
- Delivery in-app, by email and to Telegram, each independently switchable.
- Deduplication, quiet hours and a delivery log.

### Phase 30 — `phase-30-bot-builder-and-marketplace.md`
Work items: 12 · steps: 34
- The bot builder publishes a runnable strategy without hand-edited config.
- Strategy templates/marketplace with per-tier caps on bots and connections.
- Clone, edit, version and roll back a strategy.

### Phase 31 — `phase-31-signals-and-webhooks.md`
Work items: 10 · steps: 28
- Inbound TradingView-style signals with signature verification and replay protection.
- Outbound webhooks for trade and alert events with retry.
- Every signal recorded, accepted or rejected, with the reason.

### Phase 32 — `phase-32-public-api-and-mcp.md`
Work items: 12 · steps: 34 ⚑ **owner decision**
- Public API with scoped keys, rate limits and documentation.
- An MCP server so external agents can read, and trade only within the scope granted.
- Read-all / trade-one-account scoping with approvals exposed as data.

### Phase 33 — `phase-33-terminal-ux-and-mobile.md`
Work items: 11 · steps: 30
- Terminal-grade density for charts, orders and positions.
- Mobile layouts that are usable rather than shrunk.
- Accessibility pass over the interactive surfaces.

### Phase 34 — `phase-34-admin-console.md`
Work items: 13 · steps: 38
- Users, wallets, balances, strategies, venue keys, fees, switches and limits in one console.
- Every admin action writes an audit event.
- Saved views and search across users and events.

### Phase 35 — `phase-35-crm-and-support.md`
Work items: 11 · steps: 32
- Tickets/conversations, notes and full event history per user.
- Enough context to answer "what did the system do and why" without reading logs.
- Support tooling with export and saved replies.

### Phase 36 — `phase-36-audit-log-and-compliance.md`
Work items: 10 · steps: 28
- One append-only audit trail covering auth, money, strategy and admin actions.
- Export and retention windows.
- Tamper evidence: detect a modified or missing record.

### Phase 37 — `phase-37-e2e-automation.md`
Work items: 10 · steps: 30
- Playwright installed and wired into the test script.
- The canonical journey automated: sign-in, deposit, start trading, 24/7 continuation, withdraw.
- Failure screenshots and traces on red.

### Phase 38 — `phase-38-performance-and-load.md`
Work items: 9 · steps: 26
- Measure page and query times; index what the ledger and audit queries need.
- Cron and runner throughput under a realistic job count.
- Recorded before/after numbers, not impressions.

### Phase 39 — `phase-39-security-hardening.md`
Work items: 12 · steps: 36
- Security review of auth, money paths and key handling.
- Rotate every secret the platform touched; purge secrets from history with the owner.
- Dependency and supply-chain pass; headers and cookie policy.

### Phase 40 — `phase-40-public-pages-and-launch.md`
Work items: 12 · steps: 34 ⚑ **owner decision**
- Public landing, pricing, docs and status pages.
- Terms, cookie policy, risk disclosures and FAQs written with the owner.
- Deployment parity across Development/Preview/Production and an owner runbook.

**Record (2026-10-20).** Public pages: `/`, `/pricing`, `/status`, `/docs`, `/docs/api`, `/terms`,
`/privacy`, `/risk`, `/faq`, in the `(public)` route group and needing no session. Pricing renders
`pricingRows(readEffectiveFeeSchedule())` — the table the code charges — and `/status` renders
`getObservabilitySnapshot()` including the runner's last invocation and every job's next-due time.
The not-statements live once in `src/lib/public/site.ts` and are mapped into each legal page.

**Parity record.** `pnpm --dir apps/web env:parity` reads `plan/ENVIRONMENT_MANIFEST.txt` (names
only, host read 2026-10-15): Development 167 names, Preview 170, Production 179. Production holds
21 names the other scopes do not. All 21 are declared with a reason in
`apps/web/scripts/env-parity.mjs`; `--check` fails on an undeclared one and is a CI step.

| variable | missing from | why it is a difference, not a gap |
| --- | --- | --- |
| `DATABASE_URL` | Development | development uses the SQLite file `db:setup` creates |
| `DB_PROVIDER` | Development | implied by the local file |
| `SESSION_SECRET` | Development | read from `apps/web/.env` locally, documented in `.env.example` |
| `CRON_SECRET` | Development | no host schedule in development; the route is called by hand |
| `CRON_SECRET` | Preview | a preview must never run the scheduled runner against the shared database |
| `CREDENTIAL_ENCRYPTION_KEY` | Preview, Development | stale name: the vault reads `TRADING_CREDENTIAL_ENCRYPTION_KEY` |
| `COMPLIANCE_PROVIDER` | Preview, Development | Production holds it; no code in this build reads it |
| `CUSTODY_PROVIDER` | Preview, Development | same — venue funds stay at the venue |
| `CUSTODY_KEY_ID` | Preview, Development | same |
| `OWNER_WALLET_ADDRESSES` | Preview, Development | same — the OWNER role comes from the access directory |
| `WALLET_RPC_URL_ARBITRUM` | Preview, Development | the browser reads the `NEXT_PUBLIC_` pair, present in all three |
| `WALLET_RPC_URL_BASE` | Preview, Development | as above |
| `WALLET_RPC_URL_ETHEREUM` | Preview, Development | as above |

**Required names, unconfirmed.** `--strict` also reports names the code cannot run without that the
`manifest does not record in a scope. Ten are unconfirmed: `APP_BASE_URL`, `AUTH_EVM_CHAIN_IDS`,
`TRADING_CREDENTIAL_ENCRYPTION_KEY` and `INITIAL_ADMIN_EVM_ADDRESS` in Preview and Production, and
`DEPOSIT_ADDRESS_MNEMONIC` plus `WITHDRAWAL_HOT_WALLET_MNEMONIC` in Production. Sign-in is closed
without the first two. These are resolved in the host's project settings, not in this file, and
`--strict` must pass before publishing.

**Runbook.** [`OWNER_RUNBOOK.md`](OWNER_RUNBOOK.md) — restart the runner, pause trading, check the
audit chain, rotate a key, restore the database, and who to contact per provider — executed once on
2026-10-20 (restore, failing deploy, kill switch, runner invocations); the steps that need the hosted
project are named as such.

**Launch checklist.** Still open until the owner says go:

- [x] typecheck, test, lint, build green on the final tree
- [x] `node scripts/validate_plan.mjs` clean
- [x] secret audit: no environment file in git, `.env.example` holds placeholders only
- [x] backups verified by an actual restore, with the audit chain intact afterwards
- [x] public pages need no session, and no claim the code cannot back (test-enforced)
- [x] parity report names every difference between the three scopes
- [ ] `env:parity --strict` clear in the host's project settings (the ten unconfirmed names); the
      procedure is §8 of `OWNER_RUNBOOK.md`, and it cannot be done from the repository
- [x] the E2E suite green locally — 5/5 on 2026-10-20, exit 0, after the route-move repair
- [ ] the same journey verified against the deployment that will be published — the suite as written
      owns its own server, database and mock chain, so this needs a separate read-only smoke spec;
      see `proof/todo-verification-2026-10-20.md` for why it is not the same check
- [ ] the owner's explicit go-ahead to publish

**Verification record (2026-10-20).** Every line above was re-measured after the phase-40 repair:
[`proof/todo-verification-2026-10-20.md`](../proof/todo-verification-2026-10-20.md) lists each item,
its evidence and the three items that remain owner actions.

---

## 5. Whole-project definition of done

All of the following are true, checked in order:

1. `pnpm --dir apps/web typecheck`, `test`, `lint` and `build` pass on the final files, exit
   statuses inspected, from a clean checkout.
2. `node scripts/validate_plan.mjs` reports clean: 40 phase files, index matching, no
   restriction copy.
3. On a fresh clone: install → `db:setup` → `dev`, and the app renders at
   `http://localhost:3000` with seeded data.
4. Every route in the §10 dev-mode inventory answers, and no control in the UI is dead,
   hidden or silently disabled.
5. The canonical journey works end to end for a human: sign in with a wallet, deposit ~20
   USDT and see it credited, read balances/history/audit, press one visible "start smart AI
   trading" control, close the browser and confirm trading continues, then withdraw and
   confirm the money arrived.
6. No user funds are ever custodied with an unrecoverable lock-up; withdrawal is available
   whenever the owner's own controls allow it.
7. Real-money execution is reachable only through the owner's admin switch after the
   testnet phase proves the identical path.
8. Limits, fees, allow-lists, caps and kill switches live in the admin panel as data the
   owner edits; no AI-authored gate, confirmation step or refusal exists anywhere.
9. The audit trail explains every auth, money, strategy and admin action, and the owner can
   export it.
10. No secret value is stored in the repository or its history; every key is rotated and
    each one is read-only or scoped to exactly what it needs.
11. `plan/COMPETITOR_RESEARCH.md` findings that were adopted are implemented or explicitly
    declined in this file.

---

## 6. Questions for the owner

Each has a recommended default; the plan assumes the default until told otherwise.

1. **Custody model.** Veylora owns the deposit ledger and executes user trades — recommended,
   and what phases 12–15 build. Alternative: keys-only like WunderTrading/Bitsgap, where
   funds never leave the venue and the deposit journey disappears. *Which one? (default:
   Veylora holds user balances in its own ledger and can withdraw on demand.)*
2. **First deposit rail.** On-chain stablecoin transfer to a per-user address on a network
   the owner already has RPC for — recommended. Alternative: a card/bank provider
   (heavier compliance, needs a vendor decision). *Default: on-chain USDT on an existing
   network.*
3. **Withdrawal confirmations.** Recommended: crediting waits for a small, owner-editable
   confirmation count per network; withdrawals require no manual approval at all.
4. **Live execution venue.** First venue for real orders after the testnet proof —
   recommended: the same venue used on testnet, chosen in phase 21. *Needs a name.*
5. **Fees.** Recommended: no fee on deposits, network-cost plus a fixed fee on withdrawals,
   a percentage on profitable strategy runs only, all editable in the admin panel.
6. **Hosting cadence.** Whether the runner stays on Vercel cron or moves to an
   always-on worker — phase 05 measures the real limits and reports back before deciding.
   *Default: stay on the current host if it can meet the cadence honestly.*
7. **MCP/public API exposure.** Recommended: read-only by default, trade scope only on a
   dedicated account with approvals exposed as data (the Robinhood pattern), owner
   decision at phase 32.
8. **Lock-up policy.** Recommended: none, ever. A deposit can be withdrawn as soon as it is
   confirmed. *Confirm this is the intent.*
