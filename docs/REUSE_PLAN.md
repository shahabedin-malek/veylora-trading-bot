# External code reuse notes

Technical fit and license facts for third-party code worth studying. Source trees
live under `/mnt/private-ai-data/repo`. This is a study list; the owner sets policy.

## License caution
- GPL / AGPL / LGPL sources are copyleft. Analyse compatibility before copying a
  single line; a permissive root license does not clear a copyleft component header.

## Worth a closer look
- **Portfolio analytics** — `trade-journal-main/packages/core/src/` (`round-trips.ts`,
  `returns.ts`, `analysis.ts`, MIT). Pure TypeScript trade-cycle reconstruction; map
  event fields explicitly and keep `null` for missing inputs.
- **Wallet-connected DEX swap helper** — `lending-repo/web3-ethereum-defi-master/eth_defi/uniswap_v3/swap.py`
  (MIT). Uniswap V3 recipient/slippage builder. Its default deadline is forever —
  bound it before use.
- **Market data / strategy examples** — `ai-hedge-fund-crypto-main` (MIT). Readable
  normalization and signal examples; not production-ready as-is.
- **Quote freshness / null semantics** — `Vibe-Research-main` (MIT). Useful UI
  reference for rendering unavailable vs zero.

## Avoid
- Server-side / hot-wallet signing, flash-loan / MEV / arbitrage bots, and any
  seed-phrase handling. A permissive license is not a security review.
- Anything without a root or component license.
