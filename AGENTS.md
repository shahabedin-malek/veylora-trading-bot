# AGENTS.md — Veylora (`trading-ai`) working notes for coding agents

This is the human owner's private repository. The owner is the final authority.

## Non-negotiables

- Never print, commit, or paste secret **values** (`.env`, `pass`, Vercel).
  Variable **names** are fine.
- The legacy reference trees (`old/`, `last-try/`, `old-scripts/`, `qwen/`,
  `solar-pro/`, `tools/`, `php/`, `ssh/`, `data/`) are **not** part of this
  repository. They live at `/mnt/private-ai-data/trading/` and scripts reach them
  through the `VEYLORA_EXTERNAL_DATA` path (default `/mnt/private-ai-data/trading`).
  Do not mass-delete across them.
- Do not commit, push, or deploy unless the owner asks.

## Layout

- `apps/web` is the Next.js app. Run every pnpm command **from `apps/web`**
  (`pnpm-workspace.yaml` + `pnpm-lock.yaml` live there).
- Local pnpm gotcha: use `pnpm --config.verify-deps-before-run=false <script>`.
