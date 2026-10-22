import { NextRequest, NextResponse } from "next/server";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { accessRefusalPayload, getAccessRefusal, authenticationGapResponse } from "@/lib/auth/access-gate";
import { requireSitePermission } from "@/lib/auth/session-store";
import {
  getRiskPolicySettings,
  saveRiskPolicySettings,
  setStrategyKillSwitch,
} from "@/lib/risk-controls/settings";

const MAX_BODY_BYTES = 4_096;

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authErrorResponse(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal ? json(accessRefusalPayload(refusal), refusal.status) : null;
}

/**
 * The two kill switches, as toggles (phase 25, requirement 2).
 *
 * A switch is pressed, not saved: this route applies it immediately and answers with the
 * state it now has, the actor, the time and — for the global switch — the cooldown that
 * starts when it is released. Both directions are accepted; the phase forbids a switch the
 * owner cannot turn back off.
 *
 * The write goes through the same settings functions the panel's save uses, so the audit
 * row, the effective-from time and the cooldown all come from one place rather than a
 * second implementation of "engage the switch".
 */
export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let admin;
  try {
    admin = await requireSitePermission("risk.policy.manage");
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "Administrator authorization is unavailable." }, 503);
  }

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415);
  }
  const raw = await request.text().catch(() => "");
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413);

  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ error: "The request body must be a JSON object." }, 400);
  }
  const record = body as Record<string, unknown>;

  if (record.scope !== "global" && record.scope !== "strategy") {
    return json({ error: "Switch scope must be global or strategy." }, 400);
  }
  if (typeof record.active !== "boolean") {
    return json({ error: "A switch must be stated as on or off." }, 400);
  }
  if (record.reason !== undefined && (typeof record.reason !== "string" || record.reason.length > 280)) {
    return json({ error: "A reason must be at most 280 characters." }, 400);
  }

  if (record.scope === "global") {
    try {
      const current = await getRiskPolicySettings();
      const saved = await saveRiskPolicySettings(
        { ...current, killSwitchActive: record.active },
        admin.id,
      );
      return json({
        ok: true,
        scope: "global",
        active: saved.killSwitchActive,
        changedAt: saved.killSwitchChangedAt,
        changedByUserId: saved.killSwitchChangedByUserId,
        cooldownUntil: saved.cooldownUntil,
      });
    } catch {
      return json({ error: "The global switch could not be changed, so nothing was recorded." }, 503);
    }
  }

  if (typeof record.activationId !== "string" || !record.activationId.trim()) {
    return json({ error: "A strategy switch needs the activation it belongs to." }, 400);
  }
  try {
    const saved = await setStrategyKillSwitch({
      activationId: record.activationId,
      active: record.active,
      actorUserId: admin.id,
      reason: typeof record.reason === "string" ? record.reason : null,
    });
    return json({ ok: true, scope: "strategy", ...saved });
  } catch {
    return json({ error: "The strategy switch could not be changed, so nothing was recorded." }, 503);
  }
}
