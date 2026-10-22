# Phase 16 — Fees and pricing: proof

Measured on 2026-10-17 on the working tree at `/home/chris/trading-ai-ds`, with node
v24.21.0 and pnpm 11.15.1, against the derived SQLite development database
(`apps/web/prisma/dev.db`) and a dev server on `:3235`. Every gate's exit status was read
on its own; the session was a real `AuthSession` row signed with a throwaway secret
generated for the run, and this record reproduces no session value, cookie or key.

## Gates

| gate | command | result |
| --- | --- | --- |
| typecheck | `pnpm --config.verify-deps-before-run=false typecheck` | exit 0 |
| test | `pnpm --config.verify-deps-before-run=false test` | exit 0 — 472 tests, 472 pass, 0 fail |
| lint | `pnpm --config.verify-deps-before-run=false lint` | exit 0 |
| build | `pnpm --config.verify-deps-before-run=false build` | exit 0 — `/pricing` and `/admin/fees` in the route table |
| plan | `node scripts/validate_plan.mjs` | exit 0 — 40 phase files, 0 restriction hits, 0 warnings |
| routes:sweep | `pnpm routes:sweep -- --base-url http://localhost:3235 --cookie …` | exit 0 — 88 passed · 0 not swept · 0 failed (owner session) |
| db:setup | `pnpm --config.verify-deps-before-run=false db:setup` | exit 0 — schema in sync; seeded |

The sweep gained four rows: `GET /pricing`, `GET /admin/fees`, `GET /api/admin/fees` and
`PUT /api/admin/fees`. The `PUT` probe is `{}` and answers 400 because validation refuses
it before anything is inserted.

The only red gate on arrival was nobody's: the suite was green at phase 15's close. (The
phase-15 time-pinned deposit test repaired then is still green here: 472/472 includes it.)

## What the phase added

- `src/lib/fees/amounts.ts` — pure, client-safe maths: decimal ↔ minor units at an
  asset's scale, `formatFeeAmount` (zero renders as `no fee`), `quoteWithdrawal` (gross,
  fee, network cost, arriving; a fee at or above the gross is refused here with both
  numbers), and `percentToBasisPoints`.
- `src/lib/fees/table.ts` — the versioned fee table: types, strict validation, this
  build's free defaults, `readEffectiveFeeSchedule` (latest version whose
  `effectiveFrom` has passed; a stored row that no longer validates is a hard error),
  `readFeeScheduleView` (in force, staged, history), `saveFeeSchedule` (insert + one
  audit event with before/after), and `pricingRows`, which reads fees through the same
  `withdrawalFeeFor`/`networkCostFor` the withdrawal path uses.
- `src/lib/fees/apply.ts` — `performanceFeeMinor` (profit only; floored basis points),
  `chargePerformanceFee` (balance-checked under the account's asset lock; posts a
  balanced `PERFORMANCE_FEE` transaction from the owner's `AVAILABLE` to the platform's
  `FEES`, keyed by the result and carrying `sourceType`/`sourceId`),
  `reversePerformanceFee` (compensating transaction referencing the original), and
  `platformFeeBalanceMinor`.
- `prisma/schema.prisma` + `prisma/migrations/20261017120000_fee_schedule` —
  `FeeSchedule`, one row per version, insert-only.
- `src/lib/ledger/integer-cent-ledger.ts` — `PERFORMANCE_FEE` added to the closed kind
  set, so the statement and history can tell a strategy fee from a wallet transfer.
- `src/lib/withdrawals/settings.ts` + `policy.ts` + `request.ts` + `service.ts` —
  `readPricedWithdrawalPolicy` overlays the stored table on the deployment policy; the
  request refuses a fee at or above the amount **before** reserving; the view exposes
  `feeByAsset`, `networkCostByAsset`, `feeSource`, and per-network `feeLabel`/
  `networkCostLabel`; the quote is disclosed on the panel.
- `src/app/api/admin/fees/route.ts`, `src/app/admin/fees/page.tsx`,
  `src/app/admin/fees/fee-schedule-form.tsx` — the editor, guarded by the new ACTIVE
  `fees.manage` permission, with `effectiveFrom` and tier caps.
- `src/app/pricing/page.tsx` — the public price list, rendered from the same resolver;
  when the table cannot be read the page states no price rather than an old one.
- `src/lib/portfolio/pnl.ts` + `src/components/account-overview.tsx` — the period report
  now separates withdrawal fees and performance fees (net of reversals), and the CSV
  export carries a `# PERIOD FEES` block that the re-import parser stops at.
- `src/app/api/trading/credentials/route.ts` — the default tier's venue-connection cap is
  enforced when a key is added (409 with the count and the cap). Bot caps are stored and
  published here and enforced by the bot builder in phase 30, as that phase's plan says.

## Acceptance criteria, with the values observed

### 1. Setting a withdrawal fee changes the deducted amount and the pricing page with one save

One `PUT /api/admin/fees` (fee `1`, network cost `0.5`, performance `20`, tiers
`STANDARD`/`DESK`) answered 200. Immediately afterwards:

- `GET /api/withdrawals` read `feeSource: "owner-schedule"`, `feeByAsset.USDT: "1"`,
  `networkCostByAsset.USDT: "0.5"`, and every Ethereum-family network row read
  `feeLabel: "1 USDT"`, `networkCostLabel: "0.5 USDT"`.
- `GET /pricing` (200, public) rendered the same numbers: `1 USDT` in the Platform fee
  column, `0.5 USDT` with `paid by the platform` in the Network cost column, and
  `20% of a profitable result.` The page's own source line read
  “the stored fee table, version effective 10/17/2026, 1:43:42 PM”.
- A withdrawal of `2 USDT` on `ethereum-mainnet` answered **201** with
  `amount: "2"`, `fee: "1"`, `net: "1"` (`amountMinor 2000000`, `feeMinor 1000000`,
  `netMinor 1000000`) — the table's number was the deducted number. The row was `HELD`
  because it is the first send to that address under the owner's 60-minute window; the
  hold is phase 14's control, not a fee step.

### 2. A profitable result produces a fee, a losing one produces none — proven by tests

`tests/fees.test.ts`:

- `performanceFeeMinor`: 20% of 5,000,000 → 1,000,000; 12.5% of 1,000,000 → 125,000;
  −500,000 → 0; 0 → 0; 0% → 0; 50% of 7 → 3 (floored).
- A funded 10 USDT account charged on a 5 USDT profit posts one `PERFORMANCE_FEE`
  transaction, `sourceType: "StrategyResult"`, `sourceId: "result-profitable"`, the fee
  account holds exactly 1,000,000, the owner holds 9,000,000, a replay is
  `ALREADY_COMPLETED` and the fee account does not move again.
- A losing result writes **no** transaction and leaves the fee account at 0.
- Reversal posts the opposite legs referencing the original; the fee account returns to
  0; a second reversal is `ALREADY_COMPLETED`.

### 3. Every fee entry links to its originating action

Withdrawal settlement already carries `sourceType: "Withdrawal"` / `sourceId` (phase 14),
and the performance fee carries `sourceType: "StrategyResult"` / `sourceId`; both are
asserted in `tests/fees.test.ts`. The withdrawal request's audit payload also names the
fee source and the disclosed network cost.

### 4. Setting a fee to zero removes the charge and states “no fee”

A save with fee `0`, network cost `0`, performance `0` answered 200. Then:

- `GET /pricing` rendered **8** occurrences of `no fee` and `No fee.` for the performance
  section, and no percentage sentence; the USDT row read `no fee` in both cost columns.
- `GET /api/withdrawals` read `feeByAsset.USDT: "0"`, every network `feeLabel: "no fee"`.
- The ledger was not touched by any of it: a zero fee posts no entry (the settlement path
  already skips a zero fee leg, and `chargePerformanceFee` returns “not charged” for 0%).

The final click-path state restored fee `1` / cost `0.5` / performance `20` under a
**later** `effectiveFrom`; `/pricing` and the withdrawal view then agreed again
(`1 USDT`, `0.5 USDT`, `20% of a profitable result.`). That ordering was itself a check:
saving a version dated *earlier* than the version in force did not override it, which is
what `effectiveFrom` is for.

### 5. Failure case: a fee larger than the balance is refused before anything is reserved

With the version in force at fee `25 USDT` and the account holding `13 USDT`:

```
POST /api/withdrawals  {network: ethereum-mainnet, amount: "2", …}   → 400
{"error":"The withdrawal fee of 25 USDT leaves nothing of 2 USDT to send, so the request
 was refused and nothing was held. Withdraw a larger amount or lower the fee.",
 "reason":{"code":"INVALID_AMOUNT","retryable":false,
           "detail":"fee 25000000 minor units against 2000000"}}
```

No withdrawal row was created (visible count 2 → 2) and the available balance stayed at
`13 USDT`. The check runs before the reserve transaction, so nothing was held even for an
instant.

## The audit trail

Five saves produced five `FEE_SCHEDULE_UPDATED` audit rows and five `FeeSchedule` rows
(insert-only — no row was ever updated). Each audit payload carries `effectiveFrom`,
`before` (the version in force at save time, or `null` for the first) and `after`. For
example the last save:

```
FEE_SCHEDULE_UPDATED  SUCCESS  before.performanceFeePercent=0  after.performanceFeePercent=20
                              after.withdrawalFees.USDT=1
```

`GET /admin/fees` read 200 as the owner and rendered the form (`SAVE FEE TABLE`), the
`AUDITED ON SAVE` state and the history/staged sections. A body without `effectiveFrom`
is refused 400 by validation (the sweep's probe proves the refusal writes nothing).

## The account export

- CSV export answered 200 and carried the fee block:

```
# PERIOD FEES — withdrawal and performance fees for this range, from the figures the screen shows
asset,withdrawalFees,performanceFees,totalFees,totalFeesMinor
USDT,1,0,1,1000000
```

- JSON export carried the same split per asset (`withdrawalFees`, `performanceFees`,
  `fees`).
- The phase-15 reconciliation script still exits 0 with the block present: 9 rows
  re-imported, file rows summed = file `TOTAL` rows = screen totals = screen history
  summed = `15000000` USDT minor units. The parser stops at the `#` marker, so the fee
  block cannot be double-counted as a history row.

## Limitations this record carries

1. **The Postgres migration was not executed.** No Postgres is reachable from this
   machine. `prisma migrate diff --from-empty --to-schema-datamodel` derives the
   `FeeSchedule` table, two indexes and the foreign key exactly as the migration states;
   the runtime checks ran on the derived SQLite dev database, which `db:setup` pushed
   from the same models.
2. **The performance fee has no live caller yet.** There is no strategy runner in this
   build (phase 24), so `chargePerformanceFee` is exercised by tests and not by a route.
   The pricing page says so: paper and backtest results are never charged.
3. **Bot tier caps are data only.** They are stored, validated and published; phase 30
   owns enforcement, as its plan states. Venue-connection caps are enforced today by the
   credential path.
4. **The withdrawal panel's pre-submit numbers were not captured in a browser.** The
   panel computes them with `quoteWithdrawal` from the API view's `fee`, `networkCost`
   and asset scale; the view values and the quote are both verified above, but the
   preview pane had no authenticated session for `/trade`, and the screenshot endpoint
   reported no composited frames (`/pricing`'s DOM snapshot *was* read and matched its
   rendered rows). The panel's arithmetic is a shared function under test rather than a
   second implementation.
5. **`WITHDRAWAL_FEE_<ASSET>` is now a fallback, not a source.** Once any fee-table
   version exists it replaces the environment value for every asset the withdrawal path
   knows; before the first save, the free defaults apply. A deployment that relied on
   the environment values must save a version to keep charging.

## Definition of done

- [x] Fee table editable in the admin panel with effective-from and audit per change.
- [x] Fees post as ledger entries with their own account (`platform:fees:<asset>`).
- [x] Pricing page renders from the same source of truth, asserted by a test
      (`tests/fees.test.ts`, “the pricing rows and the withdrawal policy read the same
      fee table, value for value”).
- [x] Zero-fee configuration renders as free (`no fee`), including on `/pricing`.
