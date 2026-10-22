# Phase 27 — AI providers, routing and per-request metering

**Date:** 2026-10-19
**Scope:** one provider interface, admin-chosen routes with ordered fallback, one accounting row per
attempt, a usage view the owner can read, and keys that are names and never values. Out of scope:
the assistant's tools and prompts (phase 26) and strategy generation (phase 28).

## What was built

| File | What it holds |
| --- | --- |
| `apps/web/src/lib/ai/provider.ts` | The three providers as declarations: capabilities, the key variable's *name*, and a cost model (tokens per million, a flat price per request, or a documented zero). A provider with no configured rate reports an unpriced call, never a zero. |
| `apps/web/src/lib/ai/router.ts` | Route settings (validated as a whole, audited on change), the route plan (capability, key and switch checks produce `candidates` and `skipped` with reasons), `classifyAiFailure` (which failures are worth retrying at the next provider), a plain-text runner, the assistant's routed transport, and Tavily search/extract through the same plan and meter. |
| `apps/web/src/lib/ai/meter.ts` | One row per attempt, written after the call. The report is a pure function over rows, so the page's total is arithmetic on the recorded per-request costs. Rows carry provider, model, units, duration, outcome and cost — no prompt, answer or request body. |
| `apps/web/src/app/api/admin/models/route.ts` | `GET` providers, routes in effect and the period's report; `PUT` replaces the routing document. |
| `apps/web/src/app/api/admin/models/probe/route.ts` | One plain-text question through the `admin-probe` route, so the saved order can be proved rather than asserted. |
| `apps/web/src/app/admin/models/page.tsx` + form + probe panel | Routing editor (ordered targets per feature), provider capabilities and configured state, the route each feature will actually use, the month's spend by feature and by account, provider health, and the probe. |
| `apps/web/prisma/schema.prisma`, `migrations/20261018190000_ai_providers_and_metering/` | `AiProviderSettings` (singleton routing document; no row means the environment defaults) and `AiRequestRecord` (one row per attempt). |
| `apps/web/src/app/api/assistant/route.ts` | Reads the route on every request, answers from it, and reports the model that actually answered (including when a fallback did). Readiness reports the route and names any missing variable. |
| `apps/web/src/app/api/research/tavily/{search,extract}/route.ts` | The two research API surfaces now call `runResearchSearch` / `runResearchExtract`, so a search or extraction is metered with the account and the feature that caused it rather than only instrumented at the HTTP layer. Their existing switches and per-minute allowance still decide whether the call may run. |

## Acceptance criteria

**A failing primary falls back to the secondary, and the fallback is recorded.**
`tests/ai-providers.test.ts` drives `runAiTextTask` with a ChainGPT primary answering `500` and a
gateway secondary answering `200`: the run reports `providerId: "ai-gateway"` and
`fallbackFrom: "chaingpt:general_assistant"`; the meter holds two rows, the first `FAILED` with
`errorCode: "server"` and no cost, the second `SUCCESS` with `fallbackFrom` naming the first. A
`400` stops after one call and one row (a request rejected on its merits is rejected everywhere);
a `401` falls back, because the key belongs to *that* provider.

Live, with the gateway key deliberately broken (`AI_GATEWAY_API_KEY=broken-key-value`):

```
POST /api/admin/models/probe
{"status":"answered","providerId":"chaingpt","model":"general_assistant",
 "answer":"answer from general_assistant",
 "fallbackFrom":"ai-gateway:standin-model-a",
 "attempts":[{"providerId":"ai-gateway","outcome":"FAILED","errorCode":"auth","costMicrosUsd":null},
             {"providerId":"chaingpt","outcome":"SUCCESS","costMicrosUsd":10000}],
 "costMicrosUsd":10000}
```

and the usage report counts it: `admin-probe.requestsFallback = 1`, `admin-probe.failed = 1`,
gateway health `failures: 1, failureRate: 0.1667`.

**The costs page totals match the recorded per-request costs, proven by a test.**
`summarizeAiUsage` is pure over rows. The test inserts two priced rows through the real
`runAiTextTask` path and asserts `report.totals.costMicrosUsd` equals the row sum, that
`byFeature` and `byUser` sum to the same figure, and that `pricedRequests + unpricedRequests =
requests`. Live, the panel's month total (`0.000180 USD` at the first read) was the sum of the
rows, and a second account's request appeared as its own `byUser` row.

**Switching a model in the admin panel changes the next request's provider.**
The route is read per request (`getAiRoutingSettings` inside the handler), so the save needs no
restart. Live: `PUT /api/admin/models` set the assistant to `standin-model-b`; the readiness read
returned that target; the next `POST /api/assistant` replied `answer from standin-model-b`, and the
stand-in's own request log recorded `model: "standin-model-b"` for that call.

**No key value appears in a log, a response or a page.**
The registry exposes `keyEnv` (the variable name) and a boolean, never a value. The test serializes
`describeProviders` and the meter rows and asserts neither contains either key; live, the admin
read, the server-rendered page and the probe response were all checked against both test keys —
only variable names appeared.

## Live verification (13 checks over the real routes)

A `next dev` server on `127.0.0.1:3300` against the local SQLite development database, two real
`AuthSession` rows minted with a throwaway secret, and a local stand-in for both providers on
`3302` that answers in each provider's wire format, records the model it was asked for, and can
refuse a specific credential (`401`) or model (`500`).

| # | Check | Observed |
| --- | --- | --- |
| 1 | Readiness reports the saved route | `modelConfigured: true`, route `ai-gateway:standin-model-a`, `missingKeys: []` |
| 2 | Switch the assistant model through the admin route | saved; read-back route `ai-gateway:standin-model-b`; readiness follows |
| 3 | The next answer comes from the selected model | reply `answer from standin-model-b`; stand-in log shows the same model |
| 4 | The usage view totals the recorded costs | 1 request, 1 priced, `0.000180 USD`; feature and account rows sum to the total |
| 5 | The budget is a signal | `overBudget: true` at a 1-micro budget, and the next question still answered `200` |
| 6 | The probe reports the target and each attempt | `ai-gateway:standin-model-a`, `fallbackFrom: null`, 180 micro-dollars |
| 7 | A second account is recorded separately | `byUser`: `dev-owner-user`, `dev-test-account` (1 request) |
| 8 | The admin page renders the route, spend and health | 105,272 bytes of server HTML containing `AI models`, `standin-model-b`, `Vercel AI Gateway`, `dev-owner-user`, `Provider health`, `Budget signal` |
| 9 | No key value in a response or on a page | settings JSON, page HTML and probe JSON all free of both test keys; `AI_GATEWAY_API_KEY` still shown |
| 10 | A broken primary key falls back | probe answered by `chaingpt`, `fallbackFrom` the gateway, attempts `FAILED (auth)` then `SUCCESS` |
| 11 | The fallback is in the usage record | `admin-probe.requestsFallback = 1`; gateway health failure recorded |
| 12 | No keys at all: the ask names the variable | `503` — `Model access is not configured: set AI_GATEWAY_API_KEY.` |
| 13 | No keys at all: the probe names both | `503` — missing `AI_GATEWAY_API_KEY and CHAINGPT_API_KEY`, every target `skipped … is not set` |

The server was restarted between 9 and 10 (with a broken gateway key) and between 11 and 12 (with
no provider keys), so those readings are from a cold process, not a mutated one.

## Defects found and repaired during the work

- **A rejected credential was classified as non-retryable.** `classifyAiFailure` treated `401`/`403`
  as a request the next provider would reject the same way. That is true of a bad model id or an
  unreadable body, and false of a key: the key belongs to one provider, and the fallback exists for
  exactly this. Auth failures are now retryable; `400`/`404` still stop after one call. Covered by a
  new test and by live check 10.
- **Readiness named a single provider.** `/api/assistant` used to report one gateway variable. It now
  reports the route and the missing variable names from the plan, which is what makes check 12's
  sentence possible when no provider can serve the feature.
- **The admin page's route inventory and probe were missing from the sweep.** Three new routes and
  one page were added to `scripts/route-sweep.mjs`, and the coverage counts were updated (19 pages,
  83 methods) — the sweep is how a new route is kept from going unseen.

## Gates

```
pnpm typecheck                  → 0
pnpm test                       → 0 (660 tests, 0 failed; 12 of them this phase's)
pnpm lint                       → 0
pnpm build                      → 0 (/admin/models built; /api/admin/models and …/probe present)
node scripts/validate_plan.mjs  → 0 (40 phase files, 0 restriction hits)
```

## Limitations

- **No real provider was called.** This checkout holds no AI Gateway or ChainGPT credential, so the
  live readings use a local stand-in that speaks each provider's wire format. The cost figures are
  therefore computed from the *configured* prices against the token counts the stand-in reported —
  the arithmetic is the meter's, but the tokens are not a real provider's.
- **ChainGPT's model and endpoint** (`general_assistant`, `POST /chat/stream`) follow its published
  API documentation and are exercised only against the stand-in. A real account could differ in
  credits or rate limits; the provider declares a per-request unit, so a real change of plan is a
  price change, not a code change.
- **The panel was read as server-rendered HTML, not driven in a browser.** The form, the probe
  button and the tables were verified at the HTTP and HTML level; the hydrated interactions were not
  re-run here.
- **The migration ran on SQLite** through `db:setup`, not against Postgres. It is a plain
  create-two-tables migration with no data backfill.
- **The research routes were metered in a test, not live.** Both were switched off for the run, so
  the rows they write are asserted against a stubbed Tavily fetch rather than observed in the live
  usage report.
- **The budget is deliberately not enforced.** Nothing in the request path reads it; the panel shows
  the month's cost against it. That is the phase's decision, not an omission.

## Cleanup

The dev database was returned to its prior shape: the two minted sessions, the seven request rows,
the routing row, its audit row and the assistant usage windows from this run were deleted. The
stand-in, the mint script and the check drivers live in `/tmp/phase27/`, outside the repository; the
temporary script that minted sessions inside `apps/web` was removed. This record contains no session
value, cookie, key or credential.
