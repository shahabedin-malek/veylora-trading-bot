import { NextRequest } from "next/server";
import { botJson, requireBotWrite } from "@/lib/bot-builder/api";
import { publishBot, readBotCapacity } from "@/lib/bot-builder/repository";
import { prisma } from "@/lib/db";

/**
 * Publish a draft bot.
 *
 * Publishing is the one action that makes a bot runnable, and it is a single press with no
 * confirmation: validation runs first and a refusal names the offending field, so there is
 * nothing to approve. A bot over its cap was refused at creation; publishing never creates
 * a second bot, so the cap is re-read here only to report usage beside the published bot.
 * A deleted bot cannot be published, and a second publish is answered without writing a
 * second definition version.
 */

export async function POST(request: NextRequest, { params }: RouteContext<"/api/bot-builder/[botId]/publish">) {
  const { botId } = await params;
  const session = await requireBotWrite(request);
  if ("response" in session) return session.response;

  const result = await publishBot({ userId: session.userId, botId });
  if (!result.ok) {
    return botJson({ error: result.error, ...(result.problems ? { problems: result.problems } : {}) }, result.status);
  }
  const capacity = await readBotCapacity(session.userId, "bots").catch(() => null);
  // The runnable catalog is what the trade page will offer; reading it back here is how the
  // panel can say the bot is now startable rather than only that the row changed.
  const startable = await prisma.bot
    .count({ where: { userId: session.userId, state: "PUBLISHED", deletedAt: null } })
    .catch(() => null);
  return botJson({
    bot: result.bot,
    alreadyPublished: result.alreadyPublished,
    startable,
    caps: capacity
      ? { bots: { cap: capacity.cap, usage: capacity.usage, message: capacity.message } }
      : null,
  });
}
