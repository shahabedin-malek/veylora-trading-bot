# Phase 26 — Assistant with real tools

The assistant answers from data, not from memory: eleven typed tools read the signed-in owner's
balances, ledger statement, positions, open orders and alerts, the public Coinbase quote, candle
and 15m-RSI series, Tavily research, and place paper orders; every call runs server-side with the
session's identity; every answer carries the tools' own citations with the moment each source was
observed; and a failure is a sentence naming what could not be read, never a filled-in figure.

Recorded on 2026-10-18 against a development server on `:3300` with a local stand-in at `:3301`
that speaks the AI Gateway's own OpenAI-compatible SSE format, and the SQLite development database
seeded by `pnpm db:setup`. The sessions were real `AuthSession` rows minted with a throwaway
secret; this record contains no session value, cookie, key or credential.

## Acceptance criteria, with what was observed

| criterion | status | evidence |
|---|---|---|
| A question about the owner's balance returns the ledger's real balance with its as-of time | met | `POST /api/assistant` → `From the ledger, read at 2026-10-18T22:36:35.855Z: 13 USDT available, 13 USDT in total.`; `GET /api/account` for the same account reported `USDT available 13`, `held 2`, `total 15`. The citation carried `source: "ledger"` and `asOf` equal to the read time the answer itself stated |
| A question about another account's data is impossible | met | with the second account's session the answer reported its own empty ledger (`no balances`), and a model-emitted `{"userId": "dev-owner-user", "accountId": "dev-owner-user"}` on `get_account_balance` still returned the caller's rows; `tests/assistant-tools.test.ts` asserts the reader sees only the executor's id |
| With a tool failing, the answer names the missing data rather than inventing a value | met | a `get_market_quote` for an unsupported symbol emitted a failed tool, `failures: [{tool, reason: "Unsupported public Coinbase USD symbol…"}]`, zero citations, zero prices in the text; a model provider cut mid-stream produced `error: "… The answer above is incomplete: it was cut off mid-reply."` while keeping the text already shown; a throwing ledger reader is asserted in `tests/assistant-tools.test.ts` to produce `Could not read: …` plus `I have not estimated or substituted a figure for it.` |
| Transcripts contain no credential material | met | a message containing `sk-live-…` reached the stand-in gateway as `[redacted]` and nowhere else: the key did not appear in the provider payload, the response events, the answer, or the 60 most recent `ASSISTANT_REQUEST` audit rows (which store tools, sources and token counts, and no question, answer or tool result) |
| Streaming responses render progressively | met | one answer arrived as 5 `delta` events over 320 ms, each before the terminating `done`; the route's `text/event-stream` events are `usage`, `tool`, `delta`, `done`/`error` |
| Rate limits and cost per request are visible and enforced per user | met | attempt 31 in the hour answered `429` with `{code: "RATE_LIMITED", limit: "requestsPerHour", cap: 30, observed: 31, resetAt: "2026-10-18T23:00:00.000Z"}` and `Retry-After`, and no `reply` field; each `done` event carries `usage` and, with prices configured, `consumption.dayCostUsd` |

## The requirements, one by one

1. **Typed, scoped tools.** `ASSISTANT_TOOLS` in `src/lib/assistant/tools.ts` is the single list:
   `get_account_balance`, `get_ledger_history`, `get_open_positions`, `list_open_orders`,
   `list_market_alerts`, `search_research`, `extract_research`, `place_paper_order` (account
   scope) and `get_market_quote`, `get_market_candles`, `get_market_indicator` (public). Each
   carries the arguments it accepts; `sanitiseArguments` drops anything else.
2. **Server-side identity, never an argument.** `createAssistantToolExecutor({ userId, … })`
   closes over the session id, and the account readers' first parameter is that id. A tool has no
   path to choose whose data it reads; `userId`, `accountId` and `databaseUrl` are filtered before
   any reader runs.
3. **Citations and freshness from the executor, not the model.** `src/lib/assistant/citations.ts`
   records what ran (`{tool, label, source, asOf, detail}`) and `composeAnswer` appends the
   sentences the model cannot be trusted to remember: a failed tool is named, and a question the
   account tools did not answer gets `I could not read your balance — …`. `asOf` is always the
   source's own observation (ledger `readAt`, a candle's close time, a quote's `observedAt`) and is
   null when the source reports none.
4. **Progressive streaming, and a labelled break.** `src/lib/assistant/loop.ts` reports each delta,
   and a transport that ends without its terminator raises `AssistantStreamError` carrying the
   partial text; the route emits `{type: "error", message, partial}` and keeps what the reader saw.
5. **No secret in a prompt, a tool result or a stored transcript.** `runMarketAssistant` redacts
   every message on its way out and `withRedactedToolResults` redacts every tool result, both as
   composition rather than as a rule each caller must remember. The audit row records tools,
   sources, tokens and outcome only.
6. **Limits and cost, per account, before the provider.** `src/lib/assistant/limits.ts` counts and
   decides in one transaction (30/hour, 200/day, 150,000 tokens/day), states the cap and the reset
   moment in the refusal, and returns null cost rather than a remembered price when no price is
   configured.
7. **No number the tools did not return.** The system prompt says so; the tool layer enforces it
   by making failure a value; `composeAnswer` states the missing data; and the test file asserts a
   balance question produces either a real reading or an explicit `could not read`.

## The owner's click-path, as measured over HTTP

The local stand-in chooses a tool from the question and writes its final sentence from the tool
result, so an answer can only quote a figure the tool actually returned.

- **Readiness:** `GET /api/assistant` → `modelConfigured: true`, `streaming: true`, 11 tools
  (8 account-scoped, 3 public), `limits: {30, 200, 150000}`.
- **Balance:** `13 USDT available` with `read at 2026-10-18T22:36:35.855Z`, matching `/api/account`
  and citing `ledger` at that instant.
- **Indicator:** `BTC-USD RSI-14 is 66.423 on 15m candles that closed at
  2026-10-18T22:30:00.000Z`; `POST /api/screener` (`RSI_14_ABOVE 0`, BTC-USD) computed `66.4230`
  at `2026-10-18T22:30:00.000Z` from `coinbase-exchange` — the same stored 15m series, agreeing to
  the fourth decimal, with the candle's close time as the citation's as-of time.
- **Tool failure:** the failed tool appears in the stream, in the answer's `failures`, and as
  `Could not read: …` in the text, with no citation and no invented number.
- **Mid-stream break:** the deltas already shown survive and the transcript says the answer is
  incomplete.
- **Credential:** the provider received `[redacted]`; the answer and every audit row are clean.
- **Another account:** the second account's own (empty) ledger answers its question, and the
  model's attempted `userId` is discarded before the read.
- **Rate limit:** the 31st question in the hour is `429` with the cap, the observed count, the
  UTC reset and `Retry-After`.

## The defect the walk found and fixed

The assistant's research tools bypassed the admin's own switches and the research desk's budget.
`IntegrationFeatureSettings` had `tavilySearchEnabled = 0` and `tavilyExtractEnabled = 0`, and
`POST /api/research/tavily/search` refuses in that state (`403 Tavily Search is switched off in
Access & Integrations.`), yet a live `search_research` call returned CoinDesk results and left a
`tavily` `ProviderCallRecord` — and the tool also skipped `consumeTavilyRequest`, the per-account
five-a-minute allowance those routes enforce.

`tools.ts` now takes a `researchAccess(userId, kind)` dependency whose default reads the stored
settings, refuses with the switch's own sentence, and spends the same per-account budget; both
research tools are account-scoped, so they cannot run without a session. `tests/assistant-tools.test.ts`
asserts the refusal happens before the provider is called and that the session's id is the one
checked. Re-measured live with the switch still off: `Search the news for bitcoin.` →
`failures: [{tool: "search_research", reason: "Tavily Search is switched off in Access &
Integrations."}]`, provider-call count unchanged at 1 before and after, and the balance tool on the
same server still answered `13 USDT available`.

## Gates

```
pnpm typecheck   → 0
pnpm test        → 0 (648 tests, 0 failed; 30 of them the assistant's own)
pnpm lint        → 0
pnpm build       → 0
node scripts/validate_plan.mjs → 0 (40 phase files, 0 restriction hits)
```

## Limitations

- **No genuine upstream outage was induced for a tool.** This machine cannot create an unprivileged
  network namespace (`unshare: Operation not permitted`) and Node's `--use-env-proxy` did not apply
  to `fetch` (a probe fetched Coinbase `200` through a dead proxy), so the "dead provider" reading
  is evidenced two ways instead: the model provider was cut mid-stream in the live route (the
  transcript keeps the partial text and reports it), and a reader that throws is asserted in
  `tests/assistant-tools.test.ts` to produce the `could not read … not estimated or substituted`
  answer. The live tool-failure reading uses the tool layer's own refusal.
- **The model was a local stand-in**, because this checkout has no AI Gateway credential. It
  speaks the gateway's server-sent-event format (tool calls fragmented across chunks, `usage` in the
  final chunk, `[DONE]`), and the transport tests drive the same parser against the same wire
  format; provider routing and metering remain phase 27.
- **The panel was verified at the API and stream level, not driven in a browser this run.** The
  component's own behaviour (rendering `DATA USED` from the route's citation array, `NOT READ` from
  its failures, the meter from `consumption`) was read in `src/components/market-assistant.tsx`;
  no browser pass was re-run here.
- The dev database was left as it was: the verification's two sessions and its usage counters were
  deleted, and the stand-in, its log and the driver live in `/tmp/phase26/`, outside the repository.
