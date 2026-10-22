import { NextRequest } from "next/server";
import { getAccessRefusal, authenticationGapResponse } from "@/lib/auth/access-gate";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { requireUser } from "@/lib/auth/session-store";
import {
  getStrategyActivationView,
  isStartableStrategy,
  startStrategyActivation,
} from "@/lib/strategies/activation";

/**
 * The start control: `GET` reads this account's activation, `POST` starts it.
 *
 * `GET` is the panel's live state. It answers in every state, including the one where the
 * account has never started anything, because "not started" is an answer the control has
 * to render rather than an absence.
 *
 * `POST` persists the owner's intent immediately and writes one audit row. It never
 * refuses for an incomplete configuration — the view it returns names what is missing and
 * where to set it. The only 400 is a body this route cannot interpret (an unknown strategy
 * id), which is a client bug rather than a state of the owner's setup.
 *
 * There is deliberately no confirmation step, no consent field and no step-up ask in this
 * route: the phase that defines this control forbids a gate in front of it, and the owner's
 * press is the whole authorisation.
 */

const MAX_BODY_BYTES = 8_192;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authErrorResponse(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal
    ? json(
        {
          error: refusal.error,
          ...(refusal.code ? { code: refusal.code } : {}),
          ...(refusal.scope ? { scope: refusal.scope } : {}),
        },
        refusal.status,
      )
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type StartBody = { strategyId?: string | null; reason?: string };

function readStartBody(value: unknown): { valid: true; body: StartBody } | { valid: false; error: string } {
  if (value === undefined) return { valid: true, body: {} };
  if (!isRecord(value)) return { valid: false, error: "The request body must be a JSON object." };
  const allowed = new Set(["strategyId", "reason"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return { valid: false, error: "One or more submitted fields are unsupported." };
  }
  if (value.strategyId !== undefined && value.strategyId !== null) {
    // Shape only here; whether this account may name it is a database question asked below,
    // because a published bot is startable by its owner and nobody else.
    if (typeof value.strategyId !== "string" || !value.strategyId.trim() || value.strategyId.length > 120) {
      return { valid: false, error: "Choose a strategy this account can start." };
    }
  }
  if (value.reason !== undefined) {
    if (typeof value.reason !== "string" || !value.reason.trim() || value.reason.trim().length > 120) {
      return { valid: false, error: "A start reason must be 1–120 characters." };
    }
  }
  return {
    valid: true,
    body: {
      ...(value.strategyId !== undefined ? { strategyId: value.strategyId as string | null } : {}),
      ...(typeof value.reason === "string" ? { reason: value.reason.trim() } : {}),
    },
  };
}

async function readBody(request: NextRequest): Promise<{ body: unknown } | { response: Response }> {
  const raw = await request.text().catch(() => null);
  if (raw === null) return { response: json({ error: "Invalid request body." }, 400) };
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return { response: json({ error: "Request is too large." }, 413) };
  if (!raw.trim()) return { body: undefined };
  try {
    return { body: JSON.parse(raw) as unknown };
  } catch {
    return { response: json({ error: "Invalid JSON body." }, 400) };
  }
}

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "The activation state is unavailable." }, 503);
  }
  try {
    return json({ view: await getStrategyActivationView(user.id) });
  } catch {
    return json({ error: "The activation state could not be read." }, 503);
  }
}

export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "User authorization is unavailable." }, 503);
  }

  const parsed = await readBody(request);
  if ("response" in parsed) return parsed.response;
  const body = readStartBody(parsed.body);
  if (!body.valid) return json({ error: body.error }, 400);

  if (typeof body.body.strategyId === "string" && !(await isStartableStrategy(user.id, body.body.strategyId))) {
    return json({ error: "Choose a built-in strategy or one of your published bots." }, 400);
  }

  try {
    const result = await startStrategyActivation({
      userId: user.id,
      ...(body.body.strategyId !== undefined ? { strategyId: body.body.strategyId } : {}),
      ...(body.body.reason ? { reason: body.body.reason } : {}),
    });
    return json({
      view: result.view,
      changed: result.changed,
      message: result.message,
      auditAction: result.auditAction,
    });
  } catch {
    return json({ error: "The activation could not be saved and audited." }, 503);
  }
}
