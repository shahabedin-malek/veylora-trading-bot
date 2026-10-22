import { NextRequest } from "next/server";
import { getAccessRefusal, authenticationGapResponse } from "@/lib/auth/access-gate";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { requireAdmin } from "@/lib/auth/session-store";
import { ApiProblem, isRecord } from "@/lib/api/problem";
import {
  createAgentAccount,
  getApiAccessDirectory,
  issueApiKey,
  revokeApiKey,
} from "@/lib/api/manage";
import { decideAgentApproval } from "@/lib/api/trading";

/**
 * The owner's public-API control surface (phase 32).
 *
 * It stays behind the admin session on purpose: the public API has no route that mints,
 * widens or revokes a key. A key can be shown once here, revoked here, and an approval
 * created by an agent key is decided here. Every change is audited by the called service.
 */

const MAX_BODY_BYTES = 32_768;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authError(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal ? json({ error: refusal.error }, refusal.status) : null;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new ApiProblem(415, "CONTENT_TYPE_REQUIRED", "Content-Type must be application/json.");
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    throw new ApiProblem(413, "BODY_TOO_LARGE", "The request body is too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ApiProblem(400, "BODY_INVALID_JSON", "The request body is not valid JSON.");
  }
  if (!isRecord(parsed)) throw new ApiProblem(400, "BODY_INVALID", "The request body must be a JSON object.");
  return parsed;
}

export async function GET() {
  try {
    const admin = await requireAdmin();
    return json(await getApiAccessDirectory(admin.id));
  } catch (error) {
    return authError(error) ?? json({ error: "Public API settings are unavailable." }, 503);
  }
}

export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let admin;
  try {
    admin = await requireAdmin();
  } catch (error) {
    return authError(error) ?? json({ error: "Administrator authorization is unavailable." }, 503);
  }

  try {
    const body = await readBody(request);
    const action = body.action;

    if (action === "create-agent") {
      const agent = await createAgentAccount({ ownerUserId: admin.id, body });
      return json({ agent }, 201);
    }
    if (action === "create-key") {
      const issued = await issueApiKey({ ownerUserId: admin.id, body });
      return json(issued, 201);
    }
    if (action === "revoke-key") {
      if (typeof body.keyId !== "string" || !body.keyId.trim()) {
        throw new ApiProblem(400, "KEY_ID_REQUIRED", "Name the key to revoke.");
      }
      const key = await revokeApiKey({ ownerUserId: admin.id, keyId: body.keyId.trim() });
      return json({ key });
    }
    if (action === "decide-approval") {
      if (typeof body.approvalId !== "string" || !body.approvalId.trim()) {
        throw new ApiProblem(400, "APPROVAL_ID_REQUIRED", "Name the approval to decide.");
      }
      if (body.decision !== "APPROVE" && body.decision !== "DENY") {
        throw new ApiProblem(400, "APPROVAL_DECISION_INVALID", "Decision must be APPROVE or DENY.");
      }
      const result = await decideAgentApproval({
        approvalId: body.approvalId.trim(),
        ownerUserId: admin.id,
        actorUserId: admin.id,
        decision: body.decision,
        note: typeof body.note === "string" ? body.note : null,
      });
      return json(result);
    }

    throw new ApiProblem(
      400,
      "ACTION_UNKNOWN",
      "Unknown action. Use create-agent, create-key, revoke-key or decide-approval.",
    );
  } catch (error) {
    if (error instanceof ApiProblem) {
      return json({ error: error.message, code: error.code, ...(error.detail ? { detail: error.detail } : {}) }, error.status);
    }
    return authError(error) ?? json({ error: "The public API change could not be completed." }, 503);
  }
}
