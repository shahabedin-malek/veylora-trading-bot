import { isIP } from "node:net";
import { instrumentFetch, PROVIDER_IDS } from "@/lib/observability/provider-call";
export const TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search";
export const TAVILY_EXTRACT_ENDPOINT = "https://api.tavily.com/extract";

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_SEARCH_RESULTS = 5;
const MAX_EXTRACT_URLS = 3;
const MAX_EXTRACT_CHARS = 6_000;
const SENSITIVE_QUERY_PARAM = /(?:api[_-]?key|access[_-]?token|auth|bearer|credential|password|secret|signature|token)/i;

export type TavilyTopic = "general" | "news" | "finance";

export type TavilySearchResult = {
  title: string;
  url: string;
  content: string;
  score: number | null;
  publishedDate: string | null;
};

export type TavilyExtractResult = {
  url: string;
  content: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Tavily response exceeded the allowed size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

async function postKeyless(endpoint: typeof TAVILY_SEARCH_ENDPOINT | typeof TAVILY_EXTRACT_ENDPOINT, body: Record<string, unknown>): Promise<unknown> {
  // Instrumented per call, so a test that replaces the global `fetch` is the
  // function that actually runs (and is recorded).
  const request = instrumentFetch({ providerId: PROVIDER_IDS.tavily });
  const response = await request(endpoint, {
    method: "POST",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Tavily-Access-Mode": "keyless",
    },
    body: JSON.stringify(body),
  });
  const raw = await readBoundedResponse(response);
  if (!response.ok) throw new Error(`Tavily request failed with status ${response.status}.`);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Tavily returned invalid JSON.");
  }
}

function publicHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) return null;
    if (parsed.port && parsed.port !== "443") return null;
    if (isIP(hostname) !== 0 || !hostname.includes(".")) return null;
    if (["localhost", "local", "internal", "test", "invalid", "example"].some((suffix) =>
      hostname === suffix || hostname.endsWith(`.${suffix}`))) return null;
    if ([...parsed.searchParams.keys()].some((key) => SENSITIVE_QUERY_PARAM.test(key))) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function validateTavilyExtractUrls(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_EXTRACT_URLS) {
    throw new Error(`Provide between 1 and ${MAX_EXTRACT_URLS} URLs.`);
  }
  const urls = value.map(publicHttpsUrl);
  if (urls.some((url) => url === null)) {
    throw new Error("Use public HTTPS URLs without credentials or sensitive query parameters.");
  }
  const safeUrls = urls as string[];
  if (new Set(safeUrls).size !== safeUrls.length) throw new Error("URLs must be unique.");
  return safeUrls;
}

export async function searchTavily(query: string, topic: TavilyTopic): Promise<TavilySearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > 400) throw new Error("Search query must be 1–400 characters.");
  if (!( ["general", "news", "finance"] as string[]).includes(topic)) throw new Error("Unsupported Tavily search topic.");

  const payload = await postKeyless(TAVILY_SEARCH_ENDPOINT, {
    query: trimmed,
    search_depth: "basic",
    max_results: MAX_SEARCH_RESULTS,
    topic,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
  });
  if (!isRecord(payload) || !Array.isArray(payload.results)) throw new Error("Tavily search response was invalid.");

  return payload.results.flatMap((item): TavilySearchResult[] => {
    if (!isRecord(item)) return [];
    const url = publicHttpsUrl(item.url);
    if (!url) return [];
    return [{
      title: typeof item.title === "string" ? item.title.slice(0, 300) : url,
      url,
      content: typeof item.content === "string" ? item.content.slice(0, 2_000) : "",
      score: typeof item.score === "number" && Number.isFinite(item.score) ? item.score : null,
      publishedDate: typeof item.published_date === "string" ? item.published_date.slice(0, 100) : null,
    }];
  }).slice(0, MAX_SEARCH_RESULTS);
}

export async function extractTavily(urls: string[]): Promise<{ results: TavilyExtractResult[]; failed: string[] }> {
  const safeUrls = validateTavilyExtractUrls(urls);
  const payload = await postKeyless(TAVILY_EXTRACT_ENDPOINT, {
    urls: safeUrls,
    extract_depth: "basic",
    format: "markdown",
    include_images: false,
  });
  if (!isRecord(payload)) throw new Error("Tavily extract response was invalid.");
  const results = Array.isArray(payload.results) ? payload.results.flatMap((item): TavilyExtractResult[] => {
    if (!isRecord(item)) return [];
    const url = publicHttpsUrl(item.url);
    if (!url) return [];
    return [{ url, content: typeof item.raw_content === "string" ? item.raw_content.slice(0, MAX_EXTRACT_CHARS) : "" }];
  }) : [];
  const failed = Array.isArray(payload.failed_results) ? payload.failed_results.flatMap((item) => {
    if (!isRecord(item)) return [];
    const url = publicHttpsUrl(item.url);
    return url ? [url] : [];
  }) : [];
  return { results: results.slice(0, MAX_EXTRACT_URLS), failed };
}