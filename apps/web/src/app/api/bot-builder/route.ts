import { NextRequest } from "next/server";
import { authErrorResponse, botJson, readJsonBody, requireBotWrite } from "@/lib/bot-builder/api";
import {
  createBot,
  listBots,
  readBotCapacity,
} from "@/lib/bot-builder/repository";
import { requireUser } from "@/lib/auth/session-store";

/**
 * This account's bots.
 *
 * `GET` is the builder's list: every bot the account owns, including deleted ones, because
 * a deleted bot's decisions and backtests stay readable. It also carries the cap that
 * applies right now, so the panel can state "3 of 5 bots" without a second request and
 * without disabling the create control — the cap is a fact the owner reads, not a button
 * that disappears.
 *
 * `POST` creates a draft. A reached cap answers 409 with the named cap and usage and writes
 * nothing; it does not stop the control from being pressed.
 */

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authErrorResponse(error) ?? botJson({ error: "The bot list is unavailable." }, 503);
  }
  try {
    const [bots, botCapacity, venueCapacity] = await Promise.all([
      listBots(user.id),
      readBotCapacity(user.id, "bots"),
      readBotCapacity(user.id, "venue connections"),
    ]);
    return botJson({
      bots,
      caps: {
        bots: { cap: botCapacity.cap, usage: botCapacity.usage, message: botCapacity.message },
        venueConnections: { cap: venueCapacity.cap, usage: venueCapacity.usage, message: venueCapacity.message },
      },
    });
  } catch {
    return botJson({ error: "The bot list could not be read." }, 503);
  }
}

export async function POST(request: NextRequest) {
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
    return botJson({ error: "Unsupported field(s) in the create request." }, 400);
  }

  const result = await createBot({ userId: session.userId, config: record.config });
  if (!result.ok) {
    return botJson({ error: result.error, ...(result.problems ? { problems: result.problems } : {}) }, result.status);
  }
  const [botCapacity, venueCapacity] = await Promise.all([
    readBotCapacity(session.userId, "bots"),
    readBotCapacity(session.userId, "venue connections"),
  ]);
  return botJson(
    {
      bot: result.bot,
      caps: {
        bots: { cap: botCapacity.cap, usage: botCapacity.usage, message: botCapacity.message },
        venueConnections: { cap: venueCapacity.cap, usage: venueCapacity.usage, message: venueCapacity.message },
      },
    },
    201,
  );
}
