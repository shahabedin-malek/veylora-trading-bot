# Repository notes — Veylora (`trading-ai`)

Short, factual notes for editors and agents. The owner is the final authority.

## Secrets

- Never print, commit, or paste secret **values**. Refer to variables by **name**.
- Server keys (Alchemy, AI Gateway, session, database) must not use a
  `NEXT_PUBLIC_` / `VITE_` prefix — those are compiled into the browser bundle.
- `.env.example` holds placeholders only; real `.env*` files are git-ignored.

## App

- `apps/web` is the Next.js app (package `web`, `pnpm@11.15.1`).
  `pnpm-workspace.yaml` and `pnpm-lock.yaml` live **inside `apps/web`** — run every
  command from that directory.
- Local gotcha: use `pnpm --config.verify-deps-before-run=false <script>`.
- Scripts: `test`, `lint`, `typecheck`, `build`, `scan:secrets`, `check:real`,
  `check:gate-copy`.
- `check_gate_copy.mjs` holds the user-facing copy the owner has ruled out
  (`GATE_PHRASES`) and fails with `file:line` if any of it reappears under
  `apps/web/src`. Reword the copy, or amend that list deliberately.

## Alchemy / networks

- The Alchemy key is **account-wide**. Each enabled network has an
  `ALCHEMY_<NETWORK>_RPC_URL` variable; the shared key is `ALCHEMY_API_KEY`.
  Authoritative names live in `/home/chris/env/alchemy.env` and the Vercel project.
- The app resolves a network to its endpoint at runtime in
  `apps/web/src/lib/rpc/networks.ts` and proxies JSON-RPC through
  `POST /api/rpc/[network]` (e.g. `/api/rpc/ethereum`, `/api/rpc/base-mainnet`).
  The key is server-side only and never reaches the browser.
- Networks are discovered from the environment — there is **no** hand-maintained
  network list in code or docs.
