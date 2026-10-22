# Phase 15 — fund visibility and export: what exists, and what was measured

One place that answers "where is my money": balances with their ledger provenance, positions with
a stated cost, profit computed from entries rather than stored, the full history with filters, and
an export that is the same rows as the file.

- **Objective (phase file):** balances, positions, P&L, history and exports, plus a read-only venue
  import that can never be spent.
- **Status:** implemented, and every acceptance criterion is asserted by a named test below. The
  gates were re-run on 2026-10-22 (821/821 tests, typecheck, lint, build, browser suite, plan
  validator, and the read-only hosted smoke spec), after the Next.js security upgrade recorded in
  `.progress/SESSION_LOG.md`.
- **What this record is not:** the owner click-path in the phase file was not re-driven in a browser
  during this pass. The evidence is the suite, which calls the same functions the page and the API
  call; the page itself was not photographed here. That distinction is stated rather than papered
  over.

## The shape of it

- `src/app/account/page.tsx` renders `AccountOverview` inside the console shell and refuses an
  anonymous visitor with the shared access notice, not a blank panel.
- `src/lib/portfolio/pnl.ts` derives balances, positions, profit and the period report from ledger
  entries plus a dated price reading. There is no stored total to drift: the screen and the export
  are two renderings of one view.
- `src/lib/portfolio/service.ts` builds that view once (`readAccountView`) and `exportBody` turns it
  into CSV or JSON, so `/api/account` and `/api/account/export` cannot disagree — the "export
  reconciles to the screen" property is structural, not two renderers agreeing.
- `src/lib/ledger/statements.ts` is the history and the closing figure; `src/app/api/account/export`
  parses the same filter the screen uses and refuses an unreadable one by name.
- A read-only venue key is carried into the view as an **external** payload (its own shape, its own
  label) and never enters the platform's spendable balances.

## Acceptance criteria, and the tests that hold them

| Criterion (phase file) | Evidence in `apps/web/tests/fund-visibility.test.ts` |
| --- | --- |
| Screen totals equal ledger sums for the filter | "the totals for the selected filter are the sum of the rows the filter shows" |
| A filtered view follows the filter, not the book | "a filtered view's totals follow the filter rather than the whole book" |
| The statement's closing figure is the same number | "the statement's closing figure and the derived balance are the same number" |
| An export re-imported by a script reconciles | "an export re-imported by the parser reconciles to the same totals" |
| Every figure names its source and as-of time | "a position is costed at the order's own stated price and marked at a named reading"; "a market with no mark reports an absent figure rather than an estimate" |
| A read-only key is refused for trading, by name | "a read-only key is refused for trading by name, and an absent one is absent" (and the same refusal through the order path in `tests/trading-orders.test.ts`) |
| Imported balances are never spendable platform balances | "an imported balance never appears in the platform's balances" |
| An unreadable venue is reported as unread, not zero | "an unreadable venue is reported as unread, not as a zero balance" |
| A filter that cannot be read is refused | "a filter that cannot be read is refused by name" |

Two further properties the phase asked for in prose but not in its checklist are also asserted: a
credited deposit appears as two history rows (the chain arrival and the ledger movement) that share
a transaction hash, so the hash search finds both halves; and an entry that moved no money cannot
read as an outflow on screen or in the file.

## What was run in this pass

```
pnpm typecheck                    0
pnpm test                         0 — 821 tests, 821 pass
pnpm lint                         0
pnpm build                        0 — 98 pages
pnpm e2e                          0 — 10 passed
node scripts/validate_plan.mjs    0
E2E_BASE_URL=… pnpm e2e:smoke     0 — 5 passed (against a local production build)
```

## Limits this record carries

- The manual click-path (open `/account`, filter to today, export, connect a read-only key, attempt
  an order) was not performed here; the first three are covered by the view and export tests, the
  last by the read-only refusal tests. The browser half remains worth doing once against the
  deployment, because it also proves the page renders with real CSS and a session cookie.
- A figure is only as current as the price reading beside it. When no mark exists the page says so;
  it does not estimate. That is asserted, not observed on a live market here.
- The read-only import is proven against a scripted venue transport. No real venue key exists in
  this repository, so a live venue's shape is mapped but not measured.
