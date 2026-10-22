# Phase 32 — Public API and MCP server

Other software can now read an account, and an owner can grant an agent a narrow trade scope.
The REST surface and the MCP server call the same route handlers, so a key's scopes, rate limit
and account rule are checked once and cannot drift between the two entrances.

## What was built

### Keys, scopes and rate limits

- `ApiKey` stores a SHA-256 `keyHash` and a short `prefix`, never the key. `issueApiKey` returns
  `{ key, secret }` exactly once; the admin directory projection has no `secret` or `keyHash`
  field (`src/lib/api/manage.ts`, `keys.ts`).
- Scopes are `read`, `trade` and `agent`. `trade` and `agent` require `agentAccountId`; a key
  without one is refused at issue time. `trade` alone is not enough to read an agent account —
  the tool and route checks name the missing scope.
- A fixed-minute counter per key (`ApiRateWindow`, unique `(keyId, windowStart)`) is incremented
  by the database. Every answer carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
  `X-RateLimit-Reset`; exceeding it is `429` with `limit`, `remaining`, `resetAt` and
  `Retry-After`.
- Revocation is a row update, checked on every request and every MCP tool call, so it takes
  effect without restarting a client.

### Read surface

`GET /api/v1/account`, `/balances`, `/portfolio`, `/positions`, `/ledger`, `/orders`,
`/strategies`, `/alerts`, `/market-data`, `/agent`, `/approvals` and `POST /api/v1/orders` are
defined once in `src/lib/api/routes.ts` (12 routes). `/docs/api` is generated from those
definitions: method, path, query and body fields, scope, and an example rendered from the field
types. The only key in the generated docs is `vyl_replace_me`; a test asserts every example is a
placeholder.

### Agent account and approvals

- `AgentAccount` has its own ledger user (`ledgerUserId`); an agent key reads the owner's
  accounts but can place orders only in its own account. A request naming another account is
  `403 AGENT_ACCOUNT_SCOPE` with both ids in `detail`, audited with the key prefix.
- An order above the account's `approvalThresholdUsdCents` creates an `AgentApproval` and returns
  `202` with `status: "approval_required"`, the pending record, its threshold and its expiry.
  Nothing is sent. The owner reads approvals at `/admin/access` and decides them there; an
  expired approval is reported as `effectiveStatus: "EXPIRED"` and refuses a decision with
  `409 APPROVAL_EXPIRED`.

### MCP server

`apps/web/mcp/server.ts` is a dependency-free stdio JSON-RPC server (`initialize`, `ping`,
`tools/list`, `tools/call`). It authenticates the key from `VEYLORA_API_KEY` on every call,
applies the same rate limit, and invokes the same route handlers through `invokeApiTool`.
`tools/list` is filtered by scope: a read key sees 10 read tools; an agent key sees those plus
`get_agent_account` and `place_agent_order`. A tool outside the key's scope is absent and a call
by name is an error result with the same code REST would return. Client onboarding is on
`/docs/api` with a `mcpServers` snippet and the `pnpm mcp` command; the package script sets
`VEYLORA_PRISMA_QUIET=1` so Prisma's query log does not enter the transport.

## Live readings

Sessions were real `AuthSession` rows minted for the seeded owner with a throwaway secret. Keys
were created through `POST /api/admin/api-keys` with that session. The development SQLite
database holds the tables (`ApiKey 5`, `ApiRateWindow 19`, `AgentAccount 1`, `AgentApproval 4`
at the end of the run).

| Step | Reading |
| --- | --- |
| Missing key | `401 API_KEY_MISSING`, "Send an API key as `Authorization: Bearer <key>`. Keys are issued at /admin/access." |
| Read key reads `/api/v1/account` | `200` with `userId`, `readAt`, `balances` (`USDT 13`) and the portfolio summary/sources |
| Read key writes `/api/v1/orders` | `403 SCOPE_REQUIRED`, `requiredScope: "trade"`, `keyScopes: ["read"]` |
| Key creation | `201 { key, secret }`; `GET /api/admin/api-keys` afterwards lists `vyl_ki2pUf13 | read | owner | active` and has no secret/hash/full key anywhere in the body |
| Revoked key | `401 API_KEY_REVOKED`, "This API key was revoked at 2026-10-19T15:28:10.195Z. Issue a new key; the old one cannot be restored." |
| Rate limit, 1/minute | first call `200` with `limit: 1`, `remaining: 0`, `reset: 2026-10-19T16:19:00.000Z`; second call `429 RATE_LIMITED` with the same numbers and `Retry-After: 20` |
| Agent order above threshold | `202`, `status: "approval_required"`, `approval.notionalUsdCents: 8189`, threshold `500`, `expiresAt: 2026-10-19T16:40:46.251Z`, "Nothing was sent." |
| Owner approval | decision answered `{"status":"EXECUTED","orderId":"cmvfermaq001mn9dupluwf3f2"}`; the order is in the agent account's history |
| Expired approval | decision answered `409 APPROVAL_EXPIRED`; the list shows `effectiveStatus: "EXPIRED"` with its expiry preserved |
| Agent order naming another account | `403 AGENT_ACCOUNT_SCOPE`, `keyAgentAccountId` and `requestedAgentAccountId` in `detail` |
| MCP, read key | `initialize` → `veylora 1.0.0`, protocol `2025-06-18`; `tools/list` → 10 tools, no `place_agent_order`; calling it → `No tool named place_agent_order is available to this key.` |
| MCP, agent key | `tools/list` → 12 tools including `get_agent_account` and `place_agent_order`; `place_agent_order` 0.00001 BTC placed paper order `cmvfgm9o3000bn9ifghvkyafu` at `82` cents in account `Research agent`; a follow-up `get_orders` for that account lists it first; the other-account call was refused `AGENT_ACCOUNT_SCOPE` |
| MCP, revoked key | `tools/list` answered JSON-RPC error `-32001 API_KEY_REVOKED`; the tool call returned the same sentence as an `isError` result |
| Audit trail | the other-account refusal wrote `API_AGENT_SCOPE_REFUSED` with `keyPrefix`, `keyAgentAccountId`, `requestedAgentAccountId`, market and reason; the placement wrote `API_AGENT_ORDER_SUBMITTED` with the order's venue and notional; the approval wrote `API_AGENT_APPROVAL_REQUESTED`, and its decision `API_AGENT_APPROVAL_EXECUTED` with the order id |

`/admin/access` (development server, owner session) rendered `Public API and MCP`, the
`API & MCP DOCS` link, the agent account and the approval list; no key prefix or secret appears
in the page HTML. `/docs/api` was read from the production build: 12 routes, every example with
`vyl_replace_me`.

## Defect found and fixed

The MCP server's own header promised that nothing but JSON-RPC frames reaches stdout, but the
service layer's structured logger writes one JSON line per provider call to
`process.stdout.write`. A `get_account` call produced a fifth stdout line that was not a
response. The fix captures the frame writer before the first request is read and points every
other stdout write at stderr. Re-measured: four requests produced exactly four parseable frames
on stdout, and the provider-call line appeared on stderr.

## Gates

- `pnpm typecheck` → 0
- `pnpm test` → 0, **738/738** (11 new in `tests/public-api.test.ts`; the rest of the suite
  unaffected)
- `pnpm lint` → 0
- `pnpm build` → 0 (after the MCP fix; `/docs/api` and `/api/v1/[...path]` in the route table)
- `node scripts/validate_plan.mjs` → 0 (40 phase files, index 40, 0 warnings)

## Limits

- The migration was applied to the development SQLite database through the project's own setup
  path; PostgreSQL was not reachable from this machine, so the migration was not executed there.
- No browser screenshot was captured: the preview webview produced no frames in this
  environment, as in phases 28–31. The owner surfaces were verified as server-rendered HTML plus
  the authenticated admin API the panel calls.
- The trade path is the paper venue only. No live or testnet exchange credential exists here;
  the agent order above is a `dev-paper` order, `SUBMITTED`, not filled.
- The MCP client was a loopback stdio driver sending raw JSON-RPC frames, not a third-party MCP
  client; the frames and results are the same ones such a client would read.
- Doc examples are generated from field types, so a route whose real response differs in shape
  would still show the field list rather than a captured response. The parity test ties the
  documented set to `API_ROUTES`; it cannot prove response values.

The record contains no session value, cookie, key or secret. The full keys lived only in
`/tmp/phase32/` for the duration of the run and are not part of the repository.
