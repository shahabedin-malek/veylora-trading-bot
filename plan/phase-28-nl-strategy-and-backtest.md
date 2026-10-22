# Phase 28 — Natural-language strategy and honest backtesting

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

The owner describes a strategy in plain English and gets a definition they can read, edit and
version, plus a backtest that models spread, slippage and fees — as the inspectable generated
strategy of AlgoBuilder and the tick-level testing of the Strategy Designer.

## Scope

- In: NL → strategy definition, validation, editing and versioning, the backtest engine with realistic costs, comparison and parameter sweeps.
- Out: live placement (phases 21/22); the runner (phase 24); alerts.

## Files to touch

- `apps/web/src/lib/strategies/definition.ts`, `generate.ts`, `validate.ts` (new)
- `apps/web/src/lib/backtesting/rsi-backtester.ts` (extend into a general engine), `engine.ts`, `costs.ts` (new)
- `apps/web/src/app/backtest/page.tsx`, `src/components/backtest-panel.tsx`
- `apps/web/src/app/api/backtest/route.ts`, `route.test.ts`, `src/app/api/strategies/route.ts`
- `apps/web/prisma/schema.prisma` (`StrategyDefinition`, `BacktestRun`) and a migration

## Requirements

1. A generated strategy is a typed definition — entry and exit conditions, size, stops, limits —
   rendered as plain text the owner can edit, with the exact rules listed.
2. Validation rejects a definition that cannot run (unknown indicator, inverted range, zero
   size) with the specific problem, and never accepts a strategy whose rules cannot be shown.
3. Generation is transparent: the prompt, the model's output and the validated definition are
   all stored, so any rule can be traced to what produced it.
4. The backtest models spread, slippage, fees from the phase-16 table, and funding where
   relevant; results report win rate, drawdown, expectancy and trade count with the cost
   assumptions printed alongside.
5. Runs can be compared side by side and a parameter sweep returns per-run results, with the
   best parameter set flagged and the overfitting warning stated.
6. A strategy is versioned on every edit; a version that was backtested can be identified from a
   later live result.
7. Paper-trading a generated definition works before any live path is used.

## Acceptance criteria

- A plain-English request produces a definition whose rules are visible and editable.
- An invalid definition is rejected with the specific problem named.
- Backtest results change when spread or fees change, proving the costs are applied.
- A strategy edit creates a new version and the previous one remains readable.

## Manual verification (owner click-path)

1. On `/backtest`, describe a simple strategy in plain English; the rules appear as an editable
   definition.
2. Run the backtest; results show with the cost assumptions printed on screen.
3. Change the fee in `/admin/fees`, re-run — the result changes and says why.
4. Failure case: describe a strategy with an unknown indicator — validation names it rather than
   producing a silently empty result.

## Automated verification

```bash
cd apps/web
pnpm --config.verify-deps-before-run=false typecheck; echo "typecheck=$?"
pnpm --config.verify-deps-before-run=false test;      echo "test=$?"
pnpm --config.verify-deps-before-run=false lint;      echo "lint=$?"
pnpm --config.verify-deps-before-run=false build;     echo "build=$?"
cd ../.. && node scripts/validate_plan.mjs; echo "plan=$?"
```

## Definition of done

- [ ] Definitions are typed, visible, editable and versioned.
- [ ] Invalid definitions are refused with the specific problem.
- [ ] Backtests apply spread, slippage and fees, proven by a cost-sensitivity test.
- [ ] Nothing about a generated strategy is hidden from the owner.

## Rollback

- Revert this phase's commit and drop the two tables; the previous RSI backtester behaviour
  returns.

## Do not do

- No approval gate or confirmation step before a backtest or a strategy edit.
- Do not hide generated rules behind a summary the owner cannot inspect.
- Do not report a backtest result without its cost assumptions.
- Do not present a sweep winner as a guaranteed outcome.
