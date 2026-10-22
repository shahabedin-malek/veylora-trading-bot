import { NextRequest } from "next/server";
import { botJson, readJsonBody, requireBotWrite } from "@/lib/bot-builder/api";
import { cloneTemplate, listMarketplaceTemplates } from "@/lib/bot-builder/templates";

/**
 * The strategy marketplace.
 *
 * `GET` is the catalog: the built-in templates plus every template an account has shared.
 * Performance is read from recorded `BacktestRun` rows only; a template nobody has
 * backtested says so rather than showing a fabricated figure, and the note names the run.
 *
 * `POST` clones a template into a new draft owned by the caller. The clone records the
 * template slug and starts its own definition history, so editing it never changes the
 * template or its source bot.
 */

export async function GET() {
  try {
    return botJson({ templates: await listMarketplaceTemplates() });
  } catch {
    return botJson({ error: "The marketplace could not be read." }, 503);
  }
}

export async function POST(request: NextRequest) {
  const session = await requireBotWrite(request);
  if ("response" in session) return session.response;

  const parsedBody = await readJsonBody(request);
  if ("response" in parsedBody) return parsedBody.response;
  const body = parsedBody.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return botJson({ error: "A template id is required." }, 400);
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set(["templateId", "name"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    return botJson({ error: "Unsupported field(s) in the clone request." }, 400);
  }
  if (typeof record.templateId !== "string" || !record.templateId.trim()) {
    return botJson({ error: "A template id is required." }, 400);
  }
  if (record.name !== undefined && record.name !== null && typeof record.name !== "string") {
    return botJson({ error: "The clone name must be text." }, 400);
  }

  const result = await cloneTemplate({
    userId: session.userId,
    templateId: record.templateId,
    name: typeof record.name === "string" ? record.name : undefined,
  });
  if (!result.ok) {
    return botJson({ error: result.error, ...(result.problems ? { problems: result.problems } : {}) }, result.status);
  }
  return botJson({ bot: result.bot, template: result.template }, 201);
}
