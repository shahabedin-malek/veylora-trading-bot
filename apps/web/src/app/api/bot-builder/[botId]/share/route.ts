import { NextRequest } from "next/server";
import { botJson, requireBotWrite } from "@/lib/bot-builder/api";
import { shareBotAsTemplate } from "@/lib/bot-builder/templates";

/**
 * Share a published bot to the marketplace.
 *
 * The template row is a snapshot of the published rules, so a later edit to the bot does not
 * rewrite what another account clones. Sharing the same published version twice answers
 * with the existing template instead of creating a duplicate.
 */

export async function POST(request: NextRequest, { params }: RouteContext<"/api/bot-builder/[botId]/share">) {
  const { botId } = await params;
  const session = await requireBotWrite(request);
  if ("response" in session) return session.response;

  const result = await shareBotAsTemplate({ userId: session.userId, botId });
  if (!result.ok) return botJson({ error: result.error }, result.status);
  return botJson({ template: result.template, changed: result.changed }, result.changed ? 201 : 200);
}
