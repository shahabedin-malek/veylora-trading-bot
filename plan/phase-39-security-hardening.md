# Phase 39 — Security hardening

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

The platform's own security reviewed and tightened: authentication, the money paths, key
handling, dependencies and headers — plus a purge of any secret that ever reached the
repository, with the owner's involvement.

## Scope

- In: a security review of the implemented surfaces, fixes for what it finds, key rotation across every integration, secret history purge with the owner, dependency and header work.
- Out: legal text (phase 40); feature changes.

## Files to touch

- `apps/web/src/lib/auth/*`, `src/lib/trading/credential-vault.ts`, `src/lib/withdrawals/*`, `src/lib/api/keys.ts`
- `apps/web/next.config.ts` (security headers)
- `apps/web/package.json` (dependency updates; lockfile kept consistent)
- `.gitignore` and this phase's report in `plan/PROJECT_TODO.md`

## Requirements

1. Review and fix, with a written finding per item: session fixation and rotation, cookie flags,
   CSRF on state-changing routes, origin checks, authorisation on every route, injection and
   parameter handling, SSRF on provider URLs, and rate limiting on auth and money endpoints.
2. Money paths: assert that only the ledger writes balances, that reservations cannot be
   double-spent under concurrency, and that an idempotency key is required on every money
   mutation — with tests for each.
3. Key handling: confirm every credential is encrypted at rest, inaccessible to the client, and
   never present in a log; rotate every key the platform has used, and record the rotation dates
   without recording the values.
4. Secret history: list every file that ever contained a secret value, and purge with the owner's
   explicit instruction recorded in `plan/PROJECT_TODO.md`. Do not rewrite history without it.
5. Dependencies: audit the tree, update what is vulnerable, and record anything that cannot be
   updated with the reason.
6. Headers and policy: content security policy, HSTS, frame options, referrer policy,
   permissions policy, and a cookie policy consistent with what the code actually sets.
7. Every fix states the risk it addressed and how it was verified — a fixed issue without a
   reproduction is not a fix.

## Acceptance criteria

- Each reviewed surface has a written finding: clean, fixed with evidence, or accepted with a
  stated reason.
- Money-path assertions are covered by tests, including a concurrency case.
- A rotation table exists listing every credential, its provider and its rotation date — values
  absent.
- The secret purge is either done with the owner's recorded instruction or listed as pending.

## Manual verification (owner click-path)

1. Read the review report and confirm every finding is either fixed with evidence or explicitly
   accepted.
2. Attempt a cross-origin state-changing request — refused, with the reason.
3. Attempt a money mutation without an idempotency key — refused, with the specific error.
4. Failure case: replay a session cookie after sign-out — rejected, and the audit trail shows it.

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

- [ ] Every reviewed surface documented with findings and evidence.
- [ ] Money-path invariants covered by tests including concurrency.
- [ ] All keys rotated with dates recorded and no values written down.
- [ ] History purge done under the owner's instruction, or listed as pending.

## Rollback

- Revert this phase's commit for code changes. Rotation is not reversible by reverting code — the
  previous keys are disabled at the provider, and the report says which integration to update if a
  rollback is needed.

## Do not do

- No approval gate or consent step added to a user-facing action as a "security fix".
- Do not print, paste or commit a secret value, including in the report.
- Do not rewrite git history without the owner's explicit instruction.
- Do not leave a finding as "reviewed" with no evidence or stated acceptance.
