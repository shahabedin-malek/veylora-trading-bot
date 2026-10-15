import { NextRequest } from "next/server";
import { getAuthConfig, getAuthUnavailableReason, isSameOriginRequest } from "@/lib/auth/config";
import { AuthenticationRequiredError, requireUser } from "@/lib/auth/session-store";
import { getIntegrationFeatureSettings } from "@/lib/integrations/settings";
import { searchTavily, type TavilyTopic } from "@/lib/tavily/client";
import { consumeTavilyRequest } from "@/lib/tavily/rate-limit";

const MAX_BODY_BYTES = 4_096;
const TOPICS = new Set<TavilyTopic>(["general", "news", "finance"]);

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const authConfig = getAuthConfig();
  if (!authConfig) return json({ error: getAuthUnavailableReason() ?? "Authentication is unavailable." }, 503);
  if (!isSameOriginRequest(request, authConfig)) return json({ error: "Request origin is not allowed." }, 403);

  let user;
  try {
    user = await requireUser();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return json({ error: "Authentication required." }, 401);
    return json({ error: "User authorization is unavailable." }, 503);
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
    return json({ error: "Search request must be an object." }, 400);
  }
  const input = body as Record<string, unknown>;
  const query = input.query;
  const topic = input.topic === undefined ? "general" : input.topic;
  if (typeof query !== "string" || query.trim().length < 1 || query.trim().length > 400) {
    return json({ error: "Search query must be 1–400 characters." }, 400);
  }
  if (typeof topic !== "string" || !TOPICS.has(topic as TavilyTopic)) {
    return json({ error: "Topic must be general, news, or finance." }, 400);
  }

  const settings = await getIntegrationFeatureSettings().catch(() => null);
  if (!settings) return json({ error: "Integration settings are unavailable." }, 503);
  if (!settings.tavilySearchEnabled) return json({ error: "Tavily Search is disabled by the administrator." }, 403);
  if (!consumeTavilyRequest(user.id)) return json({ error: "Tavily request limit reached; try again in a minute." }, 429);

  try {
    return json({ results: await searchTavily(query, topic as TavilyTopic) });
  } catch {
    return json({ error: "Tavily Search is temporarily unavailable." }, 502);
  }
}