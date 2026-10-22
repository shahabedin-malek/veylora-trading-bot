# Phase 04 — Observability and error surfacing

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

Every run can answer "what happened, what did it call, and why did nothing happen" without
reading a console: structured server logs with request ids, one record per outbound provider
call, failures surfaced to the owner in the admin panel, and a visible reason whenever a
process idles.

## Scope

- In: logging, request ids, provider call records, an admin-visible error and health surface,
the shared "why did nothing happen" reason type.

- Out: external monitoring vendors; alerting channels (phase 29 owns delivery).

## Files to touch

- `apps/web/src/lib/observability/logger.ts` (new)
- `apps/web/src/lib/observability/provider-call.ts` (new)
- `apps/web/src/lib/market-data/provider.ts`, `coinbase-service.ts`, `cointelegraph-service.ts`
- `apps/web/src/lib/tavily/client.ts`, `chaingpt/*`, `wundertrading/client.ts`, `rpc/rpc-proxy.ts`
- `apps/web/src/lib/db.ts` (keep the dev-only Prisma caching and logging)
- `apps/web/prisma/schema.prisma` (a `ProviderCallRecord` model) and a migration
- `apps/web/src/app/admin/data/page.tsx` plus `/api/admin/*` for the health surface

## Requirements

1. One structured logger emitting JSON with level, timestamp, request id, route, and a
   redaction pass over anything matching a key-like pattern. Secrets never reach a log line.
2. A request id generated per request and echoed in the response header, so a user report can
   be traced to server lines.
3. One record per outbound provider call: provider, method, URL with the key redacted, status,
   duration, and the number of attempts. Persisted so the admin surface can read it later.
4. Prisma query logging stays on in development and off in production; the dev-only client
   caching in `src/lib/db.ts` is preserved.
5. Failures surface in the admin panel: recent errors with route, code, provider and a safe
   message, plus provider health (last success, last failure, failure count) per integration.
6. A shared reason type — for example insufficient balance, invalid key, no entry condition,
   venue unavailable, provider rate-limited — that every runner, order and alert path returns,
   so the UI always has something specific to show.
7. Health endpoints or an admin view that state whether the database, the runner and each
   provider are reachable right now.
8. Development shows raw error text, including stack and provider body, and identifies the
   missing variable by name when configuration is the cause.

## Acceptance criteria

- A forced provider failure appears in the admin error list within one refresh, with the
  provider named and the key redacted.
- Every log line for a request carries the same request id as the response header.
- No log line, API response, or admin view contains a secret value.
- The reason type is used by at least the alert evaluation path and one market-data path.

## Manual verification (owner click-path)

1. Open `/admin/data` — provider health rows are visible with last success and last failure.
2. Break one provider key in `.env.local`, trigger the action that uses it, reload — the error
   appears with the variable name, and the rest of the app still works.
3. Copy the request id from a failed response header and find the matching server lines.
4. Failure case: with the database stopped, the health view reports the database as
   unreachable instead of showing an empty list.

## Automated verification

```bash
cd apps/web
pnpm --config.verify-deps-before-run=false typecheck; echo "typecheck=$?"
pnpm --config.verify-deps-before-run=false test;      echo "test=$?"
pnpm --config.verify-deps-before-run=false lint;      echo "lint=$?"
pnpm --config.verify-deps-before-run=false build;     echo "build=$?"
cd ../.. && node scripts/validate_plan.mjs; echo "plan=$?"
```

Add tests for the redaction pass and for the reason type's serialisation.

## Definition of done

- [ ] Structured logs with request ids, verified against a real failing request.
- [ ] Provider call records persisted and readable in the admin surface.
- [ ] Every failure has a specific reason, never a bare "something went wrong".
- [ ] A redaction test proves no key-like value survives into a log line or response.

## Rollback

- Revert this phase's commit; the logger and records are additive. Drop the
  `ProviderCallRecord` table with the migration's down path if the owner asks.

## Do not do

- No approval gate, permission gate or confirmation step in any admin action.
- Do not make an error view hide the cause behind a generic sentence.
- Do not mask the owner's own data in development.
- Do not send, sell or ship logs to a third-party monitoring service without an owner decision.
