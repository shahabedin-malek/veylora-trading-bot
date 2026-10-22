# Phase 10 — account security: scoped 2FA and sessions

This record covers the phase 10 owner click-path: the gates as they were run with their exit
statuses, the owner walk performed against a real browser and the real HTTP routes, and the
limitations the record carries. It contains no TOTP secret, no backup code, no session value
and no key material. The secrets and codes below are replaced by shape (`32 base32
characters`, `ABCDE-FGHJK`) rather than quoted.

## What the phase adds

- `src/lib/auth/totp.ts` — the cryptography, pure: RFC 6238 TOTP (HMAC-SHA1, six digits,
  30-second step, one step of tolerance), RFC 4648 base32 both ways, `evaluateTotpAttempt` (one
  decision that owns the count, the lock and replay of a time step), and backup codes issued as
  readable strings and stored by SHA-256 digest.
- `src/lib/auth/totp-service.ts` — the authenticator's lifecycle as operations: begin enrolment,
  activate with a code (issuing the backup codes), verify for a step-up, consume a backup code,
  disable. Each takes its store, so the whole flow is exercised against an in-memory store.
- `src/lib/auth/totp-secret.ts` — the secret sealed at rest with AES-256-GCM under the
  deployment's existing `TRADING_CREDENTIAL_ENCRYPTION_KEY`, separated from the venue-credential
  vault by its own associated data (`veylora:totp-secret:v1`), so neither ciphertext can be
  opened as the other.
- `src/lib/auth/security-policy.ts` — the three scope switches and the lockout numbers as data,
  plus `decideStepUp`, which is the one place that answers "is a code owed".
- `src/lib/auth/session-record.ts` — a session as a row: device label derived from the
  User-Agent, IP, created, last seen, expiry, and `sessionIsUsable`, shared by the list and the
  request path so what the list promises and what a request honours cannot drift.
- `src/lib/auth/step-up.ts` — the guard a gated route calls: scope on, an activated authenticator
  behind it, and this session's own last accepted code.
- Routes: `GET/POST/DELETE /api/auth/totp`, `POST /api/auth/totp/activate`,
  `POST /api/auth/totp/verify`, `GET/POST /api/auth/sessions`, `GET/PUT /api/admin/security-policy`.
- Gated actions: `POST /api/trading/orders` and `/api/trading/orders/[orderId]/cancel`
  (`trading`), `POST`/`DELETE /api/trading/credentials` and
  `/api/trading/credentials/[credentialId]/verify` (`funding`), and sign-in (`sign-in`, inside
  `POST /api/auth/verify`, before the nonce is exchanged).
- `apps/web/src/app/admin/access/security-panel.tsx` — the owner's panel: enrol, activate, keep
  the codes, the three switches and the two numbers, and the session list with per-device
  revocation and sign-out-everywhere.

## A defect found by the click-path, and its repair

The unit tests passed, and the whole panel was broken.

`readSecurityPolicyRow` passed the *stored row* — the six policy fields **plus** `id`,
`updatedByUserId` and `updatedAt` — to `validateSecurityPolicyUpdate`, which is deliberately
strict about unknown keys because it also validates a submitted payload. Every row that exists
therefore failed validation, and `readSecurityPolicyRow` threw. The consequences were not
subtle:

- `GET/POST/DELETE /api/auth/totp`, `POST /api/auth/totp/activate`, `POST /api/auth/totp/verify`,
  `GET/PUT /api/admin/security-policy` all answered **503** — every one of them reads the policy.
- The enforcement path was worse, because it failed *quietly*: `loadSecurityPolicyForEnforcement`
  catches the throw and returns the default policy, in which every scope is off. So no scope
  could ever gate anything, and sign-in 2FA could never be demanded.

The test suite did not see it because every policy test builds a policy-shaped object and calls
the pure functions; nothing round-tripped a row through the database and back. This is why the
click-path is not decoration on top of `pnpm test`.

The repair follows the convention the sibling readers already use (`integrations/settings.ts`,
`risk-controls/settings.ts`): `selectSecurityPolicyFields` projects any object down to the six
fields, `readSecurityPolicyRow` projects before validating, and `validateSecurityPolicyUpdate`
stays strict for submissions. A regression test now reads a row shaped exactly as the database
returns one and asserts the switch that was on is still on — plus that a row whose *policy* value
is unusable still throws rather than being rounded into a requirement nobody set.

A second, smaller defect was found the same way. The panel's copy says the backup codes cannot be
shown again, but they survived the panel's own `REFRESH` button: the re-read did not clear the
one-time material from component state. `apply` now clears the enrolment offer and the codes —
neither is stored state (the secret is sealed at issue, the codes exist only as digests) — and the
two flows that *do* need to display them set them after the read rather than before it.

## Gates on the working tree

```
$ pnpm --config.verify-deps-before-run=false typecheck   -> 0
$ pnpm --config.verify-deps-before-run=false test        -> 0   (336 tests, 0 failures)
$ pnpm --config.verify-deps-before-run=false lint        -> 0
$ pnpm --config.verify-deps-before-run=false build       -> 0
$ node scripts/validate_plan.mjs                         -> 0   (40 phase files, 0 warnings)
```

The suite grew from 335 to 336 with the stored-row regression test above.

## The owner click-path

Served by `next dev` on `http://localhost:3216` (`APP_BASE_URL`), `AUTH_EVM_CHAIN_IDS=1`, the
local SQLite file, `TRADING_CREDENTIAL_ENCRYPTION_KEY` set to a throwaway key generated for this
run. Two device sessions were minted (a genuine `AuthSession` row plus the cookie that names it,
signed with the deployment's own `SESSION_SECRET`), because there is no wallet in the room on a
headless run — the row is a real row, so the session list, last-seen and revocation behave
exactly as they do for a wallet-signed session. TOTP codes were computed by a separate
implementation of RFC 6238 in the driver, so an accepted code is **not** the application agreeing
with itself.

Walked over the same HTTP routes the panel calls:

| # | Step | Observed |
|---|---|---|
| 1 | Authenticator state before enrolling | `enrolled:false, pending:false, backupCodesRemaining:0`, policy all-off |
| 2 | Begin enrolment | `200`, secret of 32 base32 characters and an `otpauth://` URI, `note: … shown only this once` |
| 3 | Activate with a code computed independently | `200 activated:true`, **10** backup codes issued, `10/10` remaining |
| 4 | State after activation | `enrolled:true`, credential `ACTIVE`, `10/10` |
| 5 | Enrol again over the active credential | `409 ALREADY_ACTIVE` — never silently rotated |
| 6 | An order with every scope off | `400` (market validation), no code asked |
| 7 | Turn sign-in, trading and funding **on** | `200 saved:true` |
| 8 | Read the policy back | `trading=true funding=true sign-in=true enrolled=true` |
| 9 | An order on a device that owes a code | **`428 TOTP_REQUIRED`**, `scope:"trading"` — the gate, before the body is read |
| 10 | Satisfy the trading scope on that device | `200 verified:true method:TOTP` |
| 11 | The same order again | `400` — no longer a 428; the gate opened |
| 12 | The same code presented again in its window | `401 TOTP_REJECTED` "already used", count 1 of 5 |
| 13 | Session list | 2 rows with device label, IP, created, last seen, expiry, `isCurrent` |
| 14 | Revoke the other device from the list | `200 revoked:true`, naming `MetaMask · iOS` |
| 15 | That device's very next request | `{authenticated:false}` — immediate, nothing pushed |
| 16 | The acting device afterwards | still authenticated |
| 17 | A backup code | `200 method:BACKUP_CODE`, remaining 9 |
| 18 | The same backup code again | `401 BACKUP_CODE_USED` "Each one works once" |
| 19 | Wrong code × 5 | counted 1…5; the 5th sets `lockedUntil` |
| 20 | A correct code while locked | `423 TOTP_LOCKED`, "no code was checked" |
| 21 | A backup code while locked | `200` — the recovery path the owner controls |
| 22 | State after recovery | `failedAttempts:0, lockedUntil:null` |
| 23 | Scope turned back off | `200`, and the gated action asks for nothing |
| 24 | Disable with a backup code | `200 disabled:true`, then `enrolled:false` |

The audit trail for the run: 33 `AUTH_TOTP*` rows in total, each with its actor — enrolment
started, activated (with the code **count**, never a code), `AUTH_TOTP_FAILED` with its reason
(`mismatch`, `replayed`, `backup-code-already-used`, `locked`) and count, `AUTH_TOTP_VERIFIED`,
`AUTH_TOTP_STEP_UP_GRANTED` with the scope and method, `AUTH_TOTP_BACKUP_CODE_USED` with the
count remaining, and `AUTH_TOTP_DISABLED` with the reason. Checked mechanically: **0** rows
contain a secret-shaped or six-digit value.

Sign-out everywhere, and the rows the two revocation acts leave behind, were measured separately
(three more minted devices): revoking one device answered `200 revoked:true` naming it, that
device's next request was `{authenticated:false}` while a third stayed signed in; then
`revoke-others` answered `200` and revoked **11** other rows, after which both other devices were
`{authenticated:false}` on their next request and the acting device was still authenticated and
still able to read its session list. The trail then held exactly two rows for the two acts —
`AUTH_SESSION_REVOKED` with the reason, the device label and the IP, and
`AUTH_SESSIONS_REVOKED_OTHERS` with the reason, the kept session id and the count — both
attributed to the actor.

Driven in a real browser (`/admin/access`, OWNER session, one device):

- The panel rendered with every section present: `AUTHENTICATOR APP NOT ENROLLED`,
  `BEGIN ENROLMENT`, the three scope switches all `OFF`, the step-up window (15), wrong codes
  before lockout (5) and lockout duration (15), `SAVE SECURITY POLICY`, and
  `SIGNED-IN DEVICES 10 ACTIVE` with each row's label, IP, signed-in, last seen and expiry, and
  `END THIS SESSION` on every row except this device's own — plus `SIGN OUT EVERYWHERE ELSE`.
- `BEGIN ENROLMENT` produced the QR, the secret shown once, the manual-entry hint and the
  activation form; `REFRESH` then took the secret and the QR off the screen (the panel falls back
  to the pending facts and `BEGIN ENROLMENT`).
- Entering a code computed from the displayed secret and pressing `ACTIVATE` returned `ENROLLED`,
  `10 / 10` left, and the ten codes rendered once under "shown once". A first attempt used a code
  whose 30-second step had expired while the check was being prepared, and was refused with
  "That code is not this account's code for the current time … attempt 1 of 5" — the failure
  path, observed by accident and exactly as designed.
- `REFRESH` after activation removed the codes entirely while the panel still reported
  `Backup codes left 10 / 10` — the repair described above, verified through the interface.
- `DISABLE AUTHENTICATOR` with one of the issued backup codes returned `NOT ENROLLED` and
  "Authenticator disabled. Any scope that depended on it now says it is not enforced."

## Acceptance criteria

- **A wrong code is rejected and counted; after the configured attempts the account locks.** Yes —
  steps 19–21 above, with the lock carried as a timestamp that ends by itself.
- **Revoking a session in the list ends its access on the next request.** Yes — steps 14–15, and
  the row is marked rather than deleted so the trail can still name what ended.
- **Changing a scope on an account affects the gated action immediately.** Yes — steps 6–11 and
  23, and the decision is computed per request from data, so there is nothing cached to restart.
- **Backup codes work once each and are never shown again after issue.** Yes — steps 17–18, the
  `10 / 10` count that survives a refresh with no codes, and the digest-only storage that makes
  "show them again" a thing that cannot be done rather than a missing feature.

## Definition of done

- [x] TOTP enrolment, verification, backup codes and lockout each covered by tests
      (`tests/security.test.ts`, including RFC 6238's published vectors).
- [x] Session list shows device, IP and last seen; revocation takes effect immediately.
- [x] Every scope is admin data — `SecurityPolicySettings`, seeded all-off, edited in the panel,
      never a constant in code.
- [x] All security events appear in the audit trail with actor and reason, and never the material.

## Limitations

- **No authenticator application was used.** The codes came from an independent implementation of
  RFC 6238 in the driver and from the same computation in the browser walk, not from a phone
  scanning the QR. The QR's `otpauth://` URI is rendered and was read from the page, but a real
  authenticator app scanning it has not been observed.
- **Sessions were minted, not signed in.** There was no wallet in the room, so each device's
  `AuthSession` row and its cookie were created directly with the deployment's own secret. The
  rows are real and every read, list and revocation ran against them; what is *not* covered is a
  session that arrived through a real SIWE sign-in carrying `totpVerifiedAt` from the `sign-in`
  scope. The `sign-in` scope's enforcement lives in `POST /api/auth/verify` and is exercised by
  the route tests, not by this walk.
- **`stepUpMinutes`, `maxFailedAttempts` and `lockoutMinutes` were left at their defaults** (15,
  5, 15). Their validation ranges are unit-tested, but the panel was not driven with a changed
   number.
- **The dev database is local and throwaway.** The credential and codes created by this walk were
  removed afterwards, so the file is back to "nothing enrolled, every scope off" — the seeded
  state. The minted `AuthSession` rows remain and expire on their own.
- **Not in this phase, by design:** passkeys (recorded as an owner decision for later) and
  organisation roles (phase 11). The TOTP secret reuses the deployment's existing encryption key
  under separate associated data rather than a dedicated key; a dedicated key is the natural next
  step once there is more than one secret class to isolate, and is recorded here as a follow-up
  rather than required now.
