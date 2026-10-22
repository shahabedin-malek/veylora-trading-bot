# Phase 33 — terminal UX, mobile and accessibility

This record covers `/trade` and `/markets` at real viewport sizes on a production build
(`next build` + `next start`) behind a local HTTPS proxy that injected a real `AuthSession`
row's cookie. It contains no session value, cookie, credential or key material.

## Gates

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `pnpm --config.verify-deps-before-run=false typecheck` | `0` |
| Lint | `pnpm --config.verify-deps-before-run=false lint` | `0` |
| Tests | `pnpm --config.verify-deps-before-run=false test` | `744 pass, 0 fail` |
| Build | `pnpm --config.verify-deps-before-run=false build` | `0` |
| Plan | `node scripts/validate_plan.mjs` | `0`, 40 phase files, 0 restriction hits |

## Desktop: the chart and its account rail share the first screen

Measured with CDP `Emulation.setDeviceMetricsOverride`, not a resized window:

| Viewport | Chart bottom | Rail bottom | Both inside the viewport |
| --- | ---: | ---: | --- |
| 1440 × 900 | 772 | 771 | yes |
| 1366 × 768 | 734 | 724 | yes |

At 1366 × 768 the chart is 280 px tall and the rail's rows use a denser padding, both only
under `(min-width: 1001px) and (max-height: 820px)`. At 1440 × 900 the original 330 px chart
is used. Balances, positions and recent orders are all readable beside the candles without
scrolling the rail away from the chart.

## Phone: no sideways scroll, 44 px controls

At 390 × 844 with `Emulation.setDeviceMetricsOverride`:

| Page | `documentElement.scrollWidth` | inner width | Horizontal page scroll | Controls under 44 px |
| --- | ---: | ---: | --- | --- |
| `/trade` | 390 | 390 | no | 1 |
| `/markets` | 390 | 390 | no | 1 |

The remaining control is the TradingView attribution link that `lightweight-charts` draws
inside the canvas (35 × 19). It is a vendor attribution rather than a product control and
was deliberately not resized. Everything else measured at or above 44 px in both dimensions:
navigation, chart ranges, segmented controls, table-to-card links, desk panel links, summary
disclosures, order-ticket inputs and buttons, credential fields, and explorer/transaction links.

The market history table becomes one card per row below 700 px, with each cell labelled from
`data-label`; the asset selector and primary navigation are inner horizontal scrollers but do
not make the page scroll.

## Keyboard only: a paper order, completed

The driver sent real `Input.dispatchKeyEvent` Tab/Enter events to the production page:

- 60 Tab presses reached `Submit paper order`; every stop had a visible
  `rgb(168, 228, 189) solid 2px` focus outline (offset 2 px), including the order-ticket inputs.
- On the quantity field the driver pressed Ctrl+A and typed `0.003`, remaining entirely on the
  keyboard.
- Enter submitted: the panel answered
  `SUBMITTED — dev-paper accepted the order as paper-1f1b4751900af36f2d629414, and it is SUBMITTED.`
  and the count moved from 16 to 17 orders.

A previous run with the default `0.001` was answered
`REPLAYED — This exact intent was already submitted...` and the count stayed at 16, which is
the idempotency rule behaving as designed rather than a second order.

A full sweep then tabbed until the sequence wrapped: **108 Tab presses reached all 100 visible,
enabled controls**, `wrapped: true`, no missing control and no control with `outline: none`.
The two controls not in the set were disabled (`Send the same order again` before a submission,
and `REQUEST WITHDRAWAL` before its fields are valid), so they are not interactive yet. The
date inputs legitimately keep focus for four Tab presses while Chrome walks their month/day/year
subfields; the sweep treats that as internal movement rather than a trap, and the sequence
continues to the next control.

## Live values: no layout shift, tabular figures

A `PerformanceObserver` for `layout-shift` was installed before navigation and read after
16 seconds:

- Total CLS `0.0060`, all of it during initial hydration (largest single entry `0.0046` on the
  automation section at ~1.5 s). Earlier runs on the same layout measured `0.0050`.
- **No layout-shift entries after 4 seconds**, while the ticker updated repeatedly.
- The price element was `82009.55` at 6 s and `82013.24` at 16 s; its width stayed
  `93.59375 px` at the same `x = 863.875` both times. `coinbase-ticker__price-row > strong`
  has a 13ch floor, and the figure is `tabular-nums`.
- `font-variant-numeric: tabular-nums` was read back as `tabular-nums` on the ticker price,
  the desk balance figure, and order rows. The rule that sets it sits after the `font`
  shorthands that would otherwise reset it.

The ticker now keeps the last verified quote when the stream is stale, labelled
`LAST VERIFIED (DELAYED/STALE)` with its observation time, instead of replacing it with
"Not connected". A level-1 book has no last trade, so before a trade arrives it shows the
best ask explicitly (`81938.16 ASK`), never an invented mid.

## Failure states name a reason

Blocking four APIs in the browser (`Network.setBlockedURLs` for `*/api/trading/orders*`,
`*/api/ledger*`, `*/api/deposits*` and `*/api/withdrawals*`) produced:

- Orders: `ORDERS UNAVAILABLE`,
  `The orders API could not be reached from this browser, so no order state was read.`, and
  `The venue and its order count are unknown, because the read failed.` The panel no longer
  claims `0 ORDER(S)` when it read nothing.
- Balances: `Balances unavailable`,
  `The ledger API could not be reached from this browser (Failed to fetch), so no balance was read.`
  The panel leaves the loading state instead of sitting on `Reading your ledger…` forever — the
  rejected-fetch path previously bypassed the error branch.
- Deposits: `Deposits unavailable`, `The watcher's cadence is unknown, because the deposit
  read failed.`, and `The deposits API could not be reached from this browser (Failed to fetch),
  so no deposit address was read.` The panel no longer shows `Watched every 0 minutes` or an
  empty-transfer claim as if the read had succeeded.
- Withdrawals: `Withdrawals unavailable`, `network list unavailable`, `The network list could
  not be read, so no route is shown as configured.`, and the same rejected-fetch sentence for
  withdrawals. The policy block is omitted while its data is unknown instead of rendering
  `no hold configured` as a fact.

All four rejected-fetch paths shared the same cause: `request()` awaited `fetch` without a
`try`, so a transport failure skipped the error branch and left each panel in its loading text.

The server-rendered surfaces are covered by `tests/terminal-states.test.ts` (6 passing tests):
a failed workbench names the account, position, order, quote and chart reasons; no stored bars
says `No verified candle history` and `LAST STORED BAR · NONE`; a single bar renders its OHLC
with `ONLY STORED BAR IN THIS RANGE`; undateable bars say `No bars in the selected range`; a
gain is `+3.25 USD` / `UNREALISED GAIN` and a loss is `−3.25 USD` / `UNREALISED LOSS`; an empty
account says `No ledger account yet`, `No open position` and `No orders yet` rather than zeroes.

## Limits

- The provider itself was not broken end-to-end: the chart's provider-outage branch is proved
  by server-rendering `MarketChart` with a `failure` and no candles, and the quote/account
  surfaces by rendering `TradeWorkbench` with their failure props. The live browser failure
  case blocked the two client-read APIs instead.
- The chart's `No bars in the selected range` path is only reachable with malformed timestamps,
  because the range is measured back from the newest candle and therefore always contains at
  least one valid bar.
- The development server on this machine did not hydrate client components; all browser
  readings above were taken against the production server, which does hydrate.
- The TradingView attribution link remains below 44 px as described above.
- Screenshots used headless Chrome with a self-signed certificate trusted only by that browser;
  the key and certificate live in `/tmp/phase33/` and are not committed.
