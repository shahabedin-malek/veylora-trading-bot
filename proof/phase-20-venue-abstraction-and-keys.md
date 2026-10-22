# Phase 20 — venue abstraction and key handling (proof record)

What was built, what was measured on the running application, the one defect the click-path
found, and what this run could not measure. No credential, cookie, session value or key
material appears here: the session secret and the credential encryption key were throwaway
values generated into `/tmp/phase20/` for this run and are not part of the repository.

## What the interface is

`src/lib/venues/` holds one contract and two adapters.

- `types.ts` is client-safe on purpose (no `node:` import, no network client): the closed
  vocabulary of venue ids, the closed capability list (`balances`, `positions`, `orders`,
  `orderStatus`, `cancel`, `health`), the permission vocabulary (`read`, `trade`, `withdraw`),
  the descriptor table (labels, capabilities, and whether the venue reports key permissions),
  the `VenueAdapter` type, the refusal type, and the pure rules that go with them —
  `permissionsForScope`, `validateRequestedPermissions`, `parsePermissions`,
  `assertWriteAllowed`, `verificationRecord`, `connectionHealth`. The connected-accounts panel
  renders the same descriptors the server enforces.
- `ccxt-adapter.ts` implements the interface for Binance, Kraken and Coinbase Advanced over
  CCXT, with the transport injectable so the same code can be driven by a counting fake.
- `wundertrading-adapter.ts` implements it for WunderTrading. Its descriptor claims **health
  only**, because that is all the venue's read surface answers; `positions`, `balances`,
  `orders`, `orderStatus` and `cancel` are refused by capability with a sentence rather than
  guessed at. Its health check is a real signed `api_profile:read` call.
- `registry.ts` is the only switch over venue names in the build, and also holds the venue
  access policy (`venueAccessRefusal`), so a route asks "may this venue be used?" once and
  never learns the name.

Route changes: the verify route lost its per-venue branches and now resolves a credential,
asks the registry for an adapter, calls `checkHealth()` and writes the result; the credentials
route records `requestedPermissions`, refuses withdrawal, and returns one credential shape from
both `GET` and `POST`; the WunderTrading read route asks the same `credentialAvailability`
function the verify route asks. `TradingVenueCredential` gained `requestedPermissions`,
`reportedPermissions`, `lastCheckedAt`, `lastCheckLatencyMs` and `lastCheckError`
(migration `20261017180000_credential_scope_and_health`).

Two files the plan lists were deliberately left alone, and it is written down here rather than left
to be discovered. `src/lib/trading/credential-vault.ts` already seals the scope inside the
authenticated ciphertext and never exposes the key, which is exactly the pattern requirement 2
asks for; the requested-permission list is a mirror of that scope, so sealing it would add
nothing, and a change there would have been churn in the crypto path.
`apps/web/src/app/admin/access/integration-settings-form.tsx` edits the *integration* switches
(Tavily, ChainGPT links) and has no venue keys in it — the admin screen's key panel is `TradingAccounts`, which was rebuilt. The
phase's manual step 1 ("in the admin integration settings, add a read-only key and confirm the
capability list shown matches what verification found") was carried out on that screen.

The migration was verified statement for statement against the DDL Prisma derives from
`prisma/schema.prisma` (`prisma migrate diff --from-empty --to-schema-datamodel`) — `TEXT NOT
NULL DEFAULT '[]'`, `TEXT`, three nullables and `INTEGER` — and the same schema was applied to
the local SQLite development database with `pnpm db:setup`, which is where the live readings
below come from. No Postgres is reachable from this machine, so the migration was not executed
against one.

## Gates (exit statuses preserved)

| gate | status | detail |
| --- | --- | --- |
| `typecheck` | 0 | `tsc --noEmit` |
| `test` | 0 | **534/534**, up from 526 — `tests/venues.test.ts` adds 8 |
| `lint` | 0 | `eslint` |
| `build` | 0 | 57 static pages collected, all routes compiled |
| `validate_plan` | 0 | 40 phase files, 0 restriction hits |
| `routes:sweep` | 0 | **93/93** rows, owner session, `http://localhost:3236` |

The new tests cover the four acceptance criteria against the same code the routes run: one
interface with an honest descriptor per venue and a capability refused before a client exists;
both adapters exposing every method, so no caller has to branch on a name; a read-only key and a
trade-capable key differing on a write (refusal before the transport, and the transport's call
count proving it); the withdrawal request refused with its reason, plus the scope conflicts and an
unknown permission; a failing check recording the error while not claiming a verification, and a
venue-reported withdrawal permission making the connection unhealthy; and revocation ending a
credential's use.

Two of the eight guard the definition of done where it could regress silently: no source file
hands a credential field (`apiKey`, `apiSecret`, `passphrase`, the ciphertext, iv or auth tag) to
a logging call, and the panel imports `@/lib/venues/types` and nothing else from `src/lib/venues`
— so the adapters, the registry and the Node crypto they need cannot reach the browser bundle.

## Owner click-path (measured)

Setup: a `next dev` on **:3236** against the local SQLite development database, with a
throwaway `SESSION_SECRET` and `TRADING_CREDENTIAL_ENCRYPTION_KEY`; a real `AuthSession` row
minted for the seeded owner with the server's own secret. The panel was driven in the browser
(admin integration settings) and the API was driven with the same session cookie.

1. **A read-only key is saved with the permissions it asked for.** `POST /api/trading/credentials`
   with `readOnly: true` answered `201` carrying
   `requestedPermissions: ["read"]`, and the row shows `READ-ONLY KEY · CANNOT PLACE OR CANCEL AN
   ORDER`.
2. **The connection check is a real read against the real venue.** Checking that key answered
   `200` with `health.ok: false` — Kraken's own refusal, `kraken {"error":["EAPI:Invalid key"]}`
   — `latencyMs: 2509`, `evidence: "No read completed."`, `permissions: null`. The listing then
   carried `health.state: "FAILING"` with that message, so the failure is on the row rather than
   only in the response the owner happened to be looking at.
3. **A write is refused before the venue is contacted.** `write-attempt.mts` read the credential
   the running application had just stored, decrypted it with the application's own vault,
   built the adapter through the application's own registry and attempted a cancellation with a
   counting transport:

   ```
   credential: Phase 20 write-gate proof · kraken · readOnly=true · revoked=false
   decrypted scope from the sealed material: readOnly=true
   refused: VenueRefusal READ_ONLY_CREDENTIAL
   message: The Kraken key is stored as read-only, so it cannot cancel an order. A read-only key
            is for balances and history; connect a key created for trading to cancel an order.
   transport calls: {"created":0,"cancelOrder":0,"fetchBalance":0}
   -- a read with the same read-only credential --
   balances read: [{"asset":"BTC","available":"0.25","total":"0.5"}] · calls {"created":1,...}
   -- the same write with a trade-capable credential (fake venue only) --
   result: {"id":"order-1","status":"cancelled"} · transport calls: {"created":1,"cancelOrder":1}
   ```

   Zero created clients and zero cancellations is the whole claim: nothing was sent.
4. **A key carrying withdrawal permission is refused on save, with the reason.** Four refusals,
   each with a code, and the connected-account count unchanged (3 before, 3 after):

   ```
   400 WITHDRAWAL_NOT_PERMITTED  Withdrawal permission is never requested or stored. Veylora
                                 cannot withdraw from a venue, so it will not hold a key that can: …
   400 SCOPE_CONFLICT            A read-only key cannot request trade permission. …
   400 PERMISSIONS_INVALID       Unsupported permission "sudo". This build understands read, trade, withdraw.
   400 SCOPE_CONFLICT            A trade-capable key must request trade permission. …
   ```
5. **The venue access policy is data, not a branch.** With WunderTrading's profile read switched
   off, its verify answered `403 "WunderTrading profile access is switched off in Access &
   Integrations."` without contacting the venue. Switching it on through
   `PUT /api/admin/wundertrading` and connecting a WunderTrading key produced `201`, then a
   check answering `health.ok: false`, `latencyMs: 482`, `error:
   "WunderTrading request failed with status 401"`, and `permissions: null` with the sentence
   that the venue does not report a key's permission set. Its own read route answered `502` for
   the same bad key. The switch was restored to off afterwards.
6. **Deleting a credential ends its use on the next request.** After `DELETE`, the verify route
   answered `404 {"error":"That credential was not found on this account.","code":"CREDENTIAL_REVOKED"}`,
   and with the switch on, the WunderTrading read route answered the same thing for the same id —
   one decision, two callers.
7. **The panel says what each connection can do, and that the venue holds the funds.** Each row
   renders the scope badge, `CAN · balances · orders · order status · cancel an order ·
   connection health` / `CANNOT · positions`, `REQUESTED · read — VENUE-REPORTED · this venue
   does not report key permissions`, `LAST CHECK · … · FAILED · kraken {"error":["EAPI:Invalid
   key"]}`, and the standing sentence *"Funds stay at the venue. Veylora holds no custody of
   them, cannot withdraw them, and never requests withdrawal permission on a key."* Pressing
   `CHECK CONNECTION` on an unchecked row moved it from `NOT CHECKED YET` to `FAILING · 3496 ms`
   in place, while the rows that were never checked still read `NOT CHECKED YET` — the three-way
   state, not two.

## Key material, measured

The definition of done says the plaintext never appears in a log, a response or the browser
bundle. Where that was checked:

- **No captured response or server log contains the material.** Every credential and check
  response from this run (`/tmp/phase20/*.json`) and the whole `next dev` log were searched for
  the dummy key and secret strings used: none appears (the search found no file at all).
- **The credential projection has no secret-shaped field.** The field set across the listing and a
  save response is `capabilities, createdAt, fingerprintLastFour, health, id, label,
  lastCheckError, lastCheckLatencyMs, lastCheckedAt, permissionReport, readOnly,
  reportedPermissions, requestedPermissions, venue, verifiedAt` — no key, secret, passphrase, iv,
  tag or ciphertext column among them. `fingerprintLastFour` is the last four characters of an
  HMAC digest, returned only in development.
- **The development query log does contain the sealed bytes.** `db.ts` logs every statement in
  development by design (Prisma query logging), so an insert shows its `credentialCiphertext` —
  the encrypted value, not the key. That is pre-existing behaviour of the local development mode
  rather than something this phase added, and it is the reason the search above is for the
  plaintext specifically.

## The defect the click-path found

Saving a key through the panel **crashed the page**. The `POST` response returned a narrower
object than `GET` did — no `capabilities` — and the panel inserts a saved credential straight
into the list it renders, so the first paint after a save threw
`TypeError: Cannot read properties of undefined (reading 'includes')` at
`src/components/trading-accounts.tsx:292`. The unit suite could not catch it: the rule lives in
the API contract, not in a function.

The fix is one projection, `credentialView`, used by both `GET` and `POST`, so a saved key and a
listed key are the same object to the client by construction. Re-measured after the fix: the
save renders its row immediately, the automatic check records the failure, the notice reads
"The check failed and was recorded: kraken …" and the console has no errors (only React's
dev-tools notice and HMR lines).

## A second defect found while verifying: source files git could not see

Checking that my own changes were the only ones in play turned up two **source** files that the
repository was ignoring: `apps/web/src/lib/trading/read-only-credentials.ts` (the read-only
refusal every order path uses, and where this phase's `credentialAvailability` now lives) and
`apps/web/src/lib/auth/totp-secret.ts` (phase 10's TOTP secret handling). The root `.gitignore`
carries `*credential*` and `*secret*` to keep credential *material* out of the repository, and it
whitelists the files that were already tracked (`credential-vault.ts`, the credentials API
routes, `tests/trading-credentials.test.ts`) — but no whitelist line existed for these two, so
they were never added. They compile, they run, and a fresh clone or a clean CI checkout would not
have them.

The fix is two negations beside the existing ones; `git status --ignored=matching apps/web/src`
now reports nothing ignored, and the only ignored file left under `apps/web` with a source
extension is Next's generated `next-env.d.ts`. Both files are still **untracked**: committing
another session's files is not mine to do, so they are left for the owner with the note here.

## Limitations of this run

- **No successful live check was measured.** No real exchange or WunderTrading key exists in
  this environment, so every live verification necessarily failed. `ok: true` with balances and
  a recorded latency is covered by `tests/venues.test.ts` through the injected transport, not by
  a live reading; the failing path is measured live for two venues (Kraken's API rejection,
  WunderTrading's 401) with real latency.
- **Binance's own permission report was not exercised live.** `readReportedPermissions` calls
  `sapiGetAccountApiRestrictions` when the CCXT client exposes it (probed by name, since CCXT
  generates the method at runtime) and maps `enableReading` / `enableSpotAndMarginTrading` /
  `enableWithdrawals`. The mapping and the "a key that can withdraw is unhealthy" rule are
  asserted against a fake; if a renamed method ever makes the probe miss, the answer degrades to
  "not reported" rather than to a failing connection.
- **The two credentials seeded by earlier sessions cannot be decrypted with this run's key.** The
  verify route answers `503 "The stored key could not be read. Connect the venue again to
  replace it."` — it fails closed and says what to do, but that path is a consequence of the
  throwaway key rather than of the code under test.
- **A revoked credential keeps its key fingerprint.** `(userId, venue, fingerprint)` is unique
  without `revokedAt`, so re-connecting the same key material after a revocation is refused
  `409 "This venue key is already connected to your account."` (measured). Read as policy, a
  revoked authorization stays revoked and reconnecting needs a new key at the venue; changing it
  would need a partial unique index, which the SQLite schema derived by `db push` for local
  development cannot express. That is a deliberate schema decision, not one this phase made.
- **The withdrawal refusal was measured as a request, not a click.** The panel deliberately has
  no field that can request withdrawal permission, so the boundary is enforced by the API and
  the vocabulary (and exercised by tests); the click-path shows the sentence the form carries
  instead ("Withdrawal permission is never requested or stored").
- **WunderTrading's strategy reads stay on their own page.** Its venue descriptor claims health
  only, so its row says `CANNOT` for balances, orders, order status and cancellation. Mapping
  live strategies onto "positions" would be inventing a holding the payload does not assert.
- `pnpm build` still logs a handled `prisma:error … Environment variable not found: DATABASE_URL`
  while prerendering the pages that read the risk policy (two pages, `riskPolicySettings.findUnique`).
  It predates this phase, the build exits 0, and the page renders.

## Rollback

Revert this phase's files and drop the five columns; every connection keeps working through
`readOnly` and `verifiedAt`, the verify route returns to its per-venue branches, and the panel
falls back to the scope badge. Nothing stored by this phase is required to read a balance or to
place an order.
