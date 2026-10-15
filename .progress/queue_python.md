# Python Worker Queue

Statuses: `pending` | `doing` | `done` | `blocked`. Python is available locally; Phase 1 validators pass their documented structural checks, but substantive repository review is still incomplete.

| ID | Task | Safe boundary / done criteria | Status |
|---|---|---|---|
| PY-01 | Complete the read-only old-project ideas triage already tracked as R04aa | No execution, copying, or architecture reuse; record ideas and limitations only | done |
| PY-02 | Coordinate source-backed six-field reviews for v1-relevant repository candidates (R06) | Read-only; inspect exact README/manifests/license and selected source/functions; no execution, moves, or extraction | doing |
| PY-03 | Diagnose the next bounded scan before scaling | Record CPU, RAM, disk/I/O and fd constraints plus files/sec; scale only if measured bottleneck warrants it | done |
| PY-04 | Re-run Phase 1 validators and reconcile the checkpoint | Both structural checks pass; substantive inventory remains explicitly NOT GREEN | done |
| PY-05 | Draft path/type-only secret quarantine proposal from existing findings | `docs/SECRET_QUARANTINE_PROPOSAL.md` validated; no candidate path altered; user approval still pending | done |

Do not run a new full-tree scan until comparing the queued scope with existing manifests/reports. Python tasks may not emit or persist secret values. Workers never commit, move, delete, extract, or approve.