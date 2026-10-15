# `last-try/` Git Object Secret Scan (values withheld)

Heuristic only; findings are not proof that a credential is live, active, paid, or valid. No secret values, fragments, Git object IDs, or matching lines are emitted or stored. Paths are URL-encoded.

All loose and packed Git blobs enumerated: 30414; scanned (<=64 MiB): 30413; skipped (>64 MiB): 1; candidate blob objects: 756; candidate paths with associations: 68; candidate blobs without a path association in refs/HEAD: 688.
Declared scanned blob bytes: 1479133342; workers: 30; size-bounded object batches: 50; elapsed seconds: 197.75; throughput: 7.13 MiB/s.
Git path association uses `git rev-list --objects --all`; candidates from unreachable objects may lack a recoverable path. Object bytes were streamed through Git batch framing in memory and never written to disk. Git pack/index metadata and object headers were not content-scanned. Oversize object IDs are withheld; count only.

| Path (URL-encoded) | Heuristic type | Inferred service |
|---|---|---|
| `.progress/DECISIONS.md` | seed/mnemonic reference or material | not inferred |
| `.progress/DECISIONS.md` | seed/mnemonic reference or material | not inferred |
| `.progress/DECISIONS.md` | seed/mnemonic reference or material | not inferred |
| `apps/web/.env.example` | seed/mnemonic reference or material | not inferred |
| `apps/web/prisma/schema.prisma` | seed/mnemonic reference or material | not inferred |
| `apps/web/prisma/schema.prisma` | seed/mnemonic reference or material | not inferred |
| `apps/web/prisma/schema.prisma` | seed/mnemonic reference or material | not inferred |
| `apps/web/prisma/schema.prisma` | seed/mnemonic reference or material | not inferred |
| `apps/web/scripts/credit-accounts-runbook.mjs` | seed/mnemonic reference or material | not inferred |
| `apps/web/scripts/scan-secrets.mjs` | credential assignment | not inferred |
| `apps/web/scripts/scan-secrets.mjs` | credential assignment | not inferred |
| `apps/web/scripts/scan-secrets.mjs` | credential assignment | not inferred |
| `apps/web/src/lib/actions.ts` | credential assignment | not inferred |
| `apps/web/src/lib/credentials/smoke.ts` | credential assignment | not inferred |
| `apps/web/src/lib/credentials/smoke.ts` | credential assignment | not inferred |
| `apps/web/src/lib/custody/index.ts` | seed/mnemonic reference or material | not inferred |
| `apps/web/src/lib/custody/index.ts` | seed/mnemonic reference or material | not inferred |
| `apps/web/src/lib/custody/index.ts` | seed/mnemonic reference or material | not inferred |
| `apps/web/src/lib/custody/types.ts` | seed/mnemonic reference or material | not inferred |
| `apps/web/src/lib/custody/types.ts` | seed/mnemonic reference or material | not inferred |
| `apps/web/src/lib/decision/providers/jev.ts` | credential assignment | not inferred |
| `apps/web/src/lib/decision/providers/llm.ts` | credential assignment | not inferred |
| `apps/web/src/lib/lending/signers.ts` | seed/mnemonic reference or material | not inferred |
| `apps/web/src/lib/log.ts` | seed/mnemonic reference or material | not inferred |
| `apps/web/src/lib/signals/altfins.ts` | credential assignment | not inferred |
| `apps/web/src/lib/signals/altfins.ts` | credential assignment | not inferred |
| `apps/web/src/lib/wundertrading/client.ts` | credential assignment | not inferred |
| `apps/web/src/lib/wundertrading/client.ts` | credential assignment | not inferred |
| `apps/web/tests/credentials.test.ts` | credential assignment | not inferred |
| `apps/web/tests/credentials.test.ts` | credential assignment | not inferred |
| `apps/web/tests/credit-accounts.live.test.ts` | seed/mnemonic reference or material | not inferred |
| `apps/web/tests/credit-accounts.live.test.ts` | seed/mnemonic reference or material | not inferred |
| `apps/web/tests/custody.test.ts` | seed/mnemonic reference or material | not inferred |
| `apps/web/tests/custody.test.ts` | seed/mnemonic reference or material, credential assignment | not inferred |
| `apps/web/tests/e2e/journey.spec.ts` | credential assignment | not inferred |
| `apps/web/tests/integration/actions.test.ts` | credential assignment | not inferred |
| `apps/web/tests/integration/credentials-actions.test.ts` | credential assignment | not inferred |
| `apps/web/tests/lending-signers.test.ts` | seed/mnemonic reference or material | not inferred |
| `apps/web/tests/log.test.ts` | seed/mnemonic reference or material, credential assignment | not inferred |
| `apps/web/tests/status.test.ts` | seed/mnemonic reference or material | not inferred |
| `apps/web/tests/status.test.ts` | seed/mnemonic reference or material | not inferred |
| `coinbase/docs/auth/123-wallet-authentication.md` | credential assignment | Coinbase CDP |
| `coinbase/docs/auth/126-apple-oauth-configuration.md` | private-key material | Coinbase CDP |
| `coinbase/docs/custody/017-custodial-wallets-quickstart.md` | credential assignment | Coinbase CDP |
| `coinbase/docs/platform/006-jwt-authentication.md` | private-key material, credential assignment | Coinbase CDP |
| `coinbase/docs/sdk-ui/148-viem-compatibility.md` | credential assignment | Coinbase CDP |
| `coinbase/docs/stablecoins/095-stablecoin-quickstart.md` | credential assignment | Coinbase CDP |
| `coinbase/docs/stablecoins/102-stableswapper-quickstart.md` | credential assignment | Coinbase CDP |
| `coinbase/docs/wallets/108-non-custodial-wallets.md` | seed/mnemonic reference or material | Coinbase CDP |
| `coinbase/docs/wallets/112-import-export.md` | credential assignment | Coinbase CDP |
| `coinbase/docs/x402/091-faq.md` | seed/mnemonic reference or material | Coinbase CDP |
| `docs/API_CREDENTIAL_REQUIREMENTS.md` | seed/mnemonic reference or material | not inferred |
| `docs/API_CREDENTIAL_REQUIREMENTS.md` | seed/mnemonic reference or material | not inferred |
| `docs/API_CREDENTIAL_REQUIREMENTS.md` | seed/mnemonic reference or material | not inferred |
| `docs/DEPLOYMENT.md` | seed/mnemonic reference or material | not inferred |
| `docs/lending-repo/TODO.md` | seed/mnemonic reference or material | not inferred |
| `docs/lending-repo/TODO.md` | seed/mnemonic reference or material | not inferred |
| `docs/lending-repo/TODO.md` | seed/mnemonic reference or material | not inferred |
| `docs/NETWORK_BOUNDARY.md` | seed/mnemonic reference or material | not inferred |
| `docs/NETWORK_BOUNDARY.md` | seed/mnemonic reference or material | not inferred |
| `docs/NETWORK_BOUNDARY.md` | seed/mnemonic reference or material | not inferred |
| `docs/NETWORK_BOUNDARY.md` | seed/mnemonic reference or material | not inferred |
| `docs/PER_ACCOUNT_CREDIT_ACCOUNTS.md` | seed/mnemonic reference or material | not inferred |
| `docs/trading-repo/RESEARCH.md` | credential assignment | not inferred |
| `docs/trading-repo/RESEARCH.md` | credential assignment | not inferred |
| `REFINED_FINTECH_CRM_FREEBUFF_PROMPT.md` | credential assignment | not inferred |
| `REFINED_FINTECH_CRM_FREEBUFF_PROMPT.md` | credential assignment | not inferred |
| `REFINED_FINTECH_CRM_FREEBUFF_PROMPT.md` | credential assignment | not inferred |
