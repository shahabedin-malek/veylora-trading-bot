# Phase 08 — mobile wallet pairing: what was run, and what it showed

Recorded on 2026-10-16 against the working tree, with a development server on
`http://localhost:3211`, a throwaway `SESSION_SECRET`, a development SQLite database and a real
browser. No credentials, session values, pairing keys, seed phrases or private keys appear here;
the signer is the throwaway key phase 07 generated into `/tmp` and the session this run created is
described, never printed.

## What the phase added

| file | role |
| --- | --- |
| `apps/web/src/lib/auth/wallet-connect.ts` | the half of pairing that is not a browser: which variable holds the project id and which name wins, one sentence and one transition table for the seven pairing stages, one place deciding what a failure is called (`PAIRING_EXPIRED`, `PAIRING_DECLINED`, `PROJECT_ID_REJECTED`, `RELAY_UNAVAILABLE`, `UNSUPPORTED_CHAIN`, `PAIRING_FAILED`), the `wc:` URI's own expiry, `redactedPairingUri` for anywhere a human reads one, `pairingLinks`, and the metadata a wallet displays (built from the configured origin, never a request `Host`) |
| `apps/web/src/lib/auth/wallet-connect-client.ts` | the pairing port and its one real implementation over `@walletconnect/ethereum-provider` with `showQrModal: false`: `display_uri` → the page's own QR, `connect` → the paired provider, `resume()` for a session that outlived a reload, and a dev-only factory double (`window.__veyloraPairingFactory`, compiled out of production) so the failure paths can be run without a phone |
| `apps/web/src/components/wallet-connect-pairing.tsx` | the surface: the QR (`qrcode.react`), the deep link, the copy link, the countdown the URI states, the stage line, and a retry that never needs a reload. Once a phone is paired the sign-in is the phase 07 flow, unchanged |
| `apps/web/src/lib/auth/config.ts` | `pairingHostProblem`: pairing is bound to `APP_BASE_URL`, and a page served anywhere else refuses it with both host names in the sentence |
| `apps/web/src/app/login/page.tsx` | resolves the project id and the host guard on the server, so the page's own HTML says `PROJECT ID REQUIRED` (and names both variables) instead of rendering a broken QR |
| `apps/web/src/app/login/login-form.tsx` | renders the pairing panel beside the injected wallets, and routes both kinds of sign-in through the same `completeSignIn` |
| `apps/web/src/lib/integrations/readiness.ts` | reads the project id through the same resolver, so the `/admin/access` checklist cannot disagree with `/login` |
| `apps/web/src/components/wallet-connection-provider.tsx` | wagmi/RainbowKit stays mounted but injected-only: a WalletConnect connector there would be a second pairing implementation with its own modal and precedence |
| `apps/web/.env.example`, `apps/web/src/lib/dev-mode/env-diagnostics.ts` | the two names documented as what they are: the Reown name read first, the pre-rebrand name as its fallback |
| `apps/web/tests/wallet-connect.test.ts` | pairing tested without a phone and without a relay, ending in the phase 07 flow driven with a paired-wallet provider whose signature the production verifier accepts |
| `apps/web/package.json` | the new test file added to the `test` script |

## Automated gates (verbatim results)

| gate | command (from `apps/web`) | result |
| --- | --- | --- |
| typecheck | `pnpm --config.verify-deps-before-run=false typecheck` | exit 0 |
| test | `pnpm --config.verify-deps-before-run=false test` | exit 0 — `ℹ tests 303 / ℹ pass 303 / ℹ fail 0 / ℹ skipped 0` |
| lint | `pnpm --config.verify-deps-before-run=false lint` | exit 0 |
| build | `pnpm --config.verify-deps-before-run=false build` | exit 0 |
| plan | `node scripts/validate_plan.mjs` | exit 0 — 40 phase files, 0 restriction hits, 0 warnings |

Phase 07 recorded `tests 289`; this phase brings it to 303. The fourteen new cases are the project
id's precedence and the placeholder rule, the seven stages and every retry edge, the five failure
sentences, the URI's expiry and redaction, the host guard, and the paired-wallet sign-in — the last
of which asserts that `signInWithEvmWallet` still makes exactly `eth_chainId` → `eth_requestAccounts`
→ `personal_sign` and that the produced signature passes `verifySiweMessage` with the nonce, domain
and URI the routes use. That is the phase's "no second auth mechanism" claim as a test, not as an
intention.

## Manual verification (owner click-path), as run

`next dev` on `http://localhost:3211` with `APP_BASE_URL=http://localhost:3211`,
`AUTH_EVM_CHAIN_IDS=1`, a throwaway `SESSION_SECRET`, `INITIAL_ADMIN_EVM_ADDRESS` set to the
signer's address, and `NEXT_PUBLIC_REOWN_PROJECT_ID` set to a public placeholder, driven from a
real browser. Pairing is the one sign-in path that cannot be exercised without a phone, so the
relay is stood in for by the dev-only factory double; every line below is the real component, the
real state machine, the real routes and a real signature.

### 1. The QR, the deep link and the copy link are one pairing

```
pressed:          START PAIRING
stage:            WAITING FOR THE WALLET
port received:    { projectId: "dev-public-project-id",
                    origin: "http://localhost:3211", chainIds: [1] }
QR:               .pairing-qr svg rendered, encoding the wc: URI
deep link:        <a href="wc:…">  — byte-identical to the URI
COPY LINK:        button became "LINK COPIED", same value written
countdown:        "This code expires in 4:55. A fresh one is one press away."
```

### 2. The phone approves, and the desktop page signs in as the phone's address

```
phone approves →  PAIRED
stage timeline:   WAITING FOR THE WALLET → SIGNING IN → SIGNED IN
wallet calls:     eth_chainId  eth_requestAccounts  personal_sign
routes used:      POST /api/auth/nonce   POST /api/auth/verify   (phase 07's)
page:             "Signed in as 0xBb67...3387. Loading the console…", then /
session:          GET /api/auth/session → {authenticated: true,
                    user: {address: "0xBb67CB390ABE14dDf4b73f97AfC7F1Ec33F23387",
                           chainReference: "1"}}
```

### 3. Each failure is its own sentence, and each is retryable where it happened

| situation | observed |
| --- | --- |
| the wallet declines | `PAIRING_DECLINED` — "The wallet declined the pairing, so no connection was made and nothing was signed. Start pairing again to show a new code." → `PAIRING FAILED`, `START PAIRING AGAIN`, same page |
| the code lapses unanswered | countdown `0:08` → `PAIRING_EXPIRED` — "This pairing code expired before a wallet answered it. Start pairing again to get a fresh code — nothing was signed." → retry in place |
| the phone paired on Base | `UNSUPPORTED_CHAIN` — "The paired wallet is on Base (chain 8453). Sign-in accepts Ethereum Mainnet. Nothing was signed. Switch the network in the wallet, then start pairing again…" and the wallet was asked for `eth_chainId` **only** (no account, no signature) |
| the relay never issues a code | the real `@walletconnect/ethereum-provider` ran in the browser; the relay answered its socket with `code 3000 (Project not found)` for the placeholder project id (the browser console shows that error) and issued no code, so the port's own 20-second bound reported `RELAY_UNAVAILABLE` — "The WalletConnect relay did not issue a pairing code within 20 seconds, so there is nothing to scan." → `START PAIRING AGAIN` |
| cancelled on purpose | `CANCEL PAIRING` → `PAIRING NOT STARTED` with `START PAIRING` back and a fresh URI; the port's `disconnect` was called |

Every one of those was reached without a page reload, and the retry went back through
`PREPARING PAIRING` rather than reusing the code that failed.

### 4. The project id unset: the page names the variable, and sign-in still works

Second run of the same server without `NEXT_PUBLIC_REOWN_PROJECT_ID`, read from the page's own
server-rendered HTML and then in the browser:

```
status line:      PROJECT ID REQUIRED
panel:            "WalletConnect mobile pairing needs a project id from the Reown dashboard. Set
                   NEXT_PUBLIC_REOWN_PROJECT_ID (or NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID) and
                   restart, and the QR appears here. Injected wallets and the rest of sign-in work
                   without it."
no QR:            no .pairing-qr element, and no "wc:" anywhere in the HTML
not a dead button: the panel is a sentence, not a disabled control
injected sign-in: 3 INJECTED WALLETS DETECTED → SIGN IN WITH METAMASK → metamask:eth_chainId ×2,
                   eth_requestAccounts, personal_sign → "Signed in as 0xBb67...3387"
```

### 5. A page served from a host that is not `APP_BASE_URL` refuses to pair

With `APP_BASE_URL=http://localhost:3211`, requesting `/login` with `Host: 127.0.0.1:3211` renders
the refusal in the page's own HTML:

```
"This page is served from 127.0.0.1:3211, but sign-in for this deployment is configured for
 localhost:3211. A wallet would be asked to trust the wrong site, so pairing is refused. Open the
 application on its configured origin and pair there."
```

### 6. Nothing secret reaches a log

The two request logs this run produced (`next dev` with every outbound provider call logged) contain
**zero** occurrences of `symKey`, `wc:`, the project id's value, or `veylora_session=`. The three
pairing files are also walked by a test asserting no `console.*` call and no telemetry call exists
in them at all, so there is no path by which a pairing key could be logged by accident.

## Notes and limitations this record carries

1. **No real phone, and no relay success.** The relay was reached and refused the placeholder
   project id (`code 3000 (Project not found)`), so the one thing not observed here is a real `wc:`
   code issued by the relay and scanned by a wallet app. What *is* observed is the real provider
   running in the browser against the real relay, and a relay that issues nothing becoming a
   bounded failure with a retry; the rest of the surface is the real component driven by the
   dev-only double. The owner's step — register a project id, scan the QR with a phone, approve,
   see the desktop advance — remains.
2. **The wallet's own screens are not exercised.** The double stands in for `EthereumProvider`; the
   pairing's screens, states and failures are this application's, and those are what the tables
   above run. The `personal_sign` results are real signatures from a real key over the nonce route's
   own message.
3. **The project id in this run is a public placeholder, not a live Reown id**, and the relay says
   so in as many words (`code 3000 (Project not found)`). That is what made the two readings (the
   real provider against the real relay, and the unconfigured run) possible on one machine. A
   registered id is untested here — and note where that refusal landed: the provider's `connect()`
   promise never settled, so the relay's own error stayed in the console and the page reported its
   timeout. A project id the relay refuses with a *settled* rejection would classify as
   `PROJECT_ID_REJECTED` instead; that path is covered by a test, not by this run.
4. **`reconnect` on a mobile return is a pump we do not control.** The port reports WalletConnect's
   own `session_delete`/`disconnect` events and resumes a persisted session on mount; the deep-link
   return path was exercised only as far as the app's own handling of a session that outlives the
   page. A real backgrounded mobile browser returning to the tab is the owner's step.
5. **One investigation, no change.** A stale `SIGNED IN` panel was briefly seen after signing out
   and looked like state restored from the router's client cache. Measured properly, that element
   belonged to React's offscreen copy of the previous route (`getBoundingClientRect()` all zeros,
   while the visible page was `/`), so nothing on the live page was stale and no change was made for
   it. The state that was changed for this phase is the state this record describes and no more.
