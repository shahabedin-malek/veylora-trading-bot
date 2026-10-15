# `last-try/` Survey Checkpoint

**Date:** 2026-10-13  
**Workstream:** Veylora Workstream 1 survey plus Workstream 2 structural recheck  
**Status:** Partial; 
## User constraints

- `last-try/` is reference-only and ideas-only under `REBUILD_PROMPT.md` §4. It is not authoritative, does not override `docs/ANSWERS.md`, and must never be copied wholesale.
- Secret reports must contain paths, secret types, and service names only—never values, raw lines, or copied tokens.
- Quarantine/edit/move/delete actions require the user's approval. Never commit files that contain live keys. Before Phase 3 `git init`, a secrets-excluding `.gitignore` must exist first.
- Approval sequence: first secrets handling plan, then repo move plan, then reuse plan. Phase 2 waits on all three. No CEX credentials are to be requested or expected.
- Phase 1 remains not green; Phase 2 is blocked. The 7-day goal does not reduce safeguards.

## Read-only structure captured

- Root is present and contains an existing `.git` directory; this outer workspace is - The authoritative path-only manifest `docs/LAST_TRY_TREE.txt.gz` contains 179,907 records: 11,589 directories, 168,280 files, and 38 symlinks (0 other/bad records). It was re-read and each path was checked to still exist; 0 missing paths were found. The manifest contains path, entry kind, and file size only, - Total tree size observed with `du`: 7.8G.
- Major root areas: `apps/web`, `coinbase` (vendor docs), `data` (corpus DBs/manifests/backups), `docs`, `scripts`, `signals`, `rss`, `logs`, `.progress`, plus root prompt/credential/export files.
- `apps/web` is a Next.js 16 / React 19 / TypeScript application with Tailwind 4, Prisma, Wagmi/Viem, RainbowKit, Vitest, Playwright, and Solidity/Foundry contract material. SQLite schema and paired PostgreSQL migration set are present. Important routes include login, dashboard, markets, trade, portfolio, wallet, support, admin, and API routes for health, webhooks, cron; detailed paths are available from `find` output in conversation and the complete compressed manifest.
- App lib modules include SIWE/auth/session, custody/signers, wallet swaps (Uniswap v3/0x), market data (CoinGecko/FinHub), credentials, risk/execution, portfolio, signals/backtest, lending/Aave/Morpho, arbitrage, autopilot, deposits/withdrawals, decision layer, compliance, audit/idempotency. All are ideas/evidence only, - `apps/web/tests` includes unit, integration, live/provider, and Playwright e2e suites (at least 99 test files observed; path listing included in conversation). Test configs run Vitest serially for shared SQLite and Playwright with Chrome. No tests were run for this - Prisma schema has SIWE wallet users/roles, wallet, ledger, portfolio, trading sessions/events, transactions, - `coinbase/` is a split Coinbase CDP documentation collection, - Huge vendored dependency and build trees exist (`
## Secrets scan state — partial, values never printed

A safe content scan of selected text/config/project files excluded `.git`, `
### Strongly named credential candidates (type inferred from name/config field only)

- `last-try/Alchemy.txt` — likely Alchemy RPC/API key(s), possibly sample or mixed export; exact live status unverified.
- `last-try/cdp_api_key.json` — Coinbase CDP API credential/private-key field; treat as sensitive.
- `last-try/cdp_wallet_secret.txt` — Coinbase CDP wallet secret; treat as sensitive.
- `last-try/coinbase-api-and-docs.txt` — Coinbase CDP/API key material and possibly private-key/seed examples in a mixed export; manual redacted review required.
- `last-try/Etherscan.txt` — likely Etherscan API key/config value; live status unverified.
- `last-try/reown-info.txt` — likely Reown/WalletConnect project ID/config; project ID may be public but classify as potentially sensitive until owner confirms.
- `last-try/tiger-cloud-db-51231-credentials.txt` — Tiger Cloud database credentials, including username/password fields.
- `last-try/tigerdata.txt` — TigerData/Tiger Cloud credentials/config, including password field.
- `last-try/vercel-token.txt` — Vercel access token.
- `last-try/apps/web/.env` — sensitive app configuration fields: database URL, session secret, RPC endpoints/keys, wallet project ID, custody key identifiers, credential-encryption key, owner allow-list and provider settings. Values were not displayed.
- `last-try/apps/web/.env.local` — Vercel OIDC token field.
- `last-try/apps/web/.env.deploy` — Vercel token, database URL and Tiger Cloud project/service/key fields.
- `last-try/pg_service.conf` — PostgreSQL host/user/database config; no password field found in the limited key-name scan, but treat as sensitive connection metadata until reviewed.

Other selected documents had generic credential-shaped or mnemonic/key examples matching broad patterns, including `last-try/REFINED_FINTECH_CRM_FREEBUFF_PROMPT.md`, `last-try/signals/signals.txt`, and some vendor docs. These are not confirmed live credentials; a stricter classifier and redacted human review are required before adding them as findings.

**Paid-service names surfaced by sensitive config fields or credential filenames (not proof of active paid subscriptions):** Alchemy, Coinbase CDP, Etherscan, Tiger Cloud/TigerData, Vercel. Reown/WalletConnect project configuration also surfaced; paid status is unknown. Never infer a paid plan, usable quota, or current key validity.

### Proposed handling — 
1. Treat the strong candidates above as secret-bearing until manually verified. Keep current originals untouched while awaiting approval.
2. If user approves handling, migrate only currently active values into a new local `last-try/apps/web/.env` or equivalent secrets manager that is git-ignored; verify application access without printing values. Do not overwrite existing `.env` without a reviewed per-key migration plan.
3. For credential/chat export `.txt` files (`Alchemy.txt`, `cdp_wallet_secret.txt`, `coinbase-api-and-docs.txt`, `Etherscan.txt`, `reown-info.txt`, `tiger-cloud-db-51231-credentials.txt`, `tigerdata.txt`, `vercel-token.txt`, and `signals/signals.txt`), propose producing a redacted archival copy outside the future Git worktree and then excluding originals from the new repository only after explicit approval and successful key rotation/migration. Do not edit or delete these now.
4. `cdp_api_key.json`, `.env`, `.env.local`, `.env.deploy`, and any actual private-key/seed source should remain outside the new Git repository; do 5. Rotate any credential confirmed live/exposed through provider consoles. Rotation itself is an external/account action; obtain user authorization before doing it. No credentials should be requested from the user for CEX access.
6. Before Phase 3, prepare and review a root `.gitig
## Workstream 2 Phase 1 recheck

Ran in this session with explicit captured status:

```text
python3 scripts/validate_phase1.py         exit 0
python3 scripts/verify_phase1_checkpoint.py exit 0
```

Both are structural checks only. They report 236 unique disposition paths (14 detailed rows + 222 ## New survey helper

`scripts/inventory_last_try.py` was created. It reads filesystem metadata only (
## Required next session steps

1. Re-read this checkpoint, `docs/LAST_TRY_CONTINUATION_PROMPT.md`, the user's latest message, `docs/ANSWERS.md`, inventory/reuse docs, and the authority rules in `REBUILD_PROMPT.md`/`REBUILD_TODO.md`.
2. Reconcile manifest item counts with a fresh filesystem scan and inspect all project-owned `last-try` structure (including hidden/ignored files); record stack/routes/models/tests and idea-only lessons without quoting secret material.
3. Complete a secret scan using safe output (paths/categories/services only), with coverage declared for every file type/area. Do 4. Finalize a single batched secrets inventory plus per-file proposed quarantine handling, and name service categories only. No file action until user approval.
5. Keep Workstream 1 (6. Do 7. At Phase 3 start, `git init` must be first, preceded by a reviewed secrets-excluding `.gitig