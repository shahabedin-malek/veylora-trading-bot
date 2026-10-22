# Session log

## Phase 40 — public pages, parity and launch (done, not published)

- Nine public pages in `(public)` — landing, pricing, status, docs, docs/api, terms, privacy, risk,
  faq — none needing a session, each with its own metadata. `/pricing` renders
  `pricingRows(readEffectiveFeeSchedule())`, so it has no amount of its own: a version written through
  the same writer `/admin/fees` uses changed the page on reload (`1.5 USDT`, `OWNER-SET TABLE`, `20%`),
  and deleting that version returned it to `FREE DEFAULTS`. `/status` renders
  `getObservabilitySnapshot()` — core services, eleven scheduled jobs with cadence and last-ran,
  providers — and the console home moved to `/terminal` so `/` could be public.
- The not-statements live once in `src/lib/public/site.ts` and are mapped into every legal page, so no
  page can claim more than another; a test reads all public sources and fails on a guarantee, "insured",
  "segregated", a return figure, an APY or an uptime claim unless the sentence denies it.
- `node scripts/env-parity.mjs` compares the three scopes from `plan/ENVIRONMENT_MANIFEST.txt` and
  names all 21 Production-only names with a reason (development's own `.env`/SQLite, one stale name,
  `CRON_SECRET` withheld from Preview so it cannot drive the runner, six names read by nothing in this
  build). `REQUIRED_NAMES` + `--strict` closes the half a scope comparison cannot see: **ten required
  names are unconfirmed by the manifest** (`APP_BASE_URL`, `AUTH_EVM_CHAIN_IDS`,
  `TRADING_CREDENTIAL_ENCRYPTION_KEY`, `INITIAL_ADMIN_EVM_ADDRESS` in Preview and Production, the two
  mnemonics in Production) — a launch blocker for the owner to clear in the host's settings.
- Deploy order is asserted, not commented: `build:vercel` is `migrate deploy && next build`, and a
  deliberately broken migration against a scratch Postgres 18 exits 1 and never prints `BUILD-STARTED`.
  All 18 migrations were applied to Postgres for the first time here.
- The runbook (`plan/OWNER_RUNBOOK.md`) was executed once: fresh cluster migrated, seeded through the
  real ledger and audit writers (2 users, 4 accounts, 1 transaction, 2 balanced entries, 5 chained
  events), dumped, restored into a new database, verified (`audit:verify` `ok`, head hash `ce7e14ca…`),
  **destroyed** to zero tables, restored again to 69 tables with the same head hash; kill switch
  engaged at chain index 11 and released at 13; two runner invocations, both `idle` with every job's
  next-due time stated. Hosted deploys, a Neon restore and live key rotation were not executed and the
  runbook says so at each step.
- Two defects the browser found: the pricing tables used a class (`market-table`) that exists nowhere,
  so the columns ran together — replaced with `.public-table`; and the status summary said "All core
  services reporting" over an unconfigured runner and withdrawals — now "Core services reporting, some
  parts not configured". Both re-photographed in `proof/screenshots/phase-40-*.png`.
- Route inventory: `pagePathFromFile` drops route-group segments, `/terminal` was added, 31 pages /
  131 methods. Gates: typecheck 0, test 0 (**787/787**), lint 0, build 0, `env:parity --check` 0
  (`--strict` 1 by design), `validate_plan` 0. Not published, and the legal sign-off is the owner's.

## Phase 29 — alerts and notifications (done)

- A rule is now a *crossing* with its own cooldown (false→true claim in `claimAndAuditAlertTrigger`, one
  conditional `UPDATE`), so the condition staying true no longer fires every pass and two overlapping
  evaluators cannot both win. `MarketAlertEvent` moved from one row per alert to one row per
  `(alertId, windowStart)` cooldown bucket; `MarketAlert` carries `conditionMet` and `cooldownMinutes`.
- `lib/notifications/` is the delivery layer: `email.ts` (Resend's HTTP API, three named variables,
  masked recipient), `telegram.ts` (Bot API, masked chat, token redacted from errors), `settings.ts`
  (three switches, quiet hours in UTC, bounded default cooldown, validation that refuses a string where
  a boolean belongs) and `dispatch.ts` (dedupe key = rule + condition + window, unique
  `(dedupeKey, channel, attempt)`, per-channel skip rows, queue inside quiet hours, three attempts with
  250 ms / 1 s backoff, one append-only row per attempt).
- `NotificationDelivery` records channel, target, subject, body, status, provider id and response id,
  error, attempt, duration and both queue and delivery instants. The panel shows the last 20 and the
  admin page carries the switches and the per-channel state — `OFF`, `NOT_CONFIGURED` with the exact
  variable names, or `READY` with the masked target.
- `GET /api/market-alerts` returns, per rule, last check, last observed value, last fire, the
  evaluation error and a derived next check, plus the effective cadence, the channel views, the quiet
  window with its `active` flag and queued count, and the delivery log. The `evaluation` sentence says
  how many rules are holding, cooling down or failing, so an idle rule reads as idle rather than broken.
- `market-alerts` is the phase 05 runner job, so the same pass works from cron, the scheduler and the
  heartbeat with no browser; the panel's *Last fire / Last check / Next check* lines come from the rows.
- Gates on the working tree: typecheck 0, test 0 (**690/690**), lint 0, build 0, `validate_plan` 0
  (40 phases). The extra route sweep passed every `/api/market-alerts` and `/api/cron/market-alerts`
  row; its only failures were `/api/bots*` (process-local paper store) and `/api/admin/models/probe`
  (no AI gateway key), both environment limits outside this phase.
- Click-path (recorded in `proof/phase-29-alerts-and-notifications.md`): a rule created with a
  2-minute cooldown fired on the runner with no page open (11 due, 1 triggered, `IN_APP SENT`) and was
  waiting on return with `nextEvaluationAt` a day out; a second pass ten seconds later on a 1-minute
  rule reported `0 triggered` with the condition still met; with email and Telegram switched off one
  trigger wrote only the `IN_APP` row; with Telegram's variables removed the channel read
  `NOT_CONFIGURED` naming both variables while email and in-app sent; quiet hours `00:00–23:59` held
  three notifications (`0 sent, 3 queued`, banner `DELIVERY PAUSED`) and the next pass delivered them
  (`queuedAt 09:35:11.517Z → deliveredAt 09:35:22.095Z`); and a `503`-answering stand-in produced
  `EMAIL FAILED 1`, `FAILED 2`, `SENT 3 (stub-email-3)` and the same shape for Telegram.
- **Limits:** no real Resend key or Telegram bot exists here, so both were one loopback stand-in
  speaking each provider's envelope (the ids and durations are the stand-in's); the quiet window
  covered the whole day rather than the owner's 22:00–07:00; the queue flushes on the next evaluation,
  so a daily cadence can hold an alert for a day; and the migration was verified against Prisma's
  derived DDL and applied to SQLite, not Postgres.

## Phase 28 — natural-language strategy and honest backtesting (done)

- A definition is data (`lib/strategies/definition.ts`): name, market, timeframe, entry and exit
  conditions with indicator/period/comparator/threshold, size percent, stop, daily halt and leverage,
  rendered as the exact line format the owner reads and edits, with `definitionRules` deriving the
  spoken rules from the same object so the list and the text cannot disagree.
- Generation is transparent (`lib/strategies/generate.ts`): the prompt (`strategy-definition-v1`),
  the model's raw answer, provider, model and `fallbackFrom` are stored on the
  `StrategyDefinition` row beside the validated text, and returned with it. An answer that will not
  validate is `422` with the issues, the raw output and the prompt, and nothing is saved.
- Validation names the value (`lib/strategies/validate.ts`): unknown indicator with its line, inverted
  entry/exit range with both thresholds, zero or >100% size, unsupported comparator, bad stop. It runs
  before authentication on both the strategies and backtest routes.
- One engine (`lib/backtesting/engine.ts` + `costs.ts`) replaces the RSI-only run: fee, spread and
  slippage against the position on both sides, funding per day only when leverage exceeds 1x, from the
  fee table version in force, with the assumptions printed as sentences naming that version. Results
  carry win rate, drawdown, expectancy, trade count and per-cost totals.
- Every edit inserts a version (`(userId, name, version)` unique) and `BacktestRun` stores the
  version, the exact strategy text, the costs and the full result; a sweep shares one `sweepId` and
  carries `bestValue` plus the in-sample warning. Paper mode runs the last 60 bars through the same
  path.
- `/backtest` is the owner's path — describe, read/edit, run, paper-run, sweep, compare — and prints
  the cost assumptions, the fee table version and the sweep's warning on screen. `/admin/fees` gained
  the four trading-cost fields, and `GET /api/backtest/runs` serves the history.
- Gates on the working tree: typecheck 0, test 0 (**679/679**), lint 0, build 0, `validate_plan` 0
  (40 phases).
- Click-path (recorded in `proof/phase-28-nl-strategy-and-backtest.md`): a plain-English sentence
  produced a generated definition with seven rules; `PUT` saved version 4 and left version 3 readable;
  the same four trades ended at `9580.45` with 10 bps fees and `9485.94` with 60 bps, each result
  naming its fee-table version; a sweep of 20/25/30/35 flagged `20` with the overfitting warning; the
  unknown-indicator and inverted-range/zero-size texts were refused `422` with the specifics; and
  paper runs over 60 bars stored a result (0 trades for the generated thresholds, 2 for a wider
  variant).
- **Limits:** the Next 16.4 development server does not hydrate the app in this environment (the
  production build does), so the panel was verified at the API level and as server-rendered HTML
  rather than driven; no ChainGPT credential exists here, so the one generation call was answered by
  a loopback stand-in speaking its envelope; the migration ran on SQLite (`db:setup`), with the
  Postgres DDL checked against Prisma's derived statements; and the candles are public production
  Coinbase history. The fee table was left at the default 10 bps.

## Phase 27 — AI providers, routing and per-request metering (done)

- Three providers behind one declaration (`lib/ai/provider.ts`): the Vercel AI Gateway (text, tools,
  stream; token-priced), ChainGPT (plain text; one credit per request) and Tavily (keyless search
  and extract; zero at this tier). A capability is declared and checked before every call, and a
  key is a *name* — `keyEnv` plus a boolean, never a value.
- Routing is admin data with audit on change (`lib/ai/router.ts`, `AiProviderSettings`). The route is
  read on every request, so a saved model change applies to the next answer without a redeploy, and
  the plan records what it skipped and why (capability, missing key, switched-off ChainGPT).
- One row per attempt (`lib/ai/meter.ts`, `AiRequestRecord`): provider, model, units, duration,
  outcome, computed cost in integer micro-dollars, `fallbackFrom`, tied to the user and the feature.
  The report is a pure function over those rows, so the page's total is the sum of the recorded
  costs; a provider with no configured price is counted as unpriced, never as free. The monthly
  budget is displayed and never read as a cap.
- Failures fall back in order: network, timeout, `408/425/429`, `5xx` and — the case this phase's
  own walk found — `401/403`, because a rejected key belongs to that provider. A `400`/`404` stops
  after one call, because the next provider would reject the request the same way.
- The assistant now answers through the route (`createRoutedAssistantTransport`) and reports the
  model that actually answered; readiness reports the route and the variables that would fix it.
  The admin surface is `/admin/models`: ordered target editor per feature, provider capabilities and
  configured state, the route in effect, this month's spend by feature and by account, provider
  health, and a probe that asks one short plain-text question so the saved order can be proved.
- The two research API surfaces call `runResearchSearch` / `runResearchExtract`, so a search or
  an extraction is a metered row with the account and the `research` feature, not just an
  instrumented HTTP call. Their existing admin switches and per-minute allowance still gate them.
- Gates on the working tree: typecheck 0, test 0 (**660/660**, up from 648; 12 of them this phase's),
  lint 0, build 0, `validate_plan` 0 (40 phases).
- Click-path (recorded in `proof/phase-27-ai-providers-and-metering.md`): switching the assistant's
  model in the admin route made the next answer come from `standin-model-b` (the stand-in's own log
  confirms it); the usage view totalled `0.000180 USD` with feature and account rows summing to the
  same figure; a 1-micro budget read `overBudget: true` while the next question still answered; a
  broken gateway key produced a ChainGPT answer with `fallbackFrom`, `FAILED (auth)` in the attempts
  and `requestsFallback = 1` in the report; and with every key removed the ask answered `503`
  naming `AI_GATEWAY_API_KEY` and the probe named both variables. 13 checks, 13 passed.
- **Limits:** no real provider credential exists here, so both providers were a local stand-in
  speaking each wire format — the token counts, and therefore the priced figures, are the
  stand-in's; ChainGPT's endpoint and model follow its published docs; the panel was read as
  server-rendered HTML rather than driven as a hydrated page; and the migration ran on SQLite
  through `db:setup`. The verification's sessions, request rows, routing row, audit row and usage
  windows were deleted afterwards, and the rig lives in `/tmp/phase27/`.

## Phase 26 — assistant with real tools (done)

- The assistant reads instead of remembering. `lib/assistant/tools.ts` is one typed list of
  eleven tools — ledger balances and statement, positions, open orders, alerts, public Coinbase
  quote/candles/15m RSI, Tavily search and extract, and a paper-only order — each declaring the
  arguments it accepts; `sanitiseArguments` drops anything else, so a model-emitted `userId` or
  `accountId` never reaches a reader.
- The account is a parameter of the executor, never of the tool call. `createAssistantToolExecutor`
  closes over the session's id and every account reader takes it as its first argument; without a
  session the account tools refuse and read nothing. `scope: "public"` is left only to the three
  market reads.
- Answers cite what ran, not what the model says ran. `lib/assistant/citations.ts` builds the
  citation block (label, source, as-of, detail) from the executor's own record, `composeAnswer`
  appends "Could not read: …" for a failed tool and "I could not read your balance — … I have not
  estimated or substituted a figure for it." when an account question went unanswered, and `asOf`
  is the source's observation (ledger read, candle close, quote time) rather than the server clock.
- One loop, two transports. `lib/assistant/loop.ts` runs the tool rounds (bounded at four) for both
  the JSON and the SSE paths, reports each delta as it arrives, and turns a stream that ends without
  `[DONE]` into `AssistantStreamError` carrying the partial text, so the transcript keeps what the
  reader saw and labels it incomplete.
- Limits and cost are per account and counted before the provider is asked
  (`lib/assistant/limits.ts`: 30/hour, 200/day, 150,000 tokens/day in one transaction), the refusal
  names the cap, the observed count and the UTC reset, and cost is null rather than invented when no
  price is configured. Redaction is composition, not convention: messages are redacted on the way
  out and tool results through `withRedactedToolResults`, and the audit row records tools, sources,
  tokens and outcome with no question, answer or tool result.
- Gates on the working tree: typecheck 0, test 0 (**648/648**, up from 622, 30 of them the
  assistant's own), lint 0, build 0, `validate_plan` 0 (40 phases).
- Click-path (recorded in `proof/phase-26-assistant-tools.md`): `13 USDT available` with its read
  time matching `/api/account`; `BTC-USD RSI-14 66.423` against the screener's `66.4230` at the same
  candle close; a failed tool and a model provider cut mid-stream each named in the transcript; a
  pasted key arriving at the provider as `[redacted]` and in no audit row; the second account's own
  empty ledger answering a model-supplied `userId`; and the 31st question in the hour refused `429`
  with the cap, the count and `Retry-After`. Streaming arrived as five deltas before `done`.
- Defect found and fixed: the research tools bypassed the admin Tavily switches and the per-account
  five-a-minute allowance the `/api/research/*` routes enforce — with both switches off, a live ask
  returned CoinDesk results and left a `tavily` provider-call row. They now take a `researchAccess`
  dependency that reads the stored settings, refuses with the switch's own sentence and spends the
  same budget, and they are account-scoped. Re-measured live: the refusal names the switch and the
  provider-call count is unchanged; two tests cover it.
- Limits of the run: the model was a local stand-in speaking the gateway's SSE format (no gateway
  credential here; routing and metering are phase 27); a genuine upstream outage could not be
  induced (no unprivileged network namespace, `--use-env-proxy` ignored by `fetch`), so that path
  rests on the mid-stream cut and the throwing-reader test; and the panel was verified at the API
  and stream level rather than driven in a browser.

## Phase 25 — risk limits and kill switches (done)

- The owner's limits are data: six columns on `RiskPolicySettings` (per-order notional,
  per-strategy notional, open positions, trades per interval, the interval in minutes, the
  post-halt cooldown) plus `allowedVenuesJson`, validated as a whole and written with a
  `RISK_LIMIT_CHANGED` audit row per limit that moved — `from`, `to`, and an effective-from
  instant kept per limit in `limitsEffectiveFromJson` so the editor can say "in effect since".
  Zero is unlimited throughout: `capIsSet(0)` is false, the panel renders `Unlimited`, and a
  zeroed cooldown clears its clock instead of leaving a stale one refusing.
- One gate serves both surfaces. `lib/risk-controls/enforcement.ts` exports `authoriseOrder`,
  called by `POST /api/trading/orders` and by the strategy runner with the same policy row and
  the same usage arithmetic (`lib/risk-controls/usage.ts` reads the account's orders once and
  derives open positions, open exposure, interval trades and the strategy's net filled
  notional). `evaluateOwnerLimits` returns `REFUSE` with
  `limits: [{reason, limit, cap, observed, scope}]`, and the sentence in the response is built
  from that list, so a refusal always names the limit and the value it saw. An unreadable
  switch counts as engaged and unmeasurable usage refuses: "no data" is never "no limit".
- The manual path keeps its own contract. A manual order has no declared capital or
  stop-loss obligation, so it is evaluated on the owner's caps and switches only, not the
  armed path's rules; the strategy pass still runs the full phase-20 policy, now with the
  phase-25 caps inside it.
- Both switches are toggles. `POST /api/admin/risk-policy/switch` applies immediately: global
  writes `killSwitchActive` with `killSwitchChangedByUserId`/`At` and a
  `KILL_SWITCH_ENGAGED`/`RELEASED` row (releasing starts the cooldown when one is set), and a
  per-strategy switch is a `StrategyKillSwitch` row keyed by the activation, audited in both
  directions. A refusal is recorded twice — the runner's `StrategyDecision` and an
  `ORDER_REFUSED_BY_RISK_LIMIT` audit row — and never becomes a silent skip.
- `/admin/risk` is three sections: the switches with their state, actor, time and what a press
  would do; the usage table (cap, used, detail, `Unlimited` for zero, `at-cap`/`over-cap`
  emphasised); and the editor with the new fields and their effective-from.
- Gates on the working tree: typecheck 0, test 0 (**622/622**, up from 601), lint 0, build 0,
  `validate_plan` 0 (40 phases). `routes:sweep` was not run; the new route is in the inventory
  and the inventory test now expects 80 methods.
- Click-path (recorded in `proof/phase-25-risk-limits-and-kill-switches.md`): a 25.00 order
  refused `409` at a 5.00 per-order cap with "Max notional per order 5.00 — this order would
  make it 25.00"; the global switch refusing a manual order and naming itself; the
  per-strategy switch making the next runner pass write `RISK_LIMIT_REACHED` for that
  strategy while the activation stayed `RUNNING`; a two-minute cooldown refusing an order
  after the switch was released; the cap set back to `0` reading `Unlimited` in the panel and
  the same order then accepted; and the `RISK_LIMIT_CHANGED` / `KILL_SWITCH_*` /
  `ORDER_REFUSED_BY_RISK_LIMIT` rows.
- Three defects the walk found and fixed: a `PUT` of exactly what `GET` returned was rejected
  as "unsupported fields" (so no panel save — and the switch endpoint, which re-saves the
  read row — could ever succeed); `allowedVenues` was compared against the raw row, writing a
  spurious audit row on every save and leaving the effective-from map stale in the response;
  and a cooldown clock from an earlier setting still refused orders after `cooldownMinutes`
  was zeroed. Each is now a test or a measured reading, not a note.

## Phase 24 — the strategy runner, 24/7 (done)

- The phase-23 control now has a loop behind it: `lib/strategies/runner.ts` runs as the
  `strategy-activation` job, evaluates every `RUNNING` activation once per the strategy's own
  interval (hourly for `rsi-daily-close`, independent of the five-minute job cadence), and
  either places one order through the phase-06/20/21 path or writes a `StrategyDecision` row
  with the inputs, condition values and reason. Three files split the concerns: `decide.ts` is
  the pure rule, `reasons.ts` is the closed taxonomy (`placed` / `idle` / `error`), and
  `runner.ts` is the only writer of decisions and the only caller of the order path.
- One decision per interval is enforced in three independent places: the claim
  (`StrategyActivation.lastWindowStart` taken with one conditional `UPDATE … WHERE
  lastWindowStart < window`), the unique `(activationId, windowStart)` index on
  `StrategyDecision` (migration `20261018140000_strategy_decisions`), and the order's client
  key `strategy.<activationId>.<windowStart>`, which makes a replay resolve to the first order.
  A second invocation in the same hour answers `0 window(s) decided` with its own sentence.
- A missed window is one recorded row. When the last decided window is more than one interval
  behind (a deploy, a crash, a schedule that stopped), the pass writes a single
  `RUNNER_MISSED_WINDOW` decision for the skipped window and then decides the current one, so
  the recovery neither loses the gap nor duplicates an interval.
- `/trade` renders the record: `getStrategyDecisionFeed` reads the last decision, history,
  next pass and pass count, and `components/strategy-status.tsx` shows them with the
  condition table, the inputs the pass used and the taxonomy it can report. The panel is the
  runner's verdict, not a second computation.
- The risk policy is consulted through its own input shape and a refusal is recorded as
  `RISK_LIMIT_REACHED` with the policy's reasons quoted. The order path's own reasons are
  mapped (`INSUFFICIENT_BALANCE → INSUFFICIENT_VENUE_BALANCE`, `PROVIDER_RATE_LIMITED →
  RATE_LIMITED`, `VENUE_UNAVAILABLE → VENUE_UNREACHABLE`, `INVALID_CREDENTIAL`, …) rather than
  flattened into one code. Daily-loss and post-arm exposure inputs are `0` until phase 25
  supplies that accounting, and the record says so.
- Gates on the final tree: typecheck 0, test 0 (**601/601**, up from 578; `tests/strategy-runner.test.ts`
  adds 23, including two concurrent passes producing one decision and a decision submitted
  through the real `submitOrder` with a scripted venue), lint 0, build 0, `validate_plan` 0
  (40 phases). `pnpm db:setup` applied the new table and column to the SQLite database without
  losing its rows.
- Live evidence (recorded in `proof/phase-24-strategy-runner-24-7.md`): a pass on `:3240`
  decided one window on real market data — RSI **46.05** from **90 closed daily BTC-USD
  candles**, last close `81378.21` at `2026-10-18T00:00:00.000Z` — and recorded `POSITION_OPEN`
  because two paper orders from phases 21/22 are still working, with the venue, position and
  policy facts in `inputsJson` and both RSI conditions in `conditionsJson`. A second invocation
  in the same hour wrote nothing and said why. A second seeded account was started through the
  phase-23 control, its window backdated three hours, and the next pass produced exactly one
  `RUNNER_MISSED_WINDOW` row at 09:00 followed by a `CREDENTIAL_MISSING` decision at 10:00 —
  the loop recorded the gap and continued. `/trade` rendered the block with `PASSES RECORDED 4`,
  `NEXT PASS 2026-10-18 10:59:12.451Z`, the last decision and its condition table, and the
  taxonomy list.
- **No live order was placed by the loop**, by the phase's own design rather than by accident:
  the real signal (RSI 46.05) is above the 30 entry, and the two working paper orders make
  `POSITION_OPEN` the honest decision. The placement path is proved through the real order
  path with a scripted venue in the suite (one order, `BTC-USD`/`BUY`/`0.00041667`, stop
  `58800.00`, the decision naming it). The migration ran on SQLite through `db:setup`, not
  Postgres; `/trade` was read as server HTML rather than driven as a hydrated panel; and
  `routes:sweep` was not run because this phase adds no route.

## Phase 22 — live execution behind the owner's switch (done)

- Real money became reachable **through one boolean the owner owns**, and nothing else. It is a
  column on the risk-policy row (`RiskPolicySettings.liveExecutionEnabled`, migration
  `20261018090000_live_execution_switch`, default `off`, plus `liveExecutionChangedByUserId` /
  `liveExecutionChangedAt`), edited beside the limits on `/admin/risk` and saved through the same
  validated `PUT /api/admin/risk-policy`. There is no environment variable, no constant and no
  code-level gate: the panel is the control, and `validateRiskPolicyUpdate` **requires** the field
  rather than defaulting it, so a save that omits it is refused instead of silently turning real
  money off or on.
- `orderPlacementRefusal(id, settings)` in `venues/registry.ts` is now the only thing that decides
  whether a live venue may be selected: `null` when the switch is on, otherwise a sentence naming
  the switch, its state and `/admin/risk`. Registration of the refusal also writes
  `ORDER_BLOCKED_BY_SWITCH` with `{switch, state}`. A flip writes two rows — the usual
  `RISK_POLICY_UPDATED` diff and a dedicated `LIVE_EXECUTION_ENABLED` / `LIVE_EXECUTION_DISABLED`
  with `{switch, from, to, changedAt}` — so "who turned it on and when" is one row, not a blob.
- `venues/live-adapter.ts` is Binance's production endpoint behind the **same** `OrderVenuePort`
  the testnet implements: identical pair mapping, client-order-id translation, classifier and
  lifecycle, with `assertLiveEndpoints` refusing a client whose hosts are a Binance testnet, so a
  venue reported as live cannot be a sandbox. It deliberately does not gate — nothing of its own
  stands between `submit` and the exchange.
- `orders/preflight.ts` is the phase's direction in code: credential verification, the venue's own
  balance and open exposure against the configured limit all produce sentences, and the module has
  **no refuse branch**. Every notice travels in the order response (`preflight`) and the audit
  trail; the venue's own answer is what decides. `GET /api/trading/orders/comparison` reports what
  the testnet configuration would have been asked and states that nothing was decrypted, no venue
  contacted and no order placed — displayed to the owner, never a step in the live path.
- `resolveVenueForOrder` resolves the venue that already holds an order with
  `permitLivePlacement`, so switching off mid-flight lets an open live order reconcile and cancel
  instead of turning its reconciliation into a refusal. `reconcile.ts`'s summary sentence now names
  the two counts separately (resolved-elsewhere vs. unresolvable) in both branches.
- Gates on the final tree: typecheck 0, test 0 (**565/565**, up from 551; `tests/live-execution.test.ts`
  adds 13), lint 0, build 0, `validate_plan` 0 (40 phases), `routes:sweep` 0 (**94/94** with the
  owner session on `:3236`, including the new comparison route).
- Live evidence (recorded in `proof/phase-22-live-execution-admin-switch.md`): `PAPER ORDERS` /
  `liveExecutionEnabled: false` before anything; a live submission answered `403
  LIVE_EXECUTION_DISABLED` with `switch: {name: "liveExecutionEnabled", state: false, panel:
  "/admin/risk"}` and **no order row**; the switch on through the panel's own `PUT` (`200`,
  changed by `dev-owner-user` at `2026-10-18T03:22:50.611Z`) turned status into `LIVE ORDERS` /
  `LIVE VENUE` with venue `binance`; the next live submission **reached the venue selection** and was
  refused `409 READ_ONLY_CREDENTIAL` naming the account's own read-only Binance key, before a row
  existed; the switch off again (`200`, `2026-10-18T03:22:51.250Z`) returned status to
  `PAPER ORDERS`. The audit trail held `LIVE_EXECUTION_ENABLED`, `LIVE_EXECUTION_DISABLED`,
  `ORDER_BLOCKED_BY_SWITCH` and the policy diffs, each with actor and time. `/admin/risk` rendered
  `LIVE ORDERS OFF`, `REAL-MONEY EXECUTION IS OFF` and "Last changed by 0x1111…1111 at …"; `/trade`
  rendered `PAPER VENUE` with the registry's sentence. The dry comparison answered `200` with
  mappedPair `BTC/USDT` and `wouldPlaceOnTestnet: false` (no testnet key), and `400` without a market.
- **The owner's first live order is open, by design.** Requirement 6 puts it in the owner's hands,
  and this machine has neither funds at a venue nor a trade-capable key: the only Binance key here
  is read-only, which the live path refused by name. The switch is therefore left **off** — the
  state the owner last chose — so nothing can move until they run the plan's click-path (small real
  order → terminal state → `/account` and the audit trail → the venue's own rejection when the
  balance is gone). No real-money order was placed by this phase, and the record says so rather
  than implying otherwise.
- **Limits.** The live adapter met a scripted transport, not Binance's production endpoint; the dev
  database is SQLite and real Postgres is still unreachable, so the migration ran through
  `scripts/dev-database.mjs` rather than `prisma migrate deploy`. The browser was not driven: the
  two pages were read as server HTML with the owner's cookie, and the client-only surfaces
  (pre-trade notices, on-demand comparison) rest on the API readings and the shared component.

## Phase 21 — the testnet order path (done)

- The order path did not grow a second branch: `binance-testnet` joined the phase-20 venue table
  as the only descriptor with a `place` capability, `venues/testnet-adapter.ts` implements both the
  read interface and the phase-06 `OrderVenuePort`, and `resolveOrderVenue(userId)` in
  `venues/registry.ts` is now the single answer to "where does this order go?" — used by
  submission, cancellation, the status surface and the runner's reconciliation pass.
- The one switch that can move an order off the paper venue is admin data:
  `IntegrationFeatureSettings.testnetOrdersEnabled` (migration `20261017190000_testnet_order_routing`,
  default off, audited, on `/admin/access`). Off means the development paper venue; on means the
  signed-in account's own newest unrevoked testnet key. Missing key, read-only key, unreadable
  ciphertext and unreadable settings each refuse with a sentence (`TESTNET_CREDENTIAL_MISSING`,
  `READ_ONLY_CREDENTIAL`, `TESTNET_CREDENTIAL_UNREADABLE`, `DATABASE_UNAVAILABLE`) before an order
  row or a reservation exists — no silent fall back to a simulation.
- "No reachable live path" is a property of the table, not a promise: live descriptors have no
  `place`, `createVenue("binance")` has no order methods, and `orderPlacementRefusal` refuses any
  venue that is not a testnet. The sandbox is enforced per client as well: `setSandboxMode(true)`
  then a host check against `testnet.binance.vision` / `testnet.binancefuture.com`, so a client
  resolving elsewhere throws instead of placing.
- Reconciliation resolves the venue per order owner and **refuses to ask a venue that does not
  hold the order**: a mismatch (routing switched off or changed, or another account's paper order)
  is left alone and counted, because a "no such order" answer from the wrong venue would close a
  live order after the grace window. `ReconcileSummary` gained `skippedByVenueMismatch` and the
  summary sentence names both counts.
- **Defects the live run found, both fixed and re-measured.** (1) Binance refused our client order
  id with `-1100 Illegal characters found in parameter 'newClientOrderId'` — the phase-06 key is
  longer than 36 characters and may contain `.`/`:`; the adapter now translates it
  (`testnetClientOrderId`) and records both spellings. (2) That same refusal was classified as "no
  definitive answer" and retried three times; `BadRequest`/`ArgumentsRequired`/`ExchangeError` are
  now definitive (`ORDER_REJECTED`/`VENUE_REFUSED`), so the re-run recorded `attempts 1` with the
  venue's own words. (3) Reading the cancel route showed it loaded an order by id with no
  ownership check — now `404` for an id that is not this account's.
- Gates on the final tree: typecheck 0, test 0 (**551/551**, up from 534; `tests/trading-orders.test.ts`
  adds 17), lint 0, build 0, `validate_plan` 0 (40 phases), `routes:sweep` 0 (**93/93** with the
  owner session on `:3236`).
- Live evidence (recorded in `proof/phase-21-testnet-order-path.md`): `PAPER ORDERS` before the
  switch; the switch on through `/api/admin/integrations` (`200`) turning status into
  `TESTNET ORDERS` / `binance-testnet`; routing on with no key refused `409` with the order count
  unchanged (4 → 4); a deliberately invalid testnet key saved and verified against the real
  testnet (`200`, `ok: false`, `-2014 API-key format invalid`, 2232 ms); an order answered by that
  refusal with `attempts 1`, `FAILED` and the venue's sentence on the row; a cancel of the failed
  order refused `409` without the venue being asked; `/trade` rendering `TESTNET VENUE`; and a
  runner pass that asked no venue (`checked 3, skipped 2` — two paper orders, one account with no
  key). The key was revoked and routing switched back off at the end (`PAPER ORDERS`).
- **Not measurable here:** no funded testnet key exists, so no live fill or partial fill was
  observed — those states come from the scripted-transport tests through the real adapter; the
  route's invalid-pair evidence is its validation refusal because all ten curated markets exist on
  the testnet (`exchangeInfo`, 1373 symbols); `USD` is mapped onto `USDT` and a testnet fill will
  not prove price parity; the Postgres migration is verified against Prisma's derived DDL rather
  than executed.

## Phase 20 — venue abstraction and key handling (done)

- One venue contract (`src/lib/venues/types.ts`, client-safe) with two adapters: `ccxt-adapter.ts`
  for Binance, Kraken and Coinbase Advanced (spot accounts, transport injectable) and
  `wundertrading-adapter.ts` for WunderTrading, whose descriptor claims **health only** because its
  read surface answers profile and strategy questions rather than a balance. `registry.ts` is the
  only switch over venue names and also holds the venue access policy, so a route asks "may this
  venue be used?" without learning which name it holds.
- A capability a venue never claimed is refused *before a client exists* (`CAPABILITY_UNAVAILABLE`),
  the write gate (`assertWriteAllowed`) runs before the transport is built, and the phase's proof
  counts it: a read-only key's cancellation attempt created 0 clients and sent 0 cancellations,
  while the same key read balances and a trade-capable key cancelled once.
- Permissions are recorded in two halves that mean different things: `requestedPermissions` (what
  the owner asked for, mirrored from the scope) and `reportedPermissions`, which is `null` when the
  venue does not report a key's permission set. Binance's `account/apiRestrictions` is asked when
  the CCXT client exposes it, and a key the venue says can withdraw makes the connection unhealthy
  instead of quietly usable. Withdrawal permission is refused at save (`WITHDRAWAL_NOT_PERMITTED`)
  along with two scope conflicts and an unknown permission, with nothing encrypted or stored.
- A check is a read whose result is written either way: `lastCheckedAt`, `lastCheckLatencyMs` and
  `lastCheckError` are recorded (with `verifiedAt` keeping its old meaning, "the last time the key
  was proved to work"), so a failure nobody is looking at is still on the row, and an unchecked
  connection reads `NOT CHECKED YET` rather than "healthy". `credentialAvailability` is now the one
  function every credential-using path asks, so revocation ends a key's use on the verify route and
  on the WunderTrading read route (`404`, `CREDENTIAL_REVOKED`).
- The panel states the custody position in plain words and shows, per connection, the scope badge,
  `CAN` / `CANNOT` capability chips, the requested and venue-reported permissions, and the last
  check with its latency and error. New connections default to read-only.
- Two of the eight new tests guard the definition of done where it regresses silently: no source
  hands a credential field to a logging call, and the panel imports only the client-safe venue
  module (so the adapters, the registry and Node crypto cannot reach the browser bundle). The
  plaintext was also searched for in every response and the whole server log of this run: absent.
- Gates on the working tree: typecheck 0, test 0 (**534/534**, up from 526), lint 0, build 0,
  `validate_plan` 0 (40 phases), `routes:sweep` 0 (**93/93** rows, owner session on :3236), and the
  migration checked statement for statement against the DDL Prisma derives for
  `TradingVenueCredential`.
- Click-path recorded in `proof/phase-20-venue-abstraction-and-keys.md`: a read-only key saved with
  `requestedPermissions: ["read"]`, two real failed checks recorded with their venue's own error and
  latency (Kraken `EAPI:Invalid key` 2509 ms, WunderTrading 401 482 ms), four save-time refusals
  with the connected-account count unchanged, the owner-switched venue policy answering 403 before
  any call, and revocation answered as `CREDENTIAL_REVOKED` on both routes.
- **Defect the walk found and fixed:** the `POST` response returned a narrower object than `GET`
  (no `capabilities`), and the panel inserts a saved credential straight into the list it renders —
  so the first save through the UI crashed the page with `Cannot read properties of undefined
  (reading 'includes')`. One shared `credentialView` projection now serves both methods, and the
  save path was re-measured in the browser.
- **Repo defect found while verifying:** `.gitignore`'s `*credential*` / `*secret*` rules were
  hiding two real source files from version control — `src/lib/trading/read-only-credentials.ts`
  (where this phase's `credentialAvailability` lives, and what the orders route imports) and
  `src/lib/auth/totp-secret.ts` (phase 10). They compile and run, but a clean checkout would not
  have them. Two whitelist lines were added beside the existing ones; both files are still
  untracked and left for the owner to commit.
- Limits of the run: no real venue key exists here, so **no successful live check was measured**
  (the healthy path rests on the counting-transport tests; the failing path is live for two venues);
  Binance's permission report is mapped but not measured live; a revoked credential keeps its
  fingerprint, so the same key material cannot be reconnected (`409`, a schema decision about a
  partial unique index the derived SQLite schema cannot express); and the two credentials seeded by
  earlier sessions cannot be decrypted with this run's throwaway key, which fails closed with a 503.

## Phase 19 — market data and the screener (done)

- Ingestion is an upsert against `MarketCandleRecord`'s unique key
  `(providerId, symbol, interval, openTime)`, so `market-ingest` writing a window twice updates those
  rows and `market-backfill` overlapping a stored range adds nothing. Gaps are generated from the
  interval and the **closed-candle** boundary, so a still-forming candle is never reported missing
  and every run does not ask for it forever.
- Provider health is kept twice on purpose: durable `ProviderCallRecord` rows (calls, failures, error
  rate, latency, last success/failure, last outcome) survive a restart, while the run-local registry
  sees the failures the HTTP record cannot (a 200 with an unreadable body) and enforces a 60-second
  cooldown after three consecutive failures. Each symbol/interval and each news feed is an
  independent operation: a failure is recorded in the summary and the sources that answered are
  still stored, so one dead provider cannot block a run or hide another source's data.
- One indicator module (`src/lib/market-data/indicators.ts`) is imported by the screener, the alert
  evaluation, the RSI backtester, the paper-trading engine, the assistant route and the market
  chart, so a number in two places cannot disagree.
- `/screener` evaluates the alert model's own conditions over a symbol set, saves a screen
  (`Screener`, unique per user + name), records every run as a new `ScreenerResult` row (20 retained)
  and can turn a screen's matches into market alerts using the screen's own condition and threshold.
  Every run states its as-of time, the newest candle that answered it, the providers and a
  `resultHash` that covers the condition and rows but not the clock — which is what lets the view say
  "identical to the previous run" with evidence.
- `market-ingest` (15 min) and `market-backfill` (6 h) are phase 05 jobs, so none of this needs a
  browser open. The README's runner job table, which still listed only two jobs, now lists all eight.
- Gates on the working tree: typecheck 0, test 0 (**526/526**, up from 521 — see below), lint 0,
  build 0 (18 pages, 46 API route files, 74 methods), `validate_plan` 0 (40 phases), and
  `routes:sweep` 0 (**93/93** rows, owner session on :3235).
- Click-path recorded in `proof/phase-19-market-data-and-screener.md`: 4 MATCHED / 10 CHECKED with
  every value's provider and observation time, a saved screen surviving a reload with its parameters
  and re-running to the identical hash `136effbdb166`, `CREATE ALERTS` creating `BCH-USD` while
  skipping the three symbols that already had the same active alert (all four then listed under
  `/#alerts`), and the failure run — the real provider class driven by a refusing fetcher — where the
  candle source failed four operations, `SOL-USD` was skipped on its cooldown, all nine news feeds
  still stored 183 headlines, both health tables showed the failure, and a screen still evaluated on
  stored data.
- **Two defects found and fixed.** `OPEN ALERTS` pointed at `/#market-alerts`, an anchor that does
  not exist (the panel's section id is `alerts`), so it was a control that did nothing.
  `src/app/api/cron/[job]/route.test.ts` had **never run**: the `test` script names that literal path
  and the test runner reads its arguments as globs, where `[job]` is a character class matching one
  of `j`/`o`/`b` — `tsx --test` reported `tests 0` while the suite exited 0. Its assertion (known
  jobs `market-alerts, retention`) was stale from phase 12 onward and would have failed had it run.
  The script now names `src/app/api/cron/*/route.test.ts` (5 tests, passing) and that assertion now
  derives from `RUNNER_JOB_IDS`; the 521 → 526 test count is those five tests actually running.
- **Plan inconsistency reported, not silently fixed:** the README and the phase 18 proof both said
  "phase 19 owns valuation", but this phase's plan has no valuation in or out of scope and no later
  phase file claims it. The README now states that the portfolio is unpriced and that no phase
  assigns it a valuation; whoever schedules it should add it to a phase file.
- Limitations recorded in the proof: there is no market-data credential to break (both providers are
  public and keyless, so the failure path used a refusing fetcher through a temporary route that was
  removed), run-local health is lost on restart by design, the host's entry plan delivers one
  invocation a day so a 15-minute interval is a claim of due-ness rather than a delivery promise, the
  screener reads 15m candles only, the saved-screen comparison needs two runs, and the Postgres
  migration was verified against Prisma's derived DDL rather than executed.

## Phase 18 — portfolio aggregation (done)

- One read across every enabled network: `GET /api/portfolio` returns holdings with network, chain
  id, checksummed contract, decimals, raw amount, exact formatted amount, provider and read time,
  plus per-network totals and an aggregate. `Accept: text/event-stream` streams `start`, one
  `network` per settled row, `summary`, `done`, so answered networks appear first.
- Networks are read four at a time with a 12-second per-network deadline that aborts the fetches it
  covers. A failed network is a row with a reason (`Base did not answer.`), and the summary carries
  `complete: false` plus every `missing` network; the panel labels the aggregate a floor rather than
  a complete total.
- Holdings come from `alchemy_getTokenBalances` discovery, not from the allow-list: a token nobody
  listed is shown with its checksummed address and a `not in allow-list` marker. Markers also flag a
  URL or claim phrase in the name, an over-long symbol, missing decimals, and `suspectedSpam`; a
  marked token stays on the page with an `Inspect` disclosure (raw amount, contract, read time,
  source, explorer).
- Token metadata lives in the shared `TokenMetadata` table with a 24-hour freshness window and
  `?refresh=1` for an on-demand refresh. A cache read that throws is a miss, not an error: the live
  chain read still lists every holding, with unresolved contracts shown in raw units by address.
- Gates on the working tree: typecheck 0, test 0 (**510/510**, 11 new in
  `tests/portfolio-aggregation.test.ts`), lint 0, build 0, `validate_plan` 0 (40 phases), and
  `routes:sweep` 0 (**71 methods**, 18 pages) after adding the new row.
- Click-path recorded in `proof/phase-18-portfolio-aggregation.md`: the seeded owner with Ethereum
  and Base enabled gave **89 Ethereum holdings** (native `5.71818055799281732` ETH, 88 tokens, 86
  metadata rows, 3 address-only), five tokens marked as possible spam and all 88 tokens marked `not
  in allow-list`; a second dev server with a dead Base endpoint answered `200 partial` with Base
  named unavailable and Ethereum still rendering; the browser showed Base first as `NO ANSWER`, the
  partial-coverage sentence and Base's reason above the totals; the token `Inspect` disclosure
  showed its raw amount, contract and explorer link; a repeat metadata resolution was a cache hit
  with **one** provider call; and `REFRESH METADATA` issued `?refresh=1`.
- Limitations recorded in the proof: no pricing (phase 19); the three unresolvable contracts are
  re-asked each load because there is nothing to cache; a fully stopped database cannot be probed
  because session resolution reads it, so the cache-unavailable path was measured with a throwing
  store; one `next dev` per project forced the dead-network reading onto a second, deliberately
  broken server; and a modified CSS rule needed a dev-server restart before the browser saw it.

## Phase 17 — network registry across every configured chain (done)

- Networks are discovered, not listed: `src/lib/rpc/networks.ts` scans `ALCHEMY_<NETWORK>_RPC_URL`
  and `ALCHEMY_<NETWORK>_API_KEY` (excluding `*_BEACON_RPC_URL`) and builds entries with name, chain
  id, native asset, explorer, kind, testnet flag, token-allow-list status, availability, source and a
  reason that names the variable and never the value. The live environment yielded **154 networks,
  all 154 usable, 89 EVM with chain ids, 29 in the portfolio allow-list, 21 identified non-EVM and
  44 proxy-only with no confident chain id**. Unknown metadata never hides a configured network.
- `network-catalog.ts` holds public metadata; `evm-mainnets.ts` gained explorer URLs; a per-network
  `_API_KEY` now resolves through a known Alchemy host, ahead of the shared-key fallback.
- Startup validation in `instrumentation.ts` logs the usable/total count and one line per problem.
  The live broken-key reading: restarting with `ALCHEMY_ROUTE_SWEEP_PROBE_RPC_URL=http://…` gave
  `154/155 usable`, named the https failure, left Base/Arbitrum/Solana available (Arbitrum proxy
  `200 · 0xa4b1`) and answered the bad network `503`; removing it restored 154/154.
- Health is in-process and per network: last success/failure, latency, consecutive failures, with a
  three-failure threshold and a 60-second skip cooldown that states the wait. The proxy and the
  portfolio read both honour it, so one dead chain cannot fail a request the others answer.
- `GET /api/portfolio/networks` serves the registry and health to a signed-in caller; `/trade`
  renders the switcher. In the browser it listed exactly the registry's **155 entries** (89
  switchable EVM + 66 proxy-only); selecting Base verified the real RPC (`chain 8453 · block
  52,721,930 · 617 ms`), a stand-in wallet was moved to 8453 and read back, and a wallet that resolved
  the request without moving produced the exact mismatch sentence. `/admin/data` section 07 shows
  totals, unavailable reasons and per-network health.
- `pnpm networks:coverage` compares Development, Preview and Production in the names-only manifest:
  **154 per scope, no gaps, 3 beacon variables ignored**; `--check` exits 1 on a gap.
- Three defects the check found and fixed: health keyed twice for Ethereum (`eth-mainnet` vs
  `ethereum-mainnet`, now canonicalised by `canonicalNetworkSlug`), the unavailable-network reason
  rendered twice, and a health label that implied live data while showing the page-load snapshot.
- Gates on the working tree: typecheck 0, test 0 (**499/499**, 27 new), lint 0, build 0,
  `validate_plan` 0 (40 phases, 0 restriction hits), `routes:sweep` 0 (**89/89**, 18 pages, 70
  methods), `networks:coverage` 0.
- Limitations recorded in `proof/phase-17-network-registry.md`: 44 networks have no asserted chain
  id; wallet switching used a stand-in EIP-1193 provider (no extension installed); health resets with
  the process; the coverage report is only as current as the manifest; portfolio aggregation across
  the new networks is phase 18; and `next build` logs Prisma errors during static generation when
  `DATABASE_URL` is absent (exit 0, unchanged).

## Phase 16 — fees and pricing (done)

- One table holds every price, as **versions**: `src/lib/fees/table.ts` stores a
  `FeeSchedule` row per save with an `effectiveFrom`, inserts only, and reads "what is in
  force" as the latest version whose time has passed. The audit event a save writes carries
  the before/after pair and names the row that still holds them. `amounts.ts` is the shared
  arithmetic (decimal ↔ minor units, `quoteWithdrawal`, zero renders as `no fee`);
  `apply.ts` is the performance fee.
- The withdrawal path and `/pricing` read **one** row: `readPricedWithdrawalPolicy` overlays
  the table on the deployment policy, and `pricingRows` asks the same
  `withdrawalFeeFor`/`networkCostFor`, so a save changes the deducted amount and the public
  page together. The request refuses a fee at or above the amount **before** the
  reservation, with both numbers in the sentence; the panel shows the fee, the disclosed
  network cost and the arriving amount before submit.
- A performance fee is a ledger movement, not a computed number: `chargePerformanceFee`
  posts a balanced `PERFORMANCE_FEE` transaction from the owner's `AVAILABLE` to
  `platform:fees:<asset>` under a key derived from the result and with
  `sourceType: "StrategyResult"`/`sourceId`; `reversePerformanceFee` posts the compensating
  legs referencing the original. Profit pays a floored basis-point percentage, a loss pays
  nothing, and the fee account can be re-derived from its entries.
- `/admin/fees` (guarded by the new ACTIVE `fees.manage` permission) edits the table, the
  effective time and the tier caps with `AUDITED ON SAVE`; `/pricing` is public, reads at
  request time and states no price when the table is unreadable. The default tier's
  venue-connection cap is enforced by the credential path; bot caps wait for phase 30.
- The `/account` period report separates withdrawal fees from performance fees, and the CSV
  export carries a `# PERIOD FEES` block after its history. The re-import parser stops at
  that marker, so the phase-15 reconciliation still exits 0 with the block present.
- Gates on the working tree: typecheck 0, test 0 (**472/472**, up from 459), lint 0,
  build 0, `validate_plan` 0, and `routes:sweep` **88/88** on the owner session against
  :3235 (the four new rows: `/pricing`, `/admin/fees`, GET and PUT `/api/admin/fees`).
- Click-path (recorded in `proof/phase-16-fees-and-pricing.md`): a save to 1 USDT / 0.5 USDT
  network cost / 20% made `/pricing` render `1 USDT`, `0.5 USDT paid by the platform` and
  `20% of a profitable result.` while `/api/withdrawals` read the same values and a 2 USDT
  withdrawal carried `feeMinor 1000000` / `netMinor 1000000`; raising the fee to 25 refused
  the request 400 with “leaves nothing of 2 USDT to send”, created no row and left the
  balance at 13; zeroing the table rendered eight `no fee` labels and `No fee.`; five
  insert-only versions produced five `FEE_SCHEDULE_UPDATED` audit rows. Restoring 1 USDT
  under a **later** `effectiveFrom` was itself a check: a version dated earlier than the one
  in force does not override it.
- Limitations recorded rather than hidden: the Postgres migration was verified against
  Prisma's derived DDL statement for statement and not executed (no Postgres here; all
  runtime checks ran on the derived SQLite dev DB); `chargePerformanceFee` has no live
  caller until phase 24's runner, so it is proven by tests; bot tier caps are data and
  published but phase 30 owns enforcement; and the withdrawal panel's pre-submit numbers
  were verified through the API view it consumes plus the shared quote under test, because
  the preview pane had no authenticated session for `/trade` (the public `/pricing` DOM
  snapshot did match its rendered rows). `WITHDRAWAL_FEE_<ASSET>` is now a fallback for a
  deployment whose table is unreadable, not a second source.

## Phase 14 — withdrawals and failure paths (done)

- The balance goes back out to a wallet the owner names, and every way that can go wrong is a
  state. `src/lib/withdrawals/` holds the path: `request.ts` (validation, the fee split, and a
  reservation posted **in the same database transaction as the row**, under a `LedgerAccountLock`
  taken before the balance is read — so two requests that each see the same spendable balance
  cannot both take it), `chain.ts` (the port: nonce allocation, `eth_estimateGas`/`eth_gasPrice`,
  signing, `eth_sendRawTransaction`, receipts, and a node's refusal text mapped onto the taxonomy's
  codes), `execute.ts` (sign once, store the bytes, broadcast under a compare-and-set; a retry
  re-sends *the same bytes*), `confirm.ts` (the network's confirmation count, the settlement that
  takes the fee with the transfer that earned it, expiry, and the cancellation *attempt*),
  `states.ts` (the taxonomy as data, with a retryability answer per code), `addresses.ts` (the
  destinations this account has used), `store.ts`/`service.ts` (Prisma, and the pass the runner and
  the panel's check button both call), and `policy.ts` (pure, and it reports every value it could
  not use instead of dropping it).
- **The new-address control is admin data, not only an environment value.** `settings.ts` +
  `WithdrawalSettings` (one column) + `GET`/`PUT /api/admin/withdrawals` + a form on
  `/admin/access`: the environment value became the fallback, a saved row always wins, and both the
  panel and the admin page say which is in force. Zero is stored as a value and holds nothing, and
  the validation refuses any other field — there is nowhere to put an approval gate, which is the
  phase's own "do not do". Editing the number never moves a row that is already waiting.
- **Surfaces:** `GET`/`POST /api/withdrawals` (the view; a request; `{"action":"check"}` to run one
  pass now), `GET`/`POST /api/withdrawals/[id]` (one row; a cancellation attempt, answered 200
  `cancelled` when nothing was sent, 202 `replacement-sent` when it was, 409 for `NOT_YET_DUE`),
  and `components/withdraw-panel.tsx` mounted on `/trade` as `05 / WITHDRAWALS`. Four new methods
  in the route inventory (65 exported methods, 81 rows) and a counter in the sweep's own test.
- Schema: `Withdrawal` (three exact integer amounts, the destination, the state and reason, a unique
  idempotency key, the nonce with a unique index on `(network, fromAddress, nonce)`, the signed and
  cancel bytes, hold/expiry/timeout stamps), `WithdrawalAddress`, `LedgerAccountLock`, and
  `WithdrawalSettings` — two migrations (13 and 3 statements) each verified **statement for
  statement** against Prisma's derived DDL, since Postgres is still unreachable from this machine.
- Gates on the working tree: typecheck 0, test 0 (439/439, up from 434; 21 in
  `tests/withdrawals.test.ts`), lint 0 (the three warnings this phase introduced were fixed rather
  than suppressed), build 0, `validate_plan` 0, and `routes:sweep` **81/81 in both readings** — the
  owner-session run on :3231 and the unconfigured run on :3233, both exit 0.
- Click-path (recorded in `proof/phase-14-withdrawals-and-failure-paths.md`): a real session cookie
  for the seeded owner, the phase 12 chain stand-in funding 20 USDT, and the app's own routes.
  Three request-time refusals (`INVALID_DESTINATION` 400, `INSUFFICIENT_BALANCE` 409,
  `NETWORK_UNSUPPORTED` 503) left the balance and the book untouched and wrote a row for none of
  them; each `WITHDRAWAL_SIMULATE_FAILURE` kind, on its own server and a fresh database, left
  `BROADCAST_FAILED`/`NETWORK_UNAVAILABLE`, `BROADCAST_FAILED`/`NONCE_CONFLICT` (amount still
  reserved, cancelled by the owner, 20 back) and `FAILED`/`TRANSACTION_REVERTED` (amount released);
  a first withdrawal of 5 USDT was held until its window, the window was then saved as 0 through the
  admin route, the held row was **not** moved and cancelled immediately; and `amount 20 / fee 1 /
  net 19` went `RESERVED` → `BROADCAST` (hash `0x751cfbc3…`, amount still reserved) → `CONFIRMED
  2/2`, leaving `available 0 / held 0` and the fees bucket holding exactly `1 USDT`. A replayed
  request returned the same withdrawal; the same key with a changed amount was `409
  IDEMPOTENCY_KEY_REUSED`.
- Two defects found and fixed while measuring, both in the development simulation:
  `WITHDRAWAL_SIMULATE_FAILURE=nonce-conflict` reported the conflict from `observe`, which left the
  row `BROADCAST` with a reason and no path forward — a node refuses the *send*, so it now does too
  (`BROADCAST_FAILED`, retryable, cancellable); and the simulated confirmation step was four per
  check, which settled a two-confirmation network in the same pass as the send, so "watch it move
  through reserved, broadcast and confirmed" was impossible by hand — it is now one. Both are
  pinned by `every simulated failure kind lands in the state the taxonomy names`.
- **Renamed:** `WITHDRAWAL_REQUEST_EXPIRY_HOURS` → `WITHDRAWAL_REQUEST_EXPIRY_MINUTES`, because the
  constant was read as minutes and documented as hours (default "168" against a real 10080).
- **Disk note:** the machine hit 100% full while a second `next dev` was compiling for the
  unconfigured sweep reading. Three stale dist directories from phase 07 (`.next-phase07`,
  `.next-phase07-click`, `.next-phase07-unconfigured` — 5.1 GB in total, all long superseded) and
  this phase's half-built `.next-phase14-plain` were removed, which brought `/` from 0 bytes free
  back to 5.1 GB. Nothing tracked by git was touched: every one of them is a regenerable `next
  dev`/`next build` cache.
- Not done, deliberately: no approval gate or second code prompt in front of a withdrawal; no fee
  policy (phase 16); no off-chain or venue balances (phase 20); the browser pane was not driven
  this time (the owner's click-path is the same requests one layer below the pane — see the proof's
  Boundary).

## Phase 13 — ledger and balances (done)

- One ledger of record, and nothing else holds money. `src/lib/ledger/integer-cent-ledger.ts`
  extends phase 03's paper helper with the real thing: amounts are `MinorUnits` (a string of digits),
  every sum runs on `bigint`, and `parseMinorUnits` is the single door a value enters by — `"10.5"`,
  `"1e6"`, `"0x10"`, `""`, `"-5"` and `2**53` are refusals (`LedgerAmountError`, with the offending
  value in the message), not parses. `postLedgerTransaction` resolves every account a posting names,
  refuses a transaction whose debits and credits differ in the asset's minor units, checks the
  idempotency key, and inserts the transaction with its legs in one database transaction — so a
  transaction row is never observable without the entries that make it balanced.
- `accounts.ts` is the taxonomy as data: four buckets (`AVAILABLE`, `TREASURY`, `DEPOSITS_PENDING`,
  `FEES`), each with one owner type and one normal side, and `deriveBalances` turns entries into a
  balance on that side. **Balances are never stored.** A user account is issued on first use, and the
  platform's buckets are issued alongside it, so every movement has a nameable counterparty before the
  first movement that needs one. `statements.ts` builds the statement from rows: `opening + net ===
  closing` holds because all three come from the same function over different cuts of the same
  entries, every line names the accounts on the other side of its own transaction, and the CSV is
  rendered from the lines on screen — so "the export matches the screen" is a property of one array.
- `invariants.ts` checks four claims against the stored book: every transaction balances, the ledger
  balances per asset, no entry is orphaned, no account holder is overdrawn without an explicit credit
  line. The sums are taken in this process rather than in SQL, because a `SUM` over a text column is
  exact on one engine and a float on another. `assertLedgerInvariants` is the throwing form the runner
  uses (`ledger-invariants`, hourly, registered in `runner/registry.ts`); `readLedgerHealth` is what
  the observability snapshot and `GET /api/admin/health` render as a health row.
- `deposits/credit.ts` is where phase 12 meets phase 13: a credit is now a balanced movement —
  `DEBIT platform:treasury:<asset>` / `CREDIT user:<userId>:<asset>:available` — posted through the
  *same* database transaction client as the claim that flips the deposit row to `CREDITED`, under the
  deposit's own key (`deposit:<id>:credit`). A reversal is a compensating transaction with each
  direction flipped that references the original; a posted entry is never edited or deleted.
- `LedgerAccount`, `LedgerTransaction`, `LedgerEntry` (`migrations/20261016190000_ledger_and_balances`,
  3 tables, 8 named indexes, 4 foreign keys); `app/api/ledger/route.ts` serves the balance, the
  statement, the CSV and the book's health on `GET`, and exactly one action on `POST`
  (`reverse-deposit`, taking a deposit id the caller can already see — never an account or an amount,
  so no request can mint a balance); `components/balance-panel.tsx` is the surface, mounted on
  `/trade` as `04 / LEDGER`.
- Gates on the working tree: typecheck 0, test 0 (417/417, up from 386), lint 0, build 0,
  `validate_plan` 0 (40 phase files, 0 restriction hits), and `routes:sweep` 75/75 with a minted owner
  session — `GET /api/ledger` 200, `POST /api/ledger` 400 naming the one action it accepts.
- The migration was verified against Prisma's own derived DDL (`migrate diff --from-empty
  --to-schema-datamodel`) rather than executed: 18 statements on each side, identical after whitespace
  normalisation, so the file and `schema.prisma` cannot drift.
- Click-path (recorded in `proof/phase-13-ledger-and-balances.md`): a local HTTPS JSON-RPC stand-in
  described a chain at head 100 with two transfers; `GET /api/deposits` issued the address,
  `POST /api/deposits` recorded both and credited one (20 USDT at 2/2, the 3 USDT transfer left at
  1/2), and the same run again recorded and credited nothing a second time. `GET /api/ledger` read
  `USDT available 20` against `USDT treasury 20`, with the statement's one line carrying its
  transaction id and counterparty, and the export's `TOTAL` row carrying the figure the screen
  showed. `POST /api/ledger` reversed the credit — a new transaction referencing the original, with
  both movements still visible and the balance back to `0` — and a second reversal of the same
  deposit was refused `409`. One extra debit with no matching credit was then written straight into
  the book: three invariants fired, the health row turned `degraded` with a `LEDGER_UNBALANCED`
  reason, and the runner job answered `failed`; removing the injected leg returned both to healthy and
  the job to `worked`.
- **Limitation.** The browser half of the owner's click-path did not settle: while the preview pane
  was being driven it reloaded the `/trade` document 33 times in a row, and every same-origin fetch
  made from the page's own JS context aborted at three seconds — including a static `/favicon.ico` —
  so every client panel on the page (the untouched orders panel, phase 12's deposits panel and the
  balance panel) sat in its loading state. The page did render signed in, with `04 / LEDGER` present,
  and the browser's own `GET /api/ledger` answered 200 in its network log; the ledger itself was
  verified a layer above the pane, over HTTP with the same cookie and the same query string the
  component builds. A human-visible render of the balance and the reversal button is what this phase
  cannot claim.
- **Limitation.** Real Postgres is still not reachable from this machine, so `prisma migrate deploy`
  has not been run; the migration rests on the Prisma comparison above, and on SQLite `db:setup`
  creating the equivalent constraints for the click-path. Reorg-un-crediting a *credited* deposit is
  not automatic: `reverseDepositCredit` is the mechanism and the operator has it, but the fresh read
  of a credited row's block is phase 14 work.

## Phase 12 — deposits and crediting (done)

- A deposit address is *derived*, not allocated: `src/lib/deposits/addresses.ts` computes
  `index = keccak256("<userId>:<network>")[0..4] mod 2^31` and the address is BIP-44
  `m/44'/60'/0'/0/<index>` from `DEPOSIT_ADDRESS_MNEMONIC`. The `DepositAddress` row is the record of
  that derivation (what the watcher looks transfers up by), not the source of it, so the same account
  sees the same address forever and deleting the row would not change it. Issuance is exactly once:
  the row insert and its `DEPOSIT_ADDRESS_ISSUED` event share a transaction, and it runs on sign-in
  (`issueDepositAddressesForSignIn`, which can never fail the sign-in) and again on the first read of
  the deposit surface, so either ordering is safe.
- The watcher is a phase 05 job (`deposit-watcher`, `DEPOSIT_WATCH_INTERVAL_MINUTES`, default 5) and
  the same run on demand from `POST /api/deposits`. One pass is three separated steps — scan (one
  block window per network, ERC-20 logs filtered on the *recipient* topic so a token nobody enabled
  is still seen, blocks read one by one because a native transfer writes no log), classify (a pure
  function to a state and a sentence), record (one row per transfer keyed by the chain's own
  `(network, txHash, logIndex)`) — then a second look re-checks every `PENDING` row against its block
  hash and the head, crediting with a conditional update from `PENDING` so two runs cannot both
  credit one transfer.
- Six states and only one of them is money: `PENDING`, `CREDITED`, `REVERTED` (a reorg removed it,
  `CHAIN_REORGANIZED` with the block evidence in the reason), `BELOW_DUST`, `TOKEN_DISABLED`,
  `UNMATCHED`, all in `src/lib/deposits/states.ts`. Confirmation counts, the dust guard and the
  deposit token are the owner's, per network (`DEPOSIT_CONFIRMATIONS_<SLUG>`,
  `DEPOSIT_MIN_AMOUNT_<SLUG>`, `DEPOSIT_TOKEN_*_<SLUG>`), and a value that cannot be read is reported
  rather than rounded into a different policy.
- `DepositAddress`, `Deposit` and `DepositScanCursor`
  (`migrations/20261016180000_deposits_and_crediting`); `/trade` gained the deposit section, and
  `deposit-panel.tsx` shows the address with copy and QR, the network, the token *and what it
  actually is on that chain*, the confirmations required, the dust guard, the derivation path, the
  live state of each arrival with the confirmations remaining, and an explorer link per hash.
- Gates on the working tree: typecheck 0, test 0 (386/386, up from 354), lint 0, build 0,
  `validate_plan` 0. `pnpm exec next typegen` is required before `typecheck` — the per-address route
  types its context with `RouteContext<"/api/deposits/[address]">`.
- The migration was checked twice over, because no gate above reads a `.sql` file: `prisma migrate
  diff --from-empty --to-schema-datamodel` renders the schema's own DDL, and the 13 statements for
  these three tables (3 tables, 7 named indexes, 3 foreign keys) match it exactly after whitespace
  normalization — the file and `schema.prisma` cannot drift. Its ten `CREATE TABLE`/`CREATE INDEX`
  statements were then executed against SQLite, where the three unique keys rejected exactly the
  conflicts this phase's correctness rests on: a second address for one account on one chain, one
  address issued to two accounts, and the same transfer observed twice. The three
  `ALTER TABLE … ADD CONSTRAINT` statements have no SQLite form and were covered by the Prisma
  comparison instead.
- Click-path (recorded in `proof/phase-12-deposits-and-crediting.md`): a local HTTPS JSON-RPC
  stand-in described a chain at head 100 with four arrivals, and a minted owner session drove the
  real routes. `GET /api/deposits` issued one address, the second read returned the same one, and
  `POST /api/deposits` recorded four arrivals and credited exactly one: 20 USDT at 2/2 confirmations
  (hash, block and raw log evidence kept), 3 USDT `PENDING` at 1/2 with "1 more before it is
  credited", and a token that is not the enabled one plus a native ETH transfer both
  `TOKEN_NOT_ENABLED` and never credited. The replay credited nothing a second time (one
  `DEPOSIT_CREDITED` row, total still 20 USDT); `GET /api/deposits/<address>` served the four rows
  and 404'd a stranger's address; the audit trail held one issuance, four detections and one credit.
  In a real browser the panel rendered the QR, `COPY` → `COPIED`, the credited total, the pending
  line and all four rows, and its own `CHECK NOW` produced the run summary from a real POST. No
  console error.
- **Three findings, all fixed.** (1) The index was first taken modulo `0xffffffff`, which `viem`
  refuses above `0x7fffffff` — BIP-32 reserves the top bit for hardened children, so the original
  range was unspendable; the bound is now `0x7fffffff` and withdrawals, which derive from the same
  paths, depend on it. (2) `DEPOSIT_ENABLED_NETWORKS` accepted any well-shaped slug and silently
  dropped the ones the registry does not know (`dogecoin` produced no network and no explanation);
  unknown slugs are now reported once against the list and rendered in the panel. (3) A run summary
  of "Scanned 0 of 1 network(s)" read like a failure when a check arrived between blocks; the panel
  now renders the skipped network's own sentence.
- **Limitation.** The accepted path was measured against a local HTTPS stand-in
  (`/tmp/phase12/rpc-stub.mjs` with a scratch certificate trusted only by the click-path's dev
  server), not against a public testnet: the application refuses a non-`https` RPC endpoint, and that
  rule was kept rather than relaxed. Nothing was seeded into `Deposit`: an arrival is a fact about a
  chain, and a seeded one would be a fabricated row on the one surface this phase exists to keep
  honest. `plan/PROJECT_TODO.md` carries no per-phase status field and was left alone, as phases
  08–11 left it. Real Postgres is not reachable from this machine — the local server on :5432 wants
  a password and the Docker daemon refuses this user — so `prisma migrate deploy` has not been run
  against a Postgres database; the migration is verified by the Prisma diff and the SQLite execution
  described above, not by applying it to Postgres.

## Phase 11 — accounts, roles and onboarding (done)

- What a successful sign-in does to an account is now a decision before it is a write:
  `src/lib/auth/sign-in-provisioning.ts` plans the rows (`creates.users` 1 or 0,
  `creates.walletIdentities` 1 or 0), the role, whether the development bootstrap applies, whether
  the stored account type has to be rewritten, whether the account is new, and that every accepted
  sign-in refreshes `lastSeenAt`. The transaction still writes it, and `AUTH_SIGN_IN` now records the
  counts, so "one account, one wallet, never a duplicate" is checkable from the audit trail and by
  test instead of only by reading branches.
- Onboarding is four records, not four checkboxes: `src/lib/onboarding/checklist.ts` derives the
  steps from a wallet identity, a completed balance read, a paper order and a live alert, each
  linking to the surface that completes it, and `/onboarding` renders it. `recordBalanceRead` is
  called by the portfolio read when a balance was actually read, so the step cannot be satisfied by
  a call that answered "not connected". The sidebar carries `ONBOARDING n/4` and a brand-new sign-in
  lands on the checklist.
- Access changes are all audited with a reason and all reversible: `POST /api/admin/access` requires
  a 3–200 character `reason` on every action, and gained `revoke-role`, `revoke-team-membership` and
  `remove-team` beside the existing grants. The panel shows each account's last sign-in, the scope it
  is rendering, and has no disabled controls left — an account that already holds everything gets a
  sentence rather than dead checkboxes.
- A denial names what is missing: `missingPermissionMessage` is one sentence naming the permission
  key and its label, `accessRefusalPayload` puts it and the key in the API body (three
  permission-gated routes now spread it), and `PermissionNotice` renders it on a page that used to
  `notFound()`. Team membership scopes the directory via `resolveAccessScope` — a scoped `ADMIN` sees
  their teams and themselves unless granted `admin.access.read.all` — and the narrowing happens in
  the query.
- `DEVELOPMENT_OWNER_EVM_ADDRESS` is now the one place the development owner wallet is written down,
  read by both the sign-in bootstrap and `prisma/seed.ts`. Before this phase the seed had its own
  copy while `getInitialAdminEvmAddress` returned `null` when unset, so a locally seeded database
  recorded an owner the bootstrap would never have granted.
- `User` gained `lastSeenAt` and `lastBalanceReadAt`
  (`migrations/20261016160000_account_onboarding`).
- Gates on the working tree: typecheck 0, test 0 (354/354, up from 336), lint 0, build 0,
  `validate_plan` 0, and `routes:sweep` 70/70 in **both** readings (configured with an OWNER cookie,
  and unconfigured with none). `prisma generate` is required before the gates — the two new columns
  change the generated client.
- Click-path (recorded in `proof/phase-11-accounts-roles-and-onboarding.md`): on a **fresh unseeded**
  SQLite database, a brand-new sign-in with the owner wallet created exactly one account and one
  wallet identity and received `OWNER` through `INITIAL_OWNER_BOOTSTRAP`; a second wallet's first
  sign-in created exactly one of each, and its repeat sign-in created none while moving `lastSeenAt`;
  the checklist went 1/4 → 2/4 (a real Alchemy balance read) → 4/4 through the four linked surfaces;
  a permission denial named `risk.policy.manage (Manage global risk policy)` on the API and on the
  page, the grant took effect on the next request, the revoke stopped it; a scoped `ADMIN` saw one
  account where the owner saw three; all seven access actions left audit rows with an actor and a
  reason. 51 checks, 0 failures.
- **Finding, not fixed:** on the unseeded database `GET /api/admin/risk-policy` answered
  `503 "Risk policy storage is unavailable."` — `getRiskPolicySettings()` throws when the singleton
  row is absent, so the sweep reports an undeclared 503 where the honest answer is "no policy has
  been saved yet". Fail-closed and safe, but a phase 04/25-shaped gap in a module this phase does not
  own; the phase 11 sweep reading was therefore measured on a seeded database.
- **Tooling note:** Next 16 refuses a second `next dev` for the same project ("Another next dev
  server is already running"), so the unconfigured sweep reading needed the configured server stopped
  first. Both readings are from the same database, not from two servers at once.
- Browser pass (same surfaces, real Chromium at `http://localhost:3223`, an owner session minted from
  a real SIWE signature): `/onboarding` rendered `1 / 4 COMPLETE` with four steps and the sidebar's
  `ONBOARDING 1/4`; each step's own link completed it — `/#portfolio` ran the read (`2 / 4`, "A
  balance was read on 2026-10-16T13:53:22.791Z"), `/trade`'s ticket submitted a paper order
  (`1 ORDER(S) · PAPER VENUE`, `paper-0ef9…`), and the alert form created `BTC-USD PRICE ABOVE
  70000` (`1 ALERTS`) — reaching `4 / 4 COMPLETE`, `NOTHING LEFT` and `ONBOARDING 4/4` with no API
  call made outside the pages. On `/admin/access` the owner granted `admin.data.read` to a viewer
  (refused first when the reason field was empty: "Add a reason of at least 3 characters"), the
  viewer's own `/admin/data` then rendered the catalog, and after the revoke the same URL answered
  `PERMISSION REQUIRED` naming `admin.data.read (Read project data catalog)`; create team, assign
  team, revoke membership and remove team each reported "Access change saved and audited." and the
  trail holds both `ACCESS_PERMISSIONS_UPDATED` rows with their reasons.
- **Fixed while verifying (browser pass):** the alert step linked to `/#activity`, the *audit
  stream's* anchor, so "Set a market alert" landed a section above the create-alert form. The
  Market alerts panel now carries `id="alerts"` and the step links to `/#alerts`, which scrolls the
  form into view. Two tests now hold it: `tests/onboarding.test.ts` pins the four step hrefs and
  asserts the panel's anchor exists (the DOM-free suite would not have caught either), and each was
  checked for teeth by restoring the old href, which fails the pinned test (`fail 1`, exit 1).
  Also found and left alone: on `/admin/access` three of 59 controls are disabled until their inputs
  are provided (`ASSIGN TEAM`, `REVOKE MEMBERSHIP`, `SAVE FUNCTION GRANTS`); each was shown to become
  usable once its selection was made, and the sidebar progress line is hidden below the mobile
  breakpoint by the same media query that hides `.sidebar-label` — the checklist page and its nav
  entry stay visible at both widths.

## Phase 10 — account security: scoped 2FA and sessions (done)

- `src/lib/auth/totp.ts` is the cryptography and nothing else: RFC 6238 TOTP (HMAC-SHA1, six
  digits, 30-second step, one step of tolerance, checked against the RFC's own vectors),
  RFC 4648 base32 both ways, `evaluateTotpAttempt` — the single decision that owns the failure
  count, the lock and the replay of an already-used time step — and backup codes issued as
  readable strings but stored only as SHA-256 digests. `totp-service.ts` is the lifecycle over an
  injected store (begin enrolment, activate, verify, consume a backup code, disable), so the whole
  flow is tested against an in-memory store and the routes own only the transaction and the HTTP
  shape. The secret is sealed with AES-256-GCM under the deployment's existing
  `TRADING_CREDENTIAL_ENCRYPTION_KEY` and separated from the venue-credential vault by its own
  associated data, so neither ciphertext opens as the other.
- `security-policy.ts` holds the three scope switches (sign-in, trading, funding) and the two
  lockout numbers as data, seeded all-off, edited in the panel. `decideStepUp` is the one place
  that answers "is a code owed", and it returns *not enforced* rather than refusing when a scope
  is on with no activated authenticator behind it — the case that must never become a locked door
  the owner cannot open. `session-record.ts` makes a session a row (`AuthSession`): device label
  from the User-Agent, IP, created, last seen, expiry, and `sessionIsUsable`, shared by the list
  and the request path so the two cannot disagree.
- Gated actions call `assertScopeVerified`: `POST /api/trading/orders` and its cancel route
  (trading), `POST`/`DELETE /api/trading/credentials` and the credential verify route (funding),
  and sign-in inside `POST /api/auth/verify` before the nonce is exchanged (sign-in). The refusal
  is `428 TOTP_REQUIRED` carrying its scope, and it happens *before* the body is read, so a
  submission that owes a code costs nothing. The panel is
  `src/app/admin/access/security-panel.tsx`; `GET/POST/DELETE /api/auth/totp`,
  `POST /api/auth/totp/activate`, `POST /api/auth/totp/verify`, `GET/POST /api/auth/sessions` and
  `GET/PUT /api/admin/security-policy` are the routes.
- **Two defects were found by the click-path that the unit suite had not caught, and both are
  fixed.** (1) `readSecurityPolicyRow` validated the whole stored row — policy fields *plus*
  `id`, `updatedByUserId`, `updatedAt` — against a validator that is deliberately strict about
  unknown keys because it also validates submissions. Every row failed, so all five TOTP routes
  and the policy route answered 503, and the enforcement path failed *quietly*:
  `loadSecurityPolicyForEnforcement` swallowed the throw and returned the all-off default, so no
  scope could ever gate anything. The fix projects the row to its six fields before validating
  (`selectSecurityPolicyFields`), exactly as the sibling integration and risk-policy readers
  already do, and leaves the submission validator strict. (2) The backup codes survived the
  panel's own `REFRESH`, contradicting its "shown once" copy; the re-read now clears one-time
  material and the two flows that display it set it after the read.
- Gates on the working tree: typecheck 0, test 0 (336/336, up from 335), lint 0, build 0,
  `validate_plan` 0.
- Click-path (recorded in `proof/phase-10-account-security-2fa-sessions.md`): enrolment issued a
  32-character secret once and activation accepted an independently computed RFC 6238 code and
  issued ten backup codes; turning the three scopes on made a device that owed a code meet
  `428 TOTP_REQUIRED` on an order while the device that had just activated did not, and satisfying
  it opened the gate; the same code presented again in its window was refused as replayed; the
  session list showed device, IP, created, last seen and expiry, and revoking one device ended it
  on that device's very next request while leaving the other untouched; "sign out everywhere"
  revoked the other eleven rows in one act and left the acting device signed in and working; a
  backup code worked once
  and then reported `BACKUP_CODE_USED`; five wrong codes locked the account and a correct code
  while locked answered `423 TOTP_LOCKED`, while a backup code still worked and cleared the lock;
  33 `AUTH_TOTP*` audit rows carried actor and reason with **no** secret or code in any of them.
  The panel was also driven in a real browser: enrolment showed the QR and the secret once,
  `REFRESH` removed them, activation rendered the ten codes once, a second `REFRESH` removed them
  while the count stayed `10 / 10`, and disabling with a backup code returned `NOT ENROLLED`.
- **Limitations:** no authenticator application was used — the codes came from an independent
  implementation of RFC 6238 in the driver and the browser, not from a phone scanning the QR. No
  wallet was in the room, so the two device sessions were minted directly as real `AuthSession`
  rows with the deployment's own secret; a session that arrived through a real SIWE sign-in
  carrying a `sign-in` step-up is covered by the route tests, not by this walk. The step-up
  window, attempt maximum and lockout duration were left at their defaults.

## Phase 09 — contract wallets and smart accounts (EIP-1271) (done)

- `src/lib/auth/contract-account.ts` is the new module and holds all of it: the standard's call
  (`isValidSignature(bytes32,bytes)`, selector `0x1626ba7e`, magic value the same four bytes), a
  reader that makes it in **one batched** request (`eth_chainId`, `eth_getCode`, the `eth_call`)
  through the same key-bearing endpoint resolution every other RPC read uses, bounded by a
  five-second `AbortSignal`, and each way it can end: accepted, refused, or not checked — never
  "accepted" by default. The batch is deliberate: the verdict cannot come from a mixture of chains,
  and `eth_getCode` is what separates "there is no contract here" from "the contract said no".
- `siwe.ts` now decides the account type: a key that recovers the claimed address is an EOA and does
  **not** touch the network; anything else is put to the contract at that address, on the chain the
  signed message names. Every refusal leaves as a `SiweVerificationError` with a stable `code`,
  `retryable`, and one sentence; `statusForSiweVerificationCode` maps the decision ones to 401 and
  the *uncompleted* ones to 502/503. The module owns the codes because it is the only place that
  knows which of the three answers it reached.
- `verify/route.ts` builds the real verifier, passes it in, and returns the refusal with its code,
  sentence and retryability instead of one generic 401; it records `accountType` on the identity
  (default `EOA`, refreshed when the proof changes) and in the `AUTH_SIGN_IN` audit event.
  `WalletIdentity.accountType` is a nullable-by-default string, not an enum, for the same reason no
  other state column here is: `scripts/dev-database.mjs` refuses to derive the SQLite development
  schema from a file containing one. Migration
  `20261016130000_wallet_identity_account_type` adds it with `DEFAULT 'EOA'`, which is what every
  pre-existing row actually was.
- The session is unchanged for both kinds — same cookie, same claims, same roles, same permission
  model — and gains exactly one field: `GET /api/auth/session` and the admin directory report the
  account type beside the address. `/admin/access` renders it as "Contract wallet (EIP-1271)" or
  "Externally owned account (EOA)", worded on the server because the module that knows the words
  also resolves key-bearing RPC endpoints and must stay out of a client bundle. `wallet-errors.ts`
  keeps the server's code, sentence *and* retryability, so an unreachable contract check stays a
  retryable error on the page rather than collapsing into "refused".
- Gates on the working tree: typecheck 0, test 0 (311/311, up from 303), lint 0, build 0,
  `validate_plan` 0.
- Click-path (recorded in `proof/phase-09-eip1271-smart-accounts.md`): a wallet claiming an address
  no key belongs to signed in through a stand-in EIP-1271 node — the node's log shows the server
  sending the standard's batched call, `POST /api/auth/verify` answered 200, and the session came
  back as `accountType: "CONTRACT"` with the identity row and the audit event to match; the admin
  view listed that wallet as "Contract wallet (EIP-1271)" beside EOAs. A tampered payload, an
  unreachable node, a node that never answers (the five-second bound), an HTTP 500, an address with
  no code and a wallet on the wrong chain each read differently in the page, each kept the user on
  `/login`, and a database query afterwards found **no identity row** for any of them. The refused
  and not-deployed readings were also taken against the real mainnet endpoint (USDC's real revert;
  a real `eth_getCode` of `0x`).
- **Limitation:** no EIP-1271 contract was deployed for this phase, so the accepted verdict came
  from a stand-in node speaking HTTPS with a scratch certificate trusted only by one dev-server
  process. Real mainnet contracts were used for the refusals, but a real smart account (Safe,
  Argent, 4337) signing in against its own contract has not been observed. The stub, the signer and
  the certificate live in `/tmp/phase09/` and are not part of the repository.
- **Recorded follow-up (not implemented, by design): session keys.** An EIP-1271 account is the
  first account here that could be *acted for* instead of *signed by*: a scoped key granting bounded
  on-chain action without a signature per trade. That is what the on-chain execution path (phase 21
  onward) will need; it requires two things that do not exist yet — somewhere to store a session key
  that is not the trading-credential store or the auth cookie, and a policy that bounds what the key
  may do. Nothing in this phase stores a key, delegates, or acts for a user.

## Phase 08 — mobile wallet pairing (done)

- `apps/web/src/lib/auth/wallet-connect.ts` is the pairing half that is not a browser: the project
  id is read from `NEXT_PUBLIC_REOWN_PROJECT_ID` with `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` as the
  fallback (and a placeholder value counts as unset), one table holds the legal stage transitions
  (`idle`, `preparing`, `waiting`, `paired`, `signing`, `signed`, `failed` — a failure can always be
  retried in place), one function names each failure (`PAIRING_EXPIRED`, `PAIRING_DECLINED`,
  `PROJECT_ID_REJECTED`, `RELAY_UNAVAILABLE`, `UNSUPPORTED_CHAIN`, `PAIRING_FAILED`), the `wc:` URI's
  own `expiryTimestamp` is what the countdown reads, and `redactedPairingUri` is the only form meant
  to be read by a human.
- `wallet-connect-client.ts` is the port over `@walletconnect/ethereum-provider` with
  `showQrModal: false` — this application draws its own QR, deep link, copy button and progress — and
  `wallet-connect-pairing.tsx` is that surface. Once paired, the sign-in is phase 07's flow
  unchanged: same nonce route, same SIWE verification, same session; only the provider differs.
- `wallet-connection-provider.tsx` now carries injected connectors only. A WalletConnect connector
  there would be a second pairing implementation with its own modal and its own project-id
  precedence, which is exactly the fork this phase forbids.
- `pairingHostProblem` in `auth/config.ts` binds pairing to `APP_BASE_URL`: a page served on any
  other host refuses it, in its own HTML, naming both hosts. `/login` resolves the project id and
  that guard on the server, so the missing-variable case is a sentence in the page (not a disabled
  control), and `readiness.ts` reads the project id through the same resolver so the admin checklist
  cannot disagree with the page.
- Gates on the working tree: typecheck 0, test 0 (303/303, up from 289), lint 0, build 0,
  `validate_plan` 0.
- Click-path (recorded in `proof/phase-08-walletconnect-mobile-pairing.md`): one `wc:` URI reached
  three ways (QR, deep link, copy) and `WAITING FOR THE WALLET` → `SIGNING IN` → `SIGNED IN` with the
  phone's address, whose session `GET /api/auth/session` confirmed server-side; decline, expiry
  (the page's own countdown), an unsupported chain (chain read before anything else was asked) and
  the real relay's own 20-second failure each read differently and each retried in place with no
  reload; with the project id unset the page names both variables and injected-wallet sign-in still
  completed; served on the wrong host, the page refuses to pair.
- **Limitation:** the real provider met the real relay, but with a placeholder project id the relay
  closed the socket (`code 3000 (Project not found)`) and issued no code, so a real QR scanned by a
  real phone has not been observed — that is the owner's step once a project id is registered. The
  bounded `RELAY_UNAVAILABLE` with a retry is what that run measured.

## Current state (2026-10-15)

- `apps/web` is the Next.js app; `typecheck`, the test suite and `pnpm build` pass.
- Multi-network RPC: `apps/web/src/lib/rpc/networks.ts` resolves any configured
  `ALCHEMY_<NETWORK>_RPC_URL`, and JSON-RPC is proxied through `POST /api/rpc/[network]`.
- The market assistant is tool-using (`lib/assistant/public-market-adapter.ts`,
  `app/api/assistant/route.ts`).
- Sign-in accepts any EVM chain id listed in `AUTH_EVM_CHAIN_IDS`.

## Phase 06 — order and process state machine (done)

- `apps/web/src/lib/orders/` now holds one lifecycle: `state-machine.ts` (status set, legal
  transitions, a sentence per status, and a refusal that carries no state), `idempotency.ts` (a
  key derived from the canonical intent, plus the `IDEMPOTENCY_KEY_REUSED` conflict), `retry.ts`
  (bounded backoff, an attempt record per try, no blind resend of a timeout), `reconcile.ts`
  (the venue is the truth, and a disagreement writes both values), and `process.ts`/`store.ts`/
  `venue.ts` (the injected port, the durable rows, the `dev-paper` venue used to prove it).
- `TradeOrder` gained the lifecycle columns, the idempotency key and the attempt record
  (`migrations/20261015180000_order_lifecycle_and_idempotency`); the runner gained the
  `order-reconciliation` job; `/trade` gained the order panel that renders every status's own
  sentence; `POST /api/trading/orders` and `/api/trading/orders/[orderId]/cancel` are the two
  new endpoints, and both are in the route sweep.
- Gates on the working tree: typecheck 0, test 0 (271/271), lint 0, build 0, `validate_plan` 0,
  and `routes:sweep` 60/60 with a seeded owner session on a `next dev` server.
- Click-path (recorded in `proof/phase-06-order-state-machine.md`): submitted → `SUBMITTED`,
  next pass → `FILLED`; the identical resubmission replayed the same order; a hand-edited
  `SUBMITTED`/`0` row was corrected to the venue's `FILLED`/`0.001` with both values on
  `ORDER_RECONCILIATION`; with `PAPER_VENUE_FAILURE=unavailable` the order landed in `FAILED`
  with the venue's own reason and no crash; a resting order cancelled, and a terminal one
  refused.

## Phase 07 — injected browser wallets (done)

- `apps/web/src/lib/auth/` gained the pieces the sign-in flow is actually made of:
  `eip1193.ts` (the four calls sign-in makes, and `switchWalletChain`, which reads the chain
  *back* after asking for a switch), `wallet-providers.ts` (detection of what the browser really
  injected — `window.ethereum`, its EIP-5749 `providers` array, `window.coinbaseWalletExtension`,
  `window.rabby.ethereum` — naming each provider by its most specific flag, and reporting the
  mainstream wallets that are missing), `wallet-address.ts` (the single normalisation point:
  lower-cased `canonical` for storage and lookup, EIP-55 checksummed `display` for humans) and
  `wallet-errors.ts` (`SignInFailure`: a stable code, one sentence for the person at the wallet,
  and whether retrying can help).
- `evm-wallet-sign-in.ts` no longer goes through `wagmi` hooks: every attempt takes the page's
  scope and a wallet kind, re-resolves the provider at the start of the attempt, reads the chain
  **before** the wallet is asked for anything, and raises a `SignInFailure` at every step.
  `login-form.tsx` renders the detected wallets, the ones that are missing (with install links,
  never a dead button), the switch offer, the failure sentence and the retry hint; the accepted
  chains sentence is derived from `AUTH_EVM_CHAIN_IDS`.
- Sign-out is now `revokeSession` in `src/lib/auth/session-revocation.ts` with its store behind a
  port, and `DELETE /api/auth/session` supplies it: it refuses an already-stale cookie, increments
  the account's `sessionVersion` and records the act. The route's test drives that function and
  then asks the production rule (`sessionMatchesUser`) whether the cookie it signed out with still
  resolves.
- Gates on the working tree: typecheck 0, test 0 (289/289, up from 271), lint 0, build 0,
  `validate_plan` 0, and `routes:sweep` 60/60 in both readings (the owner-session run against the
  click-path server, the unconfigured run against a second `next dev`).
- Click-path (recorded in `proof/phase-07-wallet-sign-in.md`): three injected providers published
  the way installed wallets coexist (Rabby and Coinbase also set `isMetaMask`) were each named
  correctly and each completed sign-in as `OWNER`; a start on Polygon PoS refused with
  `UNSUPPORTED_CHAIN` after `eth_chainId` alone, and accepting the switch completed the sign-in on
  chain 1; a reload of `/trade` stayed signed in with no wallet injected, and sign-out emptied the
  cookie, answered `{session: "REVOKED"}` and left `/trade` redirecting to `/login`; a rejected
  signature reported `SIGNATURE_REJECTED` with the buttons still enabled, and the next press on the
  same page signed in. Declined switch, cancelled connect prompt, vanished provider and the
  no-wallet-installed state each read differently.
- **Note for phase 03's sweep:** the sweep assumes the session cookie it is handed belongs to an
  owner. A *non-owner* session makes the six `/api/admin/*` rows answer 403 (`"Administrator role
  required"`), which the sweep reports as an undeclared refusal. That 403 is the correct answer for
  that account — the bootstrap rule grants `OWNER` only when no active owner exists — so the sweep
  asserting the role of its cookie is phase 03 work.
- **Tooling limitation found:** `next dev` aborted with an internal Turbopack panic (`task … is
  missing in memory or persistent storage`) partway through the second route sweep, so the
  *unconfigured* sweep reading could not be re-measured today. The configured reading
  (`60 passed · 0 not swept · 0 failed`) is the measured one; the unconfigured description in
  `apps/web/README.md` still rests on the earlier measurement.

## Phase 30 — bot builder and strategy marketplace (verified)

- The builder now publishes what the runner executes: the form maps onto the phase-28 definition,
  `validateStrategyDefinition` runs on publish, and a refusal names the form field. Publishing
  inserts one definition version in the same transaction as `BOT_PUBLISHED`; a published bot is
  startable as `bot:<id>` on a 1 440-minute daily window.
- Templates are snapshots (`StrategyTemplate`) with built-ins in code; cloning records the slug and
  starts the copy's own version history. Marketplace performance is read from `BacktestRun` rows
  only, and a template with no run says so rather than showing a figure.
- Caps are the fee-tier columns (`maxBots`, `maxVenueConnections`) rather than a second settings
  row; `botCapMessage` is the one sentence ("… 10 of 10 bots in use … Nothing was created."), the
  create control is never disabled for a cap, and a refusal writes nothing.
- Deleting marks the row `DELETED` and stops a running activation in the same transaction, so the
  resolver refuses it immediately while its rules, decisions and backtests stay readable.
- **Two defects found by the browser walk and fixed:** `/trade` rendered no strategy picker, so a
  published bot could not be started from the UI (the control re-started the previously selected
  strategy); `SmartTradingControl` now renders the catalog, sends the chosen id, and names the
  switch a press will make. `ManagedBotsPanel` also re-reads the list and caps after every
  mutation, because a delete left the panel at `10 of 10` with the cap alert on screen.
- Gates: typecheck 0, test 0 (708/708, four new picker tests), lint 0, build 0, `validate_plan` 0.
  Recorded in `proof/phase-30-bot-builder-and-marketplace.md`, with screenshots under
  `proof/screenshots/`. Readings came from a copy of `prisma/dev.db`; the newly started bot's
  daily window was reset in that copy to observe a phase-24 decision, and no order or fill is part
  of the record.

## Phase 31 — signals in, webhooks out

- Inbound `POST /api/signals/[token]`: token stored only as SHA-256 (`tokenPrefix` for display),
  signing secret sealed with AES-256-GCM under `TRADING_CREDENTIAL_ENCRYPTION_KEY` with its own
  AAD; HMAC-SHA256 over `` `${timestamp}.${rawBody}` `` verified **before** `JSON.parse`; the
  signed timestamp is bounded by a per-token, owner-set replay window (30–3600 s).
- Replay: `SignalEvent.dedupeKey` (`tokenId:signalId`) is unique and written only on the first
  attempt; a repeat is a `DUPLICATE` row pointing at the original, and the claim happens before
  the order path. Every attempt writes a row — accepted, refused with `code`/`bound`, bad
  signature, stale timestamp or duplicate.
- Mapping (`lib/signals/map.ts`) turns `enter`/`exit`/`adjust` into one order intent; every
  refusal names its bound (`strategy.market`, `policy.maxOrderNotionalUsd`,
  `strategy.budgetUsd`, `policy.maxStrategyNotionalUsd`, `position.quantity`, …) with observed
  and allowed values. The phase-25 risk evaluation runs on the same intent; a signal is not a
  privileged path.
- Outbound: per-endpoint secrets sealed the same way, `X-Veylora-Signature: sha256=HMAC(ts.body)`,
  one `WebhookDelivery` row per attempt, bounded backoff 30/120/600 s (4 attempts), endpoint
  `UNHEALTHY` after 3 consecutive failures and `HEALTHY` again on success. New runner job
  `webhook-deliveries`. Hooks: strategy decisions/trades, alert triggers, accepted signals.
- The panel (`/admin/access`) creates tokens and endpoints with a one-time credential block,
  edits the window, revokes, shows the masked signal log and the per-attempt delivery record.
- Click-path (copy of the phase-30 SQLite DB, paper venue, loopback receiver): accepted
  `tv-sol-1` enter of 2.00 USD (order placed, stop 97.75); duplicate 409 with the original
  event id/timestamp; tampered body 401 `SIGNATURE_INVALID`; BTC-USD 422
  `STRATEGY_MARKET_MISMATCH` bound `strategy.market`; exit 422 `NO_OPEN_POSITION` bound
  `position.quantity` (paper order `SUBMITTED`, not filled); 400 s-old request 401
  `TIMESTAMP_OUT_OF_WINDOW` after the window was set to 120 s. Webhook test delivered with the
  receiver verifying the HMAC; three events with the receiver down made the endpoint
  `UNHEALTHY`; retries wrote attempts 2 (`0 delivered, 6 failing`) and, once the receiver
  returned, attempt 3 (`7 delivered, 0 failing`) with health `HEALTHY`. Zero secret/token
  matches in the server, proxy and receiver logs; none in the settings JSON.
- Gates: typecheck 0, test 0 (727/727, 19 new in `tests/signals.test.ts`), lint 0, build 0,
  `validate_plan` 0. Route inventory grew to 104 methods (6 new) and its coverage test was
  updated. The migration ran on SQLite through a derived schema; Postgres was not available.
  Screenshots could not be captured (preview produced no frames), so the evidence is the exact
  bodies and the rendered table text. Recorded in `proof/phase-31-signals-in-webhooks-out.md`.

## Phase 32 — public API and MCP server

- Twelve versioned REST routes in `src/app/api/v1` dispatch through one handler
  (`src/lib/api/handler.ts`): authenticate, find the route, count the request, check the scope,
  then parse the body. Route definitions in `routes.ts` are the single source for dispatch and
  for `/docs/api`, whose examples carry only `vyl_replace_me` (a test asserts it).
- Keys are `read`, `trade` and `agent`; `trade`/`agent` require a dedicated `AgentAccount`, and
  the secret is returned once from `POST /api/admin/api-keys` while the directory shows only the
  prefix. Fixed-minute `ApiRateWindow` rows make the counter atomic and give a 429 the same
  limit/reset as the headers on a 200.
- An order above the agent account's approval threshold creates a visible `AgentApproval` and
  answers `202` with its expiry; `/admin/access` lists and decides them, and an expired one is
  `EXPIRED` as data rather than a silent refusal.
- `mcp/server.ts` exposes the same service layer over stdio JSON-RPC with per-tool scope checks.
  A read key sees 10 tools; an agent key sees 12 including `place_agent_order`, which placed a
  paper order in its own account while a call naming another account was refused
  `AGENT_ACCOUNT_SCOPE`.
- Live readings: read key reads and is refused `403 SCOPE_REQUIRED`; revoked key `401
  API_KEY_REVOKED` immediately (also `-32001` inside MCP); 1/minute key `200` then `429` with
  `Retry-After: 20`; approval `202` at 8189 cents against a 500-cent threshold, owner approval
  `EXECUTED`, expired decision `409 APPROVAL_EXPIRED`.
- Defect found and fixed: the service logger wrote provider-call JSON to stdout, corrupting the
  MCP stdio transport. The frame writer is now captured before imports and all other stdout
  writes go to stderr; four requests then produced exactly four frames.
- Gates: typecheck 0, test 0 (738/738, 11 new in `tests/public-api.test.ts`), lint 0, build 0,
  `validate_plan` 0. The migration was applied to SQLite through the project's setup path;
  Postgres was not available. No live venue order exists — the agent order is `dev-paper` and
  `SUBMITTED`. Screenshots could not be captured (preview produced no frames), so the evidence
  is the HTTP/JSON-RPC bodies and rendered page HTML. Recorded in
  `proof/phase-32-public-api-and-mcp.md`.

## Phase 34 — admin console

- `/admin` is now one shell: thirteen sections (users, wallets, balances, ledger, deposits,
  withdrawals, orders, strategies, venue keys, fees, limits, switches, audit), each with filters
  and a column box, plus one search box across wallet, transaction hash, user id and order id.
  Saved views are `AdminSavedView` rows unique per `(userId, section, name)`; applying one puts its
  filters and columns in the URL, so a reload restores the same list.
- Drill-down composes one timeline per record from ledger entries, strategy decisions,
  notification deliveries and audit events, newest first. The one money action is a balanced
  `ADMIN_CORRECTION` against the platform treasury; it prints its effect beside the button, reads
  before/after from the ledger, and writes the audit event in the same transaction.
- Live readings: search returned the seeded wallet and its account (2), hash (1 deposit) and order
  id (the order plus three audit events); `Traders only` restored `role=TRADER` and six columns with 1 row after
  a reload; a +0.02 USDT correction took `dev-test-account` from 0.01 to 0.03 in the console and
  `/api/account`, reconciled with no differences, and its audit payload names actor, target and
  both balances. A trader's `/admin` and `/admin/fees` name `admin.console.read` and `fees.manage`
  instead of rendering blank; the console API answers `403` with the same key.
- Defects found and fixed: ledger/withdrawal money was printed in minor units (`10000 USDT` for
  0.01) in the list, timeline, record title and search label; and a correction's audit event
  pointed at the ledger transaction, so it never reached the target account's timeline. It now
  points at the user, with the transaction id in the payload; a regression test asserts the object.
- Gates: typecheck 0, test 0 (751/751, 7 in `tests/admin-console.test.ts`), lint 0, build 0,
  `validate_plan` 0. The migration ran on SQLite through `prisma db push`; Postgres was not
  available. Recorded in `proof/phase-34-admin-console.md` with screenshots
  `proof/screenshots/phase34-*.png`.

## Phase 35 — CRM and support

- `/admin/support` now has the full desk: ticket list with status/priority filters, one open
  conversation with its public and internal messages, per-account notes, saved replies with
  placeholders, cross-source search and a Markdown export. Tickets can name a domain record
  (order, withdrawal, strategy or deposit); the record's own page names the ticket back.
- Internal material is separated in the data model: `TicketMessage.visibility` is selected as
  PUBLIC in the account's SQL and filtered again by `userTicketView`, while `UserNote` is a table
  the account's endpoint never queries. The account's own read of a mixed thread returned the
  public message and neither the internal body nor the note.
- The user timeline now merges sign-ins, deposits, withdrawals, trades, strategy decisions, alert
  deliveries, ledger entries, audit events, ticket messages and notes, each with its record link.
  `dev-test-account` showed 50 events across ten categories, newest first.
- Live readings: ticket `cmvfuo8m60001n92455oraeb3` linked to `dev-deposit-seed` (`25 USDT ·
  CREDITED`) and the deposit named the ticket back; status `OPEN → PENDING` wrote an audit payload
  with actor, target, previous/next status and reason; a saved reply rendered the account's wallet,
  ticket id, 20.03 USDT available / 25.03 total and the operator; search for `internal retry`
  returned the note; export was raw Markdown with the thread and internal labels; a trader's three
  admin support reads answered `403` naming `crm.support.read`.
- Defects found and fixed: the export route JSON-encoded the Markdown string even though it set
  `text/markdown`, and the credential pattern required eight characters, so a legacy
  `password=hunter2` survived export. The route now returns a raw `Response`, the pattern starts at
  four characters, and the regression is asserted in `tests/support-crm.test.ts`.
- Gates: typecheck 0, test 0 (758/758, 6 in `tests/support-crm.test.ts`), lint 0, build 0,
  `validate_plan` 0. The migration ran on SQLite through `prisma db push`; Postgres was not
  available. Recorded in `proof/phase-35-crm-and-support.md` with screenshots
  `proof/screenshots/phase35-*.png`.

## Phase 37 — end-to-end browser automation

- Playwright runs five Chromium tests against a server the suite starts itself: the canonical
  journey (wallet sign-in, mock-chain deposit credited once, balances and history, the visible
  start control, runner continuation with the browser context closed, withdrawal confirmed) and
  four refusal paths (rejected signature, unmatched token, risk-capped order, over-balance
  withdrawal), each asserting the sentence a person reads.
- `e2e/server.ts` refuses an occupied port, resets and seeds the local SQLite database, runs the
  app against a temporary copy (so Turbopack cannot rebuild a page on every database write), and
  starts a loopback HTTPS JSON-RPC stand-in plus 120 deterministic daily candles. A Node fetch
  preload and browser routes refuse every non-loopback host; the trade page's Coinbase read is
  blocked and degrades to its unavailable state.
- Test artifacts are written to `os.tmpdir()/veylora-e2e-results` (or `E2E_OUTPUT_DIR`) so they
  are outside the dev watcher. A deliberately broken selector exited 1 with a trace, screenshot,
  video and console log attached; the temporary spec was removed afterwards.
- Defects found and fixed: a fresh database failed the seed because `notificationDelivery` was
  inserted before the alert it referenced; the mock chain emitted numeric JSON-RPC block numbers
  (the watcher rejected them), reused transaction hashes across resets, and placed logs in an
  already-scanned block; the login alert locator also matched Next's route announcer.
- Gates: typecheck 0, test 0 (765/765), lint 0, build 0, `e2e` 0 (5 passed), `validate_plan` 0.
  CI now installs Chromium and runs `pnpm e2e` after build, uploading the failure artifacts from
  the same `E2E_OUTPUT_DIR`; GitHub Actions itself was not run here. Recorded in
  `proof/phase-37-e2e-automation.md`.

## Phase 38 — performance and load

- `apps/web/scripts/bench.mjs` copies `prisma/dev.db` to `prisma/bench.db`, extends it to 100,004
  ledger entries, 50,014 audit events, 20,003 orders, 20,001 decisions and 26 running strategies,
  starts the production build behind a loopback TLS terminator, mints a session for the seeded
  owner, and measures `/`, `/trade`, `/account`, `/admin` and the ledger, orders and audit endpoints
  plus both full-range exports. Every run prints the volume it used; `--volume empty` records the
  failure case, and `--indexes without` drops exactly this phase's indexes for the before run.
- Kept four indexes, each with a measured before/after: `LedgerEntry(accountId, transactionId)` (a
  statement page 120 → 80 ms, a 30-day range 200 → 139 ms, the balance aggregate 116 → 96 ms, the
  year-long ledger CSV 11.0 → 7.8 s), `LedgerTransaction(occurredAt)` (the full-book integrity read
  671 → 550 ms, no temp B-tree), `TradeOrder(userId, status, createdAt)` (4 → 3 ms) and
  `TradeOrder(userId, market, status)` (the runner's covering open-order count, 3 → 1 ms).
- Rejected three after measuring them rather than on intuition: audit by `action` cannot use a
  B-tree for a `contains` filter, audit by `source` changed the plan but not the time (4 ms vs 4 ms
  for a 200-row page), and decisions by `outcome` is never chosen because no query filters on it.
  The first draft shipped all seven; three were removed once the numbers were in.
- Exports stream: `iterateAuditEvents` pages by `(occurredAt, id)` cursor in two passes and the
  ledger statement folds a paged iterator while keeping a bounded page. Both exports completed at
  the seeded volume under a **192 MB** heap cap (`--heap 192`), which is the evidence the range is
  not materialised. RSS growth is recorded as an observation only; it grows on the empty run too.
- Runner pass 985 ms against a 300 s interval (299 s headroom) with 26 running strategies. Cache
  keys carry provider, as-of and freshness window; asserted by `tests/market-data.test.ts`.
- Still slow, with numbers: `/trade` 1305 ms (a 365-day fold over 50,000 entries), `/api/ledger`
  885 ms, the year-long ledger CSV 7.8 s, the audit CSV 7.0 s — each with a proposal in the report.
- Gates: typecheck 0, test 0 (766/766), lint 0, build 0, `validate_plan` 0. Recorded in
  `proof/phase-38-performance-and-load.md`, with raw runs in `proof/bench/`.
