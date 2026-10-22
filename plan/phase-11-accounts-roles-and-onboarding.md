# Phase 11 — Accounts, roles and onboarding

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

Real user records with roles, permissions and team membership edited as data in the admin
panel, plus a first-run onboarding path a new user finishes without help.

## Scope

- In: user records, role assignment, per-user permission grants, departments/teams,
onboarding checklist, admin CRUD.

- Out: CRM and tickets (phase 35); fund limits (phase 25); KYC vendor decisions.

## Files to touch

- `apps/web/src/lib/auth/access-control.ts`, `access-directory.ts`, `session-store.ts`
- `apps/web/src/app/api/admin/access/route.ts`, `route.test.ts`
- `apps/web/src/app/admin/access/page.tsx`, `access-management-form.tsx`
- `apps/web/src/app/onboarding/page.tsx` (new), `apps/web/src/components/session-readiness.tsx`
- Existing Prisma models: `User`, `RoleAssignment`, `TeamMembership`, `UserPermissionGrant`, `DepartmentTeam`

## Requirements

1. A user record is created on first successful sign-in with address, chain, account type and
   timestamps; repeat sign-ins update last-seen and never duplicate the wallet.
2. Roles and permissions are granted and revoked in `/admin/access`, each change writing an
   audit event with actor and reason, effective on the user's next request.
3. Team membership scopes admin visibility; a member sees only their team's records unless
   granted otherwise.
4. Onboarding is a short, visible checklist: connect a wallet, see a balance, place a paper
   trade, set an alert — each step links to the real surface and none is hidden.
5. A brand-new sign-in with the seeded owner address receives OWNER role in development.
6. Every admin CRUD action is usable and visible; nothing sits behind a disabled control.
7. Permission denials return a specific message naming the permission, not a generic refusal.

## Acceptance criteria

- First sign-in creates exactly one user and one wallet identity.
- Granting a permission lets the action succeed on the next request; revoking it stops it.
- The onboarding checklist reaches 4/4 using only the UI.
- A denial names the missing permission.

## Manual verification (owner click-path)

1. Sign in with a fresh wallet; the onboarding checklist appears.
2. Complete all four steps through their links.
3. In `/admin/access`, grant a permission to the new user and confirm the action becomes
   available, then revoke it and confirm the denial names the permission.
4. Failure case: attempt an admin action without the permission — a specific denial, not a
   blank page or a dead button.

## Automated verification

```bash
cd apps/web
pnpm --config.verify-deps-before-run=false typecheck; echo "typecheck=$?"
pnpm --config.verify-deps-before-run=false test;      echo "test=$?"
pnpm --config.verify-deps-before-run=false lint;      echo "lint=$?"
pnpm --config.verify-deps-before-run=false build;     echo "build=$?"
cd ../.. && node scripts/validate_plan.mjs; echo "plan=$?"
```

Extend `src/app/api/admin/access/route.test.ts` and `tests/access-control.test.ts`.

## Definition of done

- [ ] First sign-in creates one user and one wallet, asserted by a test.
- [ ] Role and permission changes take effect immediately and are audited.
- [ ] Onboarding is completable entirely through the UI.
- [ ] Denials name the permission and are test-covered.

## Rollback

- Revert this phase's commit; sign-in and roles fall back to the pre-existing access-control
  behaviour, and the onboarding page is removed.

## Do not do

- No approval gate or confirmation step in front of an admin action.
- Do not make a permission change require a second person.
- Do not hide an onboarding step that is not built; show it, or leave it out of the checklist.
- Do not write a KYC-style requirement as code; account flags are data the owner edits.
