import { instrumentFetch, PROVIDER_IDS } from "@/lib/observability/provider-call";

/**
 * SandBase, through the one HTTP endpoint its own CLI speaks.
 *
 * SandBase is a catalogue of third-party data APIs and models behind a single balance and a
 * single key. It exposes them as a Model Context Protocol server at `/v1/mcp`, and the CLI is
 * nothing more than a JSON-RPC client for it — so this module is the same client, written for
 * a server that cannot shell out to `npx`.
 *
 * Three properties are structural:
 *
 *  1. **The catalogue is not addressable from here.** The endpoint's `sandbase_run` tool can
 *     start any of 2,000+ capabilities, including ones that bill per call. This build calls
 *     exactly the entries in {@link SANDBASE_TOOLS}, and {@link callSandbaseTool} refuses
 *     every other name before a request is made, so a model cannot spend the balance on a
 *     model of its own choosing.
 *  2. **The pinned tool is free at the time of writing.** `sandbase inspect` reports
 *     `base_price: 0` for it; a future price change turns the call into the 402 branch below,
 *     which is reported as a refusal rather than silently paid.
 *  3. **A failure is a sentence.** Every status, JSON-RPC error and size violation becomes an
 *     `Error` whose message names the cause, because the assistant's contract is that missing
 *     data is stated rather than estimated.
 */

export const SANDBASE_MCP_URL = "https://api.sandbase.ai/v1/mcp";

/**
 * The capabilities this build is allowed to call.
 *
 * `sandbase_twitter_web_search_timeline` is a pass-through to Twitter/X keyword search: text,
 * author, time and engagement counts, priced at zero. It is the structured complement to
 * Tavily — Tavily answers "what did the web publish", this answers "what are people saying",
 * and neither number is used for trading.
 */
export const SANDBASE_TOOLS = {
  socialPosts: {
    name: "sandbase_twitter_web_search_timeline",
    vendor: "Twitter / X",
    model: "twitter/web/search-timeline",
  },
} as const;

export type SandbaseToolKey = keyof typeof SANDBASE_TOOLS;
export type SandbaseToolName = (typeof SANDBASE_TOOLS)[SandbaseToolKey]["name"];

const ALLOWED_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(SANDBASE_TOOLS).map((tool) => tool.name),
);

const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
export const MAX_SOCIAL_POSTS = 20;
const MAX_POST_CHARACTERS = 600;
const MAX_TOPIC_CHARACTERS = 120;
/** How deep a response envelope is searched for the rows it carries. */
const MAX_ENVELOPE_DEPTH = 6;

export type SandbaseSocialSort = "Top" | "Latest";

export type SandbaseSocialPost = {
  author: string;
  authorName: string | null;
  verified: boolean;
  followers: number | null;
  text: string;
  /** The post's own publication time, ISO, or null when it could not be parsed. */
  createdAt: string | null;
  url: string | null;
  engagement: {
    likes: number | null;
    reposts: number | null;
    replies: number | null;
    views: number | null;
  };
};

export type SandbaseSocialRead = {
  topic: string;
  sort: SandbaseSocialSort;
  vendor: string;
  model: string;
  /** When this deployment read the rows; never used as the citation's `asOf`. */
  readAt: string;
  /** The newest post's own time, which is what the citation carries. */
  newestAt: string | null;
  posts: SandbaseSocialPost[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The deployment's key, or null.
 *
 * A placeholder from `.env.example` reads as unconfigured rather than as a key that will fail
 * at the provider with a 401 the owner has to decode.
 */
export function resolveSandbaseKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.SANDBASE_API_KEY?.trim();
  if (!value) return null;
  if (value.length < 8 || /^(?:replace|change.?me|example|your[.\s_-])/i.test(value)) return null;
  return value;
}

export function isSandbaseConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveSandbaseKey(env) !== null;
}

function missingKeySentence(): string {
  return (
    "SandBase is not configured on this deployment: SANDBASE_API_KEY is unset, " +
    "so no social data was read."
  );
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
        throw new Error("The SandBase response exceeded the size this tool accepts.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

/** The JSON-RPC envelope, from a plain body or the server's own event-stream frame. */
function parseEnvelope(text: string, contentType: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) candidates.push(line.slice(5).trim());
    }
  } else {
    candidates.push(text, ...text.split(/\r?\n/));
  }
  for (const candidate of candidates) {
    if (!candidate || candidate === "[DONE]") continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // A gateway's HTML error page: the status already said what happened.
    }
  }
  return null;
}

function statusSentence(status: number): string {
  if (status === 401 || status === 403) {
    return `SandBase rejected this deployment's API key (HTTP ${status}); a key created at the SandBase console is needed.`;
  }
  if (status === 402) {
    return (
      "SandBase refused the call because this account's balance or spending limit does not cover it (HTTP 402). " +
      "Nothing was read and no figure was estimated."
    );
  }
  if (status === 429) {
    return "SandBase rate-limited this deployment (HTTP 429); try again in a minute.";
  }
  if (status >= 500) {
    return `SandBase answered HTTP ${status}; the provider failed and nothing was read.`;
  }
  return `SandBase answered HTTP ${status}; the request was not accepted.`;
}

function errorSentenceOf(result: Record<string, unknown>, text: string): string {
  const structured = isRecord(result.structuredContent) ? result.structuredContent : null;
  const error = structured && isRecord(structured.error) ? structured.error : null;
  const message = typeof error?.message === "string" && error.message ? error.message : null;
  if (message) return message;
  const content = Array.isArray(result.content) ? result.content : [];
  const joined = content
    .filter((item): item is Record<string, unknown> => isRecord(item) && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join(" ")
    .trim();
  if (joined) return joined;
  return text ? `SandBase reported an error: ${text.slice(0, 200)}` : "SandBase reported an error without a message.";
}

/**
 * Call one allowlisted SandBase tool and return its structured payload.
 *
 * The endpoint takes capability names as arguments to its own `sandbase_run` tool, which is
 * why the name is checked against the allowlist *here*: a request that reached the server
 * with an unpinned name would have been accepted.
 */
export async function callSandbaseTool(
  name: SandbaseToolName,
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  if (!ALLOWED_TOOL_NAMES.has(name)) {
    throw new Error(`This build does not call the SandBase capability ${name}.`);
  }
  const key = resolveSandbaseKey(env);
  if (!key) throw new Error(missingKeySentence());

  // Instrumented per call, so a test that replaces the global `fetch` is the function that
  // actually runs — and so a production call is recorded like every other provider's.
  const request = instrumentFetch({ providerId: PROVIDER_IDS.sandbase });
  let response: Response;
  try {
    response = await request(SANDBASE_MCP_URL, {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "x-sandbase-client": "veylora",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "sandbase_run", arguments: { name, arguments: args } },
      }),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError"
      ? "the request timed out"
      : "the network call failed";
    throw new Error(`SandBase could not be reached: ${reason}. Nothing was read.`);
  }

  const raw = await readBoundedResponse(response);
  if (!response.ok) throw new Error(statusSentence(response.status));

  const envelope = parseEnvelope(raw, response.headers.get("content-type") ?? "");
  if (!envelope) {
    throw new Error("SandBase answered with something that was not a JSON-RPC response.");
  }
  if (envelope.error) {
    const message = isRecord(envelope.error) && typeof envelope.error.message === "string"
      ? envelope.error.message
      : "the request failed";
    throw new Error(`SandBase refused the call: ${message}`);
  }
  const result = isRecord(envelope.result) ? envelope.result : null;
  if (!result) throw new Error("SandBase answered without a result.");
  if (result.isError === true) throw new Error(errorSentenceOf(result, raw));

  if (isRecord(result.structuredContent)) {
    const structured = result.structuredContent;
    // A run that is still going is reported by its id rather than polled from a chat tool:
    // re-running it would bill a second time, and the id is what makes it recoverable.
    const status = typeof structured.status === "string" ? structured.status : null;
    const runId = typeof structured.run_id === "string" ? structured.run_id : null;
    if (runId && (status === "running" || status === "pending")) {
      throw new Error(
        `SandBase started run ${runId} and it is still ${status}; this tool only returns finished data.`,
      );
    }
    return structured.output ?? structured;
  }

  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter((item): item is Record<string, unknown> => isRecord(item) && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n")
    .trim();
  if (!text) throw new Error("SandBase returned no data.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("SandBase returned data this build could not read.");
  }
}

/** The first array named `timeline` anywhere in a bounded response envelope. */
function findTimeline(value: unknown, depth = 0): unknown[] | null {
  if (depth > MAX_ENVELOPE_DEPTH || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTimeline(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.timeline)) return record.timeline;
  for (const nested of Object.values(record)) {
    const found = findTimeline(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function postFromRow(row: unknown): SandbaseSocialPost | null {
  if (!isRecord(row)) return null;
  const author = typeof row.screen_name === "string" ? row.screen_name.trim() : "";
  const text = typeof row.text === "string" ? row.text.replace(/\s+/g, " ").trim() : "";
  // A row with no text (a media-only or promoted entry) is dropped rather than passed to the
  // model as an empty quote it might describe.
  if (!author || !text) return null;
  const user = isRecord(row.user_info) ? row.user_info : null;
  const authorName = user && typeof user.name === "string" ? user.name.trim() : null;
  const tweetId = typeof row.tweet_id === "string" || typeof row.tweet_id === "number" ? String(row.tweet_id) : null;
  return {
    author,
    authorName: authorName || null,
    verified: user?.verified === true,
    followers: finiteNumber(user?.followers_count),
    text: text.slice(0, MAX_POST_CHARACTERS),
    createdAt: isoOrNull(row.created_at),
    url: tweetId && /^\d+$/.test(tweetId) ? `https://x.com/${author}/status/${tweetId}` : null,
    engagement: {
      likes: finiteNumber(row.favorites),
      reposts: finiteNumber(row.retweets),
      replies: finiteNumber(row.replies),
      views: finiteNumber(row.views),
    },
  };
}

/**
 * Search public posts about a topic, newest or most relevant first.
 *
 * The provider returns a fixed page of up to 20 rows and has no result-count argument, so the
 * bound is applied here: sorted the way the caller asked, then cut. `newestAt` is taken from
 * the posts that are returned, which is what the citation says the data is as-of.
 */
export async function searchSandbaseSocialPosts(
  input: { topic: string; sort: SandbaseSocialSort; limit: number; now?: Date },
  env: NodeJS.ProcessEnv = process.env,
): Promise<SandbaseSocialRead> {
  const topic = input.topic.trim();
  if (topic.length < 1 || topic.length > MAX_TOPIC_CHARACTERS) {
    throw new Error(`A SandBase topic must be 1–${MAX_TOPIC_CHARACTERS} characters.`);
  }
  if (input.sort !== "Top" && input.sort !== "Latest") {
    throw new Error("A SandBase search is either Top or Latest.");
  }
  const limit = Math.min(MAX_SOCIAL_POSTS, Math.max(1, Math.trunc(input.limit)));
  const tool = SANDBASE_TOOLS.socialPosts;

  const payload = await callSandbaseTool(
    tool.name,
    { keyword: topic, search_type: input.sort },
    env,
  );
  const timeline = findTimeline(payload);
  if (!timeline) {
    throw new Error("SandBase returned no post list for this topic.");
  }

  const posts = timeline
    .flatMap((row) => {
      const post = postFromRow(row);
      return post ? [post] : [];
    })
    .sort((left, right) =>
      input.sort === "Latest"
        ? (right.createdAt ?? "").localeCompare(left.createdAt ?? "")
        : 0,
    )
    .slice(0, limit);

  const newestAt = posts
    .map((post) => post.createdAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? null;

  return {
    topic,
    sort: input.sort,
    vendor: tool.vendor,
    model: tool.model,
    readAt: (input.now ?? new Date()).toISOString(),
    newestAt,
    posts,
  };
}
