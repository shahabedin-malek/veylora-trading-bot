# Proof Artifacts

`market-data-live.json` contains public, unauthenticated Coinbase Exchange production level-1 order-book and daily-candle responses for BTC-USD. It records provider/fetch timestamps, request URLs, HTTP statuses, raw response text and SHA-256 hashes. Recreate it with `pnpm --dir apps/web market-data:proof`.

The artifact contains no account data, credentials, private keys, seed phrases, or authenticated headers. Review source, timestamps and response hashes before accepting the Phase 5 exit gate. Never store secrets or unredacted sensitive headers in this directory.