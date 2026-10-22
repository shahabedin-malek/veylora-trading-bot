import assert from "node:assert/strict";
import test from "node:test";
import { GET, parseStatementRange, POST } from "./route";

/**
 * What the ledger route does when the deployment cannot authenticate anybody, and
 * what it does with the range it is handed.
 *
 * A missing auth configuration is a *configuration gap*, not a signed-out visitor:
 * the answer is a 503 that names the variable the deployment needs, because a 401
 * would send the owner looking for a session problem that does not exist. Both
 * methods answer that way, and the mutation refuses before it reads a body.
 *
 * The range rules are tested here rather than through a request because they are
 * the part that decides which movements a person is shown: a date with no time
 * meaning "the whole day" is what makes "filter to today" include today, and a
 * range that runs backwards is a mistake worth naming rather than an empty
 * statement.
 */

const AUTH_NAMES = ["AUTH_EVM_CHAIN_IDS", "APP_BASE_URL", "SESSION_SECRET"] as const;

function withoutAuthConfig<T>(run: () => Promise<T>): Promise<T> {
  const previous = AUTH_NAMES.map((name) => [name, process.env[name]] as const);
  for (const name of AUTH_NAMES) delete process.env[name];
  return run().finally(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function request(path: string, method: string): Request {
  const origin = "http://localhost";
  return new Request(new URL(path, origin), {
    method,
    headers: { "Content-Type": "application/json", Origin: origin },
    ...(method === "POST" ? { body: JSON.stringify({ action: "reverse-deposit", depositId: "deposit-1" }) } : {}),
  }) as never;
}

test("the ledger read fails closed when authentication is not configured", async () => {
  const response = await withoutAuthConfig(() => GET(request("/api/ledger", "GET") as never));
  assert.equal(response.status, 503);
  assert.match(((await response.json()) as { error: string }).error, /APP_BASE_URL|AUTH_EVM_CHAIN_IDS|SESSION_SECRET/);
});

test("asking to reverse a credit fails closed when authentication is not configured", async () => {
  const response = await withoutAuthConfig(() => POST(request("/api/ledger", "POST") as never));
  assert.equal(response.status, 503);
  assert.match(((await response.json()) as { error: string }).error, /APP_BASE_URL|AUTH_EVM_CHAIN_IDS|SESSION_SECRET/);
});

const NOON = new Date("2026-10-16T12:00:00.000Z");

function range(query: Record<string, string>) {
  return parseStatementRange(new URLSearchParams(query), NOON);
}

test("a date with no time covers the whole day it names", () => {
  const same = range({ from: "2026-10-16", to: "2026-10-16" });
  assert.ok(!("problem" in same));
  assert.equal((same as { from: Date }).from.toISOString(), "2026-10-16T00:00:00.000Z");
  // The end of the named day, not its start: "filter to today" has to include
  // everything that happened today.
  assert.equal((same as { to: Date }).to.toISOString(), "2026-10-16T23:59:59.999Z");
});

test("a range that runs backwards, an unreadable date and an over-long range are each named", () => {
  const backwards = range({ from: "2026-10-16", to: "2026-10-01" });
  assert.ok("problem" in backwards);
  assert.match((backwards as { problem: string }).problem, /start \(2026-10-16T00:00:00\.000Z\) is after its end/);

  const nonsense = range({ from: "yesterday" });
  assert.ok("problem" in nonsense);
  assert.match((nonsense as { problem: string }).problem, /"from" value "yesterday" is not a date/);

  const tooWide = range({ from: "2024-01-01", to: "2026-10-16" });
  assert.ok("problem" in tooWide);
  assert.match((tooWide as { problem: string }).problem, /at most 366 days/);
});

test("no range at all is the last thirty days, ending now", () => {
  const defaulted = range({});
  assert.ok(!("problem" in defaulted));
  assert.equal((defaulted as { to: Date }).to.toISOString(), NOON.toISOString());
  assert.equal(
    (defaulted as { from: Date }).from.toISOString(),
    new Date(NOON.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  );
});
