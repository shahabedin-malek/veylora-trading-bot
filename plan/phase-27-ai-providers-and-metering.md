# Phase 27 — AI providers and per-request metering

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

ChainGPT, the AI gateway and Tavily behind one provider interface with health, fallback and — as
the metered-AI products do — per-request accounting the owner can read, all configured as admin
data.

## Scope

- In: the provider interface, routing and fallback, metering and cost reporting, admin settings, health.
- Out: the assistant's tools and prompts (phase 26); strategy generation (phase 28).

## Files to touch

- `apps/web/src/lib/ai/provider.ts`, `router.ts`, `meter.ts` (new)
- `apps/web/src/lib/chaingpt/features.ts`, `settings.ts`
- `apps/web/src/lib/tavily/client.ts`, `rate-limit.ts`
- `apps/web/src/app/api/admin/chaingpt/route.ts` and a new `/api/admin/models/route.ts`
- `apps/web/prisma/schema.prisma` (`AiRequestRecord`) and a migration

## Requirements

1. One interface covers text completion, embeddings-free research search and document extract;
   each provider declares its capabilities and its cost model.
2. Routing chooses a provider per task from admin settings, with an ordered fallback that is
   attempted only on a retryable failure and recorded when it happens.
3. Every request records provider, model, tokens or units, duration, outcome and the computed
   cost in the owner's chosen currency, tied to the user and the feature that caused it.
4. Usage is reportable per feature, per user and per period, with a monthly total and a config
   value for a soft budget that is surfaced, not enforced as a hidden cap.
5. Health per provider: last success, last failure, failure rate, latency — visible in the admin
   panel next to the model settings.
6. Keys come from the environment by name only and are never logged, returned or shown in the UI.
7. Provider settings are admin data with audit on change, and switching a model takes effect
   without a redeploy.

## Acceptance criteria

- A failing primary provider falls back to the secondary and the fallback is recorded.
- The costs page totals match the recorded per-request costs, proven by a test.
- Switching a model in the admin panel changes the next request's provider.
- No key value appears in a log, a response or a page.

## Manual verification (owner click-path)

1. In the admin panel, switch the model for the assistant feature; the next answer uses it.
2. Open the usage view — per-feature and per-user costs for the current period are listed.
3. Break the primary key and ask a question — the answer succeeds via the fallback and the
   fallback is visible in the usage record.
4. Failure case: with every provider key removed, the feature reports which variable is missing
   rather than failing silently.

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

- [ ] One interface, three providers, capability-declared and health-tracked.
- [ ] Every request recorded with units, outcome and cost, totalling correctly.
- [ ] Fallback in order, recorded when used.
- [ ] No key value reaches a log, a response or the screen.

## Rollback

- Revert this phase's commit and drop the request-record table; the existing ChainGPT settings
  route keeps working for its two features.

## Do not do

- No approval gate or confirmation step before a model call.
- Do not enforce a spend cap as a refusal the owner cannot change; a budget is a signal they set.
- Do not hide a provider failure behind a generic answer.
- Do not print or return a key.
