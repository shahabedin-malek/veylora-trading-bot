# Phase 26 — Assistant with real tools

## Objective

The assistant answers questions about the owner's own account and the market using real data
through tools — balances, positions, ledger history, market candles, indicators, alerts and
research — and every answer shows which data it used.

## Scope

- In: tool definitions, tool-call loop, citations of used data, streaming, error and rate-limit handling, the assistant UI.
- Out: provider routing and metering (phase 27); strategy generation (phase 28).

## Files to touch

- `apps/web/src/lib/assistant/tools.ts`, `loop.ts`, `citations.ts`, `limits.ts` (new)
- `apps/web/src/lib/assistant/public-market-adapter.ts`, `public-market-adapter.test.ts`
- `apps/web/src/app/api/assistant/route.ts`, `route.test.ts`
- `apps/web/src/components/market-assistant.tsx`, `src/app/assistant/page.tsx`
- `apps/web/prisma/schema.prisma` (`AssistantUsageWindow`) and a migration

## Requirements

1. Tools are typed and scoped: portfolio read, ledger history read, market candles and
   indicators read, alerts read, research search and extract, and a paper-trade action that is
   clearly labelled as paper.
2. Every tool call is executed server-side with the signed-in user's identity, so the assistant
   can only read data that user may read, and never another account's data.
3. Answers cite the tools and the freshness of the data they used; when a tool fails, the answer
   says which data is missing instead of guessing.
4. Streaming responses render progressively; a provider error mid-stream is reported in the
   transcript rather than leaving a half sentence.
5. No secret, key or credential ever enters a prompt, a tool result or a stored transcript.
6. Rate limits and cost per request are visible in the transcript and enforced per user.
7. The assistant never claims a number the tools did not return, and a test asserts that a
   question about a balance produces either real tool data or an explicit "could not read".

## Acceptance criteria

- A question about the owner's balance returns the ledger's real balance with its as-of time.
- A question about another account's data is impossible: the tool layer is scoped to the caller,
  proven by a test.
- With a tool failing, the answer names the missing data rather than inventing a value.
- Transcripts contain no credential material.

## Manual verification (owner click-path)

1. On `/assistant`, ask for the current balance and positions; the answer matches `/account` and
   cites the data and time.
2. Ask for a market indicator; the same value appears as on `/markets`.
3. Ask something requiring a dead provider; the answer says which data is missing.
4. Failure case: exceed the rate limit — a specific message with the limit and a reset time.

## Automated verification

```bash
cd apps/web
pnpm --config.verify-deps-before-run=false typecheck; echo "typecheck=$?"
pnpm --config.verify-deps-before-run=false test;      echo "test=$?"
pnpm --config.verify-deps-before-run=false lint;      echo "lint=$?"
pnpm --config.verify-deps-before-run=false build;     echo "build=$?"
cd ../.. && node scripts/validate_plan.mjs; echo "plan=$?"
```

Extend `tests/assistant-tools.test.ts`, `tests/assistant-limits.test.ts`,
`src/lib/assistant/public-market-adapter.test.ts` and the assistant route test.

## Definition of done

- [ ] Tools are scoped to the caller, asserted by a test.
- [ ] Answers cite their data and its freshness.
- [ ] Tool failures are stated, never filled in with an invented value.
- [ ] Transcripts carry no credential material, asserted by a redaction test.

## Rollback

- Revert this phase's commit; the previous assistant panel behaviour returns without tools.

## Do not do

- No approval gate or confirmation dialogue before a read-only tool runs.
- Do not let the model authorise an action; permissions are enforced in code.
- Do not present an estimate as a reading.
- Do not store a secret in a transcript or send one to a provider.
