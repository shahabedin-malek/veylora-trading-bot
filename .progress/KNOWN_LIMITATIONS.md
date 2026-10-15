# Known limitations

Factual limitations of the current build.

- EVM SIWE auth verifies EOA ECDSA signatures; EIP-1271 contract-wallet
  signatures are not supported.
- Sign-out revokes all of a user's sessions via `sessionVersion`; individual
  session revocation is not implemented.
- The public Coinbase WebSocket can report `SEQUENCE GAP`; the UI surfaces it and
  does not claim stream continuity.
- UI account, price, portfolio and activity states are unverified where no data
  source is configured; no financial values are fabricated.
- The `last-try/` secret scan is partial. Never emit secret values or raw matching
  lines.
