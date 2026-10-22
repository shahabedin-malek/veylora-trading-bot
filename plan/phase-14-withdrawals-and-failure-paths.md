# Phase 14 — Withdrawals and failure paths

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

The owner withdraws the balance back to a wallet and confirms the money arrived — including
the rejection, failure, retry and partial paths, each as its own state with its own reason.

## Scope

- In: withdrawal request, execution on-chain, confirmation, failure taxonomy, retries,
the owner-configured new-address control, fee deduction point (amount from phase 16).

- Out: fees definition (phase 16); venue/off-chain balances (phase 20).

## Files to touch

- `apps/web/src/lib/withdrawals/request.ts`, `execute.ts`, `confirm.ts`, `addresses.ts` (new)
- `apps/web/src/lib/ledger/accounts.ts` (hold/release accounts)
- `apps/web/src/app/api/withdrawals/route.ts`, `src/app/api/withdrawals/[id]/route.ts`
- `apps/web/src/components/withdraw-panel.tsx` on `/trade`
- `apps/web/prisma/schema.prisma` (`Withdrawal`, `WithdrawalAddress`) and a migration

## Requirements

1. Requesting a withdrawal reserves the amount in the ledger immediately, so two requests
   cannot spend the same balance.
2. Execution signs and broadcasts on-chain with an idempotency key per withdrawal; a retry
   never broadcasts a second transaction for the same request.
3. Confirmation follows the network's confirmation policy and marks the withdrawal complete
   with the transaction hash visible.
4. Failure taxonomy with a distinct state and message each: insufficient balance, invalid
   destination, network unsupported, RPC unavailable, nonce conflict, transaction reverted,
   and expired request. Each is retryable or terminal, and says which.
5. A partial or delayed confirmation keeps the amount reserved, shows the pending hash, and
   offers the owner a cancellation attempt after the configured timeout.
6. The new-address control is owner-configured admin data: a first withdrawal to an unseen
   address can be held for a configurable window, with the window's length and the reason
   visible, and can be set to zero, which holds nothing.
7. Every state change writes an audit event including the reason and the destination address.

## Acceptance criteria

- Withdrawing 20 USDT minus the configured fee lands in a wallet and is confirmed with a hash.
- Two concurrent requests for more than the balance: one succeeds, one fails on insufficient
  balance.
- A retried failed broadcast produces one transaction, proven by a test.
- Each failure in the taxonomy is reachable in development and shows its own message.

## Manual verification (owner click-path)

1. With a credited balance, request a withdrawal to a wallet address on `/trade`.
2. Watch it move through reserved → broadcast → confirmed, with the hash visible.
3. Confirm the amount arrives in the wallet and the balance reflects the deduction.
4. Failure case: withdraw to an invalid address — a specific rejection with the amount still
   available; then withdraw more than the balance — a specific insufficient-balance message.

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

- [ ] Reservation prevents double spend, proven by a concurrency test.
- [ ] Broadcast is idempotent, proven by a retry test.
- [ ] Every failure state has a message, a retryability answer and an audit event.
- [ ] The new-address hold is admin data and can be disabled by setting it to zero.

## Rollback

- Revert this phase's commit and drop the two tables; reserved amounts are released because
  the reservation writer is removed with the code.

## Do not do

- No approval gate, manual review step or confirmation dialogue in front of a withdrawal the
  owner requests.
- Do not hold a withdrawal for a policy an agent invented; the only hold is the owner's own
  configured new-address window.
- Do not leave a failed withdrawal with no path forward: retry, cancel or state the reason.
- Do not broadcast twice for one request, and do not mark complete without a confirmation.
