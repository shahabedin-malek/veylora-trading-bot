import { defineConfig, devices } from "@playwright/test";

/**
 * The hosted, read-only smoke check.
 *
 * It is deliberately not the journey suite: that one resets a SQLite database, starts a
 * mock chain and moves money, so it can only ever be honest on a loopback server it
 * seeded itself. This one takes a URL somebody deployed and asks only questions that
 * must be true of any environment: the public pages render, the auth configuration
 * answers, a signed-out data API refuses, and the response names the commit it was
 * built from.
 *
 * `E2E_BASE_URL` is required. A missing one is an error rather than a default, so the
 * check cannot silently pass against the developer's own machine.
 */
const baseURL = process.env.E2E_BASE_URL?.trim();
if (!baseURL) {
  throw new Error("E2E_BASE_URL is required for the hosted smoke check, for example https://preview.example.com");
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: /smoke\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    viewport: { width: 1280, height: 900 },
  },
  projects: [{ name: "smoke", use: { ...devices["Desktop Chrome"] } }],
});
