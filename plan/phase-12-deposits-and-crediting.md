# Phase 12 — Deposits and crediting

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

A human deposits about 20 USDT and watches it credited: a per-user deposit address on each
supported network, crediting that follows the owner's confirmation policy, and reconciliation
for late, partial and unmatched arrivals — every step audited.

## Scope

- In: deposit addresses, detection, crediting, reconciliation, the deposit UI, audit events.

- Out: ledger internals (phase 13); withdrawals (phase 14); fees (phase 16).

## Files to touch

- `apps/web/src/lib/deposits/addresses.ts`, `watcher.ts`, `credit.ts` (new)
- `apps/web/src/lib/rpc/networks.ts`, `rpc-proxy.ts` (reuse for chain reads)
- `apps/web/src/app/api/deposits/route.ts`, `src/app/api/deposits/[address]/route.ts` (new)
- `apps/web/src/app/trade/page.tsx` and a new `src/components/deposit-panel.tsx`
- `apps/web/prisma/schema.prisma` (`DepositAddress`, `Deposit`) and a migration
- `apps/web/src/lib/runner/scheduler.ts` (register the watcher job from phase 05)

## Requirements

1. Each sign-in gets a deposit address per enabled network, derived deterministically and
   stored once — the same user always sees the same address.
2. The watcher, running as a phase-05 job, detects incoming transfers, records them with
   transaction hash, network, amount and block, and is idempotent per hash and log index.
3. Crediting occurs only after the owner's configured confirmation count for that network;
   before that the deposit shows as pending with the remaining confirmations visible.
4. Reconciliation handles: a transfer seen after a restart, a reorg that removes a pending
   transfer, an amount below the dust threshold, a token the owner has not enabled, and a
   transfer to an unknown address — each with its own state and a visible reason.
5. Every deposit state change writes an audit event, and the deposit row keeps the raw chain
   evidence it was credited from.
6. The UI shows the address with copy and QR, the network, the expected token, the live
   status of an incoming transfer and the confirmations remaining.
7. Nothing in this phase depends on a browser being open; the crediting path is identical
   whether the user is watching or not.

## Acceptance criteria

- On a testnet or local chain, a 20 USDT transfer to the shown address becomes credited after
  the configured confirmations, with the hash recorded.
- Replaying the same chain event credits nothing a second time, proven by a test.
- A reorg that removes a pending transfer reverts that pending row and states why.
- The audit trail covers address issuance, detection, crediting and reversion.

## Manual verification (owner click-path)

1. On `/trade`, open the deposit panel, copy the address or scan the QR.
2. Send a small test amount; the panel shows pending and the confirmations remaining.
3. After the confirmations, the balance increases and the deposit lists the hash and amount.
4. Failure case: send an unsupported token to the address — it appears as unmatched with the
   reason and is never credited.

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

- [ ] Deposit address per network, deterministic and stable for a user.
- [ ] Idempotent detection, proven by a duplicate-event test.
- [ ] Crediting follows the owner's confirmation policy with the count visible.
- [ ] Every failure mode above has a state, a reason and an audit event.

## Rollback

- Revert this phase's commit and drop the two tables; the deposit panel disappears and no
  balance is affected because crediting is the only writer introduced here.

## Do not do

- No approval gate, review step or manual confirmation before a deposit is credited.
- Do not credit on an assumption; wait for the confirmations the owner configured.
- Do not invent a balance when the chain cannot be reached — show the failure.
- Do not hide a network that is not configured; name the missing variable.
