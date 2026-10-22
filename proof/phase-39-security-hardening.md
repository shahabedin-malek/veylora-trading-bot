# Phase 39 — Security hardening

The review below covers the surfaces the phase names — authentication, the money paths, key
handling, dependencies and headers — on the tree as it stands. Every entry is one of three
things: **clean** (with the check that shows it), **fixed** (with the risk and the
reproduction), or **accepted** (with the reason it stays as it is). Nothing is left as
"reviewed".

The record contains no secret value, key, cookie or session token. Credentials are named by
variable name only, and the one file in history that carried live keys is named without its
contents.

## 1. Gates

Run from `apps/web` unless noted, on the final files.

| Gate | Command | Exit | Reading |
| --- | --- | --- | --- |
| typecheck | `pnpm --config.verify-deps-before-run=false typecheck` | 0 | `tsc --noEmit`, no output |
| test | `pnpm --config.verify-deps-before-run=false test` | 0 | **772 tests, 772 pass, 0 fail, 0 skipped** |
| lint | `pnpm --config.verify-deps-before-run=false lint` | 0 | `eslint`, no findings |
| build | `pnpm --config.verify-deps-before-run=false build` | 0 | production build, all routes emitted |
| plan | `node scripts/validate_plan.mjs` (repo root) | 0 | 40 phase files, 40 index entries, 0 restriction hits, 0 warnings |

## 2. Findings

| # | Surface | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Session fixation and rotation | Clean | A sign-in mints a **new** `AuthSession` row and a new signed cookie every time: `createSessionId()` and `authSession.create` in `src/app/api/auth/verify/route.ts`; `sessionMatchesUser` refuses a cookie whose `sessionVersion` no longer matches (`tests/auth.test.ts:347-356`) |
| 2 | Cookie flags | Clean | `httpOnly`, `secure` in production, `sameSite: "strict"`, `path: "/"`, 8-hour `maxAge` + `expires`; sign-out clears with the same attributes (`src/app/api/auth/verify/route.ts`, `src/app/api/auth/session/route.ts`) |
| 3 | CSRF on state-changing routes | Clean | 59 of 62 mutating handlers check the origin before touching state; the three that do not are exempt by construction (§2.1) |
| 4 | Origin checks | Clean | One implementation (`isSameOriginRequest` against the configured `APP_BASE_URL`, never the request `Host`); the RPC proxy has its own check that answers 503 when `APP_BASE_URL` is unset |
| 5 | Authorisation on every route | Clean | Every account/admin read calls `requireUser` / `requireSitePermission` / `serveApiRequest`; the public reads are enumerated with their reason (§2.2) |
| 6 | Injection and parameter handling | Clean | Prisma's typed client throughout; the only raw statement is parameterised (§2.3) |
| 7 | SSRF on provider URLs | Clean | The one surface that fetches a caller-supplied URL validates it strictly, and every outbound fetch refuses redirects (§2.4) |
| 8 | Rate limiting on auth and money | **Fixed** | New limiter wired to nonce, verify, withdrawal create and order create; 429 with `Retry-After` (§2.5) |
| 9 | Only the ledger writes balances | Clean | `LedgerAccount` has no balance column; a balance is the sum of `LedgerEntry` rows (`tests/security-hardening.test.ts` asserts the schema) |
| 10 | Reservations cannot be double-spent | Clean | A withdrawal reserves inside the ledger transaction; two concurrent requests for more than the balance produce one reservation and one refusal (`tests/withdrawals.test.ts:220`) |
| 11 | Idempotency key on every money mutation | **Fixed for withdrawals and the ledger; accepted for orders** | Withdrawal refuses a missing key with `400 MISSING_IDEMPOTENCY_KEY`; a ledger posting with a blank key is refused (`tests/ledger.test.ts`, "no idempotency key"); an order without one is keyed by its canonical intent instead (§2.6) |
| 12 | Credentials encrypted at rest | Clean | AES-256-GCM, venue-bound AAD, `readOnly` inside the sealed material; API keys stored as SHA-256 only, plaintext shown once (§3) |
| 13 | Credentials never in a log | Clean | The redaction tests cover key-bearing URLs, query strings, authorities, bearer headers, secret-named fields at any depth and private-key shapes (`tests/observability-redaction.test.ts`) |
| 14 | Session replay after sign-out | Clean | Live: replaying the old cookie answers `401 Authentication required.` (§5) |
| 15 | Security headers and cookie policy | **Fixed** | CSP, HSTS (production only), frame options, referrer, permissions, COOP, nosniff (§4) |
| 16 | Dependencies | **Fixed, one accepted** | Production tree 0 vulnerabilities; dev tree 1 high that has no published fix (§6) |

### 2.1 The three mutating routes without the shared origin helper

- `POST /api/rpc/[network]` — its own `sameOriginRefusal` in `src/lib/rpc/rpc-proxy.ts`, plus a
  body cap and a per-IP limiter. It authenticates nobody and forwards only to a network in the
  configured registry, so the origin check is the whole guard and it is present.
- `POST /api/signals/[token]` — HMAC-SHA256 over `` `${timestamp}.${rawBody}` `` verified before
  the body is parsed, a per-token replay window, and a unique dedupe key; it reads no cookie, so
  there is no ambient credential for a cross-site request to borrow.
- `POST /api/v1/[...path]` — bearer API key, hashed at rest and scoped; a browser never attaches
  it automatically.

None of the three answers differently because a session cookie happens to be present, which is
the property CSRF protection exists to guarantee.

### 2.2 Public reads, and why each is public

`GET /api/auth/config`, `/api/auth/session` (answers `authenticated: false`), `/api/trading/status`
(mode and venue name, no credential), `/api/marketplace` (published templates), `/api/bots` (the
dev-only paper store, 503 outside development), `/api/cron/[job]` (a `CRON_SECRET` bearer compared
with `timingSafeEqual`), and the support reads, which call `requireSupportCaller` with
`crm.support.read`. Every other read resolves a session.

### 2.3 The one raw statement

`src/lib/ledger/store.ts` sums entries with `client.$queryRaw` and a `Prisma.sql` template; the
account ids arrive as `Prisma.join` bindings and the range as bound values, so nothing is
interpolated as SQL text. `src/lib/db.ts` uses `$queryRawUnsafe` for a fixed `PRAGMA` string with
no caller input.

### 2.4 SSRF

`validateTavilyExtractUrls` (`src/lib/tavily/client.ts`) accepts only `https`, refuses
credentials in the URL, numeric hosts, `localhost`/`local`/`internal`/`test`/`invalid`/`example`
suffixes, any port but 443, and sensitive query-parameter names; every provider fetch sets
`redirect: "error"`, so a redirect cannot walk the request into a private address. The RPC proxy
resolves only networks present in the configured registry, and the portfolio and market providers
are fixed origins in code.

### 2.5 Rate limiting (a behavioural fix)

Risk addressed: a wallet signature, a nonce mint, a withdrawal or an order could be asked for as
fast as the network allows, so an unauthenticated caller could make the expensive path free.

`src/lib/security/rate-limit.ts` is a bounded, process-local counter: 60-second windows, caller
keyed by `x-real-ip` then the first `x-forwarded-for` hop (`unknown` is a bucket, not an
exemption), and a map capped at 10,000 keys with stale-then-oldest eviction. Wired to:

| Route | Key | Ceiling |
| --- | --- | --- |
| `POST /api/auth/nonce` | IP | 120 / min |
| `POST /api/auth/verify` | IP | 60 / min |
| `POST /api/withdrawals` | user id | 10 / min |
| `POST /api/trading/orders` | user id | 60 / min |

A refusal is a 429 whose body carries `code: "RATE_LIMITED"`, the limit, the reset instant and a
`Retry-After`, with `Cache-Control: no-store` and `X-RateLimit-*` headers; the window is not
extended by refused requests, so the reset time is stable.

Reproduction: `tests/security-hardening.test.ts` — a fourth request past a ceiling of three is
refused with `remaining: 0`, the same key is still refused 30 s later with the same `resetAt`, a
new window opens at 60 s, and another caller is unaffected; plus the 429's status, headers and
body, and the address derivation for `x-real-ip`, `x-forwarded-for` and neither.**Accepted limitation:** the buckets live in one process, so a multi-instance deployment limits each instance separately. That is stated in the module and here rather than implied away; a shared counter would be the next step if the deployment scales out.

### 2.6 Idempotency on the three money mutations

| Mutation | Where the key comes from | Refusal when absent |
| --- | --- | --- |
| Withdrawal | `Idempotency-Key` header, or `idempotencyKey` in the body | **400 `MISSING_IDEMPOTENCY_KEY`**, naming the reason; nothing is reserved (test in `tests/withdrawals.test.ts`, live in §5) |
| Ledger posting | the posting's own `idempotencyKey` field | **refused before anything is written** (`MISSING_IDEMPOTENCY_KEY`, `tests/ledger.test.ts`) |
| Order | `Idempotency-Key` header when the caller sends one, otherwise derived from the canonical intent (SHA-256 over the scope and the order's own fields) | not refused — an identical resubmission resolves to the same key and replays rather than placing twice (`src/lib/orders/idempotency.ts`) |

**Accepted, with the residual risk stated:** the order path is always idempotent, but a *caller-supplied* key is not mandatory — the derived key is the documented default for money ("an identical submission is the same operation"). The cost of that choice is that two deliberate, identical orders inside the replay window collapse into one; the panel's key field exists to distinguish them, and internal callers (the runner, a signal, the public API's agent path) pass their own derived key. Making the header mandatory would be a one-line change at the route, but it would also change what a second press of the same order means for every client, so it is the owner's call rather than a silent tightening.

## 3. Key handling and rotation

| Credential (name only) | Where it lives | Protection | Rotation |
| --- | --- | --- | --- |
| `SESSION_SECRET` | environment | HMAC-SHA256 over the cookie payload; ≥32 bytes enforced, placeholder values rejected | **Pending — owner** |
| `TRADING_CREDENTIAL_ENCRYPTION_KEY` | environment | AES-256-GCM key for venue keys, signal secrets and webhook secrets; 64 hex characters enforced | **Pending — owner** |
| `DEPOSIT_ADDRESS_MNEMONIC` | environment | derives deposit addresses; never logged, never returned | **Pending — owner** |
| `CRON_SECRET` | environment | bearer compared with `timingSafeEqual` on the cron route | **Pending — owner** |
| `DATABASE_URL` / `DATABASE_URL_UNPOOLED` | environment | Neon connection strings, server-side only | **Pending — owner** |
| `ALCHEMY_*` RPC URLs and app id | environment | server-side; the registry JSON the client sees contains no endpoint or key | **Pending — owner** |
| `CHAINGPT_API_KEY` | environment | read server-side by the provider layer | **Pending — owner + exposed key in §3.1** |
| `TAVILY_API_KEY` | environment | read server-side by the research client | **Pending — owner** |
| `RESEND_API_KEY` | environment | read server-side by the email channel | **Pending — owner** |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | environment | read server-side by the Telegram channel | **Pending — owner** |
| WunderTrading, Binance/testnet, Coinbase, Kraken keys | `TradingVenueCredential` rows | AES-256-GCM, AAD names the venue (testnet material cannot decrypt as live), scope inside the ciphertext, only the fingerprint/prefix returned | **Pending — owner** |
| Signals tokens and webhook signing secrets | database | AES-256-GCM with purpose-bound AAD; the URL form of a signal token is stored as a hash | **Pending — owner** |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | environment, public | public by design (a wallet reads it) | n/a |

What is asserted rather than assumed:

- **Encrypted at rest** — `tests/trading-credentials.test.ts`: "venue credentials are encrypted,
  venue-bound, and authenticated" and "a key's scope is part of the sealed material and cannot be
  coerced"; encryption fails closed without a valid server key.
- **Inaccessible to the client** — the credentials route returns a prefix and a fingerprint, never
  the material; the API-key table stores only `keyHash`, and the plaintext exists in exactly one
  response.
- **Never in a log** — `tests/observability-redaction.test.ts` covers the shapes a key actually
  takes.

### 3.1 The rotation that is still owed

The repository-root file `https www chaingpt org.txt` held three live keys and was committed in
`b26ace8`. Rotating them is a provider-side action that only the owner can take, and this phase
does not fabricate dates for it. The table above is the record to fill in; when each key is
rotated, write the date beside its name here and nothing else.

## 4. Headers and cookie policy

`apps/web/next.config.ts` attaches these to `/:path*` — pages, routes and exports alike.

Risk addressed: a response with no policy can load a script from any origin, be framed by
another site, leak the visited path in a referrer, or leave the browser's unused device APIs
reachable to injected code. Verified by `tests/security-hardening.test.ts` (which calls the
config's own `headers()` twice — once as the development server sees it, once with `NODE_ENV`
set to production — and asserts the values that matter: nosniff, `DENY`, the referrer policy, the
permissions list, the CSP directives, HSTS presence and max-age in production only, no `eval` in
the deployed policy, and `poweredByHeader: false`) and by the live response in §5.

| Header | Value | Why |
| --- | --- | --- |
| `Content-Security-Policy` | `default-src 'self'`; script `'self' 'unsafe-inline'` (+ `'wasm-unsafe-eval'` in production, `'unsafe-eval'` only in development); `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`; `frame-ancestors 'none'`; `connect-src` names Coinbase, the wallet relays and (in development only) localhost | Nothing loads from an origin that is not named; an injected `<base>` cannot retarget relative URLs and a form cannot post off-site |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` — **production only** | Pinning `http://localhost` for two years would be a development trap, not a protection |
| `X-Frame-Options` / `frame-ancestors` | `DENY` / `'none'` | The app cannot be framed |
| `X-Content-Type-Options` | `nosniff` | No type sniffing |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | No path leaks to third parties |
| `Permissions-Policy` | camera, microphone, geolocation, payment, usb, serial, bluetooth, magnetometer, gyroscope, accelerometer all `()` | The app uses none of them |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` | Wallet popups still work; the opener stays isolated |
| `X-DNS-Prefetch-Control` | `off` | No speculative DNS |
| `poweredByHeader` | `false` | The framework banner is not advertised |

The one concession is `script-src 'unsafe-inline'`: Next inlines its own bootstrap and the
serialised payload, and a nonce would require a middleware that rewrites every response — which
would also disable the static rendering the terminal pages rely on. `eval` is refused in the
deployed policy, and the test asserts exactly that.

Cookie policy, consistent with what the code sets: one cookie, `veylora_session`, `HttpOnly`,
`Secure` in production, `SameSite=Strict`, `Path=/`, 8-hour lifetime, cleared with identical
attributes on sign-out. It carries no identity beyond the signed claims; the session row it names
is what makes revocation take effect on the next request.

## 5. Owner click-path, run against a real server

A development server on `http://127.0.0.1:3100` with a throwaway `SESSION_SECRET`, one seeded
owner session minted as a real `AuthSession` row, and `curl` as the client.

| # | Attempt | Result |
| --- | --- | --- |
| 1 | `POST /api/withdrawals` with `Origin: https://evil.example` | **403** `{"error":"Request origin is not allowed."}`, `cache-control: no-store`, CSP and the other headers present |
| 2 | `POST /api/trading/orders` with a hostile `Origin` | **403** |
| 3 | `POST /api/withdrawals` same-origin, no session | **401** |
| 4 | `GET /api/account` with the minted session | **200** |
| 5 | `POST /api/withdrawals` same-origin **without** `Idempotency-Key` | **400** `MISSING_IDEMPOTENCY_KEY` — "Every withdrawal needs an idempotency key, so a repeated submit resolves to the same request instead of a second withdrawal." |
| 6 | `DELETE /api/auth/session` with that cookie | **200** `{"signedOut":true,"session":"REVOKED"}` |
| 7 | `GET /api/account` replaying the same cookie | **401** `{"error":"Authentication required."}` |

The audit half of #6 is covered two ways: the sign-out transaction's `INSERT INTO AuditEvent`
(`AUTH_SIGN_OUT`, with the new session version and `scope: "account-wide"`) appears in the
server's own query log, and `revokeSession`'s audit write is asserted by `tests/security.test.ts`.
A read-back of that row from a second process disagreed with the committed transaction on this
machine — the same log carries three `SqliteError extended_code: 522 (disk I/O error)` events —
so the row was not claimed from a read that did not show it. On a healthy database the owner sees
it at `/admin/audit`.

## 6. Dependencies

`pnpm audit` (full tree) and `pnpm audit --prod` were run after the overrides below.

| Tree | Before this phase | After | Notes |
| --- | --- | --- | --- |
| production | 0 | **0** | no runtime advisory |
| all | 1 high | **1 high** | `braces`, dev-only (below) |

Four transitive advisories were fixed by range-scoped overrides in `pnpm-workspace.yaml`, each
narrow enough that an unaffected major keeps the version its consumer expects:
`ws@>=8.0.0 <8.21.0 → 8.21.0`, `decode-uri-component@<=0.4.2 → 0.5.0`,
`deepmerge-ts@<8.0.0 → 8.0.0`, `uuid@<11.1.1 → 11.1.1`. The lockfile records those resolutions,
and both audit commands were re-run after `pnpm install` so the numbers above are the installed
tree's, not a proposal.

**Accepted, with the reason:** `braces` (`GHSA` stack exhaustion through deeply nested patterns)
arrives as `eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces`. Its
advisory names `>=3.0.4` as the patched range, but that version is not published to the registry
this project resolves from (`pnpm view braces version` → `3.0.3`; `braces@3.0.4` → no matching
version), so no override can satisfy it. It is lint-time only — it never loads in the server or
the browser bundle — and the tree's own direct dependencies are clean. Re-check when the patched
release is available.

## 7. Secret history

Method: every path ever present in any commit (`git ls-tree` across all commits) was read and
tested against four shapes — secret-named assignments, known key prefixes, `0x`-private-key
contexts and credential-bearing URLs — with placeholder and fixture values filtered out. Only
paths and categories were printed; no match was ever displayed.

| File | What it carried | Where | Status |
| --- | --- | --- | --- |
| `https www chaingpt org.txt` | three live keys in plaintext (ChainGPT, OctoBot, WunderTrading) | committed in `b26ace8`, deleted from the working tree, covered by `https*.txt` in `.gitignore` | **Purge pending the owner's instruction.** The deletion must be committed; rewriting history is not done without an explicit instruction recorded in `plan/PROJECT_TODO.md` |

No other file in any commit matched. The hits in the current tree are identifiers, fixture
strings and test doubles (e.g. the fake keys in `tests/trading-credentials.test.ts`), not
credentials.

## 8. What remains open

1. **Rotate the exposed keys** (ChainGPT, OctoBot/WunderTrading) at their providers, then fill in
   the dates in §3. Until then those credentials must be treated as burned.
2. **Decide the history purge** — recorded as pending in `plan/PROJECT_TODO.md`. The owner's
   instruction is required; `git filter-repo` on a shared clone is not reversible by the people
   who already have it.
3. **Commit the deletion** of `https www chaingpt org.txt` (it is removed in the working tree and
   staged as a deletion only when the owner commits).
4. **Re-run `pnpm audit`** when a `braces` patch is published, and drop the exception.
