# Veylora Rebuild Timeline

**Estimate date:** 2026-10-13  
**Status:** Planning estimate; Phase 1 is not green and no implementation phase has started.

## Estimate

Estimated active engineering effort from the current checkpoint to a release-ready local v1: **50–88 working days** after the required approvals and safe infrastructure prerequisites are available. Calendar duration is **at least 10–18 weeks**, plus any time waiting for user decisions, venue-specific approvals, credentials chosen by individual users, or external-provider access. The estimate is not a commitment to enable live trading by a target date.

| Workstream | Active effort | Main dependency |
|---|---:|---|
| Finish Phase 1 inventory and secret-handling proposal | 5–10 days | Read-only source review; user approvals in order: secrets, moves, reuse |
| Phase 2 architecture and data-model approval | 3–5 days | All Phase 1 approvals; separate approval for every DEX, chain, and endpoint before enablement |
| Phase 3 foundation and CI/security checks | 4–7 days | Architecture approval; git initialization must be the first Phase 3 action |
| Phase 4 wallet authentication and access control | 4–6 days | Foundation gate; initial admin wallet before admin completion |
| Phase 5 real market data, news, and proof | 5–8 days | Approved public data providers and live-source proof |
| Phase 6 public connectivity and approved DEX path | 6–12 days | Individual venue/chain/endpoint approvals; wallet and provider behavior |
| Phase 7 risk engine and kill switch | 4–6 days | Confirmed risk rules and tests |
| Phase 8 gated real execution | 6–10 days | Approved venue, live-trading arm, risk and audit gates; no real order without explicit authorization |
| Phase 9 ledger, wallet, and history | 4–7 days | Real event sources and transactional tests |
| Phase 10 CRM, support, and admin | 4–7 days | Scope is confirmed; depends on auth and ledger contracts |
| Phase 11 realness audit and release readiness | 4–7 days | All phase gates and repeatable live proofs |
| Phase 12 deployment | 1–3 days | Separate explicit written deployment authorization |

Ranges include implementation, focused tests, and phase evidence; they do not include approval latency, unresolved security findings, external outages, or live-trading observation. Workstreams have some possible overlap after Phase 2, but gate ordering limits safe parallelism. The broad spot/perpetuals scope is a major schedule risk; if the estimate slips, defer scope.

## Current constraints

- Phase 1 is **IN PROGRESS / NOT GREEN**: 236 unique inventory dispositions exist, but only 14 have six-field source reviews; substantive review is incomplete.
- Secret scan and historical blob review have documented residual uncertainty. The quarantine proposal and its approval are pending; no secret-bearing path may be changed before approval.
- Linux reports 6 CPUs and 13 GiB available memory. No local Ollama executable/model is available; GPU visibility is unverified because `nvidia-smi` is unavailable.
- The previous scan throughput measurement is historical, not a current benchmark. Do not scale workers until a bounded current benchmark and I/O/fd diagnosis are available.
- Windows SSH/Ollama is not provisioned or verified. Credentials pasted into chat must not be used; rotate them and complete any authentication only through a private, user-controlled terminal workflow.
- No worker may inspect secret-bearing files. The account-registration/token-extraction project is forbidden by the project rules; tools that evade service identity, quotas, or access controls are excluded from setup.

## Re-estimation triggers

Re-estimate after Phase 1 approval, after the user selects and approves each DEX venue/chain/endpoint, and after the first end-to-end test against real mainnet data. Record actual effort and blocked time at each phase gate.