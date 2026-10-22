# Phase 05 — Durable runner with heartbeats

Paste this whole file into DeepSeek Freebuff. It is self-contained.

## Objective

A scheduled runner that executes work while the user's browser is closed, the laptop is shut
and a deploy lands mid-flight — with heartbeat, last-run, next-run and a visible reason for
idling. Everything later (orders, strategies, alerts) is work this runner picks up.

## Scope

- In: the runner, job claiming, heartbeats, resume-after-deploy, the host cadence decision.

- Out: strategy logic (phase 24); order placement (phase 21); notification delivery (phase 29).

## Files to touch

- `apps/web/src/lib/runner/scheduler.ts`, `claim.ts`, `heartbeat.ts` (new)
- `apps/web/src/app/api/cron/[job]/route.ts` (generalised from `api/cron/market-alerts/route.ts`)
- `apps/web/prisma/schema.prisma` (a `RunnerJob` model with lease, attempt and heartbeat columns) and a migration
- `apps/web/src/lib/alerts/scheduler-config.ts` (reuse its interval pattern)
- `apps/web/vercel.json` (cron cadence) — only after the host's real limits are checked

## Requirements

1. One runner entry point invoked by the host's scheduler, authenticating with `CRON_SECRET`;
   an unauthenticated call is rejected with 401 and never executes work.
2. Jobs are claimed with a lease: a second runner cannot pick up a leased job, and an expired
   lease is reclaimable. Claiming is a single atomic database operation.
3. Every job run writes a heartbeat with start, finish, outcome and the reason when it did no
   work, so idling is explicable rather than silent.
4. A deploy or crash mid-run must not lose or duplicate work: an interrupted job is reclaimed
   after its lease expires and its attempt count increments.
5. Each job type declares its interval; the runner states which jobs are due, which ran, and
   which were skipped and why in one summary record.
6. Check the host's real scheduling limits before promising a cadence. If the current host
   cannot meet the cadence honestly, say so in this phase's report and propose what can be met
   — never silently downgrade the requirement or invent an uptime guarantee.
7. The runner works on a seeded local database in development by invoking the same endpoint by
   hand, so it is testable without waiting for a schedule.

## Acceptance criteria

- With two runner invocations started concurrently, each job runs once — proven by a test.
- Killing a run mid-flight leaves the job reclaimable, and the next invocation completes it.
- The heartbeat view shows last success, last failure, next due and the idle reason per job.
- An unauthenticated request to the cron endpoint returns 401 and runs nothing.

## Manual verification (owner click-path)

1. `db:setup`, `dev`, then call the local cron endpoint by hand with the secret from
   `.env.local`; the summary lists the jobs that ran.
2. Call it again immediately — due jobs are skipped and the reason is shown.
3. Interrupt a run (stop the dev server mid-job) and call again — the job is reclaimed and
   completes, and the attempt count increased.
4. Failure case: call it with a wrong secret — 401, and nothing executes.

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

- [ ] Single-execution and lease-expiry behaviour covered by tests.
- [ ] Heartbeat, last-run, next-run and idle reason visible in the admin surface.
- [ ] The host's real cadence documented, with the measured limitation stated in the report.
- [ ] An unauthenticated call runs nothing.

## Rollback

- Revert this phase's commit and drop the `RunnerJob` table; the previous
  `api/cron/market-alerts` route keeps working on its own schedule.

## Do not do

- No approval gate, permission gate or confirmation step before a job runs.
- Do not tie execution to an open browser or a running dev process.
- Do not add a job that can double-execute money operations; idempotency is mandatory, not
  optional.
- Do not claim a cadence the host cannot deliver.
