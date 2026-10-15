# Session checkpoint

## Current status
- `apps/web` is the Next.js app; `typecheck` and the test suite pass.
- Implemented locally: public Coinbase market data, RSS metadata, portfolio reads,
  bots/backtesting, paper trading, admin console, and a tool-using market assistant.
- Multi-network Alchemy RPC resolves any configured `ALCHEMY_<NET>_RPC_URL` and is
  proxied through `POST /api/rpc/[network]`.
- Live venue/chain wiring and deployment are set by the owner.
