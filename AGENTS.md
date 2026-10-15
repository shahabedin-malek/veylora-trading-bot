# AGENTS.md — Veylora (`trading-ai`) working notes for coding agents

## Commands

- `apps/web` is the Next.js app, and `pnpm-workspace.yaml` + `pnpm-lock.yaml` live
  there — run every pnpm command **from `apps/web`**.
- Local pnpm gotcha: use `pnpm --config.verify-deps-before-run=false <script>`.
- `scripts/` holds standalone Python/Node utilities (state summary export, legacy
  corpus inventory, secret-safe batch scanners). They are not part of the app build.
- CI lives in [.github/workflows/ci.yml](.github/workflows/ci.yml) and runs
  `typecheck`, `test` and `build` from `apps/web`.

## Paths outside the repository

The legacy reference trees (`old/`, `last-try/`, `old-scripts/`, `qwen/`,
`solar-pro/`, `tools/`, `php/`, `ssh/`, `data/`) live at
`/mnt/private-ai-data/trading/`, and scripts reach them through the
`VEYLORA_EXTERNAL_DATA` path (default `/mnt/private-ai-data/trading`).
`/mnt/private-ai-data/trading/archived-from-project/` holds report and planning
documents that previously sat in `docs/`.

## Secrets

- Refer to configuration by variable **name** only — never print, commit or paste
  secret **values** from `.env`, `pass`, Vercel or the database.
- The owner drives commits, pushes and deployments.
