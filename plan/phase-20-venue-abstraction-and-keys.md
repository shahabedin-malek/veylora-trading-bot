# Phase 20 — Venue abstraction and key handling

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

One venue interface the trading paths can rely on — exchange APIs through a CCXT-style adapter
and the existing WunderTrading client — with keys stored encrypted, requested read-only first,
revocable per key, and a plain statement that the venue holds the funds.

## Scope

- In: the venue interface, adapters, key storage and scoping, balance and position reads,
credential UI, connection health.

- Out: placing a real order (phase 21 on testnet, phase 22 live).

## Files to touch

- `apps/web/src/lib/venues/types.ts`, `registry.ts`, `ccxt-adapter.ts`, `wundertrading-adapter.ts` (new)
- `apps/web/src/lib/trading/credential-vault.ts`, `exchange-balances.ts`
- `apps/web/src/app/api/trading/credentials/route.ts`, `[credentialId]/verify/route.ts`
- `apps/web/src/components/trading-accounts.tsx`, `src/app/admin/access/integration-settings-form.tsx`
- Existing `TradingVenueCredential` model plus a migration for scope and last-check columns

## Requirements

1. A venue implements one interface: capability list, account balances, positions, orders,
   order status, cancel, and health — so a caller never branches on the venue's name.
2. Credentials are stored encrypted with the existing vault pattern; the plaintext never leaves
   the server and is never logged or returned by an API.
3. Each credential records which permissions were requested and which the venue reports as
   granted; withdrawal permission is refused on save with a specific message.
4. A read-only credential works for reads and is refused for any write with a named reason.
5. Verification performs a real read against the venue and records last-check time, latency and
   the error when it fails; the UI shows that result per credential.
6. The UI states plainly that funds sit at the venue and the platform cannot withdraw them, and
   shows which capabilities each connection has.
7. A revoked or deleted credential stops being used everywhere on the next request.

## Acceptance criteria

- Two credentials, one read-only and one trade-scoped, behave differently on a write attempt,
  proven by tests.
- A credential with withdrawal permission is refused on save with the reason shown.
- A failing venue verification records the error and marks the connection unhealthy.
- Deleting a credential ends its use immediately.

## Manual verification (owner click-path)

1. In the admin integration settings, add a read-only key and confirm the capability list shown
   matches what verification found.
2. Attempt a write action with the read-only key — a specific rejection naming the missing
   permission, and no order is created.
3. Add a key carrying withdrawal permission — refused on save with the reason.
4. Failure case: enter a wrong key — verification fails and the credential shows the venue's
   error, with nothing else broken.

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

- [ ] One interface implemented by both adapters, with tests per capability.
- [ ] Read-only credentials cannot write, proven by a test.
- [ ] Withdrawal permission is refused on save.
- [ ] Key plaintext never appears in a log, response, or the browser bundle.

## Rollback

- Revert this phase's commit; the existing credential route and WunderTrading client remain
  usable without the new interface.

## Do not do

- No approval gate or confirmation step before a connection is used.
- Do not request or store withdrawal permission.
- Do not store a credential in plain text or return it to the client.
- Do not hide an unverified connection; show its verification result.
