import assert from "node:assert/strict";
import test from "node:test";
import { reason } from "@/lib/observability/reason";
import { isDue, leaseIsActive, type RunnerJobState } from "@/lib/runner/claim";
import { LEDGER_INVARIANT_INTERVAL_MINUTES, resolveJobSelection, RETENTION_INTERVAL_MINUTES, RUNNER_JOBS } from "@/lib/runner/registry";
import { LedgerInvariantError, type LedgerInvariantReport } from "@/lib/ledger/invariants";
import { reasonForJobFailure, runRunner } from "@/lib/runner/scheduler";
import type { RunnerJobDefinition, RunnerJobResult } from "@/lib/runner/registry";
import { InMemoryRunnerStore } from "./support/in-memory-runner-store";

const DAY = 1_440;
const START = new Date("2026-10-15T00:00:00.000Z");

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function workedEntry(id: string, intervalMinutes = DAY, run?: () => Promise<RunnerJobResult>): RunnerJobDefinition {
  return {
    id,
    label: id,
    description: id,
    intervalMinutes: () => intervalMinutes,
    cadence: () => `${intervalMinutes} minutes`,
    run:
      run ??
      (async () => ({
        summary: `${id} did its work`,
        worked: true,
        detail: { checked: 1 },
      })),
  };
}

test("two concurrent invocations run each job exactly once", async () => {
  const store = new InMemoryRunnerStore();
  let runs = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const job = workedEntry("market-alerts", DAY, async () => {
    runs += 1;
    await gate;
    return { summary: "checked 1 alert", worked: true, detail: { evaluated: 1 } };
  });

  const first = runRunner({ store, jobs: [job], now: START, owner: "runner-a", invocationId: "inv-a" });
  await tick();
  const secondSummary = await runRunner({ store, jobs: [job], now: START, owner: "runner-b", invocationId: "inv-b" });
  release?.();
  const firstSummary = await first;

  assert.equal(runs, 1, "the job body must run once, not once per invocation");
  assert.equal(firstSummary.jobsRan, 1);
  assert.equal(secondSummary.jobsRan, 0);
  assert.equal(secondSummary.heartbeats[0]?.status, "already-running");
  assert.equal(secondSummary.heartbeats[0]?.reason?.code, "ALREADY_RUNNING");
  assert.match(secondSummary.heartbeats[0]?.summary ?? "", /holds this job's lease/);
  assert.equal(store.jobs.get("market-alerts")?.attempts, 1, "losing the race must not count as an attempt");
});

/**
 * A store that can hand one invocation a read it took a moment ago, which is the
 * race the claim statement has to survive: two invocations overlap, and the
 * second one decides "due" from a row it read before the first finished.
 */
class RacyReadStore extends InMemoryRunnerStore {
  stale: RunnerJobState | null = null;

  override async ensureJob(input: { jobId: string; intervalMinutes: number; now: number }) {
    const fresh = await super.ensureJob(input);
    if (!this.stale) return fresh;
    const snapshot = this.stale;
    this.stale = null;
    return snapshot;
  }
}

test("a stale read cannot make a job run twice in one interval", async () => {
  const store = new RacyReadStore();
  let runs = 0;
  const job = workedEntry("market-alerts", DAY, async () => {
    runs += 1;
    return { summary: "checked the alerts", worked: true, detail: {} };
  });

  // The state a second, overlapping invocation would have read before the first
  // one finished: due, unleased, never run.
  const beforeAnyRun: RunnerJobState = {
    jobId: "market-alerts",
    intervalMinutes: DAY,
    attempts: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastOutcome: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastReasonCode: null,
    lastReasonMessage: null,
    nextDueAt: START.getTime() - 60_000,
  };

  const first = await runRunner({ store, jobs: [job], now: START, owner: "runner-a" });
  assert.equal(first.jobsRan, 1);

  store.stale = beforeAnyRun;
  const second = await runRunner({ store, jobs: [job], now: START, owner: "runner-b" });

  assert.equal(runs, 1, "the job body must not run again for the same interval");
  assert.equal(second.jobsRan, 0);
  assert.equal(second.heartbeats[0]?.status, "not-due");
  assert.equal(second.heartbeats[0]?.reason?.code, "NOT_YET_DUE");
  assert.equal(store.jobs.get("market-alerts")?.attempts, 1, "the refused claim must not count as an attempt");
});

test("a job is skipped until its interval elapses, with the reason and the next due time shown", async () => {
  const store = new InMemoryRunnerStore();
  const job = workedEntry("market-alerts", DAY);

  const first = await runRunner({ store, jobs: [job], now: START });
  assert.equal(first.jobsRan, 1);
  assert.equal(first.heartbeats[0]?.status, "worked");
  assert.equal(first.heartbeats[0]?.nextDueAt, new Date(START.getTime() + DAY * 60_000).toISOString());

  // Same instant, and a day later than the interval but inside the host's
  // delivery window: the second call is the same slot, so it must do nothing.
  const immediately = await runRunner({ store, jobs: [job], now: START });
  assert.equal(immediately.jobsRan, 0);
  assert.equal(immediately.jobsSkipped, 1);
  assert.equal(immediately.heartbeats[0]?.status, "not-due");
  assert.equal(immediately.heartbeats[0]?.reason?.code, "NOT_YET_DUE");
  assert.equal(immediately.outcome, "idle");
  assert.ok(immediately.reason, "an invocation that ran nothing must carry a reason");
  assert.match(immediately.reason.message, /next due time/);

  // Past the next due time (the host's ±59 minute window accepted): it runs.
  const nextSlot = await runRunner({ store, jobs: [job], now: new Date(START.getTime() + DAY * 60_000) });
  assert.equal(nextSlot.jobsRan, 1);
  assert.equal(store.jobs.get("market-alerts")?.attempts, 2);
});

test("a run killed mid-flight is reclaimed once its lease lapses, and the attempt count says so", async () => {
  const store = new InMemoryRunnerStore();
  let runs = 0;
  const job = workedEntry("market-alerts", DAY, async () => {
    runs += 1;
    return { summary: "finished the work the killed run started", worked: true, detail: {} };
  });

  await runRunner({ store, jobs: [job], now: START });
  assert.equal(runs, 1);

  // What a deploy or a crash leaves behind: claimed, never finished, lease lapsed.
  const afterLease = new Date(START.getTime() + DAY * 60_000);
  store.simulateKilledRun("market-alerts", { now: afterLease.getTime() });

  const state = store.jobs.get("market-alerts");
  assert.ok(state);
  assert.equal(isDue(state, afterLease.getTime()), true, "an expired lease must be reclaimable");
  assert.equal(leaseIsActive(state, afterLease.getTime()), false);

  const recovered = await runRunner({ store, jobs: [job], now: afterLease });
  assert.equal(runs, 2);
  assert.equal(recovered.heartbeats[0]?.status, "worked");
  assert.equal(recovered.heartbeats[0]?.reclaimed, true);
  assert.equal(recovered.heartbeats[0]?.attempts, 3, "the reclaim increments the attempt count");
  assert.equal(store.jobs.get("market-alerts")?.lastFinishedAt, afterLease.getTime());

  // A live lease, by contrast, is not reclaimable.
  const live = { ...state, leaseOwner: "somebody-else", leaseExpiresAt: afterLease.getTime() + 60_000 };
  assert.equal(leaseIsActive(live, afterLease.getTime()), true);
});

test("a failing job is recorded with a specific reason and does not stop the other jobs", async () => {
  const store = new InMemoryRunnerStore();
  const failing = workedEntry("market-alerts", DAY, async () => {
    throw new Error("Can't reach database server at localhost:5432");
  });
  const healthy = workedEntry("retention", DAY);

  const summary = await runRunner({ store, jobs: [failing, healthy], now: START });

  assert.equal(summary.jobsFailed, 1);
  assert.equal(summary.jobsRan, 1);
  assert.equal(summary.outcome, "mixed");
  const failed = summary.heartbeats.find((heartbeat) => heartbeat.jobId === "market-alerts");
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.reason?.code, "DATABASE_UNAVAILABLE");
  assert.equal(failed?.reason?.variable, "DATABASE_URL");
  assert.notEqual(failed?.reason?.message, "Something went wrong.");
  assert.equal(store.jobs.get("market-alerts")?.lastFailureAt, START.getTime());
  assert.equal(store.jobs.get("retention")?.lastSuccessAt, START.getTime());
});

test("a job that does no work always carries a reason, and the summary says which job was skipped", async () => {
  const store = new InMemoryRunnerStore();
  const idler = workedEntry("market-alerts", DAY, async () => ({
    summary: "0 alerts were due",
    worked: false,
    detail: { evaluated: 0 },
  }));
  const idleButReasoned = workedEntry("retention", DAY, async () => ({
    summary: "nothing to remove",
    worked: false,
    reason: reason("NO_ENTRY_CONDITION", { message: "Both record tables are already inside their retention windows." }),
    detail: { removed: 0 },
  }));

  const summary = await runRunner({ store, jobs: [idler, idleButReasoned], now: START });

  assert.equal(summary.outcome, "idle");
  assert.equal(summary.jobsRan, 0);
  assert.equal(summary.jobsSkipped, 2);
  for (const heartbeat of summary.heartbeats) {
    assert.ok(heartbeat.reason, `${heartbeat.jobId} did no work without saying why`);
    assert.ok(heartbeat.reason.message.length > 20, `${heartbeat.jobId} has a vague reason`);
  }
  const filled = summary.heartbeats.find((heartbeat) => heartbeat.jobId === "market-alerts");
  assert.equal(filled?.reason?.code, "NO_ENTRY_CONDITION");
  assert.equal(filled?.reason?.message, "market-alerts did no work: 0 alerts were due");
});

test("the invocation summary is persisted as one heartbeat record", async () => {
  const store = new InMemoryRunnerStore();
  const summary = await runRunner({
    store,
    jobs: [workedEntry("market-alerts"), workedEntry("retention")],
    now: START,
    owner: "runner-a",
    invocationId: "inv-recorded",
  });

  assert.equal(store.invocations.length, 1);
  assert.equal(summary.jobsRan, 2);
  const record = store.invocations[0];
  assert.equal(record?.invocationId, "inv-recorded");
  assert.equal(record?.owner, "runner-a");
  assert.equal(record?.selector, "all");
  assert.equal(record?.jobsDue, 2);
  assert.equal(record?.jobsRan, 2);
  assert.equal(record?.outcome, "worked");
  assert.deepEqual(
    (record?.heartbeats as { jobId: string }[]).map((heartbeat) => heartbeat.jobId).sort(),
    ["market-alerts", "retention"],
  );
});

test("a key-like value never reaches a recorded reason", async () => {
  const failure = reasonForJobFailure(
    new Error("Request failed 401: https://api.example.com/v2/quotes?api_key=abcdefghijklmnopqrstuvwxyz123456"),
  );
  assert.equal(failure.code, "UNKNOWN");
  assert.ok(failure.detail);
  assert.ok(!failure.detail.includes("abcdefghijklmnopqrstuvwxyz123456"), failure.detail);
  assert.match(failure.detail, /\[redacted\]/);
});

test("the selector is resolved explicitly: unknown job ids are reported, never ignored", () => {
  const all = resolveJobSelection("all");
  assert.equal(all.selected.length, RUNNER_JOBS.length);
  assert.deepEqual(all.unknown, []);

  const one = resolveJobSelection("market-alerts");
  assert.deepEqual(one.selected.map((job) => job.id), ["market-alerts"]);

  const unknown = resolveJobSelection("market-alert");
  assert.deepEqual(unknown.selected, []);
  assert.deepEqual(unknown.unknown, ["market-alert"]);
});

test("a job that knows why it failed keeps its own reason, and the ledger's failure is a failed run", async () => {
  const store = new InMemoryRunnerStore();
  const report: LedgerInvariantReport = {
    ok: false,
    checkedAt: START.toISOString(),
    counts: { accounts: 1, transactions: 1, entries: 1 },
    totals: [],
    checks: [],
    violations: [{ check: "LEDGER_BALANCED", detail: "USDT has 0 debited and 10.5 credited across the ledger." }],
    reason: null,
  };
  const violation = new LedgerInvariantError(
    report,
    reason("LEDGER_UNBALANCED", {
      message: "1 ledger invariant violation(s): Every asset's debits equal its credits. USDT has 0 debited and 10.5 credited across the ledger.",
    }),
  );

  // The reason travels with the error: a job that can name what is wrong must not
  // have its answer flattened into "UNKNOWN" on the way to the heartbeat.
  assert.equal(reasonForJobFailure(violation).code, "LEDGER_UNBALANCED");
  assert.equal(reasonForJobFailure(violation).retryable, false);
  assert.match(reasonForJobFailure(violation).message, /debits equal its credits/);

  const summary = await runRunner({
    store,
    jobs: [workedEntry("ledger-invariants", LEDGER_INVARIANT_INTERVAL_MINUTES, async () => { throw violation; })],
    now: START,
  });
  assert.equal(summary.jobsFailed, 1);
  assert.equal(summary.outcome, "failed");
  assert.equal(summary.heartbeats[0]?.status, "failed");
  assert.equal(summary.heartbeats[0]?.reason?.code, "LEDGER_UNBALANCED");
  assert.match(summary.heartbeats[0]?.summary ?? "", /USDT has 0 debited/);

  // An error that carries nothing still gets the honest fallback.
  assert.equal(reasonForJobFailure(new Error("something else entirely")).code, "UNKNOWN");
});

test("the registry declares a real interval for every job", () => {
  const empty = {} as NodeJS.ProcessEnv;
  for (const job of RUNNER_JOBS) {
    const intervalMinutes = job.intervalMinutes(empty);
    assert.ok(intervalMinutes >= 1, `${job.id} has no interval`);
    assert.ok(job.cadence(empty).length > 0, `${job.id} has no cadence sentence`);
  }
  const ledger = RUNNER_JOBS.find((job) => job.id === "ledger-invariants");
  assert.equal(ledger?.intervalMinutes(empty), LEDGER_INVARIANT_INTERVAL_MINUTES);
  assert.match(ledger?.cadence(empty) ?? "", /1 hour/);
  assert.match(ledger?.description ?? "", /every transaction balances/);

  const alerts = RUNNER_JOBS.find((job) => job.id === "market-alerts");
  assert.equal(alerts?.intervalMinutes(empty), RETENTION_INTERVAL_MINUTES, "the alert cadence follows the host's daily floor");
  assert.equal(
    alerts?.intervalMinutes({ MARKET_ALERT_EVALUATION_INTERVAL_MINUTES: "60" } as unknown as NodeJS.ProcessEnv),
    RETENTION_INTERVAL_MINUTES,
    "a sub-daily interval cannot be delivered by a daily schedule, so the effective cadence stays daily",
  );
});
