import { Buffer } from "node:buffer";

const MAX_PAPER_BODY_BYTES = 4_096;
const PAPER_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPaperRuntimeAvailable(): boolean {
  return process.env.NODE_ENV !== "production";
}

export function isPaperSessionId(value: unknown): value is string {
  return typeof value === "string" && PAPER_SESSION_ID_PATTERN.test(value);
}

export function isSameOriginPaperWrite(request: Request): boolean {
  const expectedHost = request.headers.get("host") ?? new URL(request.url).host;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const parsedOrigin = new URL(origin);
      return parsedOrigin.host === expectedHost && (parsedOrigin.protocol === "http:" || parsedOrigin.protocol === "https:");
    } catch {
      return false;
    }
  }
  if (request.headers.get("sec-fetch-site") === "same-origin") return true;
  const referer = request.headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).host === expectedHost;
  } catch {
    return false;
  }
}

export function paperJson(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function readPaperJson(request: Request): Promise<{ body: unknown } | { response: Response }> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return { response: paperJson({ error: "Content-Type must be application/json." }, 415) };
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { response: paperJson({ error: "Invalid paper request body." }, 400) };
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_PAPER_BODY_BYTES) return { response: paperJson({ error: "Paper request is too large." }, 413) };
  try {
    return { body: JSON.parse(raw) as unknown };
  } catch {
    return { response: paperJson({ error: "Invalid JSON request." }, 400) };
  }
}

export function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}