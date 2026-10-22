import assert from "node:assert/strict";
import test from "node:test";
import { buildInvocationSummary } from "@/lib/runner/heartbeat";
import { RUNNER_JOB_IDS } from "@/lib/runner/registry";
import type { RunRunnerInput } from "@/lib/runner/scheduler";
import { handleRunnerCron, hasValidCronAuthorization } from "./route";

const SECRET = "test-only-placeholder-cron-secret";

function summaryFor(input: RunRunnerInput, selector = "all") {
  const heartbeat = {
    jobId: "market-alerts",
    label: "Market alert evaluation",
    status: "worked" as const,
    summary: "1 alert was due and 1 triggered.",
    reason: null,
    attempts: 1,
    reclaimed: false,
    intervalMinutes: 1_440,
    cadence: "24 hours",
    startedAt: "2026-10-15T00:00:00.000Z",
    finishedAt: "2026-10-15T00:00:01.000Z",
    durationMs: 1_000,
    nextDueAt: "2026-10-16T00:00:00.000Z",
    detail: { evaluated: 1, triggered: 1 },
  };
  return buildInvocationSummary({
    invocationId: `inv-${selector}`,
    owner: "runner-under-test",
    selector: input.selector ?? selector,
    startedAt: Date.parse("2026-10-15T00:00:00.000Z"),
    finishedAt: Date.parse("2026-10-15T00:00:01.000Z"),
    heartbeats: [heartbeat],
  });
}

function withSecret(value: string | undefined, body: () => Promise<void>) {
  const previous = process.env.CRON_SECRET;
  if (value === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = value;
  return body().finally(() => {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  });
}

test("without CRON_SECRET the runner answers 503 naming the variable and executes nothing", async () => {
  await withSecret(undefined, async () => {
    let ran = false;
    const response = await handleRunnerCron(
      new Request("https://veylora.example/api/cron/all"),
      "all",
      async (input) => {
        ran = true;
        return summaryFor(input);
      },
    );
    const body = (await response.json()) as { error: string; variable?: string; reason?: { code: string } };
    assert.equal(response.status, 503);
    assert.match(body.error, /CRON_SECRET/);
    assert.equal(body.variable, "CRON_SECRET");
    assert.equal(body.reason?.code, "MISSING_CONFIGURATION");
    assert.equal(ran, false, "an unconfigured runner must not run a job");
  });
});

test("a request without the bearer secret is refused with 401 and runs nothing", async () => {
  await withSecret(SECRET, async () => {
    let ran = false;
    const response = await handleRunnerCron(
      new Request("https://veylora.example/api/cron/all"),
      "all",
      async (input) => {
        ran = true;
        return summaryFor(input);
      },
    );
    assert.equal(response.status, 401);
    assert.equal(ran, false);

    const wrong = await handleRunnerCron(
      new Request("https://veylora.example/api/cron/all", { headers: { authorization: "Bearer not-the-secret" } }),
      "all",
      async (input) => {
        ran = true;
        return summaryFor(input);
      },
    );
    assert.equal(wrong.status, 401);
    assert.equal(ran, false);
    assert.equal(hasValidCronAuthorization(new Request("https://veylora.example/api/cron/all"), SECRET), false);
  });
});

test("a valid call runs the selected job and answers with the invocation summary", async () => {
  await withSecret(SECRET, async () => {
    const selectors: string[] = [];
    const response = await handleRunnerCron(
      new Request("https://veylora.example/api/cron/market-alerts", { headers: { authorization: `Bearer ${SECRET}` } }),
      "market-alerts",
      async (input) => {
        selectors.push(input.selector ?? "");
        return summaryFor(input, "market-alerts");
      },
    );
    const body = (await response.json()) as { outcome: string; heartbeats: { status: string }[]; jobsRan: number };
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(selectors, ["market-alerts"]);
    assert.equal(body.jobsRan, 1);
    assert.equal(body.heartbeats[0]?.status, "worked");
  });
});

test("an unknown job is a 404 naming the jobs that exist, and nothing is claimed", async () => {
  await withSecret(SECRET, async () => {
    let ran = false;
    const response = await handleRunnerCron(
      new Request("https://veylora.example/api/cron/market-alert", { headers: { authorization: `Bearer ${SECRET}` } }),
      "market-alert",
      async (input) => {
        ran = true;
        return summaryFor(input);
      },
    );
    const body = (await response.json()) as { error: string; knownJobs: string[] };
    assert.equal(response.status, 404);
    assert.match(body.error, /market-alert/);
    // The refusal names the jobs that exist, read from the registry rather than
    // repeated here: a hand-kept list of them is exactly the kind of copy that
    // goes stale the next time a phase registers a job.
    assert.deepEqual(body.knownJobs, [...RUNNER_JOB_IDS]);
    assert.ok(body.knownJobs.includes("market-alerts"));
    assert.equal(ran, false);
  });
});

test("a runner that cannot read its own state answers 503 naming DATABASE_URL", async () => {
  await withSecret(SECRET, async () => {
    const response = await handleRunnerCron(
      new Request("https://veylora.example/api/cron/all", { headers: { authorization: `Bearer ${SECRET}` } }),
      "all",
      async () => {
        throw new Error("Can't reach database server at localhost:5432");
      },
    );
    const body = (await response.json()) as { error: string; variable?: string; reason?: { code: string } };
    assert.equal(response.status, 503);
    assert.equal(body.variable, "DATABASE_URL");
    assert.equal(body.reason?.code, "DATABASE_UNAVAILABLE");
  });
});
