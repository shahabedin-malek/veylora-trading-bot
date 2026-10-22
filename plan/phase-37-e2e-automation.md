# Phase 37 — End-to-end browser automation

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

The canonical journey is automated in a real browser — sign in, deposit, start smart AI trading,
confirm it keeps running while the browser is closed, then withdraw — so a regression is caught
before the owner finds it.

## Scope

- In: Playwright installation and configuration, specs for the canonical journey and key failure paths, fixtures, traces and screenshots, CI wiring.
- Out: load testing (phase 38); unit tests owned by earlier phases.

## Files to touch

- `apps/web/package.json` (`e2e` script, devDependency; keep the pnpm lockfile consistent)
- `apps/web/playwright.config.ts` (new), `apps/web/e2e/*.spec.ts` (new)
- `apps/web/e2e/fixtures/*` (seeded identities and a mock venue/testnet configuration)
- `.github/workflows/ci.yml` (run the suite after the existing gates)

## Requirements

1. Playwright installs with the project's package manager and runs against a locally started dev
   server with a seeded database, using the phase-02 scripts.
2. A spec covers: wallet sign-in (with a test wallet strategy), deposit credited from a mock
   chain event, balances and history visible, one visible start control pressed, runner
   continuation while the browser context is closed, and a withdrawal confirmed.
3. Failure specs: a rejected signature, a failed deposit (unmatched token), an order refused by a
   risk limit, and a withdrawal failure — each asserting the specific message a human would see.
4. Wallet interaction uses a deterministic test signer rather than a real extension, and the
   suite never touches a real network or a real key.
5. On failure the runner saves a trace, a screenshot and the console log, and the test name states
   the journey step so a failure is self-explanatory.
6. The suite is deterministic: no fixed sleeps, waits on observable state, and a rerun of a
   failing test reproduces it.
7. CI runs the suite after typecheck, test and build, with the exit status inspected.

## Acceptance criteria

- `pnpm e2e` passes locally on a seeded database from a clean state.
- Closing the browser context after starting trading does not stop the runner — asserted inside
  the spec.
- A deliberately broken selector makes the suite fail with a trace attached.
- CI runs the suite and reports its real status.

## Manual verification (owner click-path)

1. Run `db:setup` then `pnpm e2e`; the suite passes and prints the journey steps.
2. Open the most recent trace after a forced failure and read the screenshots.
3. Confirm the suite restores the database to the seeded state when it finishes.
4. Failure case: run it with the dev server already stopped — the suite reports the precondition
   failure rather than hanging.

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

- [x] The canonical journey runs end to end in a browser, including browser-closed continuation.
- [x] Four failure paths assert their specific messages.
- [x] Traces and screenshots are produced on failure.
- [x] CI runs the suite and surfaces its exit status.

## Rollback

- Revert this phase's commit; the previous gates remain and the E2E suite and CI step disappear.

## Do not do

- No approval gate or confirmation step introduced into a spec's journey.
- Do not use a real key, a real network or a real order in a spec.
- Do not paper over flakiness with fixed sleeps or retries that hide a real failure.
- Do not let the suite leave the database in a mutated state for the next run.
