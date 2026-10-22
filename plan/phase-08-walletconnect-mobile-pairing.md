# Phase 08 — WalletConnect and mobile wallet pairing

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

A phone wallet signs in: WalletConnect/Reown pairing with QR, deep link and return-to-app,
with pairing state and failures a human can act on.

## Scope

- In: Reown/WalletConnect connector, QR, deep links, pairing state and error copy.

- Out: injected wallets (phase 07); contract wallets (phase 09); session policy (phase 10).

## Files to touch

- `apps/web/src/components/wallet-connection-provider.tsx`
- `apps/web/src/app/login/login-form.tsx`, `login/page.tsx`
- `apps/web/src/lib/auth/config.ts` (origin and callback validation)
- `apps/web/src/lib/integrations/readiness.ts` (`NEXT_PUBLIC_REOWN_PROJECT_ID` / `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`)
- `apps/web/.env.example`, `apps/web/README.md`

## Requirements

1. The protocol project id is read from `NEXT_PUBLIC_REOWN_PROJECT_ID` with
   `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` as fallback; when neither is set, `/login` states the
   variable name instead of showing a broken QR.
2. QR, deep link and copy-link all start the same pairing, and the page shows pairing progress
   (waiting, paired, signing, signed, failed).
3. Returning from the wallet app on mobile resumes the session without a manual reload.
4. Expiry, rejection and network mismatch each produce a distinct message with a retry.
5. The same SIWE nonce and verification path as phase 07 is used — no second auth mechanism.
6. No project id, pairing secret or session token is logged or rendered in page source beyond
   the public project id.

## Acceptance criteria

- A phone wallet pairs by QR and completes sign-in, verified by the owner on a real device.
- With the project id unset, `/login` names the variable and the rest of sign-in still works.
- A cancelled pairing offers a retry without a reload.

## Manual verification (owner click-path)

1. Open `/login` on the desktop and scan the QR with a mobile wallet; approve.
2. Confirm the desktop page advances to signed-in and shows the phone's address.
3. Repeat through a deep link on the phone; the app returns to the site signed in.
4. Failure case: decline in the wallet — the page says pairing was declined and offers retry.

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

- [ ] QR, deep link and copy-link reach the same pairing flow.
- [ ] Pairing states are visible and each failure is retryable in place.
- [ ] The missing-project-id case names the variable and breaks nothing else.
- [ ] Sign-in reuses the phase 07 verification path, proven by shared tests.

## Rollback

- Revert this phase's commit; injected wallets and the existing SIWE path keep working.

## Do not do

- No confirmation step of our own between pairing and signing.
- Do not hide the desktop QR behind a disabled control when the project id is missing; show
  the missing configuration instead.
- Do not log pairing secrets or session tokens.
- Do not fork the authentication path for mobile.
