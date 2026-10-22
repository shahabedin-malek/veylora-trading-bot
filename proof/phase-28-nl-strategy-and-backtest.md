# Phase 28 — Natural-language strategy and honest backtesting

A plain-English request becomes a typed definition whose rules are listed and whose text is editable;
every edit writes a new version and leaves the old ones readable; and every backtest prices its fills
with the fee table's own fee, spread, slippage and funding, printing those assumptions beside the
result. The model's prompt and raw answer are stored with the definition, so any rule can be traced to
what produced it, and a definition that cannot run is refused with the value that is wrong. Sweeps
return every run and flag the best one while saying in words that the winner is in-sample selection.

Recorded on 2026-10-19 against the development server on `:3210` (reached through a loopback cookie
proxy on `:3310`, because the session cookie is httpOnly and the browser panel cannot be handed one),
a local stand-in for ChainGPT's `/chat/stream` on `:4319`, and the SQLite development database seeded by
`pnpm db:setup`. The session was a real `AuthSession` row minted with a throwaway secret; this record
contains no session value, cookie, key or credential.

## Acceptance criteria, with what was observed

| criterion | status | evidence |
|---|---|---|
| A plain-English request produces a definition whose rules are visible and editable | met | `POST /api/strategies {"mode":"generate","description":"Buy BTC-USD on the daily when RSI drops below 30, exit when RSI rises above 70, risk 25% of capital with a 4% stop."}` → `201` with `version 3, origin "generated"`, the definition text (`STRATEGY "Oversold BTC bounce"` … `LEVERAGE 1x`), and seven rules: *Market BTC-USD on 1d candles*, *Entry when RSI(14) crosses below 30*, *Exit when RSI(14) crosses above 70*, *Size 25% of equity per entry*, *Stop-loss 4% below the entry fill*, *Daily-loss halt 2%*, *Leverage 1x: no borrowed notional and no funding*. The same row saves edited text as a new version (`PUT` → `200`, "Saved as version 4. Version 3 remains readable.") |
| An invalid definition is rejected with the specific problem named | met | `mode: "validate"` with `ENTRY … CROSS_BELOW 70` / `EXIT … CROSS_ABOVE 30` / `SIZE 0%` → `422` with both issues: "The entry threshold (70) must be below the exit threshold (30) for a strategy that buys low and sells high." and "The size must be a percentage of equity greater than zero and no more than 100%." A generated definition naming `MACD(12)` → `422`, `issue: Line 4: ENTRY: Unknown indicator "MACD". This build supports RSI, SMA, EMA and PRICE.`, nothing saved |
| Backtest results change when spread or fees change, proving the costs are applied | met | the same definition and window at 10 bps then 60 bps: final capital `9580.45378733947818447113615157170176` → `9485.93814178193438123842329572868096`, fees `19.28226682874422508669065496653824` → `115.26852910324726749015516613115904`, expectancy `-104.89` → `-128.52`, trade count `4` → `4`, and the fee-table schedule id and `appliedFrom` differ between the two results |
| A strategy edit creates a new version and the previous one remains readable | met | the edit above wrote `version 4` (`origin "edit"`) and returned `previous: {version 3, text: …}`; `GET /api/strategies` lists `v5 edit`, `v4 edit`, `v3 generated`, `v2 edit`, `v1 generated` with each version's own text, and `StrategyDefinition` has 7 rows |

## The requirements, one by one

1. **A typed definition, shown as plain text.** `src/lib/strategies/definition.ts` holds the type
   (name, market, timeframe, entry/exit conditions with indicator, period, comparator and threshold,
   size percent, stop percent, daily halt, leverage) and renders it to the exact line format the owner
   reads and edits; `definitionRules` derives the seven spoken sentences from the same object, so the
   list and the text cannot disagree. `validateStrategyText` parses that text back and returns the
   typed definition or the specific issues.
2. **Refusal with the value that is wrong.** `src/lib/strategies/validate.ts` names an unknown
   indicator with its line, an inverted entry/exit range with both thresholds, a zero or >100% size,
   an unsupported comparator, a missing market and a stop outside its range. Both the strategies route
   and the backtest route validate before authentication, so a malformed definition is answered as
   itself rather than hidden behind an auth error.
3. **Transparency.** `StrategyDefinition` stores `promptJson` (system and user, version
   `strategy-definition-v1`), `modelOutput` (the model's raw answer), `providerId`, `model` and
   `fallbackFrom` beside the validated `text` and `definitionJson`. The generate response returns the
   same trace. The stored row for the generated definition: `promptJson` 1137 bytes, `modelOutput`
   169 bytes equal to the stored text, provider `chaingpt`, model `general_assistant`.
4. **Realistic, printed costs.** `src/lib/backtesting/costs.ts` builds the model from the fee table in
   force (fee, spread, slippage per side; funding per day on a leveraged position) and writes the
   `costAssumptions` sentences. `engine.ts` applies fee and spread and slippage against the position on
   both entry and exit and charges funding per day held only when leverage is above 1x; results carry
   win rate, drawdown, expectancy, trade count and per-cost totals, and their sentences name the fee
   table version and its effective instant. Leveraged funding is proved by
   `tests/backtest-engine.test.ts` ("a leveraged definition pays funding per day held and says so").
5. **Comparison and sweeps.** `GET /api/backtest/runs` returns stored runs with kind, definition
   version, costs and metrics; the panel's *Compare runs* region selects up to two. `mode: "sweep"`
   returned four runs for `ENTRY_THRESHOLD 20/25/30/35` (final `9739.58`, `9361.61`, `9485.94`,
   `9238.90`), `bestValue "20"`, and the warning: "The flagged value is the best of these runs on one
   history, which is in-sample selection: it is a hypothesis to test forward, not a guaranteed outcome."
6. **Versioning, and a run you can trace.** Every edit inserts; the unique index on
   `(userId, name, version)` makes the next version a database fact. `BacktestRun` stores
   `definitionVersion`, the exact `strategyText` it evaluated, `costAssumptionsJson` and the full
   `resultJson`, and a sweep shares one `sweepId`. The six most recent rows read
   `PAPER v1 10bps`, `BACKTEST v1 10bps`, `PAPER v1 10bps`, `BACKTEST v5 60bps`, `BACKTEST v5 10bps`,
   so a later reading is tied to the version and the costs that produced it.
7. **Paper before live.** `mode: "paper"` runs the stored definition over the last 60 daily bars and
   stores a `PAPER` run: the generated definition processed 60 bars and honestly reported 0 trades
   (its last entry in the year was 2026-07-31, before the window), while a 55/65 variant over the same
   60 bars produced 2 trades, 50% wins, `10209.29` final capital and `10.38` in fees.

## The owner's click-path, as measured over HTTP

- **Describe:** the request above produced `201` with editable text and seven rules, and the trace.
- **Run:** `mode: "definition"` on the stored id ran 365 daily candles of BTC-USD (2025-10-19 →
  2026-10-19): final `9580.45`, return `-4.1955%`, max drawdown `4.1955%`, win rate `0.00%`,
  expectancy `-104.89`, 4 trades, fees `19.28`, spread `3.86`, slippage `9.64`, with the four cost
  sentences printed.
- **Change the fee in `/admin/fees` and re-run:** `PUT /api/admin/fees` at `tradingFeeBps 60` (a new
  insert-only version, audited), then the same run: final `9485.94`, fees `115.27`, expectancy
  `-128.52`, and the result names the new schedule id and its `appliedFrom` instant. Restored to
  `10` afterwards.
- **Failure case:** the description naming `MACD` returned `422` with the unknown-indicator sentence
  and nothing saved; the inverted-range/zero-size text returned `422` with both issues.
- **Sweep:** four values, per-run metrics, `bestValue`, and the in-sample warning, all stored.
- **Paper:** 60 bars, stored, with trades for a variant whose entry is reachable in the window.

## Gates

```
typecheck=0  test=0  lint=0  build=0
plan=0  (40 phase files, 0 restriction hits, 0 warnings)
```

## What this record could not do

- **The client panel was not driven in a browser.** In this environment the Next 16.4 development
  server never hydrates the app (no React container on the document, no console error; the same is
  true of `/screener`, a page this phase did not touch), while the production build on `:3410` does
  hydrate. So the panel is verified at the API level and as server-rendered HTML — the convention
  phases 24, 26 and 27 also recorded — and the interactive click-path in the owner's browser is an
  open check rather than a pass.
- **The model was a local stand-in.** No ChainGPT credential exists on this machine, so the one
  generation call was answered by a loopback server speaking the provider's own envelope. The prompt of
  record, the validation and the storage are the application's; the wording of the answer is not the
  live model's.
- **The migration ran on SQLite.** `db:setup` derived the schema from the models and the tables are
  present (7 definitions, 23 runs); the Postgres DDL is verified against Prisma's derived statements
  rather than executed, because no Postgres is reachable here.
- **Candles are public production data.** The 365 daily BTC-USD candles came from the public Coinbase
  provider, so the figures above are reproducible only while that history is unchanged.
- The fee table was left at the default `10` bps trading fee, `2` bps spread, `5` bps slippage and
  `0` funding; the sensitivity test's fee versions remain in its insert-only history.
