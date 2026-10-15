# Veylora Remaining Tasks Checklist

**Status date:** 2026-10-14
**Authority:** `REBUILD_TODO.md` and `docs/ANSWERS.md`. This checklist summarizes current work; it does 
`docs/OPEN_TASKS_AND_IDEAS.md` describes a different/older architecture and is 
## Verified Complete

- [x] Phase 1 repository inventory, disposition coverage, move plan, and reuse-plan approvals.
- [x] Phase 2 architecture approval and - [x] Phase 3 foundation commit and fresh-clone verification.
- [x] Phase 4 SIWE implementation and local test/build gates. Auth is disabled pending an approved EVM auth chain; initial admin wallet is still needed. Phase 4 changes remain uncommitted and have not been fresh-clone verified.
- [x] Phase 5 market-data interface, public Coinbase data, chart/UI, RSS metadata, cache, endpoint checks, and local gates. Live proof was refreshed on 2026-10-14; its exit gate still needs user review and RSS terms confirmation.
- [x] Recovery fixes: credential-ciphertext tamper test, runtime endpoint scan, wallet integration types, Git visibility of credential-named source, and local verification gates.
- [x] Add the ChainGPT hosted-tool link directory and audited admin visibility controls. This is outbound-link-only; no paid API, credential, portfolio data, or trading flow is connected. Production availability requires the pending settings-table migration.
- [x] Add user-owned WunderTrading credential storage, HMAC-signed - [x] Add `/research` with keyless Tavily Search and Extract, admin-controlled switches defaulting off, authenticated same-origin routes, bounded requests, and public-HTTPS URL validation. Results do - [x] Inventory useful no-cost API candidates, verify official terms/limits, and write the ordered implementation checklist in [FREE_API_PROVIDER_ROADMAP.md](FREE_API_PROVIDER_ROADMAP.md). No candidate beyond the providers already marked connected/implemented is enabled by this research.
- [x] Implement the Alternative.me daily Bitcoin Fear & Greed reader and attributed Markets panel behind an audited admin switch, default off. Parsing and five-minute cache tests pass; one live smoke read returned 62/100 (Greed), observed 2026-10-14. The score has no trading/risk wiring.
- [ ] Obtain prior written commercial-use consent from DefiLlama before using any of its data in Veylora. For DEX data, approve exact Ethereum endpoints/pair IDs and obtain written clarification of GeckoTerminal free-tier rights and DEX Screener third-party display/non-compete terms. No integration or provider request before these gates pass.

## Immediate User Gates

- [ ] Review `proof/market-data-live.json` and confirm the public production responses and hashes are acceptable evidence for Phase 5.
- [ ] Confirm whether the enabled RSS publishers' metadata may be used and redistributed in production. If - [ ] Approve an EVM mainnet authentication chain and provide the initial admin wallet through the intended secure configuration path. Until then, keep authentication and admin bootstrap disabled.
- [x] Alchemy key configured account-wide. The app reads per-network `ALCHEMY_<NET>_RPC_URL` values through `apps/web/src/lib/rpc/networks.ts`; keep the key server-only.
- [ ] Configure a WalletConnect project ID as `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` to enable mobile WalletConnect pairing. This is a public application ID, not a secret.
- [ ] Confirm Ethereum Mainnet as the EVM sign-in chain before setting `AUTH_EVM_CHAIN_IDS=1`. Do not enable auth/admin until the initial admin wallet and required admin MFA are ready.
- [ ] Decide separately whether Solana/- [ ] Review the - [ ] For any candidate selected, resolve its documented API-key, signing, custody, collateral, withdrawal, and endpoint questions before connector implementation. Do not request operator CEX credentials; they are not a prerequisite.
- [ ] AI auto-trading remains locked. The user selected Vercel AI Gateway's limited free tier, with public market data only. Before model calls, verify an eligible model's terms/data handling and configure Gateway credentials privately with auto-top-up disabled. Before AI-driven execution, resolve the architecture rule that LLM output is advisory only, then approve exact venue, chain, endpoints, and token/symbol allow-list. The current Coinbase USD watchlist is - [ ] Complete the Coinbase CDP Onramp human gates and engineering work in [CDP_ONRAMP_ACTION_PLAN.md](CDP_ONRAMP_ACTION_PLAN.md). The current source has - [ ] Privately rotate the CDP/API/wallet/webhook secrets referenced by the legacy Coinbase export before use. Do - [ ] Privately revoke/rotate the newly posted ChainGPT, OctoBot Cloud, WunderTrading, and Tavily credentials before any use; do - [ ] Keep ChainGPT disabled at the user-confirmed USD 0 cap. “Other” was selected without a feature description; any future - [ ] Privately revoke/rotate the pasted Tavily API key and remove the key-bearing MCP URL wherever it was configured; do 
## Phase 4 Closeout

- [ ] After the auth-chain and initial-admin prerequisites are resolved, enable only the approved mainnet auth configuration and verify the initial admin bootstrap without self-assigned roles.
- [ ] Verify admin authentication meets the confirmed TOTP-or-passkey requirement before exposing admin functions.
- [ ] Fresh-clone verify Phase 4 changes when an explicitly authorized commit or equivalent reviewable snapshot is available. Do not commit or push without explicit authorization.

## Phase 5 Exit

- [ ] Complete the two Phase 5 user gates above: proof review and RSS metadata-use decision.
- [ ] Record the user's decision and update `REBUILD_TODO.md`, `docs/PROJECT_TODO.md`, and `.progress/` consistently before marking Phase 5 green.

## Phase 6 Connectivity

- [ ] Prove public, unauthenticated mainnet market-data connectivity, including the required server-time/order-book evidence; the Phase 5 Coinbase proof is relevant but does not replace `proof/connectivity.json`.
- [ ] For each individually approved DEX, implement only its approved wallet-connected read/quote path and SIWE-compatible wallet identity path. Do - [ ] Assert enabled endpoints are production/mainnet, log configured base URLs without secrets, and test rejection of - [ ] Create `proof/connectivity.json` with public CEX and approved DEX responses plus wallet-connectivity evidence; redact secrets and never request operator CEX credentials.
- [ ] Verify private balances and private order history display `Not connected` without that user's own optional CEX key.
- [ ] Obtain user review of connectivity proof and close the Phase 6 gate.
- [x] Add a - [ ] Decide whether to add Alchemy Token/NFT/Portfolio/Transfers/WebSocket products; 
## Phase 7 Risk Engine

- [ ] Reconcile the existing risk code and persisted policy with all confirmed limits: unset capital/trading disabled by default; 1% per-trade risk; 25% exposure; 2% daily-loss halt; 10 trades/day; mandatory stop-loss; 1x default leverage; per-user symbol allow-list; USD 20 minimum balance; and USD 20 exposure cap for the first 24 hours after arming.
- [ ] Ensure the risk gate is pure and can only allow an unchanged order or refuse it with a reason; it must never create, resize, or enlarge an order.
- [ ] Verify insufficient/unverified funds, malformed inputs, unavailable audit storage, disallowed symbols, missing stops, venue/arm failures, and kill-switch state all fail closed.
- [ ] Complete and test the end-to-end kill switch: block new orders, cancel open orders, request position closure, and report/audit closure outcomes.
- [ ] Ensure every risk refusal is recorded with reason and timestamp in the append-only audit trail.
- [ ] Have the user confirm the encoded limits match `docs/ANSWERS.md` before closing Phase 7.

## Phase 8 Execution

- [ ] Implement execution only for individually approved wallet-connected DEX venues/chains/endpoints; keep optional user-owned CEX keys - [ ] Verify withdrawals are disabled for every CEX key and enable IP whitelisting where supported; no operator key or account is required.
- [ ] Put every real order behind the risk gate and use an idempotency key for each submission.
- [ ] Make order, cancel, fill, and refusal audit events append-only with exact submitted parameters, timestamps, and venue order IDs; retain records for 365 days.
- [ ] Implement and test one-time UI live-trading arming and the first-24-hour USD 20 total-exposure cap. Per-order approval remains waived by Q27; all other safeguards remain mandatory.
- [ ] Implement and unit-test the STATE 0-4 trading state machine, terminal event stream, minimum-balance rule, and five-minute force-stop warning; UI must only read state.
- [ ] Do - [ ] Obtain user review of execution proof before closing Phase 8.

## Phase 9 Ledger, Wallet, and History

- [ ] Implement money-in-cents domain operations and formatting, including balance plus/minus P&L minus fees.
- [ ] Add `LedgerEntry` and `Transaction` persistence with atomic writes and idempotent replay.
- [ ] Implement deposit confirmation on the server and enforce `DEPOSIT_CAP_USD`; never credit an unconfirmed deposit.
- [ ] Implement withdrawal requests that reserve funds, enter an admin approve/decline queue, and return reserved funds on decline. Requests do not enable API withdrawals or automatic payouts.
- [ ] Build `/wallet`, `/history`, and `/portfolio` with source attribution; unknown values must remain null, never fabricated zeroes.
- [ ] Test replay idempotency, unconfirmed deposits, and declined-withdrawal balance restoration; pass the Phase 9 gate.
- [ ] If Coinbase Onramp is approved, integrate it only as an optional user-wallet funding path; follow the CDP action plan and do not credit the Veylora ledger from a redirect alone.

## Phase 10 Support and Administration

- [ ] Add `Customer` and `Ticket` support workflows with `TCK-1001` numbering and customer linkage.
- [ ] Build `/support` ticket list, conversation, and status views.
- [ ] Complete the admin console for ticket - [ ] Test ticket lifecycle, admin authorization, audit coverage, and decline-returns-funds behavior; pass the Phase 10 gate.

## Phase 11 Release Readiness

- [ ] Rerun the complete typecheck, tests, production build, and `check:real`.
- [ ] Rerun secret scanning; audit `.env` handling and dependencies without printing or committing secrets.
- [ ] Re-run and verify every applicable proof artifact against live approved endpoints; confirm source timestamps, hashes, and mainnet status.
- [ ] Sync README, architecture/data-model docs, route/script tables, and `.progress/` to the implemented product.
- [ ] Review all user-facing copy for fabricated data, misleading performance claims, and unsupported return guarantees.
- [ ] Complete a full user journey on a fresh database against approved real endpoints.
- [ ] Create and walk `docs/RELEASE_CHECKLIST.md`; it does 
## Phase 12 Deployment

- [x] Obtain explicit authorization to publish to private GitHub and Vercel; Cloudflare was explicitly skipped.
- [ ] Review the final diff and rerun tests, build, realness check, and secret scan.
- [x] Rerun the application tests (53 + 6 realness), lint, typecheck, realness scan, and secret scan with installed binaries after the PostgreSQL schema changes; all passed. The production build and final diff review remain pending.
- [ ] Push the PostgreSQL migration changes to the confirmed private GitHub branch after validation.
- [x] Provision Neon Free and connect it to the Vercel project; rotated secrets are managed by the integration and must never be committed.
- [x] Offline preflight: Prisma schema validates with dummy local URLs, generated SQL matches the PostgreSQL baseline exactly, importer syntax passes, and Phase 1 validators plus `git diff --check` pass. No database was accessed or modified.
- [x] Inspect both Vercel projects and deployment state before changes: `veylora-fintech-ai-trading` is the production target (`apps/web`, Next.js, Node 24) with Ready preview `6350634`; duplicate `web` shares the repository/root, has - [x] Add runtime and CLI fallback for the Neon-prefixed database variable names; add opt-in `build:vercel` that applies migrations before `next build`. Focused tests and full app checks pass; the default local build is unchanged.
- [ ] Privately refresh the local Neon URLs. A name-only check found no database URL keys in `.env.local`; do not share values in chat.
- [ ] Apply the PostgreSQL baseline, import retained SQLite records, and configure the confirmed Vercel project's build to use `build:vercel` only after target validation and smoke tests.
- [ ] Deploy and verify the replacement only after schema, data import, and runtime smoke tests pass; keep old production/deployments until then.
- [ ] Obtain user verification of production before marking deployment complete.

## Ongoing Constraints

- [ ] Keep unapproved venues, chains, endpoints, auth chains, live trading, and deployment disabled.
- [ ] Keep the Alchemy proxy - [ ] Never require operator CEX accounts, CEX credentials, or KYC; optional CEX integrations belong to the individual account owner.
- [ ] Do not commit, push, delete, overwrite, or detach existing resources without the required explicit authorization.
- [ ] Do 
## Paused Ancillary Workstreams

These are not blockers for local Veylora development, but remain open in the progress/decision records.

- [ ] Privately rotate previously disclosed Linux/Windows credentials before any future machine authentication. Do not paste values into chat or ask the assistant to handle them.
- [ ] Continue only the previously approved, path-by-path review of `last-try/` named/config candidates. Historical/pathless and oversized scan uncertainty remains; any broader handling, copy, move, archive, or rotation needs separate approval.
- [ ] Have the owners privately review the two previously flagged sensitive reference paths. Do - [ ] Keep Windows access blocked until credentials are privately rotated, key authentication and the fail-closed session guard are verified, and the exact prerequisite phrase `keys ready` is supplied.
- [ ] Keep Freebuff project sessions and MCP write/session access paused until a sanitized worktree and Desktop authorization are available. Do 