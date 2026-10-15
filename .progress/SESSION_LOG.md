# Session log

## Current state (2026-10-15)

- `apps/web` is the Next.js app; `typecheck`, the test suite and `pnpm build` pass.
- Multi-network RPC: `apps/web/src/lib/rpc/networks.ts` resolves any configured
  `ALCHEMY_<NETWORK>_RPC_URL`, and JSON-RPC is proxied through `POST /api/rpc/[network]`.
- The market assistant is tool-using (`lib/assistant/public-market-adapter.ts`,
  `app/api/assistant/route.ts`).
- Sign-in accepts any EVM chain id listed in `AUTH_EVM_CHAIN_IDS`.
