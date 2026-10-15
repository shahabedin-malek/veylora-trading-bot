# `last-try/` Secret Inventory Work Ledger

**Status: PARTIAL / NOT EXHAUSTIVE.** This ledger records findings by path, secret category, and service name only. It must never contain credential values, value fragments, raw matching lines, or unredacted scanner output.

## Source scope and safety

- Input path list is the existing `docs/LAST_TRY_TREE.txt.gz`; the last reconciliation verified 179,907 entries. Do not restart by walking `last-try/` from scratch. Compare the manifest to current filesystem only when needed.
- Content scan excludes `.git`, packed Git objects, `- The broad scanner attempt timed out before yielding output. A later selected text/config scan was bounded and redacted (only paths/categories/services emitted), but did not scan every regular file or identify exact known-live validity.
- Findings from credentials-named exports/config paths are **potential secret-bearing files**, not proof the keys are live or paid. A provider name is not proof of a paid subscription or usable quota.

## Resumable scan batches

| Batch | Exact file set | Method | Status | Output |
|---|---|---|---|---|
| LTS-01 | Root named credential/export files and `apps/web/.env*`, plus `pg_service.conf` | Read bounded files into process memory; display only field names, categories, path, and inferred service; do not print values | partial done | Candidate list below |
| LTS-02 | 1,002 project/| LTS-03 | Remaining source files from manifest outside excluded generated/vendor paths | Pending bounded, parallel chunks; use workers with capped memory; redact output; persist batch index/status before/after each chunk | pending | Not yet scanned |
| LTS-04 | Excluded binary/database/vendored/build areas | Decide whether feasible/necessary; use a scanner that produces only path/category/service results and bounded batches | pending | Not yet scanned |
| LTS-05 | Human classification of heuristic hits | Read only in memory with redaction; distinguish documentation examples from possible live credentials without copying values | pending | Not yet complete |

## Candidate files (paths + types + service only; no values)

These are currently strong path/config candidates. Keep originals untouched until the user approves handling. Exact value/live status was not determined.

| File path | Potential secret type | Service / system |
|---|---|---|
| `last-try/Alchemy.txt` | RPC/API key or token; mixed export may also contain wallet/private-key examples | Alchemy |
| `last-try/cdp_api_key.json` | API key identifier and private-key field | Coinbase CDP |
| `last-try/cdp_wallet_secret.txt` | Wallet signing secret | Coinbase CDP |
| `last-try/coinbase-api-and-docs.txt` | API key/secret and possible private-key or seed examples in a mixed provider export | Coinbase CDP |
| `last-try/Etherscan.txt` | API key/config token | Etherscan |
| `last-try/reown-info.txt` | WalletConnect/Reown project identifier/config; sensitivity/paid status unknown | Reown / WalletConnect |
| `last-try/tiger-cloud-db-51231-credentials.txt` | Database username/password/connection credentials | Tiger Cloud / TigerData |
| `last-try/tigerdata.txt` | Database password/connection credentials | Tiger Cloud / TigerData |
| `last-try/vercel-token.txt` | Access token | Vercel |
| `last-try/apps/web/.env` | Session secret, database URL, credential-encryption key, wallet/RPC provider config and custody identifiers | App / database / RPC / wallet providers |
| `last-try/apps/web/.env.local` | OIDC access token | Vercel |
| `last-try/apps/web/.env.deploy` | Access token, database credentials, provider project/service/key fields | Vercel / Tiger Cloud |
| `last-try/pg_service.conf` | Database host/user/database connection metadata; password field not found in limited scan | PostgreSQL / Tiger Cloud candidate |
| `last-try/signals/signals.txt` | Credential-like patterns; likely mixed examples/docs; requires redacted classification | Provider names not yet reliably classified |

**Service categories surfaced (credential fields/path names only):** Alchemy, Coinbase CDP, Etherscan, Tiger Cloud/TigerData, Vercel. Reown/WalletConnect appears as configuration; billing is unknown. Do not request any CEX credentials.

## Proposed quarantine handling — 
1. Do 2. After approval, build a per-provider mapping using only values held locally: migrate confirmed active keys to a git-ig3. Mixed provider/chat exports (`Alchemy.txt`, `coinbase-api-and-docs.txt`, `Etherscan.txt`, `reown-info.txt`, `tiger-cloud-db-51231-credentials.txt`, `tigerdata.txt`, `vercel-token.txt`, `signals/signals.txt`) should be retained only outside the future Git worktree or replaced with an approved redacted archive after successful migration/rotation. No deletion is proposed without separate permission.
4. `cdp_api_key.json`, `cdp_wallet_secret.txt`, app `.env` files, and any real seed/private-key material must never enter future Git history. Add and test a comprehensive `.gitignore` before the Phase 3 `git init` action.
5. Before any future `git init`, confirm 
## Next safe work

Resume LTS-03 in batches smaller than ten minutes using the existing compressed path manifest. Persist batch boundaries and completion here before and after each chunk. Never print matched values or line contents. When uncertain whether a file has a secret, report its path, conservative type, service if inferable, and mark live status unverified.
