import { NextRequest } from "next/server";
import { authErrorResponse, botJson, readJsonBody, requireBotWrite } from "@/lib/bot-builder/api";
import { deleteBot, readBot, updateDraftBot } from "@/lib/bot-builder/repository";
import { requireUser } from "@/lib/auth/session-store";

/**
 * One bot: read it, edit its draft, or delete it.
 *
 * Ownership is part of every lookup, so another account's id is a 404 rather than a hint
 * that the row exists. Editing is refused for a published bot — its rules are what the
 * runner may be executing, so a change creates a clone instead of silently moving the
 * ground under a running activation.
 *
 * `DELETE` is idempotent and keeps the row: state becomes DELETED, the activation naming
 * it is stopped in the same transaction, and the trades and decisions that name it stay
 * readable.
 */

export async function GET(_request: NextRequest, { params }: RouteContext<"/api/bot-builder/[botId]">) {
  const { botId } = await params;
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authErrorResponse(error) ?? botJson({ error: "The bot is unavailable." }, 503);
  }
  const bot = await readBot(user.id, botId).catch(() => null);
  if (!bot) return botJson({ error: "No bot with that id belongs to this account." }, 404);
  return botJson({ bot });
}

export async function PATCH(request: NextRequest, { params }: RouteContext<"/api/bot-builder/[botId]">) {
  const { botId } = await params;
  const session = await requireBotWrite(request);
  if ("response" in session) return session.response;

  const parsedBody = await readJsonBody(request);
  if ("response" in parsedBody) return parsedBody.response;
  const body = parsedBody.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return botJson({ error: "A bot configuration is required." }, 400);
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set(["config"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    return botJson({ error: "Unsupported field(s) in the update request." }, 400);
  }

  const result = await updateDraftBot({ userId: session.userId, botId, config: record.config });
  if (!result.ok) {
    return botJson({ error: result.error, ...(result.problems ? { problems: result.problems } : {}) }, result.status);
  }
  return botJson({ bot: result.bot });
}

export async function DELETE(request: NextRequest, { params }: RouteContext<"/api/bot-builder/[botId]">) {
  const { botId } = await params;
  const session = await requireBotWrite(request);
  if ("response" in session) return session.response;

  const result = await deleteBot({ userId: session.userId, botId });
  if (!result.ok) return botJson({ error: result.error }, result.status);
  return botJson({
    bot: result.bot,
    stoppedActivation: result.stoppedActivation,
    alreadyDeleted: result.alreadyDeleted,
  });
}
