# Free API Provider Roadmap

**Status date:** 2026-10-14  
**Budget:** USD 0/month. No paid tier, automatic overage, trading permission, deployment, or credential pasted in chat is authorized by this roadmap.  
**Authority:** `docs/ANSWERS.md`; exact chains, venues, endpoints, commercial terms, and live trading remain separate gates.

## Connected or Implemented

| Provider | Current state | Cost / access | Notes |
|---|---|---|---|
| Coinbase Exchange public market data | Connected for public quotes, candles, and ticker updates | No API key for public endpoints | Current public market-data source. Not a private balance/order connection. |
| RSS feeds | Connected: Coinbase Status and nine financial feeds | Public RSS | Publisher metadata-use/redistribution review remains open. |
| Tavily Search/Extract | Implemented on `/research`; keyless smoke tested; admin switches default off | Free, rate-limited, no key | Basic Search/Extract only. Never connected to trading/risk decisions. CLI OAuth is separate from the website. |
| Alternative.me Fear & Greed | Reader and attributed Markets panel implemented locally; admin switch remains off. One live smoke read returned 62/100 (Greed), observed 2026-10-14 | No key; 60 requests/minute over a rolling 10-minute window; upstream updates every 5 minutes | Commercial use allowed with attribution. Informational only; never a trading/risk input. Provider may change or discontinue service. |
| Alchemy multi-network RPC | Connected: account-wide key configured; the app resolves any network at runtime and proxies JSON-RPC via `POST /api/rpc/[network]` | Free tier includes 30M compute units/month; overage is paid | Per-network endpoints are `ALCHEMY_<NET>_RPC_URL`; the key is server-only and never reaches the browser. |
| Coinbase Advanced, Kraken, Binance user credentials | Encrypted per-user credential flow exists; no user keys connected | Depends on each user's own account/key permissions | Balance reads only here. No withdrawals or order execution. |
| WunderTrading | User-owned read-only profile/strategy/history support exists; no key connected; switches default off | Requires a user-owned WunderTrading API key | Trading actions are not callable. No withdrawal permission. |

## Candidates and Restrictions

| Provider | Useful for | Free access / limit | Production status |
|---|---|---|---|
| DefiLlama | TVL, chain and protocol context | `GET https://api.llama.fi/v2/historicalChainTvl/Ethereum` is documented as a free public endpoint; no API key | **Blocked for Veylora product use pending prior written commercial-use consent.** Terms §8(10) prohibit commercial exploitation of Content & Data without that consent; press-use permission is not a product license. Endpoint is a research candidate only; no request or integration. [API docs](https://api-docs.defillama.com/) · [Terms](https://defillama.com/terms) · [Press use](https://defillama.com/press) |
| GeckoTerminal | DEX pools, tokens, trades and OHLCV | Public no-key API, approximately 10 calls/minute, one-minute cache; beta | **Candidate.** Ethereum network identifier is `eth`; exact pool/pair route and commercial/free-tier rights need written clarification. Docs direct higher/stabler limits to paid CoinGecko plans; CoinGecko API terms are plan-dependent and restrict redistribution/storage. No request or integration. [API docs](https://api.geckoterminal.com/docs/index.html) · [CoinGecko API terms](https://www.coingecko.com/en/api_terms) |
| DEX Screener | DEX pair/token discovery and market metrics | Public API; pair lookup documented at `GET https://api.dexscreener.com/latest/dex/pairs/ethereum/{pairId}` | **Candidate.** API terms allow commercial use but prohibit competing products and making the API or any portion available to third parties. Whether Veylora's pair-data display fits those limits needs provider clarification; exact Ethereum pair IDs also need user approval. No request or integration. [API reference](https://docs.dexscreener.com/api/reference) · [API terms](https://docs.dexscreener.com/api/api-terms-and-conditions) |
| CoinPaprika Free | Broad price, market-cap, exchange and daily-history fallback | No key to start; 20,000 requests/month, 2,000 assets; up to 10-minute update delay | **Do not use on the public production site:** free plan is Personal use and prohibits redistribution. [Official plan terms](https://docs.coinpaprika.com/api-plans) |
| CoinGecko keyless / Demo | Broad market data and metadata for prototypes | Keyless roughly 10–30 calls/minute; Demo key 10,000 credits/month and 100 calls/minute | **Do not use as a production feed:** keyless is unsuitable for production/scheduled workloads; Demo pricing does not grant commercial redistribution. [Keyless docs](https://docs.coingecko.com/docs/keyless-public-api) · [Pricing](https://www.coingecko.com/en/api/pricing) |
| NewsAPI Developer | General news search for development | 100 requests/day; 24-hour delay | **Development/testing only**, not staging or production. [Official pricing and restrictions](https://newsapi.org/pricing) |
| Etherscan Free | Explorer/account/contract data for experiments | 3 calls/second, up to 100,000/day, selected chains | **Personal/research use.** Not a production/commercial endpoint. [Official API plans](https://etherscan.io/apis) |

## Ordered Tasks

1. **[x] T01 — Add Alternative.me sentiment context.** Implemented a fixed-host, read-only Bitcoin sentiment adapter with source/time attribution and five-minute caching. Admin toggle defaults off. It does not alter risk, orders, or strategies. Parser/cache tests pass; one live smoke read returned 62/100 (Greed), observed 2026-10-14.
2. **[blocked] T02 — Add selected DefiLlama public context.** Research candidate: Ethereum-only `GET https://api.llama.fi/v2/historicalChainTvl/Ethereum`. Do not implement or call it for Veylora until DefiLlama gives prior written consent for commercial use under Terms §8(10). Exclude API-plan-only and retiring legacy yield routes. Any future display must be labeled provider context, not verified wallet balances.
3. **[blocked] T03 — Review DEX data terms and exact chain scope.** Research candidates are GeckoTerminal network `eth` and DEX Screener's Ethereum pair-lookup route. No chain/pair/provider is approved. Obtain user approval for exact chain, pair IDs and endpoint; obtain written provider clarification on commercial display, free-tier rights and third-party access before implementation.
4. **[ ] T04 — Add approved DEX analytics adapters.** Implement only after T03, with fixed HTTPS hosts, response bounds, rate limits, provenance, attribution, and no order/signing methods.
5. **[ ] T05 — Keep restricted free tiers excluded.** CoinPaprika Free, CoinGecko keyless/Demo, NewsAPI Developer, and Etherscan Free remain excluded from production unless the provider grants suitable commercial rights at zero cost. Paid plans require a separate budget decision and are outside the current scope.
6. **[ ] T06 — Verify and review.** Run tests, lint, typecheck, production build, endpoint/secret scans, and a bounded live smoke test only for the enabled no-cost endpoint. Obtain user review of attribution and source terms before publishing results.

## Credential Handling

- Do not send API keys, OAuth codes, or key-bearing MCP URLs in chat. The Tavily, WunderTrading, ChainGPT, and other credentials previously pasted are compromised; revoke/rotate them privately.
- Providers that support public/keyless endpoints should use those where their terms permit. If a future approved service requires a key, the owner adds it privately to the deployment secret manager; the website shows readiness only and never displays or accepts deployment secrets.
- User-owned exchange credentials continue through the existing encrypted, account-bound credential manager. They are not operator credentials and do not grant Veylora trading permission.
- No provider result may directly trigger an order, change risk limits, verify funds, or approve an asset/chain.