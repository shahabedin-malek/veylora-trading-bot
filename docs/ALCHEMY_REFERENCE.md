# Alchemy reference

**Source:** [`last-try/Alchemy.txt`](../last-try/Alchemy.txt) (reference only; not
copied into the application).

## Current state

- The Alchemy key is **account-wide**. Every enabled network has a
  `ALCHEMY_<NETWORK>_RPC_URL` variable (150+ networks; authoritative names in
  `/home/chris/env/alchemy.env` and the Vercel project `veylora-fintech-ai-trading`).
  The shared key is `ALCHEMY_API_KEY`.
- The app resolves a network to its endpoint at **runtime** in
  [`apps/web/src/lib/rpc/networks.ts`](../apps/web/src/lib/rpc/networks.ts) and
  proxies JSON-RPC through `POST /api/rpc/[network]` — e.g. `/api/rpc/ethereum`
  (alias for `ethereum-mainnet`) or `/api/rpc/base-mainnet`.
- Networks are discovered from the environment, so every enabled network works
  without a hand-maintained list. The key stays server-side and is never sent to
  the browser.
- An older key value was exposed in git history and must not be reused. The
  current `ALCHEMY_API_KEY` / `ALCHEMY_<NET>_RPC_URL` values are separate from it.

## Alchemy CLI

Installed and authenticated from `pass`. Always run as an agent:

```bash
alchemy --json --no-interactive <command>
```

Useful reads: `config status`, `evm data balance <address> -n <network>`,
`evm block <number> -n <network>`, `evm gas -n <network>`,
`evm rpc <method> [params] -n <network>`, `evm network list`.
