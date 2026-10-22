import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import nextConfig from "../next.config";
import {
  clientAddress,
  consumeRateLimit,
  RATE_LIMITS,
  rateLimitResponse,
  resetRateLimits,
} from "../src/lib/security/rate-limit";

/**
 * The phase 39 assertions, one per property the review turned from a description into a check.
 *
 *  - The limiter refuses a burst, and the refusal is a 429 that tells the caller when to come
 *    back rather than a generic error.
 *  - Every response carries the headers that constrain what a page can load and where it can
 *    send data. HSTS is production-only, because pinning http://localhost for six months is a
 *    development trap.
 *  - The ledger account table carries no balance column, which is why "only the ledger writes
 *    balances" is a structural fact rather than a rule someone has to remember.
 */

test("the limiter refuses past the ceiling and resets when the window closes", () => {
  resetRateLimits();
  const start = 1_000_000;
  const decisions = Array.from({ length: 4 }, (_, index) =>
    consumeRateLimit("test:burst", 3, { now: start + index }),
  );
  assert.deepEqual(decisions.map((decision) => decision.allowed), [true, true, true, false]);
  assert.equal(decisions[3]!.remaining, 0);
  assert.equal(decisions[0]!.remaining, 2);

  const stillRefused = consumeRateLimit("test:burst", 3, { now: start + 30_000 });
  assert.equal(stillRefused.allowed, false, "refusals do not extend the window, but they do not pass");
  assert.equal(stillRefused.resetAt, start + 60_000, "the reset time is stable while refused");

  const afterWindow = consumeRateLimit("test:burst", 3, { now: start + 60_000 });
  assert.equal(afterWindow.allowed, true, "a new window starts one window after the first request");
  assert.equal(afterWindow.remaining, 2);
});

test("the limiter keeps callers apart, and a refusal is a 429 with the numbers", async () => {
  resetRateLimits();
  consumeRateLimit("auth.verify:203.0.113.7", 1);
  assert.equal(consumeRateLimit("auth.verify:203.0.113.7", 1).allowed, false, "the same caller is capped");
  assert.equal(consumeRateLimit("auth.verify:198.51.100.9", 1).allowed, true, "another caller is not");

  const decision = consumeRateLimit("auth.verify:203.0.113.7", 1);
  const response = rateLimitResponse(decision, "Too many sign-in attempts.");
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), String(decision.retryAfterSeconds));
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.code, "RATE_LIMITED");
  assert.equal(body.limit, 1);
});

test("the caller address is the proxy's, and an unattributable request is still counted", () => {
  const real = new Request("https://example.test/", { headers: { "x-real-ip": "203.0.113.7" } });
  assert.equal(clientAddress(real), "203.0.113.7");

  const forwarded = new Request("https://example.test/", {
    headers: { "x-forwarded-for": "198.51.100.9, 10.0.0.1" },
  });
  assert.equal(clientAddress(forwarded), "198.51.100.9", "the first hop is the client");

  const none = new Request("https://example.test/");
  assert.equal(clientAddress(none), "unknown", "no header is not an exemption");
  assert.equal(RATE_LIMITS.authVerifyPerMinute, 60);
  assert.equal(RATE_LIMITS.withdrawalCreatePerMinute, 10);
});

test("every response carries the constraining headers, and HSTS only in production", async () => {
  assert.ok(nextConfig.headers, "next.config declares headers()");
  const rules = await nextConfig.headers();
  assert.equal(rules.length, 1);
  const rule = rules[0]!;
  assert.equal(rule.source, "/:path*", "the rule covers pages and routes alike");
  const headers = new Map(rule.headers.map((header) => [header.key.toLowerCase(), header.value]));

  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.match(headers.get("permissions-policy") ?? "", /camera=\(\)/, "the browser features this app never uses are off");

  const csp = headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/, "nothing loads from an origin that is not named");
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/, "an injected <base> cannot retarget relative URLs");
  assert.match(csp, /form-action 'self'/, "a form cannot post to another origin");
  assert.match(csp, /frame-ancestors 'none'/, "the app cannot be framed");
  assert.match(csp, /wss:\/\/ws-feed\.exchange\.coinbase\.com/, "the live ticker's own feed is allowed");
  assert.match(csp, /wss:\/\/\*\.walletconnect\.org|\*\.walletconnect\.com/, "mobile pairing reaches its relay");
  const connectSources = (/connect-src ([^;]+)/.exec(csp)?.[1] ?? "").split(" ");
  assert.ok(connectSources.length > 1, "connect-src lists its sources");
  assert.equal(connectSources.includes("*"), false, "connect-src has no wildcard origin");
  assert.equal(connectSources.includes("https:"), false, "connect-src is not \"any https host\"");

  // Under `node --test`, NODE_ENV is not "production", so the production-only header is absent.
  assert.equal(headers.has("strict-transport-security"), false, "HSTS is not pinned on a development origin");

  // The same call under NODE_ENV=production is what the deployed server emits: HSTS with a
  // two-year max-age, and eval refused in the script policy.
  // `process.env.NODE_ENV` is typed read-only; the runtime value is what `next start` sets, and
  // the header builder reads it at call time, so a writable view is enough to exercise that
  // branch without starting a server.
  const env = process.env as Record<string, string | undefined>;
  const previous = env.NODE_ENV;
  env.NODE_ENV = "production";
  try {
    const productionRule = (await nextConfig.headers!())[0]!;
    const productionHeaders = new Map(productionRule.headers.map((header) => [header.key.toLowerCase(), header.value]));
    assert.equal(
      productionHeaders.get("strict-transport-security"),
      "max-age=63072000; includeSubDomains; preload",
    );
    const productionCsp = productionHeaders.get("content-security-policy") ?? "";
    assert.doesNotMatch(productionCsp, /'unsafe-eval'/, "eval is refused in the deployed policy");
    assert.match(productionCsp, /'unsafe-inline'/, "the framework's own inline bootstrap is still allowed");
    assert.doesNotMatch(productionCsp, /ws:\/\/localhost/, "development origins are not in the deployed policy");
  } finally {
    if (previous === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = previous;
  }
  assert.equal(nextConfig.poweredByHeader, false, "the framework banner is not advertised");
});

test("the ledger account table has no balance column to write", () => {
  const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
  const block = /model LedgerAccount \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? "";
  assert.ok(block.length > 0, "the LedgerAccount model is present");
  assert.doesNotMatch(block, /\bbalance/i, "a balance is derived from LedgerEntry rows, never stored beside them");
  assert.match(block, /entries\s+LedgerEntry\[\]/, "the account's only money relationship is its entries");
});
