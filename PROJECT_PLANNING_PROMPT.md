# Veylora — full project plan request

You are the **planning AI** for the Veylora trading platform. The repository at
`/home/chris/trading-ai` already contains a substantial, working Next.js app. Your
job is to turn it into a complete, ordered development plan and to split that plan
into one paste-ready prompt file per phase.

The human owner (Chris) is the product owner, project manager and only authority.
Nothing in this brief is optional unless the owner says so.

---

## 1. Research before you write anything

Do not plan from this document alone. Read the real checkout first and cite what you
read (path, and the fact you drew from it) inside `plan/PROJECT_TODO.md`.

Minimum reading list:

- `apps/web/package.json`, `apps/web/pnpm-workspace.yaml`, `apps/web/next.config.ts`
- `apps/web/src/app/**` — every route/page currently shipped (login, markets, screener,
  research, trade, wundertrading, admin/*, assistant, api/*)
- `apps/web/src/lib/**` — auth (SIWE), rpc (multi-network Alchemy resolver), portfolio,
  market data, paper trading, bot builder, backtesting, risk controls, integrations,
  assistant, alerts
- `apps/web/prisma/schema.prisma` and `apps/web/prisma/migrations/**` — the data model
- `apps/web/.env.example`, `plan/ENVIRONMENT_MANIFEST.txt` — configuration surface
  (**names only; never values**)
- `.github/workflows/*`, `scripts/*` — CI and the standalone utility scripts
- `apps/web/vercel.json`, `plan/ENVIRONMENT_MANIFEST.txt` — deployment config and the
  configuration surface
- `AGENTS.md` — how agents must work in this repo

Archived reports from earlier rounds live outside the repository at
`/mnt/private-ai-data/trading/archived-from-project/`; read them only when a phase
needs their data.

State clearly in `plan/PROJECT_TODO.md` what exists today, what is partial, and what is
missing, before proposing work.

---

## 2. Deliverables (exact paths)

Write into `/home/chris/trading-ai/plan/`:

1. **`plan/PROJECT_TODO.md`** — the complete project TODO from where the code stands
   today to a finished, tested, deployable product:
   - a short "current state" section (evidence-based, from your reading)
   - every work item, ordered, grouped by phase, each item small enough to verify
   - the phase index: phase number → file name → one-line goal
   - a final "whole-project definition of done" section
   - a "questions for the owner" section at the end (see §8)

2. **`plan/phase-NN-<slug>.md`** — one file per phase, zero-padded (`phase-01-…`,
   `phase-02-…`). There are as many files as there are phases; 40 phases means 40
   files. Each file is a **self-contained, paste-ready prompt for GitHub Copilot** and
   must contain exactly these sections:

   - **Objective** — one paragraph, the outcome, not the steps
   - **Scope** — what is in, and explicitly what is out, for this phase
   - **Files to touch** — the paths you expect to change (best estimate from your reading)
   - **Requirements** — numbered, testable statements of behaviour
   - **Acceptance criteria** — the observable result, written so a human can confirm it
   - **Manual verification (owner click-path)** — the exact clicks for a human: which
     URL, which button, what should happen, including the failure case
   - **Automated verification** — the exact commands, run from `apps/web`:
     `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm build`
     (locally: `pnpm --config.verify-deps-before-run=false <script>`)
   - **Definition of done** — ticks that must all be true before the phase closes
   - **Rollback** — how to undo the phase if it goes wrong
   - **Do not do** — the anti-patterns for this phase (see §3)

   A phase file must be usable on its own: an agent that reads only that file should be
   able to complete the phase without asking for the plan again.

3. **Optional but encouraged:** `plan/PROJECT_TIMELINE.md` only if it adds information
   the TODO does not already carry.

Keep `plan/` as the single ledger. Do not scatter planning documents elsewhere in the
repository, and do not create a second competing todo list.

---

## 3. Operating rules for the plan you write (owner's authority — read carefully)

These rules are the owner's, and every phase file must carry them explicitly:

1. **No AI-imposed restrictions.** Do not plan any consent layer, approval gate,
   permission gate, "owner approval required" step, "await board decision" language, or
   policy prose that stops the product from working. The AI does not get to decide what
   the owner may test.
2. **Nothing stays disabled for later.** Never plan "this button stays disabled until
   phase N". If a capability is not finished, it must still be reachable and honestly
   labelled, or simply not be in the UI yet — never a dead control the owner cannot test.
3. **Everything must be manually testable at every phase.** The owner will deposit a
   small amount (for example 20 USDT), watch the flow end to end, press the
   "start smart AI trading" control, watch trades run, and withdraw the money back. Each
   phase must state exactly which of those journeys a human can click through at that
   phase, and none may be blocked by the plan.
4. **If the owner asks for an action, it happens.** An AI working from this plan must
   never refuse a development-phase request by citing a policy, safety rule or limit it
   authored itself, and must never silently disable a feature to avoid a risk.
5. **The only pause is a real one.** For an action that is genuinely irreversible
   (deleting production data, wiping a deployment, force-pushing over history), the
   agent warns in one line and proceeds once the owner confirms. Nothing else pauses.
6. **Limits are a product feature the owner configures.** Risk limits, spend caps,
   allow-lists, fees, KYC-ish gates and kill switches belong in the **admin panel**, as
   data the owner edits — not as code-level refusals written by an AI.
7. **Security and legal come last, with the owner.** A final phase (or final few) covers
   hardening, security policy, FAQs, cookie policy, terms and the public pages — written
   with the owner, after the product works. Do not front-load policy work.
8. **No reintroduced gate copy.** The AI-authored consent/approval wording ("approval
   required", "awaiting owner decision", "cannot proceed without permission") has been
   removed from the product, together with the guard lists and agent-instruction files
   that enforced it. Phases must not bring that copy back and must not add a new guard
   list. Product policy is written by the owner, in the admin panel. Honest status
   labels for unfinished work (for example "order placement is not available yet")
   stay, because rule 2 requires them.

Write these rules into every phase file's "Do not do" section in your own words.

---

## 4. Product requirements the plan must cover

- **Wallet sign-in, all wallet types.** Keep the existing EVM SIWE sign-in working;
  plan the full set: browser-injected wallets, **mobile wallets via WalletConnect /
  Reown** (pairing, deep links, QR), and contract wallets (EIP-1271 / smart accounts).
  The owner's words: "i want all kind of wallets and even mobile wallets can sign in."
  Treat non-EVM support (for example Solana) as a phase with an explicit owner decision
  point, not as an assumption.
- **All configured networks active.** Every network in the environment
  (`ALCHEMY_<NETWORK>_RPC_URL`, ~157 networks today) must be usable in the product — for
  portfolio reads, chain switching, deposits and execution. Networks must be discovered
  from the environment at runtime; never hard-code a list. A phase must also cover the
  configuration side: the `ALCHEMY_*` variables exist in all three Vercel scopes
  (Development, Preview, Production) today, and every newly enabled network must be added
  to all three or it silently loses RPC in that environment (see
  `plan/ENVIRONMENT_MANIFEST.txt`).
- **Deposit flow.** A human must be able to deposit a small test amount (for example
  20 USDT) and see it credited, with an audit trail. Research the right provider or
  on-chain approach before committing to one; do not assume one from memory.
- **One-click "start smart AI trading".** A single control that starts the automated
  strategy for a user, with visible state, and that a human can verify.
- **Server-side, 24/7 execution.** Auto-trading must keep running when the user closes
  the browser, goes offline, or shuts the laptop down. Plan the durable server-side
  runner (scheduled jobs, a worker, or a queue-backed loop) plus heartbeat, retry,
  idempotency and observability. Check the real limits of the hosting plan before you
  promise a cadence; if the current host cannot run the cadence you need, say so and
  propose what can (do not silently downgrade the requirement).
- **Withdrawal flow.** The owner must be able to withdraw the balance back to the wallet
  and confirm the money arrived, including the failure and rejection paths.
- **Strategy/bot surface.** Keep and extend the bot builder, backtesting and paper
  trading that already exist, and connect them to the live path.
- **Admin console.** Everything the owner needs to operate the product: users, wallets,
  balances, strategies, venue keys, risk limits, fees, feature switches, audit log.
  This is where the owner applies security and limits.
- **Observability.** Events, alerts, and a support/CRM layer so the owner can see what
  the system did and why.
- **Testing.** A dedicated phase that adds browser/E2E automation (nothing is installed
  today) covering sign-in, deposit, start-trading, 24/7 continuation, and withdrawal.

---

## 5. Phase shape

- Small, ordered, each ending with green automated gates and a stated manual click-path.
- Dependencies explicit: "phase 12 requires phase 09".
- No phase may end with an unreachable, dead, or silently disabled control.
- Real-money execution phases must be gated by an owner-controlled admin switch (data,
  not code) and must be preceded by the testnet phase that proves the same path.
- Aim for phases a single agent can finish in one sitting; split anything larger.

---

## 6. Testing mandate

For every phase, name the concrete check:

- automated: the `pnpm` gates listed in §2, run from `apps/web`, exit status inspected;
- manual: the click-path an owner can follow, with the expected screen and the expected
  failure mode;
- after the E2E phase exists: the Playwright spec that covers it.

No phase is done because "it builds". A phase is done when the owner can click it and
see the behaviour, and the automated gates pass on the final files.

---

## 7. Anti-loop rules for the Copilot working from your plan

- Work on **one phase at a time**; finish it, verify it, then start the next.
- Read the current phase file at the start; do not re-derive the whole plan.
- Never re-open a finished phase without the owner asking.
- Never recreate deleted approval/policy/plan documents, and never add a new
  "approval required" step.
- Never ask the owner the same question twice; batch at most three questions per phase
  and default to the least restrictive option consistent with the owner's intent.
- Update only `plan/PROJECT_TODO.md` for status; do not create new markdown outside
  `plan/`.
- Keep working until the phase's definition of done is satisfied; do not stop for
  reassurance.

---

## 8. Questions

If something about scope is genuinely ambiguous, add it to the "questions for the owner"
section of `plan/PROJECT_TODO.md` — batched, concrete, and each with a recommended
default — rather than guessing silently or blocking on it. Never ask the owner to
confirm something this brief already decides in their favour.

---

## 9. Secret hygiene

- Never print, commit, paste or copy secret **values** — not from `.env*`, not from
  `pass`, not from Vercel, not from the database.
- Refer to configuration by variable **name** only (see `plan/ENVIRONMENT_MANIFEST.txt`).
- Server-side keys must never carry a `NEXT_PUBLIC_` or `VITE_` prefix.
- Configuration files (`.env*`, credential exports) stay out of the repository.

---

## 10. Tone of the deliverable

Write `plan/PROJECT_TODO.md` and every phase file as if this project is starting fresh
and forward-only: no history of past cleanup, no references to earlier agents, no
"previously removed" notes. The owner wants a clean, unambiguous forward plan that a
fresh agent can execute without inheriting stale context.

When you are done, reply with: the number of phases, the file names you created, and the
handful of decisions only the owner can make.
