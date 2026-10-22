import { timingSafeEqual } from "node:crypto";
import { loggerFor } from "@/lib/observability/request-context";
import { reason, serializeReason } from "@/lib/observability/reason";
import { ALL_JOBS, resolveJobSelection, RUNNER_JOB_IDS } from "@/lib/runner/registry";
import { runRunner, type RunRunnerInput } from "@/lib/runner/scheduler";
import type { RunnerInvocationSummary } from "@/lib/runner/heartbeat";

/**
 * The runner's one entry point: `GET /api/cron/[job]`.
 *
 * The host calls this on its schedule; a hand-run in development calls the same
 * URL with the same secret, which is why the local click-path and the deployed
 * schedule cannot drift apart. `job` is `all`, one job id, or a comma-separated
 * list (`/api/cron/market-alerts` still works and now means exactly one job).
 *
 * Three answers matter, and each says something specific:
 *
 *  - **503 naming `CRON_SECRET`** when the secret is not configured. Nothing is
 *    executed, and the body names the variable to set — the same refusal shape
 *    every other route in this app uses.
 *  - **401** when the secret is configured and the request does not carry it.
 *    No job runs, and nothing about a job is revealed.
 *  - **200 with the invocation summary** when it runs, including the jobs that
 *    were skipped and the reason each one was skipped.
 *
 * `maxDuration` is set to the ceiling the host gives an entry-plan request (300
 * seconds) rather than left unset, so a stuck job is cut off by the platform at a
 * known point instead of being killed at an undocumented one. This build has
 * cache components enabled, where route segment config like `dynamic` is not
 * allowed; the answer is never cached anyway, because the handler reads a secret
 * and writes job state, and every response carries `Cache-Control: no-store`.
 */

export const maxDuration = 300;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function hasValidCronAuthorization(request: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const authorization = request.headers.get("authorization");
  if (!authorization) return false;
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const supplied = Buffer.from(authorization, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export type CronRunner = (input: RunRunnerInput) => Promise<RunnerInvocationSummary>;

/**
 * The route body, exported so a test can call it with a runner that does not
 * touch a database. `run` defaults to the real one.
 */
export async function handleRunnerCron(
  request: Request,
  job: string,
  run: CronRunner = runRunner,
): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret?.trim()) {
    const failure = reason("MISSING_CONFIGURATION", {
      variable: "CRON_SECRET",
      message: "CRON_SECRET is not configured, so the runner cannot be called and no scheduled job runs.",
    });
    return json({ error: failure.message, variable: "CRON_SECRET", reason: serializeReason(failure) }, 503);
  }
  if (!hasValidCronAuthorization(request, secret)) {
    return json({ error: "Unauthorized." }, 401);
  }

  // The selector is checked before anything is claimed, so a mistyped schedule
  // is a clear 404 instead of an invocation that silently ran nothing.
  const selection = resolveJobSelection(job);
  if (selection.unknown.length > 0) {
    return json(
      {
        error: `Unknown runner job: ${selection.unknown.join(", ")}. Known jobs: ${RUNNER_JOB_IDS.join(", ")}, ${ALL_JOBS}.`,
        knownJobs: [...RUNNER_JOB_IDS],
      },
      404,
    );
  }

  try {
    const summary = await run({ selector: job });
    return json(summary);
  } catch (error) {
    // The runner writes one log line per job it handles; this is the line for an
    // invocation that could not read its own state (a database that is down).
    loggerFor("/api/cron/[job]").error("runner invocation could not start", { error, selector: job });
    const failure = reason("DATABASE_UNAVAILABLE", {
      variable: "DATABASE_URL",
      detail: "The runner could not read or claim its job list, so no job ran.",
    });
    return json({ error: failure.message, variable: failure.variable, reason: serializeReason(failure) }, 503);
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ job: string }> }) {
  const { job } = await params;
  return handleRunnerCron(request, job);
}
