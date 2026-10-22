# Phase 07 — Injected browser wallets

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

Every mainstream injected browser wallet signs in reliably: MetaMask, Rabby, Coinbase Wallet
and any EIP-1193 provider, with chain detection, chain switching and mismatch handling, and a
session that survives a reload.

## Scope

- In: injected providers, RainbowKit/wagmi configuration, chain detection and switching,
sign-in error states, session continuity.

- Out: mobile pairing (phase 08); contract wallets and EIP-1271 (phase 09); 2FA (phase 10).

## Files to touch

- `apps/web/src/lib/auth/evm-wallet-sign-in.ts`, `siwe.ts`, `chain-labels.ts`, `config.ts`
- `apps/web/src/components/wallet-connection-provider.tsx`
- `apps/web/src/app/login/login-form.tsx`, `apps/web/src/app/login/page.tsx`
- `apps/web/src/app/api/auth/nonce/route.ts`, `verify/route.ts`, `session/route.ts`
- `apps/web/package.json` (RainbowKit/wagmi/viem are already present; keep the lockfile intact)

## Requirements

1. The wallet list is discovered from the injected providers actually present, plus the
   configured connectors; a missing provider is reported, never a dead button.
2. Sign-in is SIWE: fetch a nonce, sign, verify server-side, create a session. An expired or
   reused nonce is rejected with a specific reason.
3. The connected chain is detected before signing; if it is not an `AUTH_EVM_CHAIN_IDS` chain,
   the UI offers to switch, and the switch result is verified rather than assumed.
4. A rejected signature, a user-cancelled prompt, an unsupported chain and a provider that
   disappears mid-flow each produce a distinct, human-readable message and leave the user able
   to retry without reloading.
5. Wallet address normalisation is consistent everywhere (checksummed display, lowercased
   lookup) so one wallet never becomes two accounts.
6. Session continuity: a reload keeps the signed-in state until expiry; signing out clears it
   on the server as well as the client.
7. Sign-in with the seeded owner address reaches every `/admin/*` page in development.

## Acceptance criteria

- MetaMask, Rabby and Coinbase Wallet each complete sign-in, verified in development.
- A wrong-network attempt triggers a switch offer, and after switching the sign-in completes.
- A cancelled signature shows a retryable message and creates no session.
- A reload keeps the session; sign-out removes it server-side.

## Manual verification (owner click-path)

1. On `/login`, connect each available wallet and confirm the address shown is checksummed.
2. Switch to a network outside `AUTH_EVM_CHAIN_IDS` and sign in; accept the switch offer and
   complete sign-in.
3. Reload `/trade` — still signed in. Press sign out — returned to `/login`.
4. Failure case: reject the signature request — the page reports the rejection and offers to
   try again; no session exists afterwards.

## Automated verification

```bash
cd apps/web
pnpm --config.verify-deps-before-run=false typecheck; echo "typecheck=$?"
pnpm --config.verify-deps-before-run=false test;      echo "test=$?"
pnpm --config.verify-deps-before-run=false lint;      echo "lint=$?"
pnpm --config.verify-deps-before-run=false build;     echo "build=$?"
cd ../.. && node scripts/validate_plan.mjs; echo "plan=$?"
```

Extend `tests/auth.test.ts` and the auth route tests for the new error cases.

## Definition of done

- [ ] Three injected wallets complete sign-in in development.
- [ ] Nonce reuse, expiry and wrong-chain paths each have their own tested outcome.
- [ ] Address normalisation is single-sourced, with a test for both display and lookup.
- [ ] Sign-out invalidates the server session, proven by a test.

## Rollback

- Revert this phase's commit; the existing SIWE path from `src/lib/auth/siwe.ts` remains and
  sign-in continues to work with the previously supported wallet.

## Do not do

- No approval gate or extra confirmation step beyond the wallet's own signature.
- Do not add a second wallet whose button is dead or hidden when detection fails — report the
  detection failure instead.
- Do not trust a client-reported chain or address for authorisation decisions.
- Do not store a session token anywhere the browser can read it as a long-lived credential.
