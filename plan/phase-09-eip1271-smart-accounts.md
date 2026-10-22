# Phase 09 — Contract wallets and smart accounts (EIP-1271)

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

A smart account or contract wallet signs in and acts: EIP-1271 signature verification on the
server, the same session model as an EOA, and the groundwork for session keys recorded for the
on-chain automation path.

## Scope

- In: EIP-1271 verification, smart-account sign-in, delegation accounts, session-key note.

- Out: on-chain strategy execution itself (phase 21 onward).

## Files to touch

- `apps/web/src/lib/auth/siwe.ts`, `evm-wallet-sign-in.ts`, `session-store.ts`
- `apps/web/src/app/api/auth/verify/route.ts`
- `apps/web/prisma/schema.prisma` (`WalletIdentity` account-type column) and a migration
- `apps/web/tests/auth.test.ts`

## Requirements

1. Verification detects the account type: EOA by `ecrecover`, contract wallet by EIP-1271
   `isValidSignature`, with a bounded RPC timeout before falling back to rejection.
2. Both account types produce the same session shape; permissions and roles are unchanged by
   account type.
3. The chain id used for verification is bound into the signed message, and a mismatch is
   rejected with a specific reason.
4. A contract-wallet call that cannot be completed (RPC down, no bytecode) is a distinct,
   retryable error — never an accepted signature.
5. `WalletIdentity` records the account type so admin views can show it.
6. Session keys are recorded as the future path for on-chain execution and are not implemented
   in this phase.

## Acceptance criteria

- A test contract wallet (or a mocked EIP-1271 responder) signs in and receives a session.
- An invalid contract signature, an RPC failure and a chain mismatch are each rejected with
  their own message.
- An EOA sign-in behaves exactly as before.

## Manual verification (owner click-path)

1. Sign in with a smart-account wallet; confirm the admin view shows the account type.
2. Tamper with the signature payload and attempt sign-in — rejected with a clear reason.
3. Point the RPC at an unreachable host and sign in — a retryable network error, no session.
4. Failure case: sign with a different chain selected — rejected, and the page explains why.

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

- [ ] EIP-1271 verification implemented with timeout and explicit failure modes.
- [ ] Account type persisted and visible in the admin view.
- [ ] Chain binding asserted by a test.
- [ ] Session keys recorded as a follow-up with the phase that will use them.

## Rollback

- Revert this phase's commit and drop the account-type column; contract-wallet sign-in stops
  and EOA sign-in is unaffected.

## Do not do

- No approval gate, consent step or extra confirmation for smart accounts.
- Do not accept a signature whose verification call could not be completed.
- Do not disable the control for an unsupported wallet; say what is unsupported and why.
- Do not add a second session mechanism just for contract wallets.
