# Phase 33 — Terminal UX, mobile and accessibility

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

The product feels like a trading terminal on a desktop and is genuinely usable on a phone:
dense, fast surfaces for charts, orders and positions, honest loading states, and interactive
elements that pass an accessibility pass.

## Scope

- In: `/trade` and `/markets` density and layout, chart panels, order and position tables, mobile breakpoints and touch targets, keyboard navigation, loading and empty states.
- Out: new features; the design system rewrite; marketing pages (phase 40).

## Files to touch

- `apps/web/src/components/terminal-shell.tsx`, `depth-text.tsx`, `coinbase-live-ticker.tsx`, `ethereum-portfolio-panel.tsx`
- `apps/web/src/app/trade/page.tsx`, `markets/page.tsx`, `bots/page.tsx`
- `apps/web/src/app/globals.css` (tokens, breakpoints, focus styles)
- `apps/web/src/components/*` panels created in earlier phases

## Requirements

1. Desktop layouts use the available width for charts plus side panels, with positions, orders and
   balances visible without scrolling away from the chart.
2. Mobile layouts are composed for a phone: stacked panels, one primary action per screen, tables
   that become cards, and touch targets of at least 44px.
3. Every data surface has three honest states: loading, loaded and failed-with-reason — no spinner
   that never ends and no empty panel that hides an error.
4. Keyboard: every interactive control is reachable, focus is visible, and no control traps focus.
5. Colour is never the only signal: gains/losses carry a sign or label as well.
6. Live-updating values do not shift layout as they change; numbers use tabular figures.
7. Charts handle an empty range, a single data point and a provider outage without breaking, and
   state their last-updated time.

## Acceptance criteria

- At a 390×844 viewport, the whole flow is usable one-handed with no horizontal scrolling.
- Keyboard-only navigation reaches every control on `/trade` and can complete a paper order.
- Every panel's failed state names its reason rather than showing blanks.
- No layout shift is visible while live prices update.

## Manual verification (owner click-path)

1. On a desktop, open `/trade` and read prices, positions and balances without scrolling away
   from the chart.
2. Resize to a phone width; the panels stack and every control is reachable.
3. Tab through `/trade` and complete a paper order without a mouse.
4. Failure case: break the price provider — each panel shows a failed state with the reason and
   the last-known time.

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

- [ ] Desktop and phone layouts both usable, verified at real viewport sizes.
- [ ] Loading, loaded and failed states on every data surface.
- [ ] Keyboard navigation completes a core task.
- [ ] No colour-only signalling and no layout shift on live updates.

## Rollback

- Revert this phase's commit; the previous layout returns with no data or behaviour change.

## Do not do

- No approval gate or confirmation step added to a control during this pass.
- Do not hide a panel that has no data; show the empty or failed state.
- Do not add a disabled control for a feature that is not built.
- Do not replace a real value with a placeholder.
