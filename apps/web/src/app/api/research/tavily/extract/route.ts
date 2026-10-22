import { NextRequest } from "next/server";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { getAccessRefusal, authenticationGapResponse } from "@/lib/auth/access-gate";
import { requireUser } from "@/lib/auth/session-store";
import { developmentDetail } from "@/lib/dev-mode/development-detail";
import { getIntegrationFeatureSettings } from "@/lib/integrations/settings";
import { validateTavilyExtractUrls } from "@/lib/tavily/client";
import { consumeTavilyRequest } from "@/lib/tavily/rate-limit";
import { runResearchExtract } from "@/lib/ai/router";

const MAX_BODY_BYTES = 8_192;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const authConfig = getAuthConfig();
  if (!authConfig) return authenticationGapResponse();
  if (!isSameOriginRequest(request, authConfig)) return json({ error: "Request origin is not allowed." }, 403);

  let user;
  try {
    user = await requireUser();
  } catch (error) {
    const refusal = getAccessRefusal(error);
    return refusal ? json({ error: refusal.error }, refusal.status) : json({ error: "User authorization is unavailable." }, 503);
  }

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415);
  }
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413);

  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ error: "Extract request must be an object." }, 400);
  }

  let urls: string[];
  try {
    urls = validateTavilyExtractUrls((body as Record<string, unknown>).urls);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "URL list is invalid." }, 400);
  }

  const settings = await getIntegrationFeatureSettings().catch(() => null);
  if (!settings) return json({ error: "Integration settings are unavailable." }, 503);
  if (!settings.tavilyExtractEnabled) return json({ error: "Tavily Extract is switched off in Access & Integrations." }, 403);
  if (!consumeTavilyRequest(user.id)) return json({ error: "Tavily request limit reached; try again in a minute." }, 429);

  try {
    // Metered like every other AI request: one row for the extraction, with the URL count as its
    // request unit, and the provider named from the route rather than from this handler.
    const extracted = await runResearchExtract({ feature: "research", userId: user.id, urls });
    return json(extracted);
  } catch (error) {
    return json({ error: developmentDetail(error, "Tavily Extract is temporarily unavailable.") }, 502);
  }
}