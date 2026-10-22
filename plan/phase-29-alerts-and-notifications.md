# Phase 29 — Alerts and notifications

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

Alerts the owner actually receives: rules evaluated by the runner while the browser is closed,
delivered in-app, by email and to Telegram — each channel independently switchable — with
deduplication and a delivery log that shows what was sent and what failed.

## Scope

- In: rule evaluation on the runner, delivery channels, channel settings, deduplication, quiet hours, the delivery log.
- Out: the screener that creates rules (phase 19); marketing email.

## Files to touch

- `apps/web/src/lib/alerts/conditions.ts`, `evaluate.ts`, `scheduler-config.ts` (extend)
- `apps/web/src/lib/notifications/email.ts`, `telegram.ts`, `dispatch.ts` (new)
- `apps/web/src/app/api/market-alerts/route.ts`, `src/app/api/cron/market-alerts/route.ts`
- `apps/web/src/components/market-alerts-panel.tsx`, `src/app/admin/access/page.tsx` (channel settings)
- `apps/web/prisma/schema.prisma` (`NotificationDelivery`, channel settings) and a migration

## Requirements

1. The scheduler evaluates every enabled rule per its interval without a browser, reusing the
   condition model from `conditions.ts`.
2. Each channel — in-app, email, Telegram — is enabled or disabled independently in the admin
   panel; a channel that is not configured states which variable is missing instead of failing
   silently.
3. A rule does not fire repeatedly for the same condition: deduplication on (rule, condition,
   window) with a per-rule cooldown the owner sets.
4. Quiet hours pause delivery, queue the alerts, and deliver or summarise them afterwards, with
   the pause visible in the UI.
5. Every attempt is recorded: channel, target, provider response id, status, error and duration;
   failures retry with bounded backoff and then report.
6. The rules list shows last evaluation, last fire and next evaluation per rule, so an idle rule
   is explainable.
7. Email and Telegram credentials are environment variables by name; no secret is logged or
   rendered.

## Acceptance criteria

- A rule fires while the browser is closed and the in-app alert appears on return.
- The same condition does not fire twice inside the cooldown, proven by a test.
- With Telegram unconfigured, the UI names the missing variable and other channels still work.
- The delivery log records a failure and its retry outcome.

## Manual verification (owner click-path)

1. Create a rule that triggers immediately, close the browser, wait — the alert is waiting on
   return and the log shows the delivery.
2. Disable the email channel and confirm in-app still arrives.
3. Set a cooldown and re-trigger the condition — no duplicate alert.
4. Failure case: remove the Telegram token — the log shows the failure with the provider's error
   and the missing-variable message appears in settings.

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

- [ ] Evaluation runs server-side without a browser, proven in development.
- [ ] Three channels, independently switchable, each with a configuration message when unset.
- [ ] Deduplication and cooldown covered by tests.
- [ ] Delivery log explains every send, failure and retry.

## Rollback

- Revert this phase's commit and drop the delivery table; the market-alert panel returns to
  in-app only.

## Do not do

- No approval gate or confirmation step before a notification is sent.
- Do not hide a disabled channel; show it with its configuration state.
- Do not fire the same alert repeatedly for one condition.
- Do not put a token in a log, a response or a page.
