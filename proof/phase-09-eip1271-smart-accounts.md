# Phase 09 — A smart account signs in (EIP-1271)

What was run, what was observed, and what was **not** proved. Every reading below is from the
running application; where a chain's answer came from a stand-in node, it says so in the row.

## The gates

Run on this working tree, after the last code edit and before this record was written:

```bash
cd apps/web
pnpm --config.verify-deps-before-run=false typecheck   # 0
pnpm --config.verify-deps-before-run=false test        # 0 — 311 tests, 311 pass, 0 fail (was 303)
pnpm --config.verify-deps-before-run=false lint        # 0 — no errors, no warnings
pnpm --config.verify-deps-before-run=false build       # 0
cd ../.. && node scripts/validate_plan.mjs             # 0 — 40 phase files, 0 restriction hits
```

The 8 new tests are in `apps/web/tests/auth.test.ts` (phase 09 section). They cover: a contract
wallet accepted through a mocked EIP-1271 responder; a key-based account decided with **no** RPC call
at all; the contract reached over the wire with the standard's own call, in one batched request,
bounded by a timeout, with the EIP-191 hash of the exact signed text; a refused contract signature,
an unreachable node, a timeout, an HTTP error, a node with no code at its answer and an endpoint
answering for the wrong chain, each producing its own code, sentence and retryability; the chain in
the signed message deciding which chain is asked; EOA sign-in unchanged; and the client-side mapping
that keeps the server's code, sentence and retryability all the way to the page.

## The rig, and what it stands in for

Manual verification needs a contract wallet, so the click-path ran against a wallet and a chain that
were assembled for it, with everything on the application's side left real.

| piece | what it is | what it stands in for |
| --- | --- | --- |
| `/tmp/phase09/signer.mjs` (port 3198) | a throwaway key generated into `/tmp`, reached over HTTP with CORS so the page's injected provider can ask it to sign | the owner key inside a smart account — it signs, and its address is **never** the address a wallet claims |
| an injected EIP-1193 provider | published into the page the way MetaMask publishes itself; reports the address the message claims and asks port 3198 for the signature | a smart-account wallet (Safe, Argent, 4337) |
| `/tmp/phase09/stub-rpc.mjs` (port 8443, HTTPS) | a stand-in node with a switchable answer: `accepted`, `refused`, `revert`, `nocode`, `error`, `hang` (never answers), `unreachable` (drops the socket) | an EIP-1271 contract at the claimed address, and the ways a node can fail |
| the real Alchemy endpoint from `apps/web/.env` | the deployment's own mainnet RPC, used unmodified on a second dev server | — (real) |
| dev server on `:3212` | `APP_BASE_URL=http://localhost:3212 AUTH_EVM_CHAIN_IDS=1`, the stand-in node as `ALCHEMY_ETHEREUM_MAINNET_RPC_URL`, `NODE_EXTRA_CA_CERTS` pointing at the stub's scratch certificate | the deployment under test |

The stand-in node speaks HTTPS because `resolveRpcEndpoint` (`src/lib/rpc/networks.ts`) accepts only
`https:` endpoints. Rather than disable certificate checking anywhere, the stub uses a
self-signed certificate generated into `/tmp` and **only** the one dev-server process trusts it
(`NODE_EXTRA_CA_CERTS`). Certificate validation is on, in that process and everywhere else.

## Manual verification, step by step

### 1. A smart-account wallet signs in, and the admin view shows the account type

Stand-in node in `accepted` mode, the wallet claiming `0xA11Ce00000000000000000000000000000000`, the
signature produced by the rig key (a *different* address — no key exists at the claimed one):

- the node's log records exactly one batched request, and it is the standard's call:

  ```
  POST /v2/rig [
    {"id":1,"method":"eth_chainId","params":[]},
    {"id":2,"method":"eth_getCode","params":["0xA11Ce00000000000000000000000000000000","latest"]},
    {"id":3,"method":"eth_call","params":[
      {"to":"0xA11Ce00000000000000000000000000000000",
       "data":"0x1626ba7e…"},"latest"]}
  ]
  ```

  — the selector `0x1626ba7e` first, then the bytes32 hash, then the signature as ABI `bytes`.
- `POST /api/auth/verify` → **200**; the console then read
  `Signed in as viewer with wallet 0xA11C...0000`.
- `GET /api/auth/session` → `{authenticated: true, user: {address: "0xA11Ce00000000000000000000000000000000000", accountType: "CONTRACT", chainReference: "1", role: "VIEWER"}}`
  — the same payload shape an EOA session returns, plus the account type.
- the persisted row: `WalletIdentity.addressDisplay = 0xA11Ce00000000000000000000000000000000`,
  `accountType = CONTRACT`, `proofType = SIWE_EIP4361`; and the audit event:
  `AUTH_SIGN_IN … {"chainNamespace":"eip155","chainReference":"1","accountType":"CONTRACT"}`.
- `/admin/access`, rendered by the app for a seeded `OWNER` session, lists the wallet as
  **`0xA11Ce00000000000000000000000000000000` · VIEWER · "Contract wallet (EIP-1271) · 0 teams · 0 function grants"**,
  beside the other wallets' **"Externally owned account (EOA)"**. Screenshot and DOM text both
  recorded during the run.

### 2. A tampered payload is rejected, with its own reason

The provider was made to return `0x` + 65 zero bytes instead of the signature, against a stand-in
node that refuses (`eth_call` → `0x00000000`). The page showed, and stayed on `/login`:

> The contract at 0xC0dEC0DE00000000000000000000000000000000 was asked to verify this signature on
> chain 1 and refused it (it answered 0x00000000), so nothing was signed in. A different signer for
> that account, or signing again, is what fixes it. — `CONTRACT_SIGNATURE_INVALID`

and no identity row exists for `0xC0dEC0DE…` afterwards. On the **real** mainnet endpoint, the same
attempt against an address that is a real deployed contract (USDC, `0xA0b869…eB48`, which has no
`isValidSignature`) produced:

> The contract at 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 was asked to verify this signature on
> chain 1 and refused it (it answered (the call reverted)), so nothing was signed in. —
> `CONTRACT_SIGNATURE_INVALID`

### 3. An unreachable RPC is a retryable error, and no session

Three ways for the check not to complete, all on `:3212`, all observed in the page, none creating a
session (checked in the database afterwards — see "What the refusals did not create"):

| node mode | page | code | retry offered |
| --- | --- | --- | --- |
| `unreachable` (socket dropped) | "The RPC endpoint that has to check this contract wallet's signature could not be reached, so the signature was not checked and was not accepted. Nothing was signed in and no session was created. Check this deployment's connection and try again." | `CONTRACT_VERIFICATION_UNAVAILABLE` | yes |
| `hang` (never answers) | "Checking this contract wallet's signature against its contract took too long, so the check was abandoned and the signature was not accepted…" — the five-second bound fired | `CONTRACT_VERIFICATION_UNAVAILABLE` | yes |
| `error` (HTTP 500) | "The RPC endpoint answered the contract-wallet check with an error (500), so the signature could not be verified and was not accepted…" | `CONTRACT_VERIFICATION_UNAVAILABLE` | yes |
| `nocode` (address has no code) | "There is no contract deployed at this address on the chain the signature names, so it cannot be a contract wallet there and the signature was not accepted…" | `CONTRACT_ACCOUNT_NOT_DEPLOYED` | **no** — nothing about the next attempt would differ |

The retryability is visible, not just coded: the three `CONTRACT_VERIFICATION_UNAVAILABLE` readings
rendered the warning icon and "Nothing was signed in, so there is nothing to undo. Press a wallet
button above to try again.", and the `CONTRACT_ACCOUNT_NOT_DEPLOYED` reading rendered neither.
The retry is also usable rather than merely offered: with the node still unreachable, the sign-in
button was `disabled: false` and still labelled "SIGN IN WITH METAMASK" after the refusal, and
pressing it again on the same page — nothing reloaded — produced the same
`CONTRACT_VERIFICATION_UNAVAILABLE` sentence again. Two refusals, zero `WalletIdentity` rows, and
zero audit events naming that claim.

On the **real** mainnet endpoint, an address with no code (`0xe0a1…1111`) produced the same
`CONTRACT_ACCOUNT_NOT_DEPLOYED` sentence — that one is a real `eth_getCode` against Ethereum
mainnet, not the stub.

### 4. Signed with a different chain selected — refused, and the page says why

The provider reported `eth_chainId` → `0x2105` (Base) while `AUTH_EVM_CHAIN_IDS=1`:

> Your wallet is connected to Base (chain 8453). Sign-in accepts Ethereum Mainnet. — `UNSUPPORTED_CHAIN`

with the switch offer ("SWITCH TO ETHEREUM MAINNET") and its note. The wallet was never asked for an
account or a signature, and no request reached the chain. The **server-side** half of chain binding —
a message whose `chainId` this deployment does not accept, and a node answering `eth_chainId` with a
chain other than the one the signature names — is covered by tests rather than by this click-path,
because a browser cannot produce either once the page has refused.

## What the refusals did not create

Queried from the development database after all of the above:

```
0xA11Ce00000000000000000000000000000000000 -> accountType CONTRACT   (the one accepted sign-in)
0xc0dec0de…, 0xdead…, 0xb0b0…, 0xface…     -> no identity at all
```

Four refused attempts, four `POST /api/auth/verify` refusals, and not one `WalletIdentity` row: a
check that could not be completed and a signature a contract refused are both, in the only place
that matters, not a sign-in. Every `/login` failure also stayed on `/login` — no redirect, no half-
created session.

## The limits this record carries

- **The accepted sign-in's verdict came from a stand-in node, not from a deployed contract.** No
  EIP-1271 contract was deployed for this phase: deploying one needs a funded key and a real
  transaction, and the acceptance criteria allow a mocked responder. So the *browser* half of
  "accepted" is proved against `/tmp/phase09/stub-rpc.mjs`, while the *refused* half is additionally
  proved against real mainnet contracts (USDC's real revert) and the *not-deployed* half against a
  real `eth_getCode`. What has not happened is a real smart account (a Safe, an Argent account, a
  4337 account) signing in against its own contract on mainnet.
- **The signature is always the rig key's.** No owner of any real smart account has signed in, and no
  counterfactual account has been deployed-then-signed.
- **The rig's node is reached over HTTPS with a scratch self-signed certificate** that only the one
  dev-server process trusts. That is a property of the rig, not of the application — the application
  under it made an ordinary verified HTTPS call.
- **Session keys are not implemented.** Requirement 6 asks only that they be recorded as the future
  path: nothing stores a key, nothing delegates, and nothing acts for a user.

## Rollback

Revert this phase's commit and drop the `WalletIdentity.accountType` column
(`prisma/migrations/20261016130000_wallet_identity_account_type`). Contract-wallet sign-in then
refuses with `SIGNATURE_INVALID` or `SIGNATURE_FORMAT` (the "key-based accounts only" sentence), the
admin view stops showing an account type, and EOA sign-in is unaffected.
