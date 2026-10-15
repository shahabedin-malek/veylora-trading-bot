import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TAVILY_EXTRACT_ENDPOINT,
  TAVILY_SEARCH_ENDPOINT,
  extractTavily,
  searchTavily,
  validateTavilyExtractUrls,
} from "@/lib/tavily/client";

test("Tavily Search uses keyless basic mode without an authorization key", async () => {
  const previousFetch = globalThis.fetch;
  let observedUrl = "";
  let observedHeaders: Headers | undefined;
  let observedBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    observedUrl = String(input);
    observedHeaders = new Headers(init?.headers);
    observedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ results: [{ title: "Source", url: "https://news.example.org/story", content: "Relevant source", score: 0.9 }] });
  };
  try {
    const results = await searchTavily("BTC market structure", "finance");
    assert.equal(observedUrl, TAVILY_SEARCH_ENDPOINT);
    assert.equal(observedHeaders?.get("X-Tavily-Access-Mode"), "keyless");
    assert.equal(observedHeaders?.get("Authorization"), null);
    assert.equal(observedBody?.search_depth, "basic");
    assert.equal(observedBody?.max_results, 5);
    assert.equal(observedBody?.include_answer, false);
    assert.deepEqual(results, [{
      title: "Source",
      url: "https://news.example.org/story",
      content: "Relevant source",
      score: 0.9,
      publishedDate: null,
    }]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Tavily Extract rejects local, insecure, credentialed, and sensitive URLs", () => {
  const credentialedUrl = new URL("https://news.example.org/");
  credentialedUrl.username = "reader";
  credentialedUrl.password = "pass";
  for (const value of [
    "http://news.example.org",
    "https://localhost/admin",
    "https://127.0.0.1/private",
    credentialedUrl.toString(),
    "https://news.example.org/?access_token=hidden",
  ]) {
    assert.throws(() => validateTavilyExtractUrls([value]));
  }
  assert.deepEqual(validateTavilyExtractUrls(["https://news.example.org/article"]), ["https://news.example.org/article"]);
  assert.throws(() => validateTavilyExtractUrls(Array.from({ length: 4 }, (_, index) => `https://site${index}.org`)));
});

test("Tavily Extract sends keyless mode and bounds returned content", async () => {
  const previousFetch = globalThis.fetch;
  let observedUrl = "";
  let observedHeaders: Headers | undefined;
  let observedBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    observedUrl = String(input);
    observedHeaders = new Headers(init?.headers);
    observedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ results: [{ url: "https://news.example.org/article", raw_content: "x".repeat(7_000) }] });
  };
  try {
    const result = await extractTavily(["https://news.example.org/article"]);
    assert.equal(observedUrl, TAVILY_EXTRACT_ENDPOINT);
    assert.equal(observedHeaders?.get("X-Tavily-Access-Mode"), "keyless");
    assert.equal(observedHeaders?.get("Authorization"), null);
    assert.equal(observedBody?.extract_depth, "basic");
    assert.equal(result.results[0]?.content.length, 6_000);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Tavily search rejects oversized queries and extracts reject duplicates", async () => {
  await assert.rejects(searchTavily("x".repeat(401), "general"), /1–400 characters/);
  assert.throws(() => validateTavilyExtractUrls([
    "https://news.example.org/article",
    "https://news.example.org/article",
  ]), /unique/);
});