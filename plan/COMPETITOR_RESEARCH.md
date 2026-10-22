# Competitor research — what the market actually does (Veylora planning input)

Scope: the 19 URLs the owner listed. Method: public pages read directly; login-walled pages
were left unread rather than guessed at. Every factual claim below carries the page it came
from. Claims a vendor makes about itself (segregated funds, audits, certifications) are
marked as **vendor claims**, not verified facts.

Variable **names** only in this document — no secret values.

---

## 1. Quick scan

| Product | Category | Custody model | The one thing worth taking |
| --- | --- | --- | --- |
| ChainGPT | AI assistant + API | none (analysis only) | Paid-per-request AI credits, developer API/SDK as a product |
| OctoBot Cloud | Self-hosted + cloud bots | funds stay at exchange | Node **or** cloud; Strategy Designer with backtest compare |
| WunderTrading | Multi-exchange bot SaaS | exchange-side via API keys | One bot → up to 10 pairs × 50 API profiles; TradingView webhooks |
| Crypto.com | Custodial exchange + app | fully custodial | DCA/Grid bots with pause/resume/end and "sell or retain" choice |
| CryptoRobotics | Exchange bot + signals | exchange-side | AI Columbus: hourly retrain, entry-or-wait signal, demo futures account |
| AlgosOne | Delegated managed trading | **platform holds funds** | Time-limited one-click approval of proposed trades |
| AutoTraderBot | MT5/OANDA automation | broker-side | Economic-news pause; broker is the execution venue |
| AlgoBuilder | NL → strategy → MT5 | broker-side | Plain-English strategy → **visible, editable Python**; tick-level backtest |
| Screener.in AI | Document-grounded research | n/a (no trading) | Answer grounded in filings, no prompt engineering, pay-per-answer credits |
| Capitalise.ai | NL strategy automation | n/a here | Natural-language strategies, acquired by Kraken for its tech |
| Robinhood Agents | Brokerage + agent/MCP | fully custodial | **Dedicated agent account**: agent reads all, trades only that account; approvals on/off |
| Kraken | Custodial exchange | fully custodial | REST/WS/**FIX** APIs; "Kraken CLI for AI agents" |
| CoinTracking | Portfolio + tax | read-only imports | Read-only exchange API imports; own API with HMAC signing + rate limits |
| Perplexity Finance | AI research surface | n/a | Finance search tool; **page was JS-only, unverifiable** |
| Coinrule | No-code rule bot | exchange + on-chain | If/then rules, AI optimisation, **non-custodial on-chain via SAFE session keys** |
| Bitsgap | Multi-exchange terminal | exchange-side | Demo with $100k virtual funds, real prices and order books |
| CryptoHero | Exchange bot | exchange-side | 21 exchanges; paper exchange; explicit FAQ on *why* a bot idles |
| TradingView/Cointelegraph article | Educational news | n/a | The operational checklist: read/trade keys only, 2FA, IP allow-list, small capital |

Four custody archetypes exist in this list and Veylora must choose deliberately:
**analysis only** (ChainGPT, Screener, Perplexity), **exchange-side keys** (OctoBot,
WunderTrading, CryptoRobotics, Coinrule, Bitsgap, CryptoHero, AlgoBuilder, AutoTraderBot),
**read-only** (CoinTracking), and **platform-held funds** (AlgosOne, Robinhood, Kraken,
Crypto.com).

---

## 2. Per product

### ChainGPT — https://www.chaingpt.org/
- **Users:** traders, developers, businesses. The Trading Assistant is analysis, not execution.
- **Wallets/sign-in:** Web3 wallet connect for the assistant; no verified email/password path.
- **Chains/venues:** token analytics on crypto assets; **no verified execution venue**.
- **Flows:** no verified deposit/trade/withdrawal. Charges **1 CGPTc per assistant request**.
- **AI/automation/offline:** historical pattern detection over 1,000+ tokens, forecasts for
  BTC/ETH/SOL/BNB/XRP; no bot builder, no live execution → offline behaviour not applicable.
- **Admin/CRM:** none verified for the assistant.
- **API/pricing:** developer APIs/SDKs, staking-based freemium, models not open source
  (`docs.chaingpt.org/overview/faq`, `/ai-tools-and-applications/ai-trading-assistant`).
- **Trust/risk:** token audits refer to CGPT, not to assistant output quality.
- **Take:** metered AI per request; assistant kept separate from execution.

### OctoBot Cloud — https://www.octobot.cloud/dashboard
- **Access:** requested dashboard **redirects to sign-in**; features taken from public guides.
- **Users:** retail basket/DCA users plus strategy developers.
- **Wallets:** node "wallet" is a node identity, **explicitly not a crypto wallet**; exchanges
  connect by API key.
- **Venues:** Binance and Coinbase appear in examples; full list not verified.
- **Flows:** simulated trading works without API keys; real balances stay exchange-side.
- **AI/automation/offline:** DCA/grid/baskets/TradingView/AI strategies; **browser may close
  but the node must keep running**. Strategy Designer: backtest history, comparison, optimise.
- **Ops:** web/mobile monitoring, Telegram reports and emergency sell; FAQ warns the bot may
  use **all available funds**.
- **Pricing:** free / **$9.99** / **$29.99** per month, 7-day trials; no trade fees claimed.
- **Take:** offline continuity is a *stated product promise* with a documented prerequisite.
  Veylora must promise the same and own the runtime itself.

### WunderTrading — https://wundertrading.com/en/trader/dashboard/traders
- **Access:** the trader dashboard returned **403**; details from public product/terms pages.
- **Users:** retail traders, asset managers, developers.
- **Wallets/sign-in:** email/password; exchange API keys, **withdrawal permission required off**.
- **Venues:** spot + futures across many exchanges and Hyperliquid DEX (full matrix not readable).
- **Flows:** funds stay on the exchange; bot positions, history and logs are the visibility layer.
- **Automation/offline:** grid, DCA, signal/TradingView (webhooks), multi-grid, market-neutral,
  spread/arbitrage; marketed **24/7 cloud** execution.
- **Ops:** one bot up to **10 pairs × 50 API profiles**; SL/TP/trailing/breakeven/dynamic sizing.
- **API/pricing:** open API and **MCP** marketed; free lifetime plan + 7-day Pro trial.
- **Take:** signal ingestion by webhook and a documented public API/MCP are table stakes.

### Crypto.com — https://crypto.com/en
- **Users:** beginners through advanced; API serves institutions.
- **Wallets/sign-in:** custodial app/exchange (email/password, Apple ID, phone; **KYC required**)
  plus a separate self-custody Onchain Wallet.
- **Venues:** 400+ assets; spot, margin, perps, futures, OTC surfaces.
- **Flows:** bank/card/crypto funding, fiat deposits, network-fee withdrawals (2–3 hours),
  in-app transfer instant; **new withdrawal addresses locked 24 hours**.
- **Bots/offline:** DCA and Grid bots (DCA not in the app; Grid not in the Exchange App),
  TWAP, funding arbitrage; server-side by construction. Users can pause/resume/end and choose
  to sell or retain accumulated assets.
- **Ops:** active-bot list with aggregate P&L, per-bot detail, transaction-history export,
  price alerts, subaccounts, 2FA/passkeys.
- **API/pricing:** REST + WebSocket + **FIX**; bots carry **no bot fee** but normal trading
  fees apply.
- **Take:** the "pause / resume / end and decide what to do with the bag" control set, and the
  new-address withdrawal lock as a risk control the *owner* configures.

### CryptoRobotics — https://cryptorobotics.ai/ai-bot/
- **Users:** beginners to experienced; also signals/copy-trading and white-label.
- **Wallets/venues:** no wallet login verified; API keys across Binance, Bybit, Bitget, OKX,
  Kraken, KuCoin, Gate.io, MEXC, HTX, Blofin, XT (spot/futures/margin/DEX claimed).
- **Flows:** capital stays at the exchange; no platform deposit flow verified.
- **AI/automation/offline:** AI Columbus retrains hourly and signals entry **or wait**, long/short
  and hedging; 24/7 with mobile management; demo futures account with 3,000 USDT refreshed daily.
- **Ops:** analytics dashboard on free tier is 30 days; support channels exist.
- **API/pricing:** no public developer API found; pricing **inconsistent across pages** —
  10% of profitable trades vs 0.15% per order vs $699/month.
- **Take:** "entry or wait" is the honest AI state machine; demo capital that refreshes is a
  cheap onboarding win. Also: pricing must be unambiguous in our own product.

### AlgosOne — https://algosone.ai/ai-trading/ · https://algosone.ai/ai-crypto-trading/
- **Users:** hands-off investors who never configure a strategy.
- **Custody:** **the platform holds funds** — deposits to an AlgosOne account; vendor claims
  third-party segregated custody. This is the opposite of the Veylora model.
- **Flows:** **$300 minimum**, plan capital locked **12–24 months**, early exit forfeits profits
  and penalises principal; withdrawals in USDT/BTC/ETH/EUR/GBP/USD where available.
- **AI/offline:** proprietary ML trades 24/7; some orders need **one-click approval within a
  time limit** and expire otherwise; the rest auto-approve by tier.
- **Pricing:** no transaction fee but **up to 25% of profitable trades**, lower at higher tiers.
- **Trust:** Czech entity, FAU licence and segregated-funds claims; stop-loss/hedging and a
  5–10% per-trade balance cap claimed. **Vendor claims — unverified.**
- **Take:** the expiring-approval idea is genuinely useful UX; the lock-up and custody model is
  what makes this product feel untrustworthy — Veylora should be the opposite.

### AutoTraderBot — https://autotraderbot.ai/
- **Users:** forex/metals traders wanting prebuilt rule automation.
- **Wallets/sign-in:** email/password + email verification + optional 2FA (TOTP, email codes,
  backup codes); MT5 broker or OANDA; provider **cannot withdraw** from either.
- **Venues:** 16 FX pairs + XAU/XAG via MT5 and OANDA; no chains or exchanges.
- **Flows:** money stays at the broker; subscription billing via Stripe.
- **Automation/offline:** OANDA bots run **in the cloud**; MT5 needs the Windows client running.
- **Ops:** dashboard + performance reports, trial-expiry emails, Telegram announcements;
  terms mention desktop-client heartbeats and an internal admin view.
- **Pricing:** 30-day demo trial, monthly/yearly (yearly = two months free); amounts not extractable.
- **Take:** heartbeats and an explicit "cannot withdraw" statement about venue keys.

### AlgoBuilder — https://algobuilder.com/
- **Users:** idea → code → MT5 traders, no-code to quant.
- **Custody:** no wallet; broker credentials are **not stored in a cloud relay** — live orders
  flow from the user's machine to MT5.
- **Venues:** MT5 only for live; 1,602 markets claimed subject to broker availability.
- **Automation/offline:** plain-English or chart-drawn setups, AI emits **visible editable
  Python**, cloud backtests with tick data, spreads and slippage; live loop runs **locally**.
- **Ops:** contact form, feature requests, 24/7 live chat advertised; no CRM verified.
- **Pricing:** Free / **$20** Core / **$100** Pro / **$200** Quant per month, AI top-ups from $10.
- **Take:** generated strategies must be *inspectable and editable*, never a black box; backtests
  must model spread and slippage.

### Screener.in AI — https://www.screener.in/ai/
- **Users:** company-research investors. No trading, no custody, no brokerage connection.
- **Sign-in:** Google, Apple or email.
- **AI:** ask in plain English; the AI selects and reads official documents itself — **no uploads,
  no prompt engineering**; available from company pages.
- **Ops:** watchlists, saved screens, company/stock alerts; premium priority support.
- **Pricing:** **pay-per-answer** (₹10–30 typical, up to ₹100), token rates ₹100/million in,
  ₹800/million out; premium ₹4,999/year includes ₹500 credits.
- **Take:** document-grounded answers with per-answer metering and no user prompt work.

### Capitalise.ai — https://capitalise.ai/
- **Access:** **403 Forbidden** on the product and IBKR pages; a support article failed on a
  certificate error. Nothing about its own sign-in, custody or funding could be verified.
- **Verified only via third parties:** Kraken's blog announces it acquired Capitalise.ai's assets
  and technology with phased Kraken Pro integration; IBKR's contributor page confirms
  freestyle-text strategy creation, testing and automation.
- **Take:** the pattern (natural language → testable strategy → automation) is confirmed by two
  independent parties, but nothing about its live product should be copied on faith.

### Robinhood Agents — https://robinhood.com/us/en/agents/
- **Users:** retail customers directing built-in or third-party AI agents.
- **Model:** a **dedicated agent account** is opened; the agent **can read all accounts but trade
  only its own**; external agents connect over **MCP** after authentication.
- **Markets:** equities, options, crypto (Robinhood Crypto pairs); no external wallet transfers.
- **Tools:** portfolio/P&L, watchlists, market data, order review/place/cancel, scanners, alerts;
  market/limit/stop-limit/stop-market; **multi-leg options not supported by agents**.
- **Approvals:** built-in default **on**, external MCP default **off**, some orders always require
  approval; pending/past approval requests are visible. Continuous "Agent Loops" **coming soon**.
- **Ops:** activity history, order status, alert configuration and logs.
- **Trust:** warns agents can be wrong, act on stale data and be hard to stop; crypto not
  FDIC/SIPC protected; state restrictions.
- **Take:** per-agent account isolation with explicit read/trade scopes, and approval state exposed
  as data — both directly relevant to Veylora's MCP surface.

### Kraken — https://www.kraken.com/
- **Users:** retail buyers, active traders, developers/institutions.
- **Sign-in:** username/email + password with **passkey or authenticator app**; sign-in, trading
  and funding 2FA configurable **separately**. KYC before funding.
- **Venues:** 600+ crypto pairs, 11,000+ stocks/ETFs (US only for equities). Custodial, plus a
  separate self-custody product.
- **Flows:** Add Money → choose currency/method → user initiates transfer → email confirmation;
  crypto deposits need network confirmations; withdrawals from available balance, new addresses
  may need **email approval**.
- **API:** REST, WebSocket and **FIX** for spot/margin/futures; key permissions granular (order
  placement, cancellation, optionally deposit/withdrawal); keys treated as credentials with
  rotation advice. "Kraken CLI for AI agents" advertised; no consumer AI strategy builder.
- **Take:** separable 2FA scopes, passkeys, and permissioned API keys with per-scope toggles.

### CoinTracking — https://cointracking.info/
- **Users:** holders consolidating exchanges/wallets, mostly for tax.
- **Sign-in:** can be **anonymous — no email or phone** — with authenticator 2FA.
- **Venues:** imports for 400+ exchanges, wallets and blockchains; full list not readable here.
- **Flows:** no deposits, trades or withdrawals; import history → balances, P&L, gains, tax reports
  (25+ report types on the free plan). Read-only API keys that **cannot trade or withdraw**.
- **API/pricing:** own authenticated API with **HMAC-SHA512** signing, JSON responses, 20 req/hour
  (Pro/Expert) and 60/hour (Unlimited); free tier has **no API access**.
- **Trust:** ISO/IEC 27001:2017, EU data residency and GDPR claims; support Mon–Fri 08:00–18:00 UTC.
- **Take:** read-only imports are a trust-building first step for users who will not hand over
  trade keys, plus documented API rate limits per plan.

### Perplexity Finance — https://www.perplexity.ai/finance/crypto
- **Access:** **JS-only**; the page rendered only "Perplexity Finance". No wallet, venue, funding,
  bot, alert, pricing or compliance information could be verified. The related portfolio route
  rendered the same. A separate engineering post describes finance research tools and a Finance
  Search Tool for time-sensitive stock/crypto/FX lookups — **data retrieval, not execution**.
- **Take:** nothing may be assumed about this page; treat it as unread.

### Coinrule — https://coinrule.com/
- **Users:** no-code rule builders through to leverage/on-chain users.
- **Venues:** Binance, Coinbase, Kraken, Bybit, OKX, KuCoin, Hyperliquid named; tier limits of
  **1/3/5/unlimited** connections. On-chain automation on **Base, Arbitrum and BNB Smart Chain**
  using SAFE smart accounts and **session keys** (wallet sign-in method itself not verified).
- **Flows:** exchange funds stay at the venue and are aggregated without transfers; on-chain
  trades need wallet-approved smart-account transactions; not a deposit service.
- **Automation/offline:** rule templates, visual if/then, AI optimisation, Coinrule AI Cloud and
  "Agentic Mode"; **24/7 cloud** execution; 2/7/25/50 live rules by tier; TradingView signals,
  Telegram and text alerts.
- **API/pricing:** free / **$29.99** Investor / **$59.99** Trader / **$749** Pro per month with
  volume caps; estimator shows **0.02% of traded volume**; the Bybit guide requires **Read-Write**
  keys for order/position management while instructing no withdrawals — worth reconciling loudly
  in our own docs.
- **Trust:** claims API-call and transaction audit logs plus permission revocation.
- **Take:** per-tier connection and rule caps, plus session-key on-chain execution as a future path.

### Bitsgap — https://bitsgap.com/
- **Users:** multi-exchange terminal users, beginners to experienced.
- **Venues:** 17 exchanges via API keys (list not readable); demo signup is email-only, no exchange
  account, KYC or card.
- **Flows:** **does not hold or access funds**; portfolio tracking and manual trading alongside bots.
- **Demo:** **$100,000 virtual funds** with real prices and simulated order books; GRID/DCA/COMBO
  bots and manual trades supported.
- **Automation/offline:** grid, DCA/LOOP, COMBO/futures bots, smart orders, analytics, backtesting,
  AI Assistant on paid tiers, AI Portfolio Mode on Pro; **cloud trading 24×7×365**.
- **Pricing:** **$23/$55/$119** per month against $29/$69/$149, 7-day Pro trial without card, free
  plan; no trading commission claimed (exchange fees still apply).
- **Take:** the demo environment is the onboarding funnel — real prices, simulated books, no KYC.

### CryptoHero — https://cryptohero.ai/
- **Users:** preset beginners, custom spot/futures traders, white-label enterprise.
- **Venues:** **21 exchanges** in the public table (Binance, Coinbase, Kraken, Bybit, OKX, KuCoin,
  Crypto.com, Gate.io, Gemini, HTX, MEXC, Bitfinex, Bitget, BitMart, Indodax, Mandala, MetaX,
  OKX Europe, Tokocrypto, XT, Binance.US), spot/futures varying by venue.
- **Flows:** bots trade assets at the exchange; available balance is read from the exchange
  **Spot wallet** — margin/P2P balances and funds reserved by open orders may not show as available.
- **Automation/offline:** DCA, grid, arbitrage and futures bots; long/short, stop-loss, indicators,
  backtesting, paper trading; **24/7 while offline** promised. FAQ explains why a bot waits for
  entry conditions or deactivates for insufficient balance/invalid API permissions, with email error
  messages and restart behaviour.
- **Pricing:** **$19.99/mo or $199.99/yr** (15 bots), **$39.99/mo or $399.99/yr** (30 bots),
  enterprise quote; marketplace strategy rental billed separately; 14-day money-back.
- **Take:** the FAQ's explicit failure taxonomy — why a bot idled, which balance counted, what the
  API key lacked — is exactly the observability Veylora needs.

### TradingView news / Cointelegraph — https://www.tradingview.com/news/cointelegraph:7aa605837094b:0-how-to-set-up-and-use-ai-powered-crypto-trading-bots/
- **Not a product** — a republished educational article. No account, wallet or execution flow.
- **Its operational checklist** is the useful part: separate fixed-rule from ML bots; configure
  pair, order size, stop-loss/take-profit, cooldown and position limits; backtest first; keep
  monitoring; disable **API withdrawal permissions**, enable **2FA and IP restrictions**, start with
  small capital, review execution logs/slippage/fees, and alert on failed orders and drawdown.
- **Take:** this is the minimum viable risk-control UX, and it matches the owner's own rule that
  limits live in the admin panel as data.

---

## 3. Cross-product comparison

**The journey everyone assumes.** Sign in → connect or fund something → see balances → start
automation → keep it running while the browser is shut → withdraw and confirm the money moved.
Veylora's canonical 20-USDT journey is the same spine; the differentiator is that Veylora owns the
funding leg instead of delegating it to an exchange.

**Recurring patterns worth having, with no copying of protected text or design:**
1. **Offline continuity is a headline promise.** OctoBot, WunderTrading, CryptoRobotics, Coinrule,
   Bitsgap, CryptoHero and Crypto.com all assert server-side/cloud execution. Veylora must make the
   same claim true, and state the prerequisite (our runtime, not the user's machine).
2. **Approvals exist, but as data.** Robinhood's dedicated agent account sets read-all/trade-one
   scoping and exposes pending approvals; AlgosOne's expiring one-click approval is a good pattern.
   Both are configuration the owner controls, never an AI-authored gate.
3. **Demo/paper capital is the standard onboarding funnel** (Bitsgap's $100k, CryptoRobotics' 3,000
   USDT refreshed daily, CryptoHero's paper exchange, OctoBot's simulation without API keys).
4. **The failure taxonomy is a feature.** CryptoHero's FAQ explains *why* a bot sat idle. Veylora's
   bot detail view should always answer "why did nothing happen".
5. **Per-tier connection and rule caps** (Coinrule 1/3/5/∞, CryptoHero 15/30 bots) — a clean,
   honest monetisation axis that does not touch the user's funds.
6. **Granular, revocable keys and scoped 2FA** (Kraken's separate sign-in/trading/funding 2FA,
   CoinTracking's read-only imports, permissioned API keys everywhere) — read-only first, write
   only when needed, withdrawals never.
7. **Explicit "we cannot withdraw your funds" statements** (WunderTrading terms, AutoTraderBot,
   CryptoHero, Bitsgap, Coinrule docs) — trust copy that costs nothing and answers the first question
   every user has.
8. **Inspectable AI output** (AlgoBuilder's visible editable Python; Screener's document-grounded
   answers; OctoBot's Strategy Designer) — never a black box.
9. **Metered AI** (ChainGPT 1 CGPTc/request, Screener's ₹ per answer) — a cost model for our
   assistant and research surfaces.
10. **Multi-venue aggregation without moving funds** (WunderTrading, Bitsgap, Coinrule, CryptoHero)
    — useful even for a platform that also accepts deposits.

**Gaps and failure modes we can exploit:**
- **Pricing confusion is endemic.** CryptoRobotics shows three incompatible fee models; AlgosOne
  quotes "free" then up to 25% of profitable trades; Coinrule's marketing says read-only while its
  own setup guide needs write keys. Veylora's admin-configured fee table and one truthful fee page
  is a real differentiator.
- **Lock-ups destroy trust.** AlgosOne's 12–24 month lock-up with principal penalties is the
  cautionary tale; Veylora's deposit-and-withdraw-anytime journey is the answer.
- **Nobody shows the operator side.** Not one product here documents a real admin/CRM/audit console
  (CoinTracking's reports are not an audit log; AutoTraderBot's terms mention an internal admin view
  only). Owner-facing operations — users, balances, strategies, keys, risk limits, audit trail,
  support tickets — is an uncontested advantage for a single-owner platform.
- **Offline behaviour is promised, rarely explained.** Where the loop runs, what happens on a
  restart or a deploy, whether state survives — mostly undocumented. Veylora should document and
  show it (heartbeats, last-run, next-run, resume-after-deploy).
- **Portfolio/tax and transfer-in-place are underserved** — CoinTracking is read-only with no
  execution; nobody in this list joins read-only aggregation to live execution in one account.

**Explicitly not to copy:** vendor-asserted guarantees (segregated funds, no-loss claims, licence
wrapping), lock-ups and exit penalties, custody of user funds with delegated discretion, opaque
"AI" marketing with no visible reasoning, and any wording or visual design lifted from these sites.

---

## 4. Inaccessible pages and open uncertainty

| Page | Result | What remains uncertain |
| --- | --- | --- |
| https://wundertrading.com/en/trader/dashboard/traders | **403** | Trader-dashboard layout, login options, per-trader controls |
| https://wundertrading.com/en/supported-exchanges and /pricing | **403 / no readable text** | Full venue matrix; exact plan prices and caps |
| https://www.octobot.cloud/dashboard | redirect to sign-in | In-app screens, plan gating inside the product |
| https://capitalise.ai/ and /interactivebrokers/ | **403** | Everything about its own product: sign-in, custody, funding, runtime |
| https://capitalise.ai support article | certificate error | Support/help UX |
| https://www.perplexity.ai/finance/crypto | **JS-only shell** | All nine dimensions for that route |
| https://cryptorobotics.ai pricing | inconsistent between pages | The actual fee model |
| Screener.in / CoinTracking / Bitsgap / CryptoHero pricing | partially extracted | Exact tier amounts and caps in some cases |

Unauthenticated dashboards are the single biggest blind spot: the *logged-in* experiences of
OctoBot, WunderTrading, CoinTracking and Perplexity could not be observed at all, so anything about
their admin surfaces, alert configuration or audit views is unverified.

## 5. Research → phase mapping

| Finding | Lands in |
| --- | --- |
| Offline/24-7 promises, heartbeats, resume-after-deploy | 05, 24 |
| Dedicated agent account, read-all/trade-one scopes, approvals as data | 11, 26, 32 |
| Demo/paper capital and a paper-vs-live switch | 23, 30 |
| Failure taxonomy: why a bot idled | 04, 24 |
| Per-tier caps on connections, rules and bots | 16, 30 |
| Read-only-first keys, scoped 2FA, passkeys, revocable permissions | 10, 11, 20 |
| "We cannot withdraw your funds" trust copy | 15, 20 |
| Inspectable AI output; metered AI per request | 27, 28 |
| Multi-venue aggregation without moving funds | 18, 20 |
| Honest fee table and one truthful pricing page | 16, 40 |
| No lock-ups; withdraw anytime | 12, 14 |
| Owner-facing admin, CRM and audit console | 34, 35, 36 |
| Read-only portfolio imports plus tax-style reporting | 15, 18 |
| Signal ingestion (webhooks, Telegram) and public API/MCP | 29, 31, 32 |
| NL → strategy, tick-level backtest with spread and slippage | 28 |
| Venue-key and secret hygiene (rotate, never commit) | 01, 39 |
