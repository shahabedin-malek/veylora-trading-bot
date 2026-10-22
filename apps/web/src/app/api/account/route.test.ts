import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "./route";
import { GET as exportGet } from "./export/route";

/**
 * What the account surface does when the deployment cannot authenticate anybody.
 *
 * A missing auth configuration is a *configuration gap*, not a signed-out visitor: the
 * answer is a 503 whose body names the variable the deployment needs, because a 401
 * would send the owner looking for a session problem that does not exist. Both reads
 * answer that way — the view and the export — and the export is checked as well
 * because it is a second route onto the same data and a gap it forgot would be a
 * download that leaks nothing but looks like a working one.
 *
 * The filter's own refusals are asserted in `tests/fund-visibility.test.ts` against
 * the pure parser, because reaching them through the route would need a session and
 * the refusal does not depend on the request being authenticated at all.
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

function request(path: string): Request {
  return new Request(new URL(path, "http://localhost"), { method: "GET" }) as never;
}

test("the account view fails closed when authentication is not configured", async () => {
  const response = await withoutAuthConfig(() => GET(request("/api/account") as never));
  assert.equal(response.status, 503);
  assert.match(((await response.json()) as { error: string }).error, /APP_BASE_URL|AUTH_EVM_CHAIN_IDS|SESSION_SECRET/);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("the export fails closed the same way, so a download is never a gap that looks like a file", async () => {
  for (const query of ["", "?format=csv", "?format=json&from=2026-10-01&to=2026-10-17"]) {
    const response = await withoutAuthConfig(() => exportGet(request(`/api/account/export${query}`) as never));
    assert.equal(response.status, 503, query);
    assert.match(((await response.json()) as { error: string }).error, /APP_BASE_URL|AUTH_EVM_CHAIN_IDS|SESSION_SECRET/);
  }
});
