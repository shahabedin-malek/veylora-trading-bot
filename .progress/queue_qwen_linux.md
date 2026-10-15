# Linux Qwen Worker Queue

Statuses: `pending` | `doing` | `done` | `blocked`. Ollama 0.40.3 and Qwen 2.5 7B are installed on `/mnt/private-ai-data`; server is localhost-only. Linux has 6 CPUs and Ollama detects a 1 GiB AMD Radeon HD 7700 GPU; use bounded inference and expect CPU/RAM fallback.

| ID | Task | Safe boundary / done criteria | Status |
|---|---|---|---|
| QL-01 | Install and verify local Qwen light model | Official 0.40.3 archive SHA-256 verified; `qwen2.5:7b` listed; localhost-only test returned `READY` in 26.68 s | done |
| QL-02 | Rank five inventory candidates for human source-backed review | Qwen returned a partial ranking before the 100-token cap (108.01 s); advisory only, no source or secrets sent | done |
| QL-03 | Summarize non-sensitive Phase 1 review priorities in short batches | Qwen synthesized the verified AllTick/AIOQuant/Aave findings in 116.93 s; advisory only, no source or secrets sent, no reuse approval | done |
| QL-04 | Synthesize non-sensitive findings from recent strategy/data/UI reviews | Returned 3 bullets in 109.87 s but covered only part of inputs; partial advisory only, no source or secrets sent, no reuse decisions | done |

Never send secrets, credentials, secret candidate contents, or raw scan matches to a model. Qwen output is advisory and cannot make final decisions.