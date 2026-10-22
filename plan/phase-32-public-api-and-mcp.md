# Phase 32 — Public API and MCP server

Paste this whole file into DeepSeek Freebuff. It is self-contained. **Exposure of write scopes is an
owner decision (see `plan/PROJECT_TODO.md` §6 question 7); build the read surface first and treat
the trading scope as opt-in.**

## Objective

An API other software can use: scoped keys with rate limits, documentation that matches the code,
and an MCP server so an external agent can read the account and — only within a scope the owner
grants — trade in a dedicated account, with its approvals visible as data.

## Scope

- In: versioned REST endpoints, key issuing and scoping, rate limits, docs, the MCP server, agent-account scoping and approval records.
- Out: browser-facing internal routes (unchanged); the signal endpoint (phase 31).

## Files to touch

- `apps/web/src/app/api/v1/**` (new: account, portfolio, orders, strategies, alerts, ledger)
- `apps/web/src/lib/api/keys.ts`, `auth.ts`, `limits.ts`, `docs.ts` (new)
- `apps/web/src/app/docs/api/page.tsx` (new)
- `apps/web/mcp/server.ts` (new; MCP tools over the same service layer)
- `apps/web/prisma/schema.prisma` (`ApiKey`, `AgentAccount`, `AgentApproval`) and a migration

## Requirements

1. Keys are issued per account with named scopes — read, trade, agent — shown once at creation
   and stored hashed; revocation takes effect immediately.
2. Rate limits per key with a documented allowance, returning the limit and the reset time when
   exceeded.
3. The read surface covers account, balances, portfolio, ledger history, orders, positions,
   strategies, alerts and market data, all scoped to the key's account.
4. The trade scope is opt-in per key and, when used by an agent, trades only within a dedicated
   agent account: the agent may read the owner's accounts and trade only its own scope.
5. Approval requirements are visible data: a request that needs the owner's attention appears as
   a pending record the owner can read, with its expiry — never a silent refusal.
6. The MCP server exposes typed tools over the same service layer as REST, with per-tool scope
   checks, and the onboarding instructions for connecting a client.
7. Documentation is generated from the route definitions so the docs and the code cannot
   disagree; every example uses placeholder keys.

## Acceptance criteria

- A read-only key can read and cannot write, proven by tests.
- An agent key trades only inside its agent account; an attempt outside it is refused and logged.
- Rate limiting returns the limit and reset, proven by a test.
- No key value is retrievable after creation.

## Manual verification (owner click-path)

1. Create a read-only key, call an endpoint with it — data returns; call a write endpoint —
   refused by scope.
2. Create an agent key and connect an MCP client; list the tools and read the account.
3. Place an agent trade — it lands in the agent account and appears in its history.
4. Failure case: revoke the key, call again — 401 with a specific reason, effective immediately.

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

- [ ] Keys scoped, hashed, revocable, with tests for each scope.
- [ ] Rate limits reported, not silently dropped.
- [ ] Agent trading confined to its own account, proven by a test.
- [ ] Docs generated from the routes and free of real credentials.

## Rollback

- Revoke all issued keys, then revert this commit and drop the three tables; internal routes are
  unaffected throughout.

## Do not do

- No approval gate the owner cannot see or configure; approval state is data, never a silent
  refusal.
- Do not give an agent scope over the owner's main accounts by default.
- Do not return a key value after creation, or log one.
- Do not ship a docs page that disagrees with the implemented routes.
