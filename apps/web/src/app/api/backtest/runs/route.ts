import { accessRefusalPayload, getAccessRefusal } from "@/lib/auth/access-gate";
import { requireUser } from "@/lib/auth/session-store";
import { listBacktestRuns } from "@/lib/backtesting/repository";

/**
 * The stored runs, newest first — what the comparison table reads.
 *
 * A run is history and this route only reads it: there is no delete and no edit, because a
 * result that can be quietly rewritten is not evidence. The payload is a summary (metrics,
 * costs, parameters, version) rather than the full trade list, so comparing ten runs is ten
 * rows of numbers rather than megabytes of JSON.
 */

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    const refusal = getAccessRefusal(error);
    return refusal ? json(accessRefusalPayload(refusal), refusal.status) : json({ error: "The run list is unavailable." }, 503);
  }
  try {
    return json({ runs: await listBacktestRuns(user.id) });
  } catch {
    return json({ error: "The run list could not be read." }, 503);
  }
}
