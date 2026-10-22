import { getAuthConfig } from "@/lib/auth/config";
import { accessRefusalPayload, authenticationGapResponse, getAccessRefusal } from "@/lib/auth/access-gate";
import { requireSitePermission } from "@/lib/auth/session-store";
import { getObservabilitySnapshot, probeDatabase } from "@/lib/observability/health";
import { reason, serializeReason } from "@/lib/observability/reason";
import { loggerFor } from "@/lib/observability/request-context";

/**
 * The machine-readable half of the health surface (phase 04).
 *
 * It answers with the same snapshot `/admin/data` renders, so the owner can ask
 * from a shell what the panel shows.
 *
 * The order of the checks is the honest part:
 *
 *  1. **No usable auth configuration** — 503 naming the missing variable, the
 *     same answer every other route gives (phase 03).
 *  2. **The database is not reachable** — 503 naming `DATABASE_URL`. Answering
 *     401 here would send the owner to sign in, and sign-in reads the database,
 *     so it cannot succeed. The body holds the reason and the variable only: no
 *     provider data is revealed to a caller who could not be authorized.
 *  3. **A caller without an owner session** — 401 (or 503 when sign-in itself
 *     is misconfigured), as everywhere else.
 *  4. The snapshot. An unreachable *provider* is data, not an error, so this
 *     still answers 200 and reports it.
 *
 * Only the last step needs a session, which is why a stopped database still
 * produces a truthful answer instead of an empty list.
 */

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export type AdminHealthDeps = {
  probe?: typeof probeDatabase;
  snapshot?: typeof getObservabilitySnapshot;
};

export async function handleAdminHealth(deps: AdminHealthDeps = {}): Promise<Response> {
  if (!getAuthConfig()) return authenticationGapResponse();

  const probe = await (deps.probe ?? probeDatabase)();
  if (!probe.reachable) {
    const failure = reason("DATABASE_UNAVAILABLE", {
      variable: probe.variable ?? "DATABASE_URL",
      detail: probe.detail,
    });
    loggerFor("/api/admin/health").error("health snapshot could not read the database", { error: failure.detail });
    return json(
      {
        error: `The database is unreachable, so the health snapshot cannot be read. ${probe.detail}`,
        variable: failure.variable,
        reason: serializeReason(failure),
      },
      503,
    );
  }

  try {
    await requireSitePermission("admin.data.read");
  } catch (error) {
    const refusal = getAccessRefusal(error);
    if (refusal) return json(accessRefusalPayload(refusal), refusal.status);
    loggerFor("/api/admin/health").error("health snapshot could not be authorized", { error });
    return json({ error: "The health snapshot could not be authorized." }, 503);
  }

  try {
    return json(await (deps.snapshot ?? getObservabilitySnapshot)());
  } catch (error) {
    loggerFor("/api/admin/health").error("health snapshot failed", { error });
    return json(
      { error: "The health snapshot could not be read.", reason: serializeReason(reason("UNKNOWN")) },
      503,
    );
  }
}

export async function GET() {
  return handleAdminHealth();
}
