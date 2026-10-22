# Phase 10 — Account security: scoped 2FA and sessions

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

The owner's account is protected on its own terms: TOTP enrolment with backup codes, 2FA
scopes that can be enabled separately for sign-in, trading and funding, a session list with
device and revocation, and sign-out everywhere.

## Scope

- In: TOTP, backup codes, per-scope policy, session list and revocation, audit events.

- Out: passkeys (recorded as an owner decision for later); organisation roles (phase 11).

## Files to touch

- `apps/web/src/lib/auth/totp.ts`, `session-store.ts`, `session-token.ts`
- `apps/web/src/app/api/auth/session/route.ts`, plus new `/api/auth/totp/*` routes
- `apps/web/src/app/admin/access/page.tsx`, `access-management-form.tsx`
- `apps/web/prisma/schema.prisma` (`AuthSession`, `TotpCredential`) and a migration

## Requirements

1. TOTP enrolment shows a secret once, verifies a code before activating, and issues
   single-use backup codes stored hashed.
2. Scopes are separable: sign-in, trading and funding each carry their own requirement, all
   stored as data the owner edits in the admin panel.
3. A session record stores device label, IP, created, last seen and expiry; the session list
   shows them and revokes any one immediately.
4. Sign-out everywhere revokes all sessions except the current one, and revocation of an
   active session is effective on the next request.
5. Every enrolment, scope change, revocation and failed code is written to the audit trail
   with actor and reason.
6. Rate limits and lockout on repeated wrong codes, with the lockout duration as admin data.

## Acceptance criteria

- A wrong code is rejected and counted; after the configured attempts the account locks.
- Revoking a session in the list ends its access on the next request.
- Changing a scope on an account affects the gated action immediately.
- Backup codes work once each and are never shown again after issue.

## Manual verification (owner click-path)

1. Enrol TOTP on `/admin/access`, activate with a code from the authenticator app.
2. Open the session list on two devices, revoke one — that device is signed out on its next
   action.
3. Turn the trading scope on, sign out, sign in again — the code is requested before trading.
4. Failure case: enter a wrong code repeatedly — the account locks and the audit trail shows
   each failure.

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

- [ ] TOTP enrolment, verification, backup codes and lockout each covered by tests.
- [ ] Session list shows device, IP and last seen; revocation takes effect immediately.
- [ ] Every scope is admin data, not a hard-coded requirement.
- [ ] All security events appear in the audit trail.

## Rollback

- Revert this phase's commit and drop the two new tables; sign-in returns to the phase 07/09
  behaviour with no 2FA requirement.

## Do not do

- No confirmation dialogue of our own in front of an action the owner takes; scope policy in
  the admin panel is the only place a requirement lives.
- Do not add a security requirement the owner cannot turn off.
- Do not store a TOTP secret or backup code in plain text.
- Do not lock the owner out with a requirement that has no recovery path they control.
