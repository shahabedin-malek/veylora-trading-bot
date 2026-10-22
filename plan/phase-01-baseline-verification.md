# Phase 01 — Baseline verification and key rotation

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

Establish a green, trustworthy starting point: the four foundation gates pass on the
current tree, the route/test/model inventory is recorded as fact, and the credentials that
were committed to this repository in a plain-text file are rotated and removed. Nothing
else in the plan may build on unrotated keys.

## Scope

- In: running the gates; recording results and the inventory; rotating and relocating the
exposed credentials; a repository sweep for other committed secret values; the first
`plan/COMPETITOR_RESEARCH.md` cross-check.

- Out: any new feature; schema changes; UI work; reworking CI.

## Files to touch

- `apps/web/package.json` (only if a gate script needs a fix)
- `apps/web/README.md` (results and local setup notes)
- `plan/PROJECT_TODO.md` (current-state section, if the measured inventory has drifted)
- `.gitignore` (patterns for credential drops)
- the repository root text file holding the keys — **moved out of the repository**, never
  committed again

## Requirements

1. Run, from `apps/web`, with the local pnpm quirk:
   `pnpm --config.verify-deps-before-run=false typecheck`, then `test`, `lint`, `build`.
   Inspect each exit status individually — a pipeline that hides the status is not evidence.
2. Record each command and its real output in `apps/web/README.md`, including any failure,
   and fix the cause of every failure rather than adjusting the check to pass.
3. Confirm the counted inventory and correct `plan/PROJECT_TODO.md` if it differs:
   14 pages, 27 API routes, 46 test files, 20 Prisma models, 147 source files.
4. Rotate the three credentials held in the root text file at their providers: the
   ChainGPT key, the OctoBot key pair and the WunderTrading key. Owners: the account holder
   does this; an agent must never rotate, print or transmit a value.
5. Move that file outside the repository, delete it from the working tree, and add an
   ignoring pattern so a same-named drop cannot be staged again. Purge it from git history
   only with the owner's explicit instruction, and record that instruction in
   `plan/PROJECT_TODO.md`.
6. Sweep the tracked tree for other secret values by name-based heuristics; list every hit
   in the phase report. Do not print matched values — report file and line only.
7. If any rotation is pending, list exactly which integration is blocked and in which phase
   it is needed (ChainGPT features → phase 27, WunderTrading venue → phase 20).
8. Note the Alchemy-scope trap for later phases: 159 `ALCHEMY_*` names exist across three
   Vercel scopes, and a network missing from one scope silently loses RPC there.
9. Leave the tree committed by its owner with a message stating what was rotated.

## Acceptance criteria

- `typecheck`, `test`, `lint` and `build` each reported with its own exit status: 0.
- `apps/web/README.md` contains the command transcript and the measured inventory.
- The credential file is gone from the working tree and cannot be re-added by accident.
- A written list exists naming every credential that was rotated, its provider, and the
  phase that needs it.
- No secret value appears in any file the phase touches.

## Manual verification (owner click-path)

1. Open `apps/web/README.md` — the four gate results and the inventory are visible.
2. Run `ls` at the repository root — the credential text file is absent.
3. Run `git status` — the credential file is not listed as a deletion-to-commit unless the
   owner chose that, and nothing unexpected is staged.
4. Log into each provider dashboard and confirm the old key no longer authenticates and the
   new one does. Expected failure case: if a provider will not rotate, the old key is
   disabled instead, and the blocked integration is listed.

## Automated verification

```bash
cd apps/web
pnpm --config.verify-deps-before-run=false typecheck; echo "typecheck=$?"
pnpm --config.verify-deps-before-run=false test;      echo "test=$?"
pnpm --config.verify-deps-before-run=false lint;      echo "lint=$?"
pnpm --config.verify-deps-before-run=false build;     echo "build=$?"
cd ../.. && node scripts/validate_plan.mjs; echo "plan=$?"
```

## Definition of done

- [ ] All four gates pass with their exit statuses inspected and recorded.
- [ ] Inventory in `plan/PROJECT_TODO.md` matches the measured tree.
- [ ] Exposed credentials rotated, removed from the working tree, and the ignore pattern added.
- [ ] No secret value was printed, committed or pasted into chat.
- [ ] Every blocked integration is named with the phase that needs it.

## Rollback

- Keep the previous keys in the provider dashboards (disabled, not deleted) until phase 27
  and phase 20 have run, so a broken integration can be restored by re-enabling one key.
- Restore the ignore pattern and README notes by reverting this phase's commit.

## Do not do

- Do not print, paste, commit or transmit any secret value, old or new.
- Do not rewrite git history without the owner's explicit instruction.
- Do not weaken, skip or silence a failing gate to make this phase pass; fix the cause.
- Do not add an approval gate, a permission gate, a consent screen or a confirmation step
  anywhere in this phase.
- Do not leave a control disabled or a capability hidden because it is not wired up yet —
  if it does not work, label it honestly or leave it out of the UI.
