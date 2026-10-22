# Phase 02 — Development mode: local data, seeding, one-command reset

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

Make `NODE_ENV=development` the most capable mode the app has: a fresh clone reaches a
running, seeded app in three commands, every page renders real values from a local database,
and one command returns the database to a known-good state. This is the mode every later
phase is verified in.

## Scope

- In: `db:setup`, `db:reset` and `db:seed` scripts; a deterministic seed; a dev-only banner
naming the database in use; unmasked values in development; the README three-command path.

- Out: production migrations; any change to the production database; new product features.

## Files to touch

- `apps/web/package.json` (scripts: `db:setup`, `db:reset`, `db:seed`)
- `apps/web/prisma/seed.ts`
- `apps/web/scripts/with-neon-env.mjs` (pattern reference; the new scripts must only target the local database)
- `apps/web/src/app/layout.tsx` and a new `apps/web/src/components/dev-database-banner.tsx`
- `apps/web/src/lib/db.ts` (resolution order for the local target)
- `apps/web/.env.example` (names only, including `NEXT_PUBLIC_REOWN_PROJECT_ID`)
- `apps/web/README.md`

## Requirements

1. `db:setup` creates the local database at `apps/web/prisma/dev.db`, applies migrations and
   runs the seed. `db:reset` drops it, recreates it and reseeds. `db:seed` is idempotent: a
   second run leaves the same state, not a duplicate of it.
2. Neither script may ever resolve to a remote database: assert the resolved `DATABASE_URL`
   is a local file connection and exit non-zero with a clear message otherwise.
3. The seed inserts, at minimum: the owner account already at OWNER role keyed from
   `INITIAL_ADMIN_EVM_ADDRESS`; one funded test account with a visible balance and at least
   three transactions; strategies in every lifecycle state the product has (draft, paper,
   stopped); a risk-policy row matching the admin defaults; two integration-settings rows; a
   handful of market-alert rows with events; and a set of audit events.
4. Every seeded value is obviously local: `dev-`/`test-` labels in names and emails, fake
   balances, no copied production rows, no real keys of any kind.
5. The dev-only banner renders in development and names the database in use. It must not
   render in production, and it must not print any secret value or connection string.
6. Development shows received values unmasked: balances, positions, trade history, provider
   responses, API-key labels and last four characters, and raw error text. A value that could
   not be fetched states exactly that and which variable or provider was missing.
7. Two architectural facts stay as they are and are documented in the README: server secrets
   never cross into the browser bundle (no secret gains a `NEXT_PUBLIC_` prefix), and the
   audit log keeps storing its redacted payloads.
8. `apps/web/.env.example` lists, by name only, every variable the development app reads,
   with a local fallback where one exists — including `NEXT_PUBLIC_REOWN_PROJECT_ID`, which
   `src/app/login/page.tsx` and `src/components/wallet-connection-provider.tsx` read today
   but the example file does not list.
9. `apps/web/README.md` documents install → `db:setup` → `dev` and states that `db:reset` is
   the way back to a known-good state.

## Acceptance criteria

- From a clean checkout: install, `db:setup`, `dev` — and the app renders at
  `http://localhost:3000` against the seeded local database.
- `db:reset` twice in a row returns identical seeded state, confirmed by comparing two
  counts of the seeded tables.
- Pointing `DATABASE_URL` at a remote host makes both scripts refuse and exit non-zero.
- The dev banner appears in development and is absent from a production build.
- No page shows `••••` masking of the owner's own data in development.

## Manual verification (owner click-path)

1. Delete `apps/web/prisma/dev.db`, then run `db:setup` and `dev`.
2. Open `http://localhost:3000` — the banner names the local database and balances are
   visible as real numbers.
3. Open `/admin/risk` — the seeded policy row is present and editable.
4. Run `db:reset`, reload — the same seeded values return, with no duplicates.
5. Failure case: set a remote `DATABASE_URL` and run `db:setup` — it exits non-zero with a
   message saying the target is not local, and nothing is written.

## Automated verification

```bash
cd apps/web
pnpm --config.verify-deps-before-run=false typecheck; echo "typecheck=$?"
pnpm --config.verify-deps-before-run=false test;      echo "test=$?"
pnpm --config.verify-deps-before-run=false lint;      echo "lint=$?"
pnpm --config.verify-deps-before-run=false build;     echo "build=$?"
pnpm --config.verify-deps-before-run=false db:setup && pnpm --config.verify-deps-before-run=false db:reset
cd ../.. && node scripts/validate_plan.mjs; echo "plan=$?"
```

Add a test that asserts the seed is idempotent and that a remote target is rejected.

## Definition of done

- [ ] Three commands from a clean checkout reach a rendering, seeded app.
- [ ] Seed is deterministic and idempotent; both are asserted by a test.
- [ ] Remote-database targets are refused by both scripts, asserted by a test.
- [ ] `.env.example` lists every variable name the development app reads, values absent.
- [ ] Dev banner present in development, absent in production, and secret-free.

## Rollback

- Delete `apps/web/prisma/seed.ts` and the three scripts; the app still runs with the
  pre-existing `dev` script. `prisma/dev.db` is local and disposable.

## Do not do

- No approval gate, permission gate, consent step or confirmation step anywhere in these
  scripts or the UI.
- Do not make `db:reset` sit behind a warning stop or ask the owner to confirm anything.
- Do not commit a real balance, a real key, or a copy of production rows into the seed.
- Do not hide an unfinished area behind a disabled control, a "coming soon" label or a
  hidden route — label it honestly or leave it out of the UI entirely.
- Do not require a `NEXT_PUBLIC_` prefix on anything that is secret.
