import { NextRequest } from "next/server";
import {
  accessRefusalPayload,
  authenticationGapResponse,
  getAccessRefusal,
} from "@/lib/auth/access-gate";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { requireSitePermission } from "@/lib/auth/session-store";
import type { ActiveSitePermissionKey } from "@/lib/auth/access-control";
import { prisma } from "@/lib/db";
import { auditExportEvents } from "@/lib/audit/export";
import { parseAuditFilters, readAuditEvents } from "@/lib/audit/query";
import {
  AuditRetentionRefusal,
  readAuditRetention,
  saveAuditRetention,
} from "@/lib/audit/retention";
import { verifyAuditChain } from "@/lib/audit/verify";

/**
 * The audit trail's read surface (phase 36).
 *
 * `GET` returns the filtered events, the chain report and the retention setting
 * the view renders. `POST` runs one of the two owner actions: verifying the
 * chain now, or saving the retention window.
 *
 * There is deliberately no `PUT`, `PATCH` or `DELETE`. An audit row has one
 * writer (`recordAudit`) and no update or delete path anywhere in the app, so a
 * request that tries to edit history fails at the router rather than at a
 * handler that would have to refuse it.
 */

const MAX_BODY_BYTES = 4_096;

type AuditPermission = Extract<ActiveSitePermissionKey, "audit.read" | "audit.manage">;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

async function requireCaller(
  permission: AuditPermission,
): Promise<
  { ok: true; user: Awaited<ReturnType<typeof requireSitePermission>> } | { ok: false; response: Response }
> {
  try {
    return { ok: true, user: await requireSitePermission(permission) };
  } catch (error) {
    const refusal = getAccessRefusal(error);
    return {
      ok: false,
      response: refusal
        ? json(accessRefusalPayload(refusal), refusal.status)
        : json({ error: "The audit trail is unavailable." }, 503),
    };
  }
}

export async function GET(request: NextRequest) {
  const caller = await requireCaller("audit.read");
  if (!caller.ok) return caller.response;

  const filters = parseAuditFilters(new URL(request.url).searchParams);
  try {
    const [{ rows, total }, chain, retention] = await Promise.all([
      readAuditEvents(filters),
      filters.check ? verifyAuditChain(prisma) : Promise.resolve(null),
      readAuditRetention(),
    ]);
    return json({
      events: auditExportEvents(rows),
      total,
      limit: filters.limit,
      truncated: total > rows.length,
      chain,
      retention,
    });
  } catch {
    return json({ error: "The audit trail could not be read." }, 503);
  }
}

export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  const caller = await requireCaller("audit.manage");
  if (!caller.ok) return caller.response;

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415);
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413);

  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  if (typeof body !== "object" || body === null) return json({ error: "A JSON object is required." }, 400);
  const action = (body as Record<string, unknown>).action;

  try {
    if (action === "verify") {
      const [chain, retention] = await Promise.all([verifyAuditChain(prisma), readAuditRetention()]);
      return json({ chain, retention });
    }
    if (action === "retention") {
      const retention = await saveAuditRetention({
        actorUserId: caller.user.id,
        windowDays: (body as Record<string, unknown>).windowDays,
      });
      return json({ retention });
    }
    return json({ error: 'The action must be "verify" or "retention".' }, 400);
  } catch (error) {
    if (error instanceof AuditRetentionRefusal) return json({ error: error.message }, 400);
    return json({ error: "The audit action could not be completed." }, 503);
  }
}
