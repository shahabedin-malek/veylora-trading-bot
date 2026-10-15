# Windows Qwen Worker Queue

Statuses: `pending` | `doing` | `done` | `blocked`. The Windows host is not authenticated, SSH key access/firewall scope is unverified, Ollama/model/VRAM are unverified, and the required session-presence guard is not operational.

| ID | Task | Safe boundary / done criteria | Status |
|---|---|---|---|
| QW-01 | Rotate credentials disclosed in chat and establish user-controlled SSH key access | User performs credential rotation and setup privately; restrict SSH ingress to the Linux host; no password in agent context | blocked |
| QW-02 | Verify `privateai` session guard before any remote batch | Must reliably detect any other logged-in user and stop remote Ollama before work; test and document fail-closed behavior | blocked |
| QW-03 | Install/verify Ollama, selected high-end Qwen model, and visible VRAM | Only after QW-01/QW-02; user-controlled administrative setup; harmless response test | blocked |
| QW-04 | Summarize approved, non-sensitive long documents | Only after QW-01–QW-03; no secrets or secret inventories; advisory output only | blocked |

Do not connect, install, start, or submit work to this host until the credentials have been rotated and the identity/session guard is verified. Re-check the guard before a batch and at least every 15 minutes; any other logged-in user means immediate stop and Linux-only failover.