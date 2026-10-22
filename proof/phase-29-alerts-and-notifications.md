# Phase 29 — Alerts and notifications

A rule the owner created now fires while no browser is open: the runner evaluates every due rule on
its own schedule, records the crossing once per cooldown, and delivers it in-app, by email and to
Telegram as three independently switched channels. Every attempt — send, skip, queue, retry, failure —
is a row with the target, the provider's response id, the status, the error and the duration, so the
delivery log is the record of what happened rather than a reconstruction. Quiet hours hold delivery
and the panel says so while they are on.

Recorded on 2026-10-19 against the production build on `:3210` (`next start`), reached through a
loopback cookie proxy on `:3310` because the session cookie is httpOnly and the preview browser cannot
be handed one, with one loopback stand-in on `:4329` answering Resend's and Telegram's wire formats,
and the SQLite development database seeded by `pnpm db:setup`. The session was a real `AuthSession` row
minted with a throwaway secret. This record contains no session value, cookie, token or credential.

## Acceptance criteria, with what was observed

| criterion | status | evidence |
|---|---|---|
| A rule fires while the browser is closed and the in-app alert appears on return | met | `POST /api/market-alerts` created `BTC-USD PRICE_ABOVE 4` with a 2-minute cooldown at 09:41:04.608Z; a bearer-authenticated `GET /api/cron/market-alerts` at 09:41:04.890Z (no browser, no page) reported `11 alert(s) were due, 1 triggered … 1 notification(s) sent`; the alert row then read `conditionMet true`, `lastEvaluatedAt 09:41:04.916Z`, `triggeredAt 09:41:04.916Z`, `lastObservedValue 82938.305`, `nextEvaluationAt 2026-10-20T09:41:04.916Z`, and its delivery row was `IN_APP · SENT · attempt 1 · 0 ms`. The panel's *Last fire / Last check / Next check* line rendered the same three instants |
| The same condition does not fire twice inside the cooldown, proven by a test | met | `tests/notifications.test.ts` → *a crossing notifies every enabled channel once and a second dispatch in the same window is a duplicate*; `src/lib/alerts/evaluate.test.ts` → *a re-crossing inside the cooldown is not a second fire, and the first one after it is*. On the running app, two passes 10 s apart with a 1-minute cooldown: `6 due, 1 triggered, 3 sent` then `6 due, 0 triggered, 0 sent` |
| With Telegram unconfigured, the UI names the missing variable and other channels still work | met | with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` removed from the server's environment, `GET /api/market-alerts` answered `channels[TELEGRAM] = { state: "NOT_CONFIGURED", missingVariables: ["TELEGRAM_BOT_TOKEN","TELEGRAM_CHAT_ID"], message: "Telegram is enabled but TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID is not set, so nothing can be delivered on it." }`; the same trigger wrote `EMAIL SENT (stub-email-21)` and `IN_APP SENT`, and a `TELEGRAM SKIPPED` row with that sentence as its error |
| The delivery log records a failure and its retry outcome | met | the stand-in answered `503` for the first two email and Telegram attempts: `EMAIL FAILED 1 (18 ms, "stub_error: stub upstream unavailable")`, `EMAIL FAILED 2 (4 ms)`, `EMAIL SENT 3 (stub-email-3)`, and `TELEGRAM FAILED 1`, `FAILED 2`, `SENT 3 (9006)` — each attempt its own row, 250 ms and 1 s apart |

## The requirements, one by one

1. **Evaluation on the runner.** `market-alerts` is a job in the phase-05 runner registry, so the
   cron route, the scheduler and the heartbeat all treat it like every other job. A pass selects the
   owner's enabled rules that are due, evaluates each with the same condition model the screener uses
   (`lib/alerts/conditions.ts`, `lib/alerts/evaluate.ts`), and writes the decision, the trigger and the
   notification totals to the heartbeat. The three live invocations above ran with no page loaded.
2. **Three channels, switched independently, each explaining itself.** `NotificationChannelSettings`
   stores one boolean per channel plus quiet hours and the default cooldown; `POST`/`PUT
   /api/admin/notifications` validates the closed set and writes an audit row with before/after. A
   channel is always rendered: `OFF` when its switch is off (`"Email delivery is switched off in the
   admin channel settings."`), `NOT_CONFIGURED` with the exact variable names when it is on but its
   environment is incomplete, `READY` with the masked target otherwise. The admin page carries the
   switches under *ADMIN / ALERT DELIVERY → Notification channels*; the panel carries the same three
   states above the rule list.
3. **One announcement per crossing.** `MarketAlert.conditionMet` turns a fire into a false→true
   crossing instead of every check while the condition stays true, and `cooldownMinutes` is the
   rule's own minimum gap. The claim is one conditional `UPDATE` (old value false or cooldown
   expired), so two overlapping evaluators cannot both win; `MarketAlertEvent` gets a unique
   `(alertId, windowStart)` index where `windowStart` is the cooldown bucket, and
   `NotificationDelivery` gets a unique `(dedupeKey, channel, attempt)` index where `dedupeKey` is
   (rule, condition, window). The panel shows the cooldown on every rule.
4. **Quiet hours pause, queue and resume, visibly.** Inside the window `dispatchAlertNotification`
   writes `QUEUED` rows with `queuedAt` instead of sending; the next evaluation after the window
   closes flushes them (bounded to 50 per pass) and stamps `deliveredAt`. With `00:00–23:59` on, a
   pass reported `0 sent, 3 queued`; the panel showed `QUIET HOURS 00:00–23:59 UTC · DELIVERY PAUSED`
   and *"3 notification(s) are queued and will be delivered when the window closes."* With the window
   turned off, the next pass reported `3 sent`, and the queued row's own timestamps read
   `queuedAt 09:35:11.517Z → deliveredAt 09:35:22.095Z`.
5. **Every attempt recorded, retries bounded.** A row carries channel, target, subject, body, status,
   `providerId`, `providerMessageId`, `error`, `attempt`, `durationMs`, `queuedAt` and `deliveredAt`.
   A retry is another row, never an overwrite. `MAX_DELIVERY_ATTEMPTS = 3` with `250 ms` and `1 s`
   backoff, after which the last row is `FAILED` with the provider's own answer; a failure that
   outlasts the retries is covered by its own test.
6. **An idle rule is explainable.** The list returns `lastEvaluatedAt`, `lastObservedValue`,
   `lastEvaluationError`, `triggeredAt`, `conditionMet`, `nextEvaluationAt` (derived from the last
   check plus the effective cadence, never stored), and an `evaluation` sentence that names how many
   rules are holding, cooling down, or failing. The panel prints *LAST FIRE*, *LAST CHECK*,
   *NEXT CHECK* and the cooldown on every row.
7. **Credentials by name, never by value.** Email reads `RESEND_API_KEY`, `ALERT_EMAIL_FROM`,
   `ALERT_EMAIL_TO` and an optional `RESEND_API_BASE_URL`; Telegram reads `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_CHAT_ID` and an optional `TELEGRAM_API_BASE_URL`. Targets are masked (`o***@example.com`,
   `chat ***4321`), the Telegram token is redacted from every error and log line, and
   `tests/notifications.test.ts` asserts a provider error cannot carry it.

## The owner's click-path, as measured

- **Create, close, wait.** The rule above fired on the next runner invocation and was waiting on
  return; the log showed one `IN_APP SENT` row and the panel's *Last fire* line.
- **Disable email and Telegram.** `PUT /api/admin/notifications` with both false, then a pass:
  `inapp-only` settings read `EMAIL OFF` and `TELEGRAM OFF`, one trigger wrote **one** row —
  `IN_APP SENT` — and no email or Telegram row at all. Both channels stayed visible as `OFF`.
- **Cooldown.** Two passes ten seconds apart on a 1-minute rule: one trigger, then none, with the
  rule still `conditionMet true` and its `triggeredAt` unchanged.
- **Failure.** The stand-in's two `503`s produced two `FAILED` rows and a third `SENT` row with the
  provider id; a permanent failure is covered by *a failure that outlasts the retries is reported
  with the provider's own answer*.
- **Telegram removed.** The channel card named both missing variables, the panel kept working, and
  the trigger that followed wrote `EMAIL` and `IN_APP` normally plus a `TELEGRAM SKIPPED` row carrying
  the same sentence.

## Gates, on the working tree

```
typecheck=0
test=0        (690 tests, 690 pass)
lint=0
build=0
plan=0        (40 phase files, 0 restriction hits, 0 warnings)
```

The extra route sweep was also run against the same server and owner session: every
`/api/market-alerts` and `/api/cron/market-alerts` row passed (`200`, `400`, `401` as declared). Its
only failures were outside this phase and are environment limits: `/api/bots*` answered `503` because
the paper store is process-local, and `/api/admin/models/probe` answered `503` because no AI gateway
key is configured here.

## Limits of this record

- **No real email or message was sent.** No Resend key and no Telegram bot exist on this machine, so
  both were answered by one loopback stand-in on `:4329` that speaks each provider's envelope. The
  `stub-email-*` ids and the numeric Telegram ids are the stand-in's, and the 18 ms / 4 ms durations
  measure the local hop, not the providers.
- **Quiet hours are UTC**, as the settings say; the run exercised a window covering the whole day
  rather than waiting for the owner's 22:00–07:00.
- **The queue flush runs on the next evaluation**, so with a daily cadence a queued alert can wait up
  to the next daily pass. That is the same ceiling the scheduler already publishes.
- **The migration was verified against the DDL Prisma derives from `schema.prisma` and applied to
  SQLite by `db:setup`; no Postgres is reachable here.**
- The in-app channel is the alert row itself plus its delivery row, not a separate notification
  centre; the panel is the inbox, and old rows stay until deleted.
