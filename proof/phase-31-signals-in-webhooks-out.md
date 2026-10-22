# Phase 31 — Signals in, webhooks out

Automation can be driven from outside and can tell the outside what happened: signed inbound
signals in the TradingView style, outbound webhooks for trade, alert and strategy events with
retry and a visible delivery record.

## What was built

### Inbound: one endpoint, verified before parsing

`POST /api/signals/[token]` is the only write in the app authenticated without a session. The
order of its steps is the design:

1. **The token is looked up by hash.** `SignalToken.tokenHash` is the lookup key; the URL
   credential is never stored, so a database dump yields no working endpoint. `tokenPrefix`
   (`sig_ass…36tt`) is all the panel and the log ever show.
2. **The signature is verified over the raw bytes before `JSON.parse`.** HMAC-SHA256 over
   `` `${timestamp}.${rawBody}` ``, sent as `X-Signal-Timestamp` and
   `X-Signal-Signature: sha256=<hex>`. The timestamp is inside the signed material, so a
   captured signature cannot be re-dated.
3. **The replay window is per token and owner-set** (`replayWindowSeconds`, clamped 30–3600).
   A request outside the window is refused as `TIMESTAMP_OUT_OF_WINDOW` naming the observed age
   and the configured window.
4. **The signal id is claimed before acting.** `SignalEvent.dedupeKey` (`tokenId:signalId`) is
   unique and set only on the first attempt. A second delivery loses that insert and is stored
   as its own `DUPLICATE` row pointing at the original, with the original's timestamp in the
   refusal. Two concurrent deliveries cannot both reach the order path.
5. **Mapping and the owner's bounds run** (`src/lib/signals/map.ts`), then the phase-25 risk
   policy (`evaluateRiskOrder`) with the strategy's budget and declared stop.
6. **The order path submits** with `clientKey = signal.<tokenId>.<signalId>`, so even a retry
   that reached submission replays the existing order instead of placing a second one.

Every attempt that belongs to an account writes a row: accepted, rejected with the bound that
refused it, bad signature, stale timestamp or duplicate. An unknown token has no account to show
a log entry to; it is answered `401 TOKEN_UNKNOWN` and recorded in the server log with the masked
body digest only.

### Mapping bounds, each named

`mapSignal` answers `enter`, `exit` and `adjust`, with every refusal carrying `code`, `bound` and
a sentence containing the observed and allowed values:

| Bound | Refusal |
| --- | --- |
| `action` | `ACTION_UNSUPPORTED` |
| `market` | `MARKET_NOT_SUPPORTED` / `SIGNAL_INVALID` |
| `policy.approvedSymbols` | `MARKET_NOT_APPROVED` |
| `strategy.market` | `STRATEGY_MARKET_MISMATCH` |
| `activation.status` / `activation.killSwitch` / `policy.killSwitchActive` | `STRATEGY_NOT_RUNNING` / `KILL_SWITCH_ENGAGED` |
| `strategy.budgetUsd` | `STRATEGY_BUDGET` |
| `policy.maxOrderNotionalUsd` | `MAX_ORDER_NOTIONAL` |
| `policy.maxStrategyNotionalUsd` | `STRATEGY_POSITION_CAP` |
| `position.quantity` / `position.notionalUsd` | `NO_OPEN_POSITION` / `EXIT_EXCEEDS_POSITION` |
| `strategy.stopLossPercent` | `STOP_LOSS_MISSING` |
| `sizeUsd` | `SIGNAL_SIZE_INVALID` |
| `price` | `PRICE_UNAVAILABLE` |

An `enter` with no size uses what remains of the strategy's own budget. `exit` closes the stored
position (full or a `sizeUsd` partial) and refuses to exceed it — a signal cannot flip a position.
`adjust` takes a signed size: positive adds, negative reduces. The price is the public quote first
and the stored daily close as fallback; no price is never guessed.

### Outbound: signed, retried, visibly recorded

- Subscriptions are per `(account, endpoint, event type)` with a per-endpoint secret:
  `trade.placed`, `alert.triggered`, `strategy.decision`, `webhook.test`.
- Every delivery is signed `X-Veylora-Signature: sha256=HMAC(timestamp.body)` with
  `X-Veylora-Timestamp`, `X-Veylora-Delivery` and `X-Veylora-Event`.
- Each attempt is its own `WebhookDelivery` row; `@@unique([deliveryKey, attempt])` makes a retry
  a new row rather than an overwrite, so the record shows first failure, wait, second failure.
- Backoff is bounded: 30 s, 120 s, 600 s, then final (4 attempts). The `webhook-deliveries` runner
  job sends what is due; the first attempt happens inline when the event occurs.
- Three consecutive failures mark the endpoint `UNHEALTHY` with `lastError`; the next success
  returns it to `HEALTHY` and clears the count. A paused/revoked endpoint or an unreadable secret
  fails once with no retry.
- Hooks: the strategy runner publishes `strategy.decision` for every decision and `trade.placed`
  when it places; alert evaluation publishes `alert.triggered`; the signal route publishes both
  for an accepted signal.

### Secrets

The token's signing secret and each endpoint's secret are sealed with AES-256-GCM under the
existing `TRADING_CREDENTIAL_ENCRYPTION_KEY`, with purpose-specific AADs
(`veylora:signal-secret:v1`, `veylora:webhook-secret:v1`), so signal material cannot be opened as
webhook material or as an exchange key. Creation is the only response that carries a secret.
`GET /api/signals` and `GET /api/webhooks` do not select the sealed columns; pages and logs show
only masked values; the logged body is a SHA-256 digest.

## Automated verification

```text
pnpm typecheck  → 0
pnpm test       → 0   (727/727; 19 new in tests/signals.test.ts)
pnpm lint       → 0
pnpm build      → 0   (/api/signals, /api/signals/[token], /api/webhooks present)
validate_plan   → 0   (40 phase files, 0 restriction hits, 0 warnings)
```

The new tests prove, without a database:

- a correct signature is accepted; a tampered body, wrong secret, missing/malformed signature,
  missing/unreadable timestamp and a timestamp outside the window are each refused with its code;
- the window is clamped and a stale request is accepted only after the owner widens it;
- sealing is purpose-bound (a signal secret cannot open as a webhook secret) and tamper-detecting;
- tokens are stored only as hashes and displayed only as masks;
- every mapping bound above, including per-order cap and strategy cap naming both values;
- a webhook payload is signed so it verifies against the endpoint secret, and neither payload nor
  signature contains the secret;
- a failing receiver produces attempts 1–4 with 30/120/600-second schedules, becomes `UNHEALTHY`
  at the third failure, stops at attempt 4, and recovers to `HEALTHY` on a later success with the
  earlier failed rows still visible.

## Owner click-path (running application)

Environment: a copy of the phase-30 development SQLite database, a throwaway session secret and a
throwaway 32-byte encryption key, a production build served on loopback behind a cookie proxy, and
a loopback HTTP receiver on `127.0.0.1:4555` that records each request. No session value, token or
secret is reproduced below.

1. **Token created from the settings UI.** On `/admin/access` → *Signals and webhooks*, the form
   accepted label `TradingView SOL alerts` and window `300`; the one-time block showed the
   endpoint, token and secret, and the list afterwards showed only `sig_asskU…36tt`. The window
   was then changed to `120` through the same row's `SAVE WINDOW`, and the list read `120s`.
2. **A correctly signed `enter` was accepted.**
   `POST /api/signals/<token>` with `{"signalId":"tv-sol-1","action":"enter","market":"SOL-USD","sizeUsd":"2"}`
   answered `200`:
   `accepted: true`, `SIGNAL_ACCEPTED`,
   `"Enter 2.00 USD of SOL-USD (0.01923261 SOL) with a stop at 97.75 USD."`,
   order `cmvfcz9ww000on91bbnmep14k`, routing `paper`. The strategy is the account's running
   `SOL deep value copy` (`bot:` activation), and `103.99` was the price used (the stored daily
   close at the time; the route now prefers the live public quote and falls back to this candle).
3. **The same signal again was a duplicate, with the original reference.** `409`
   `SIGNAL_DUPLICATE`, `originalEventId cmvfcz9vt000kn91br9g1kxxs`,
   `originalReceivedAt 2026-10-19T14:37:36.330Z`, and a second `DUPLICATE` row in the log.
4. **A tampered body was refused before parsing.** The same signature over
   `sizeUsd: "2"` sent with `sizeUsd: "20"` answered `401 SIGNATURE_INVALID`; the log row shows
   `signature invalid`, reason `Signature invalid`, decision `REJECTED`.
5. **A bound refused a signal by name.** `market: "BTC-USD"` against the SOL strategy answered
   `422 STRATEGY_MARKET_MISMATCH`, `bound: "strategy.market"`, with
   `"SOL deep value copy · v1 trades SOL-USD; the signal named BTC-USD."`
6. **An exit with no position was refused by the position bound.** The paper order was accepted
   by the venue (`SUBMITTED`, `filledQuantity 0`), so no position existed: `422 NO_OPEN_POSITION`,
   `bound: "position.quantity"`, `"holds no SOL-USD position to reduce"`. This is the honest
   reading of a paper order that has not filled; the exit mapping itself is proved by the tests.
7. **A stale request was refused by the configured window.** With the token window set to `120`,
   a request signed 400 seconds ago answered `401 TIMESTAMP_OUT_OF_WINDOW`:
   `"The signal timestamp is 400s from now; this token accepts a window of 120s."` The log now
   held six attempts in order: `ACCEPTED`, `DUPLICATE`, `REJECTED/SIGNATURE_INVALID`,
   `REJECTED/STRATEGY_MARKET_MISMATCH`, `REJECTED/NO_OPEN_POSITION`,
   `REJECTED/TIMESTAMP_OUT_OF_WINDOW` — the accepted row naming its order, the duplicate naming
   its original, and each refusal naming its bound.
8. **A test webhook was delivered and the receiver verified the signature.** The endpoint
   `http://127.0.0.1:4555/hook` subscribed to `webhook.test`; `SEND TEST EVENT` produced a
   delivery row `DELIVERED | 200` and the receiver's captured headers. The HMAC recomputed in
   the page from that endpoint's secret over `${timestamp}.${body}` matched
   `X-Veylora-Signature` exactly (`signatureValid: true`); the captured payload contained no
   secret.
9. **A dead receiver failed, retried and turned the endpoint unhealthy.** With the receiver
   stopped, three test events produced three `FAILED` attempt-1 rows with `fetch failed`, the
   endpoint read `UNHEALTHY` with `3 consecutive failure(s)`, and the signal's own
   `strategy.decision` / `trade.placed` deliveries also accumulated failures. The
   `webhook-deliveries` job then answered
   `6 retry attempt(s) across 3 endpoint(s): 0 delivered, 6 still failing` and wrote attempt-2
   rows with next attempts 120 seconds later. Every row's attempt number and next attempt were
   visible in the panel.
10. **The receiver came back and the retries delivered.** With the receiver listening, the
    job answered `7 retry attempt(s) across 3 endpoint(s): 7 delivered, 0 still failing`; the
    delivery table showed `attempt 3 | DELIVERED | 200 | Delivered` rows, all three endpoints
    read `HEALTHY`, `consecutiveFailures 0` and `lastError null`, and the newest captured retry
    (`strategy.decision`) verified against its endpoint secret.
11. **No secret was exposed.** `GET /api/signals` and `GET /api/webhooks` contained neither the
    full token, the signal secret nor the `whsec_` prefix (`leakedToken: false`,
    `leakedSignalSecret: false`, `leakedWebhookSecret: false`); the server, proxy and receiver
    logs each had **0** matches for `ss_`, `whsec_` and a full-token pattern.

The delivery rows persist the evidence rather than a final status: the successful retry did not
rewrite the earlier failures, so the record shows attempt 1 `FAILED`, attempt 2 `FAILED`,
attempt 3 `DELIVERED` for the same `deliveryKey`.

## Limits

- **Postgres was not available.** The migration was applied to a copy of the development SQLite
  database via a derived SQLite schema (`prisma db push`); it was not run against Postgres.
- **No real order or fill.** All orders are the paper venue. The paper adapter accepted the
  signal's order (`SUBMITTED`) but did not fill it, which is why the exit signal correctly
  answered `NO_OPEN_POSITION`. Exit/adjust mapping is proved by the unit tests.
- **Screenshots could not be captured.** The preview webview produced no frames in this
  environment; the panel was read through its DOM and the API in the same running application.
  The evidence in this record is the exact response bodies and the rendered table text.
- **Live feeds.** Prices for the accepted signal came from the stored daily close because that
  is what `marketCandidate` had; the route now prefers the public Coinbase quote and falls back.
  No live receiver was used beyond the loopback one, and webhook retries were driven by invoking
  the runner's job with the host's `CRON_SECRET`, which is the same entry point the schedule uses.
- **One signal per id, forever.** Retaining duplicate protection across all time is the phase's
  requirement; a sender that needs to reuse an id must use a new one. Nothing prunes
  `SignalEvent`, which is intentional for an audit log.
- **No approval gate in front of an accepted signal**, as required; the only preconditions are
  the running activation, the owner's kill switches and the measured risk caps.

## Files

- `apps/web/src/app/api/signals/[token]/route.ts` — inbound endpoint
- `apps/web/src/app/api/signals/route.ts` — token list/create/window/revoke
- `apps/web/src/app/api/webhooks/route.ts` — subscription list/create/pause/revoke/test
- `apps/web/src/lib/signals/verify.ts` — sealing, token hashing/masking, HMAC, replay window
- `apps/web/src/lib/signals/map.ts` — enter/exit/adjust mapping and the risk input
- `apps/web/src/lib/signals/log.ts` — claim/resolve, masked log and token views
- `apps/web/src/lib/webhooks/subscriptions.ts` — validation, one-time secrets, masked views
- `apps/web/src/lib/webhooks/dispatch.ts` — signing, inline delivery, retries, health
- `apps/web/src/app/admin/access/signal-settings-panel.tsx` — the panel
- `apps/web/src/lib/runner/registry.ts` — the `webhook-deliveries` job
- `apps/web/src/lib/strategies/runner.ts`, `src/lib/alerts/evaluate.ts` — event hooks
- `apps/web/prisma/schema.prisma`, `prisma/migrations/20261019120000_signals_and_webhooks` —
  `SignalToken`, `SignalEvent`, `WebhookSubscription`, `WebhookDelivery`
- `apps/web/tests/signals.test.ts` — 19 tests
