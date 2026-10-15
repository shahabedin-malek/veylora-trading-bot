# Veylora Project Plan — Phase 2 Draft

**Status: working plan.** Describes a fresh implementation. The Phase 1 inventory and move/reuse work are complete.

## Product outcome

Veylora is a multi-user, responsive, real-data crypto spot and perpetuals/futures dashboard, manual trading desk and automation platform, with portfolio analytics, news, support CRM and admin console. The primary trading path is a user-connected wallet interacting with individually approved DEXs/aggregators. The product must work with zero operator CEX accounts and zero KYC. Public unauthenticated CEX market data is permitted for charts/analytics only. Equities and Alpaca are deferred.

No mock, demo, paper, sandbox or fabricated financial values may be presented as real. Unknown, stale, failed or disconnected data remains explicitly unknown/unavailable. A source, observation timestamp, retrieval timestamp and freshness status accompany financial data.

## Confirmed implementation baseline

- Web: Next.js 16, strict TypeScript, Tailwind 4; preserve unless a concrete change is presented for approval.
- Data access: Prisma; SQLite for local development and PostgreSQL for production.
- Authentication: SIWE/EIP-4361 with single-use nonce and server-validated session.
- CI: GitHub Actions plus local checks.
- Production/deployment: not authorized. Existing GitHub and Vercel targets must not be deleted, overwritten, detached or deployed without separate written authorization.
- Secrets: local values only in ignored `.env`; production values only in server/hosting-managed secret storage; user CEX keys encrypted at rest; seed phrases never enter Veylora.

## Delivery phases

1. **Phase 0 — confirmed product constitution:** complete. `docs/ANSWERS.md` is authoritative.
2. **Phase 1 — repository survey and approvals:** inventory complete and all three ordered approvals received. The full source tree was later relocated intact to `/mnt/private-ai-data/repo` at the user's explicit request; the proposed internal categorized reorganization was not performed, and no code was extracted.
3. **Phase 2 — architecture sign-off:** these three documents are drafts: `docs/PROJECT_PLAN.md`, `docs/ARCHITECTURE.md`, and `docs/DATA_MODEL.md`. Resolve document comments, then wait for the exact approval phrase before implementation.
4. **Phase 3 — foundation:** after architecture approval, create the fresh app structure, reviewed secrets-excluding `.gitignore`, security/realness checks, CI, local database setup and design-system shell. `git init` must be the first Phase 3 action, before any implementation change.
5. **Phase 4 — authentication and roles:** SIWE sessions, single-use nonces, admin MFA, explicit role assignment and locked admin bootstrap until the user supplies the initial admin wallet.
6. **Phase 5 — public market data:** implement provider-neutral interfaces and source/freshness/error semantics. Use only approved, real, public mainnet endpoints requiring no authentication for initial CEX charts/analytics. No endpoint is selected by these drafts.
7. **Phase 6 — portfolio and news:** real recorded events and approved feeds only; attribution and freshness required. Portfolio balances must not be inferred from strategy output or imported fills.
8. **Phase 7 — deterministic risk controls:** pure allow/refuse gate with independently tested user/admin limits; it may never increase requested size.
9. **Phase 8 — trading intents and user-wallet DEX path:** only after exact venue, chain, contract/router and endpoint approval. Require simulation/quote validation, explicit calldata display, wallet signing, risk approval and post-chain reconciliation. No live order before all user-approved gates.
10. **Phase 9 — ledger, deposit observations and withdrawal requests:** reconcile confirmed on-chain/provider events idempotently. A withdrawal request is an internal request only, never an API withdrawal or automatic payout.
11. **Phase 10 — support CRM and admin:** tickets, customer timeline, role-gated operations, kill switch and append-only audit view.
12. **Phase 11 — proof and release readiness:** real-data provenance, security/risk proof, end-to-end tests, dependency/secret scans, and user review. Deployment remains separately gated.

## Trading defaults and hard boundaries

- Capital default: unset / USD 0; trading disabled until configured capital and verified available funds exist.
- Maximum risk per trade: 1% of configured capital; never above verified available funds.
- Maximum total open exposure: 25% of configured capital.
- Daily-loss halt: 2% of configured capital; reaching it blocks new orders.
- Minimum trade-balance threshold: USD 20-equivalent by default; admin may raise it but may not reduce it below supported risk/venue requirements without the confirmed separate policy.
- A valid stop-loss and maximum-loss bound are mandatory for every opening position.
- Default maximum: 10 trades/day; maximum leverage 1x until user explicitly raises it.
- Per-user symbol allow-list; disabled symbols cannot trade.
- The deterministic risk gate allows the exact requested order only when all limits pass; otherwise it refuses. It does not resize orders.
- One explicit UI “arm live trading” confirmation before the first real order. Total exposure is capped at USD 20 for the first 24 hours after arming.
- Per-order human approval is not required, per confirmed Q27 override. Mode remains signal-only/manual by default; automation still cannot bypass risk, venue, wallet, key-owner, audit or arm gates.
- Kill switch blocks new orders, cancels open orders and requests position closure; each result is reported and audited, not promised.
- API withdrawals are prohibited; withdrawal requests do not cause transfers.

## Researched venue shortlist

Research checked against first-party developer documentation on 2026-10-13. These are candidates for user review, not selections or connector authorization. Every venue, chain, endpoint, token/market and any router contract must be separately approved before implementation. No requests were sent to these services.

| Candidate | Chain / exact endpoint | Evidence and fit | Material constraints / disposition |
|---|---|---|---|
| Uniswap Trading API (spot) | Ethereum Mainnet, chain ID 1. API base: `https://trade-api.gateway.uniswap.org/v1`; `POST /check_approval`, `POST /quote`, then `POST /swap` for AMM routes or `POST /order` for UniswapX routes. The official supported-chain table lists Ethereum and Universal Router deployments. | Uniswap's integration guide describes route generation and unsigned transaction data; the user's wallet signs, and the integrating app broadcasts through its RPC. It documents Permit2 typed-data approval and quote freshness/transaction validation. | All requests require `x-api-key`. The RPC provider, key availability/terms, current router version/address, supported token policy, API rate limits and service terms still need verification and separate approval. Candidate only; no router or token allow-list enabled. |
| CoW Protocol (spot / signed orders) | Ethereum Mainnet, chain ID 1. Orderbook base: `https://api.cow.fi/mainnet`; `POST /api/v1/quote` and `POST /api/v1/orders`, with order/status endpoints under the same API. | The official SDK supports Ethereum and documents quote -> verify -> EIP-712 wallet signature -> orderbook submission. Solver competition and later settlement make this an asynchronous signed-order flow, not a direct wallet-broadcast swap. | Orderbook status is off-chain until settlement; solver, expiry, cancellation and final-fill reconciliation must be modeled. Partner API keys are described for higher-rate access; public limits, fees, terms and RPC needs require confirmation. Candidate only; no tokens or order types enabled. |
| Jupiter Swap API V2 (Solana spot) | Solana Mainnet. API base: `https://api.jup.ag/swap/v2`; `GET /order` then wallet-sign the returned transaction and `POST /execute`, or use `/build` plus an approved transaction-submission path. | Current official docs recommend the meta-aggregator order/execute flow and describe Metis, JupiterZ, Dflow and OKX routing. The wallet signs; Jupiter's execute service submits and reconciles the signed transaction. | The endpoint page says all endpoints require an API key, while pricing/rate-limit pages also document keyless access at 0.5 RPS; resolve this documentation conflict before use. Free keyed tier is listed at USD 0 and 1 RPS. Fees vary by pair/router and must be shown from the returned quote. Third-party routing and sending signed bytes to Jupiter require explicit user acceptance. Candidate only; no mint or router enabled. |
| Hyperliquid (perpetuals candidate; elevated review) | Hyperliquid L1 / HyperCore Mainnet. API base: `https://api.hyperliquid.xyz`; `POST /info` for public/account reads and `POST /exchange` for signed order actions. | Official docs document perpetual and spot order actions, mainnet endpoints, and account/order/fill reads. This is the only researched candidate here that addresses the confirmed perpetuals scope. | It is not a direct per-order wallet-broadcast DEX flow: a master account authorizes an API/agent wallet that signs actions on its behalf; collateral is held in the venue account. The same exchange endpoint exposes withdrawal actions. This custody/signing and withdrawal surface conflicts with the present no-automatic-withdrawal and user-wallet transaction assumptions. **Research only; not recommended for v1 unless the user separately approves this account, agent-key, collateral, and withdrawal model. Do not implement or request keys.** |

The EVM RPC path resolves any configured Alchemy network at runtime (`ALCHEMY_<NET>_RPC_URL`) and proxies JSON-RPC through `POST /api/rpc/[network]`. Venue selection for spot and perpetuals is a separate decision.

Official sources reviewed:
- [Uniswap Trading API integration guide](https://developers.uniswap.org/docs/trading/swapping-api/integration-guide) and [supported chains](https://developers.uniswap.org/docs/trading/swapping-api/supported-chains).
- [CoW SDK documentation](https://docs.cow.fi/cow-protocol/reference/sdks/cow-sdk) and [Order Book API](https://docs.cow.fi/cow-protocol/reference/apis/orderbook).
- [Jupiter Swap API](https://developers.jup.ag/docs/swap), [order and execute](https://developers.jup.ag/docs/swap/order-and-execute), [rate limits](https://developers.jup.ag/docs/portal/rate-limits), and [plans and pricing](https://developers.jup.ag/docs/portal/plans).
- [Hyperliquid API overview](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api), [exchange endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint), [info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint), and [API wallets/nonces](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets).

## Phase 5 public market-data candidate — research only

Coinbase Exchange public market data is a candidate for the first read-only adapter, not an approved source. Its official documentation identifies market-data REST as public and shows `security: []` for `GET https://api.exchange.coinbase.com/products/{product_id}/book` and `/candles`. The production WebSocket feed is `wss://ws-feed.exchange.coinbase.com`; public ticker and level2 batch channels are documented without authentication, with heartbeats and sequence handling needed for continuity. REST candles allow at most 300 rows per request, omit intervals with no trades, and are not intended for frequent real-time polling. Coinbase states access is subject to its Market Data Terms of Use. No endpoint, product or data request is enabled; confirm terms, rate limits, product availability and exact scopes before implementation.

Official evidence reviewed: [public market-data and rate-limit overview](https://docs.cdp.coinbase.com/exchange/docs/rate-limits), [product book](https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproductbook), [product candles](https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproductcandles), [WebSocket overview](https://docs.cdp.coinbase.com/exchange/websocket-feed/overview), [WebSocket channels](https://docs.cdp.coinbase.com/exchange/websocket-feed/channels), and [Market Data Terms](https://www.coinbase.com/legal/market_data). Pages were read for documentation research only; no market-data API or WebSocket was contacted.

## Explicitly unresolved / separately gated

- The venue shortlist and provider review above are research notes.
- The Jupiter/Solana candidate does not settle wallet authentication: confirmed SIWE proves an EVM address only. A separate chain-appropriate Solana proof/link flow (such as SIWS) requires design review and user approval before implementation; it is not implied by this shortlist.
- No initial admin wallet is available yet; admin functions remain locked until the user provides it through the approved auth setup.
- Strategy acceptance thresholds (drawdown, profit factor and win rate) require user approval before any strategy is live.
- User-supplied CEX keys are optional and read-only first. Trading permissions require that key owner’s written approval per key; withdrawal permissions remain disabled. Do not request operator CEX credentials.
- Paid providers/services are disabled unless separately configured and cost-approved; budget is USD 0/month.
- Legal/jurisdiction risk is flagged for review before live enablement; it does not block local architecture work.

## Phase 2 acceptance checklist

- [x] User reviewed and approved the three Phase 2 documents.
- [x] Conflicts with `docs/ANSWERS.md` are resolved in favor of confirmed answers or raised for clarification.
- [x] Every venue/chain/endpoint remains disabled pending its own approval.
- [x] Security, role, ledger, audit, live-arm, kill-switch and failure-state requirements are explicit.
- [x] User sent the exact phrase **“architecture approved”** on 2026-10-13.

Phase 3 is authorized to proceed. The separate venue/chain/endpoint and deployment gates remain in force.

## Phase 5 implementation status — 2026-10-13

The user instructed “what other todo actions needed? do all.” In response, the following exact, read-only public scopes were implemented: Coinbase Exchange `GET /products/{product_id}/book?level=1`, `GET /products/{product_id}/candles`, public `wss://ws-feed.exchange.coinbase.com` ticker/heartbeat, Coinbase Exchange Status RSS (`https://status.exchange.coinbase.com/history.rss`), and nine validated public financial RSS feeds from `last-try/rss/rss-feeds.txt`: Bitcoin Magazine, Bitcoinist, CoinDesk, Cointelegraph, CryptoPotato, CryptoSlate, Decrypt, NewsBTC, and Crypto Briefing. The REST adapter does not call Coinbase's ticker endpoint; last-trade values come only from the public WebSocket. Exact HTTPS/WSS allow-list tests cover each configured URL; sandbox hosts and unapproved paths are rejected.

The Markets route uses one year of persisted Coinbase BTC-USD daily candles and shows a live public quote, source attribution, delayed-history status, and a per-feed RSS directory. The latest sync stored 208 headline metadata rows: 25 Coinbase Status notices and 183 items across the nine financial feeds. `proof/market-data-live.json` records unauthenticated HTTP 200 production book/candle responses, raw response bodies, provider timestamps and matching SHA-256 hashes. RSS descriptions and images are not stored. Tokenized RSS.app URLs from the CSV, Sharpe feeds returning 429/401, the HTML-only rsscrypto URL and placeholder URLs were excluded. The user must review the proof artifact before the Phase 5 exit gate and confirm RSS metadata-use terms before production redistribution. No authenticated exchange access, trading, order submission, wallet transaction, credential use or deployment occurred.