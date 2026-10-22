# Phase 07 — injected browser wallets: what was run, and what it showed

Recorded on 2026-10-16 against the working tree, with a development server, a throwaway SQLite
database under `/tmp` and three injected EIP-1193 wallets. No credentials, session values, seed
phrases or private keys appear here; the signer used was a throwaway key generated into `/tmp`
that never leaves it, and the session cookies minted for the sweeps are described, never printed.

## What the phase added

| file | role |
| --- | --- |
| `apps/web/src/lib/auth/eip1193.ts` | the injected-wallet port: `eth_chainId`, `eth_requestAccounts`, `personal_sign`, `wallet_switchEthereumChain`, the codes the flow branches on, and `switchWalletChain`, which reads the chain back after asking for the switch |
| `apps/web/src/lib/auth/wallet-providers.ts` | detection of the providers actually present (`window.ethereum`, its `providers` array per EIP-5749, `window.coinbaseWalletExtension`, `window.rabby.ethereum`), naming each by its most specific flag, and reporting the mainstream wallets that are missing |
| `apps/web/src/lib/auth/wallet-address.ts` | the single normalisation point: `canonical` (lower-cased, for storage and lookup) and `display` (EIP-55 checksummed, for humans), plus `shortWalletAddress` |
| `apps/web/src/lib/auth/wallet-errors.ts` | `SignInFailure` — a stable code, one sentence written for the person looking at the wallet, and whether pressing the button again can help |
| `apps/web/src/lib/auth/evm-wallet-sign-in.ts` | the flow rewritten against a supplied provider instead of `wagmi` hooks: read the chain, refuse before prompting, request the account, fetch the nonce, sign, verify, return the session |
| `apps/web/src/app/login/login-form.tsx` | the wallet list, per-wallet buttons, the switch offer, the failure sentence and the retry hint |
| `apps/web/src/lib/auth/session-revocation.ts` | signing out as a function with its store behind a port: refuse an already-stale cookie, increment `sessionVersion`, record the act |
| `apps/web/src/lib/auth/config.ts`, `nonce.ts`, `siwe.ts`, `chain-labels.ts`, `session-token.ts`, `session-store.ts` | the accepted-chain sentence derived from `AUTH_EVM_CHAIN_IDS`, three separate nonce reasons, and the canonical address used on both sides of the SIWE comparison |
| `apps/web/src/app/api/auth/nonce/route.ts`, `verify/route.ts`, `session/route.ts` | the routes: a `code` beside every refusal, and `DELETE` as the sign-out |
| `apps/web/tests/wallet-sign-in.test.ts` | the flow driven against fake providers with a real secp256k1 signer |
| `apps/web/tests/auth.test.ts`, `src/app/api/auth/session/route.test.ts`, `src/app/api/auth/verify/route.test.ts` | detection, normalisation, the failure classification, and the server-side sign-out |
| `apps/web/tsconfig.json` | the per-run dev dist directories, following the convention already in the file |

`src/components/wallet-connection-provider.tsx` keeps wagmi/RainbowKit mounted for the rest of the
app, and `src/app/login/page.tsx` keeps saying, in the page body, that WalletConnect pairing and
non-EVM sign-in are not enabled — which the phase did not change.

## Automated gates (verbatim results)

| gate | command (from `apps/web`) | result |
| --- | --- | --- |
| typecheck | `pnpm --config.verify-deps-before-run=false typecheck` | exit 0 |
| test | `pnpm --config.verify-deps-before-run=false test` | exit 0 — `ℹ tests 289 / ℹ pass 289 / ℹ fail 0 / ℹ skipped 0` |
| lint | `pnpm --config.verify-deps-before-run=false lint` | exit 0 |
| build | `pnpm --config.verify-deps-before-run=false build` | exit 0 — `✓ Compiled successfully in 8.6s`, 39 prerendered pages, 45 routes in the table |
| plan | `node scripts/validate_plan.mjs` | exit 0 — 40 phase files, 0 restriction hits, 0 warnings |
| routes:sweep (owner session) | `pnpm routes:sweep -- --base-url http://localhost:3142 --cookie "$(node …/mint-session.mjs)"` | exit 0 — `60 passed · 0 not swept · 0 failed (of 60)` |
| routes:sweep (unconfigured) | `pnpm routes:sweep -- --base-url http://localhost:3141` | exit 0 — `60 passed · 0 not swept · 0 failed (of 60)` |

Phase 06 recorded `tests 271`; phase 07 brings it to 289. The rows this phase is about, from the
owner-session sweep:

```
GET /login                                           200     235ms     pass     6cf6388d250d  34168B <title>Sign in | Veylora>
GET /api/admin/access                                200     506ms     pass     fcf2f2e98957   1108B {users,teams,permissionCatalog,assignableRoles}
GET /api/admin/chaingpt                              200     444ms     pass     2723a2725252    245B {chatbotEnabled,contractAuditorEnabled,contractGeneratorEnabled,aiTradingAssistantEnabled}
GET /api/admin/health                                200    1377ms     pass     c42e3974f941   5165B {reason,database,runner,providers}
GET /api/admin/integrations                          200     440ms     pass     ea83a90a4526     96B {alternativeMeSentimentEnabled,tavilySearchEnabled,tavilyExtractEnabled}
GET /api/admin/risk-policy                           200     375ms     pass     568e49f6015b    344B {maxRiskPerTradePercent,maxOpenExposurePercent,dailyLossHaltPercent,maxTradesPerDay}
GET /api/admin/wundertrading                         200     365ms     pass     3cf34502de32    142B {apiProfilesEnabled,liveStrategiesEnabled,strategyHistoryEnabled,openTradesEnabled}
```

## Manual verification (owner click-path), as run

Development server on `http://localhost:3142` with `AUTH_EVM_CHAIN_IDS=1`,
`APP_BASE_URL=http://localhost:3142`, a throwaway `SESSION_SECRET`, and
`INITIAL_ADMIN_EVM_ADDRESS` set to the signer's own address, writing to a throwaway SQLite file
under `/tmp` — so nothing in the repository's own development database was touched by this run.

**The three wallets.** No extension was installed. The page was given three EIP-1193 providers the
way installed wallets coexist: `window.ethereum` publishing a `providers` array (EIP-5749) whose
entries are MetaMask (`isMetaMask`), Rabby (`isRabby` **and** `isMetaMask`) and Coinbase Wallet
(`isCoinbaseWallet`). Their signatures come from a throwaway secp256k1 key served from
`127.0.0.1:3199` — the one thing a page cannot do for itself — so the `personal_sign` results are
real signatures over the real EIP-4361 message the nonce route built.

### 1. Each wallet connects, and the address shown is checksummed

The page reported and named them without mislabelling:

```
header: 3 INJECTED WALLETS DETECTED
rows:   MetaMask DETECTED · Rabby DETECTED · Coinbase Wallet DETECTED
copy:   Sign-in accepts Ethereum Mainnet.
```

Signing in with each one in turn, and the provider calls each attempt made:

```
MetaMask  → metamask:eth_chainId  metamask:eth_chainId  metamask:eth_requestAccounts  metamask:personal_sign
Rabby     → rabby:eth_chainId     rabby:eth_chainId     rabby:eth_requestAccounts     rabby:personal_sign
Coinbase  → coinbase:eth_chainId  coinbase:eth_chainId  coinbase:eth_requestAccounts  coinbase:personal_sign
→ session {authenticated: true, role: "OWNER", address: "0xBb67CB390ABE14dDf4b73f97AfC7F1Ec33F23387", chainReference: "1"}
→ redirect to /
```

That Rabby's attempt called only `rabby:*` is the point of naming a provider by its kind: all
three publish themselves through the same scope, and the flow still drove the wallet the user
pressed.

The address the top bar shows is the checksummed form, shortened:
`0xBb67...3387` for `0xBb67CB390ABE14dDf4b73f97AfC7F1Ec33F23387`.

The seeded owner reaches every `/admin/*` page, checked from the signed-in page itself:

```
GET /admin/access 200 · GET /admin/data 200 · GET /admin/risk 200
```

### 2. A network outside `AUTH_EVM_CHAIN_IDS` offers a switch, and the switch completes the sign-in

Started on Polygon PoS (`AUTH_EVM_CHAIN_IDS=1`):

```
pressed:  SIGN IN WITH METAMASK
wallet calls: metamask:eth_chainId              (nothing else — no prompt, no signature)
message:  "Your wallet is connected to Polygon PoS (chain 137). Sign-in accepts Ethereum Mainnet."
code:     UNSUPPORTED_CHAIN
offer:    "This wallet is on Polygon PoS (chain 137). … Accepting this offer asks the wallet to
           switch; nothing is signed until the wallet is on an accepted network."
button:   SWITCH TO ETHEREUM MAINNET   (enabled)
session:  authenticated: false
```

Accepting the offer:

```
wallet calls: metamask:eth_chainId  metamask:wallet_switchEthereumChain  metamask:eth_chainId
              metamask:eth_chainId  metamask:eth_requestAccounts  metamask:personal_sign
→ wallet reports chain 1 on the read-back that follows the switch
→ session {authenticated: true, role: "OWNER", chainReference: "1"} , redirect to /
```

The read-back after `wallet_switchEthereumChain` is what makes this "verified" rather than
"assumed": the switch request resolving is the wallet saying it accepted, and the chain is read
again before anything is signed.

### 3. A reload keeps the session, and signing out ends it on the server

```
reload /trade → authenticated: true · role: OWNER · header 0xBb67...3387
              → window.__phase07Wallets undefined: the session does not depend on the wallet
                still being injected
SIGN OUT      → DELETE /api/auth/session → 200 {session: "REVOKED", signedOut: true}
              → document.cookie empty · GET /api/auth/session → {authenticated: false}
              → GET /trade → 307 to http://localhost:3142/login
```

The server half of that is covered by a test rather than by a reading:
`src/app/api/auth/session/route.test.ts` drives `revokeSession` with an in-memory store and then
asks the production rule — `sessionMatchesUser` — whether the cookie it signed out with still
resolves. It does not: the cookie's signature is still valid, and the account it names has moved
on, which is exactly what "sign-out cleared it on the server as well as the client" means.

### 4. Failure case: the signature is rejected, and the page can be retried without reloading

Rabby's rejection (`code 4001`) and Coinbase Wallet's closed prompt are both classed as rejections
during signing, so the signature case was run with MetaMask refusing exactly one signature:

```
pressed:  SIGN IN WITH METAMASK          wallet calls: … eth_requestAccounts  personal_sign
message:  "The signature request was rejected in your wallet, so nothing was signed and no
           session was created. Press the button again to retry."
code:     SIGNATURE_REJECTED
session:  authenticated: false           url: /login (no reload, no redirect)
buttons:  SIGN IN WITH METAMASK:enabled  … RABBY:enabled  … COINBASE WALLET:enabled
hint:     "Nothing was signed in, so there is nothing to undo. Press a wallet button above to try again."
pressed the same button again, same page (still no reload):
→ session {authenticated: true, role: "OWNER"} , redirect to /
```

### Extra, beyond the four steps

| check | how | result |
| --- | --- | --- |
| a declined network switch has its own message | `?chain=137&switchreject=metamask`, then accepting the offer | `CHAIN_SWITCH_REJECTED` — "The network switch was rejected in MetaMask. Nothing changed, and no signature was requested. You can try again, or move the wallet to the right network yourself and sign in." Wallet still on 137, offer still enabled, no session. Wallet calls: `eth_chainId`, `wallet_switchEthereumChain` — **no** `personal_sign`. |
| a cancelled connect prompt has its own message | `?connectreject=coinbase`, then Coinbase Wallet | `PROMPT_CANCELLED` — "Coinbase Wallet closed the connection request before sharing an account, so no session was created. Press the button again to retry." No session, no signature. |
| a provider that disappears mid-flow is reported, not crashed on | the page listed three wallets, then `window.ethereum` was removed before the button was pressed | `PROVIDER_UNAVAILABLE` — "MetaMask is no longer available in this browser, so sign-in cannot start. Reload the page to look for it again, or install it and come back." The wallet list emptied rather than leaving buttons that cannot work. |
| nothing installed is reported, never a dead button | `/login` with no injected provider | header `NO EVM WALLET DETECTED`, 0 wallet buttons, and three lines naming where to get each wallet — `https://rabby.io/`, `https://www.coinbase.com/wallet/downloads`, `https://metamask.io/download/` |
| a second wallet does not become an owner | a different deployment whose database already had an active owner, signed in with the same signer address | the sweep answered 403 `"Administrator role required"` on the six `/api/admin/*` rows: the bootstrap rule grants `OWNER` only when no active owner exists. Recorded, not hidden — see limitation 4. |

## Limitations this record carries

1. **The three wallets are EIP-1193 doubles, not extensions.** Their `personal_sign` results are
   real signatures from a real key, and the flow is the flow, but a real extension's own screens
   (its connect prompt, its chain-add prompt, its queued-request behaviour) are not exercised
   here. Nothing about the page's side of the exchange is simulated: detection reads only what a
   provider publishes on `window`.
2. **WalletConnect mobile pairing is out of scope**, which this phase is explicit about: the phase
   is the injected providers, and `/login` says on the page that mobile pairing is not yet wired
   to sign-in. That is phase 08.
3. **Contract wallets and EIP-1271 are out of scope** (phase 09), so a smart-contract account that
   signs by validating on-chain is not covered by this record.
4. **The route sweep assumes the session it is given belongs to an owner.** Supplying a valid
   session for a *non-owner* account produced `54 passed · 6 failed`, all six being
   `/api/admin/*` answering 403 — which is the correct answer for that account and an undeclared
   answer for the sweep's row. The owner reading above is the one that matches the phase's
   requirement 7; making the sweep assert the role of the cookie it is handed is phase 03 work,
   not phase 07.
5. **`SESSION_SECRET` and the signer key were throwaway values in `/tmp`.** No session value is
   reproduced in this record, and the click-path wrote to a throwaway database, so the repository's
   own development database still holds what the seed put there.
