# Phase 31 — Signals in, webhooks out

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

Automation can be driven from outside and can tell the outside what happened: signed inbound
signals in the TradingView style, and outbound webhooks for trade, alert and strategy events
with retry and a visible delivery record.

## Scope

- In: inbound signal endpoint with signing and replay protection, mapping a signal to a strategy action, outbound webhook subscriptions, delivery and retry, the signal log.
- Out: the public API surface (phase 32); charting (phase 33).

## Files to touch

- `apps/web/src/app/api/signals/[token]/route.ts` (new)
- `apps/web/src/lib/signals/verify.ts`, `map.ts`, `log.ts` (new)
- `apps/web/src/lib/webhooks/dispatch.ts`, `subscriptions.ts` (new)
- `apps/web/src/app/api/webhooks/route.ts` (new), `src/app/admin/access/page.tsx` (subscription UI)
- `apps/web/prisma/schema.prisma` (`SignalToken`, `SignalEvent`, `WebhookSubscription`, `WebhookDelivery`) and a migration

## Requirements

1. An inbound signal is authenticated by a per-account token plus a signature over the raw body
   with a shared secret; a bad signature is rejected before parsing and recorded as rejected.
2. Replay protection: a signal id or nonce used before is rejected as duplicate, and the window
   is configurable by the owner.
3. Accepted signals map to a strategy action — enter, exit, adjust — with size and pair bounds
   taken from the strategy or the owner's settings, and every rejection states which bound
   refused it.
4. The signal log shows every attempt with timestamp, source, decision and reason, including
   rejected and duplicate signals.
5. Outbound subscriptions per event type with per-endpoint secrets; delivery is signed so the
   receiver can verify it.
6. Deliveries retry with bounded backoff and record each attempt, status and error; a
   persistently failing endpoint is marked unhealthy and visible in the admin panel.
7. Neither the signal secret nor the webhook secret is ever returned by an API or written to a
   log.

## Acceptance criteria

- A correctly signed signal triggers the mapped action; a bad signature is rejected and logged.
- A replayed signal is rejected as a duplicate, proven by a test.
- An outbound webhook retries on failure and the attempts appear in the delivery record.
- Signal and webhook secrets are absent from every log, response and page.

## Manual verification (owner click-path)

1. From the signal settings, copy the endpoint and token, send a signed test signal — it is
   accepted and the log shows the decision.
2. Send it again — rejected as a duplicate with the original reference.
3. Add an outbound webhook to a local receiver; trigger a trade event and see the delivery.
4. Failure case: turn the receiver off, trigger again — the delivery fails, retries and is
   marked unhealthy with the error visible.

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

- [ ] Signature and replay protection covered by tests.
- [ ] Every signal, accepted or rejected, recorded with its reason.
- [ ] Outbound retries and health recorded per endpoint.
- [ ] No secret returned or logged.

## Rollback

- Revert this phase's commit and drop the four tables; existing strategies keep running without
  signal input.

## Do not do

- No approval gate or confirmation step in front of an accepted signal.
- Do not act on an unsigned or unverifiable signal.
- Do not fail silently on a rejected signal; record it with the reason.
- Do not expose a signal token in a page or a log.
