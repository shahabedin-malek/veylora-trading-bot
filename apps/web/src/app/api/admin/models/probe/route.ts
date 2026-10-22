import { NextRequest } from "next/server";
import { authenticationGapResponse, getAccessRefusal } from "@/lib/auth/access-gate";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { requireAdmin } from "@/lib/auth/session-store";
import { AiRouteUnavailableError, runAiTextTask } from "@/lib/ai/router";

/**
 * One plain-text question through the `admin-probe` route.
 *
 * This exists because a routing panel otherwise asks the owner to trust it: the only way to
 * prove that the saved order is the order used, that a broken primary key really falls back,
 * and that every key being absent names the variable, is to ask a question and read the
 * answer. It is deliberately a feature of its own (`admin-probe`) rather than a special case
 * inside the assistant, so probing costs one short completion and cannot accidentally become
 * a tool-calling conversation.
 *
 * The response names the provider that answered and the target it fell back from. No key, no
 * prompt and no provider body is returned.
 */

const MAX_BODY_BYTES = 2_048;
const MAX_QUESTION_CHARACTERS = 400;
const DEFAULT_QUESTION = "Reply with one short sentence confirming you received this probe.";

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authErrorResponse(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal ? json({ error: refusal.error }, refusal.status) : null;
}

export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let admin;
  try {
    admin = await requireAdmin();
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "Administrator authorization is unavailable." }, 503);
  }

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415);
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413);

  let body: Record<string, unknown> = {};
  if (raw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return json({ error: "Invalid JSON body." }, 400);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return json({ error: "The probe body must be an object." }, 400);
    }
    body = parsed as Record<string, unknown>;
  }

  const question = body.question === undefined ? DEFAULT_QUESTION : body.question;
  if (typeof question !== "string" || question.trim().length === 0 || question.length > MAX_QUESTION_CHARACTERS) {
    return json({ error: `The probe question must be 1–${MAX_QUESTION_CHARACTERS} characters.` }, 400);
  }

  try {
    const run = await runAiTextTask({
      feature: "admin-probe",
      userId: admin.id,
      messages: [{ role: "user", content: question.trim() }],
    });
    return json({
      status: "answered",
      providerId: run.providerId,
      model: run.model,
      answer: run.text,
      fallbackFrom: run.fallbackFrom,
      attempts: run.attempts,
      costMicrosUsd: run.costMicrosUsd,
    });
  } catch (error) {
    if (error instanceof AiRouteUnavailableError) {
      return json(
        {
          status: "unavailable",
          error: error.message,
          missingKeys: error.missingKeys,
          skipped: error.skipped,
        },
        503,
      );
    }
    // A provider's own words can carry a URL or a body fragment, so the message is not
    // echoed. The attempt rows are the diagnosis; the panel shows them.
    return json({ status: "failed", error: "The probe could not be completed." }, 502);
  }
}
