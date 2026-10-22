import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SANDBASE_MCP_URL,
  SANDBASE_TOOLS,
  callSandbaseTool,
  isSandbaseConfigured,
  searchSandbaseSocialPosts,
} from "@/lib/sandbase/client";
import { SANDBASE_REQUEST_LIMIT, consumeSandbaseRequest } from "@/lib/sandbase/rate-limit";

/**
 * The SandBase client's contract, with no network and no key.
 *
 * Three things are asserted here because they are the properties the assistant's promise
 * depends on: an unconfigured deployment reads nothing, only the pinned capability can be
 * called (the endpoint's own `sandbase_run` would start any of 2,000+ others), and a provider
 * failure is a sentence rather than an empty result the model could narrate around.
 */

const ENV: NodeJS.ProcessEnv = { NODE_ENV: "test", SANDBASE_API_KEY: "unit-test-sandbase-key" };

function postRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    screen_name: "trader",
    text: "  BTC  breaking   out  ",
    created_at: "Wed Oct 21 19:56:13 +0000 2026",
    tweet_id: "2112996398186508493",
    favorites: 320,
    retweets: 37,
    replies: 14,
    views: 12_345,
    user_info: { name: "A Trader", verified: true, followers_count: 1_500 },
    ...overrides,
  };
}

/** The envelope the endpoint answers with for a finished `sandbase_run`. */
function runResponse(timeline: unknown[]): Response {
  const payload = [{ data: { timeline, next_cursor: null, prev_cursor: null, status: "ok" } }];
  return Response.json({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: {
        cost_status: "settling",
        model: SANDBASE_TOOLS.socialPosts.model,
        output: payload,
      },
    },
  });
}

test("an unconfigured deployment refuses by name and never reaches the network", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({});
  };
  try {
    await assert.rejects(
      searchSandbaseSocialPosts({ topic: "bitcoin", sort: "Latest", limit: 5 }, {} as NodeJS.ProcessEnv),
      /SANDBASE_API_KEY is unset/,
    );
    assert.equal(calls, 0, "no request was made without a key");
    assert.equal(isSandbaseConfigured({} as NodeJS.ProcessEnv), false);
    // A placeholder from `.env.example` reads as absent rather than as a key that fails later.
    assert.equal(
      isSandbaseConfigured({ NODE_ENV: "test", SANDBASE_API_KEY: "replace-with-a-key" } as NodeJS.ProcessEnv),
      false,
    );
    assert.equal(isSandbaseConfigured(ENV), true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a search calls the pinned capability with the deployment key and bounds the rows", async () => {
  const previousFetch = globalThis.fetch;
  let observedUrl = "";
  let observedHeaders: Headers | undefined;
  let observedBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    observedUrl = String(input);
    observedHeaders = new Headers(init?.headers);
    observedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return runResponse([
      postRow(),
      postRow({
        screen_name: "analyst",
        text: "x".repeat(900),
        created_at: "Thu Oct 22 08:00:00 +0000 2026",
        tweet_id: "2112996398186508494",
        user_info: { name: null, verified: false, followers_count: null },
      }),
      // A row with no text is dropped, not passed on as an empty quote.
      postRow({ screen_name: "empty", text: "   " }),
    ]);
  };
  try {
    const read = await searchSandbaseSocialPosts(
      { topic: " bitcoin ", sort: "Latest", limit: 5, now: new Date("2026-10-22T12:00:00.000Z") },
      ENV,
    );

    assert.equal(observedUrl, SANDBASE_MCP_URL);
    assert.equal(observedHeaders?.get("Authorization"), `Bearer ${ENV.SANDBASE_API_KEY}`);
    assert.equal(observedHeaders?.get("x-sandbase-client"), "veylora");
    const params = observedBody?.params as Record<string, unknown>;
    assert.equal(observedBody?.method, "tools/call");
    assert.equal(params.name, "sandbase_run");
    const forwarded = params.arguments as Record<string, unknown>;
    assert.equal(forwarded.name, SANDBASE_TOOLS.socialPosts.name);
    assert.deepEqual(forwarded.arguments, { keyword: "bitcoin", search_type: "Latest" });

    assert.equal(read.topic, "bitcoin");
    assert.equal(read.vendor, SANDBASE_TOOLS.socialPosts.vendor);
    assert.equal(read.posts.length, 2);
    // Newest first, and the long post is cut rather than returned whole.
    assert.equal(read.posts[0]!.author, "analyst");
    assert.equal(read.posts[0]!.text.length, 600);
    assert.equal(read.posts[1]!.text, "BTC breaking out");
    assert.equal(read.posts[1]!.url, "https://x.com/trader/status/2112996398186508493");
    assert.equal(read.posts[1]!.createdAt, "2026-10-21T19:56:13.000Z");
    assert.equal(read.posts[1]!.verified, true);
    assert.deepEqual(read.posts[1]!.engagement, { likes: 320, reposts: 37, replies: 14, views: 12_345 });
    // The citation's as-of is the newest post's own time, not the read time.
    assert.equal(read.newestAt, "2026-10-22T08:00:00.000Z");
    assert.equal(read.readAt, "2026-10-22T12:00:00.000Z", "the read time is the server's, the as-of is the post's");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Top results keep the provider's order and the limit is applied here", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    runResponse([
      postRow({ screen_name: "first", created_at: "Mon Oct 20 10:00:00 +0000 2026" }),
      postRow({ screen_name: "second", created_at: "Tue Oct 21 10:00:00 +0000 2026" }),
      postRow({ screen_name: "third", created_at: "Wed Oct 22 10:00:00 +0000 2026" }),
    ]);
  try {
    const read = await searchSandbaseSocialPosts({ topic: "solana", sort: "Top", limit: 2 }, ENV);
    assert.deepEqual(read.posts.map((post) => post.author), ["first", "second"]);
    assert.equal(read.newestAt, "2026-10-21T10:00:00.000Z");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("only the pinned capability can be called, so the balance cannot be spent on another", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({});
  };
  try {
    const unpinned = "sandbase_run" as unknown as Parameters<typeof callSandbaseTool>[0];
    await assert.rejects(callSandbaseTool(unpinned, {}, ENV), /does not call the SandBase capability/);
    assert.equal(calls, 0, "the refusal happened before any request");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a provider failure is a sentence, never an empty result", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response("{}", { status: 402, headers: { "content-type": "application/json" } });
    await assert.rejects(
      searchSandbaseSocialPosts({ topic: "bitcoin", sort: "Latest", limit: 3 }, ENV),
      /balance or spending limit/,
    );

    globalThis.fetch = async () => new Response("{}", { status: 401 });
    await assert.rejects(
      searchSandbaseSocialPosts({ topic: "bitcoin", sort: "Latest", limit: 3 }, ENV),
      /rejected this deployment's API key/,
    );

    globalThis.fetch = async () =>
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: true,
          structuredContent: {
            error: { code: "invalid_arguments", message: "parameter validation failed: missing 'keyword'" },
          },
        },
      });
    // The provider's own sentence is carried through rather than replaced with a guess.
    await assert.rejects(
      searchSandbaseSocialPosts({ topic: "bitcoin", sort: "Latest", limit: 3 }, ENV),
      /parameter validation failed/,
    );

    globalThis.fetch = async () => new Response("x".repeat(600_000));
    await assert.rejects(
      searchSandbaseSocialPosts({ topic: "bitcoin", sort: "Latest", limit: 3 }, ENV),
      /exceeded the size/,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a search rejects an empty or oversized topic before asking the provider", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return runResponse([]);
  };
  try {
    await assert.rejects(
      searchSandbaseSocialPosts({ topic: "   ", sort: "Latest", limit: 3 }, ENV),
      /1–120 characters/,
    );
    await assert.rejects(
      searchSandbaseSocialPosts({ topic: "x".repeat(121), sort: "Latest", limit: 3 }, ENV),
      /1–120 characters/,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("one account's SandBase budget is its own, and it resets on the next minute", () => {
  const now = Date.UTC(2026, 9, 22, 12, 0, 0);
  for (let index = 0; index < SANDBASE_REQUEST_LIMIT; index += 1) {
    assert.equal(consumeSandbaseRequest("sandbase-budget-owner", now), true, `request ${index + 1} is allowed`);
  }
  assert.equal(consumeSandbaseRequest("sandbase-budget-owner", now), false, "the next one is refused");
  assert.equal(consumeSandbaseRequest("sandbase-budget-neighbour", now), true, "another account has its own minute");
  assert.equal(consumeSandbaseRequest("sandbase-budget-owner", now + 60_000), true, "the window resets");
});
