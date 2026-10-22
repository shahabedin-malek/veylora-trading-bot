# Phase 40 — Public pages, deployment parity and launch

Paste this whole file into DeepSeek Freebuff. It is self-contained. **Legal wording and the decision
to publish are the owner's; write with them, and publish only when they say so.**

## Objective

The product is presentable and deployable: public landing, pricing, docs and status pages, terms,
cookie policy, risk disclosures and FAQs written with the owner, environment parity across
Development, Preview and Production, and a runbook the owner can follow at 3am.

## Scope

- In: public pages, legal and support content written with the owner, environment and network parity, deploy procedure, monitoring and the owner runbook.
- Out: new product features; security fixes (phase 39).

## Files to touch

- `apps/web/src/app/(public)/page.tsx`, `pricing/page.tsx`, `docs/page.tsx`, `status/page.tsx`, `terms/page.tsx`, `privacy/page.tsx`, `risk/page.tsx`, `faq/page.tsx` (new)
- `apps/web/src/app/layout.tsx` (metadata per page)
- `.github/workflows/ci.yml` (deployment checks)
- `apps/web/README.md`, `plan/PROJECT_TODO.md` (runbook and parity record)

## Requirements

1. Public pages render from the real product state: the pricing page reads the same fee table the
   code charges, the status page reports live health, and the docs page links the API documentation
   from phase 32.
2. Terms, cookie policy, privacy, risk disclosure and FAQs are written with the owner and state
   plainly what the platform is not — not a broker, exchange or adviser — and that the owner holds
   their own keys, mirroring the trust copy conventions of every researched venue.
3. No marketing claim appears anywhere that the code cannot substantiate: no return figure, no
   uptime guarantee, no "insured" or "segregated" wording unless the owner has the documentation
   behind it.
4. Environment parity: every variable and every `ALCHEMY_*` network present in Production is
   present in Development and Preview, or its absence is named as a known difference, using the
   coverage report from phase 17.
5. Deployment procedure: build and migrate in the correct order, with the migrate step's result
   inspected; a failed migration stops the deploy rather than serving a broken app.
6. A status page reflects the phase-04 health data plus runner heartbeats, so an outage is visible
   before a user reports it.
7. An owner runbook covering: how to restart the runner, how to pause trading during an incident,
   how to check the audit chain, how to rotate a key, how to restore the database from backup, and
   who to contact for each provider.
8. Launch checklist: the four gates green, the E2E suite green, the plan validator clean, the
   secret audit clear, backups verified by an actual restore, and the owner's explicit go-ahead.

## Acceptance criteria

- Pricing, status and docs pages render from real state and cannot drift from the code.
- Every public page states what the platform is not, in the owner's wording.
- The parity report names every difference between the three environments.
- The runbook has been followed once end to end, and the restore step actually restored a database.

## Manual verification (owner click-path)

1. Open each public page on a preview deployment and confirm the numbers match the admin panel.
2. Follow the runbook's restart-runner step and confirm trading resumes.
3. Follow the restore step into a scratch database and confirm the data returns.
4. Failure case: deploy with a deliberately failing migration — the deploy stops and the previous
   version keeps serving.

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

- [ ] Public pages render from real state, with a test asserting pricing matches the fee table.
- [ ] Legal and risk text signed off by the owner.
- [ ] Parity across the three environments documented, differences named.
- [ ] The runbook executed once, including a verified restore.

## Rollback

- Unpublish or revert to the previous deployment (the platform keeps the previous version
  available); the public pages are additive and removing them leaves the app working.

## Do not do

- No approval gate or consent step added to a user action as part of launch work.
- Do not publish a claim the code cannot back.
- Do not publish without the owner's explicit go-ahead.
- Do not leave a public page showing a placeholder price, a fake uptime figure or a sample health
  value.
