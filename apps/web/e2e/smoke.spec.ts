import { expect, test } from "@playwright/test";

/**
 * What must be true of *any* deployment that is going to be handed to a client.
 *
 * These are the checks the journey suite cannot make, because it owns the server it
 * tests. Nothing here writes, signs in or moves money: it asks whether the public side
 * answers, whether the deployment knows its own auth configuration, whether a
 * signed-out data route refuses, and whether the response names the commit it came from.
 *
 * Run it with `E2E_BASE_URL=https://… pnpm e2e:smoke`. Set `SMOKE_EXPECT_COMMIT` to the
 * commit that was meant to deploy and the check becomes a deployment check rather than
 * a liveness check.
 */

const PUBLIC_PAGES = ["/", "/pricing", "/status", "/docs", "/docs/api", "/terms", "/privacy", "/risk", "/faq", "/login"];

test("every public page renders without a session", async ({ request }) => {
  for (const path of PUBLIC_PAGES) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), `${path} must answer 200`).toBe(200);
    const body = await response.text();
    expect(body.length, `${path} must render something`).toBeGreaterThan(400);
  }
});

test("the deployment reports its own auth configuration", async ({ request }) => {
  const response = await request.get("/api/auth/config");
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { enabled?: unknown; allowedChainIds?: unknown; reason?: unknown };
  expect(typeof body.enabled).toBe("boolean");
  if (body.enabled === true) {
    expect(Array.isArray(body.allowedChainIds)).toBe(true);
    expect((body.allowedChainIds as unknown[]).length).toBeGreaterThan(0);
  } else {
    expect(typeof body.reason).toBe("string");
  }
});

test("a signed-out data route refuses instead of answering data", async ({ request }) => {
  const response = await request.get("/api/account");
  expect([401, 403, 503], "a signed-out request must never receive account data").toContain(response.status());
  const body = await response.text();
  expect(body).not.toContain("availableMinor");
});

test("the response names the commit the deployment was built from", async ({ request }) => {
  const response = await request.get("/");
  const commit = response.headers()["x-veylora-commit"];
  expect(commit, "every response carries X-Veylora-Commit").toBeTruthy();
  const expected = process.env.SMOKE_EXPECT_COMMIT?.trim();
  if (expected) expect(commit).toBe(expected);
});

test("no page carries an RPC endpoint with a key in it", async ({ request }) => {
  for (const path of PUBLIC_PAGES) {
    const body = await (await request.get(path)).text();
    expect(body, `${path} must not embed an Alchemy endpoint`).not.toMatch(/alchemy\.com\/v2\//i);
  }
});
