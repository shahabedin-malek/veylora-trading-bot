import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { E2E_BASE_URL } from "./e2e/config";

/**
 * The browser suite's own configuration.
 *
 * One worker and no retries on purpose: these specs mutate a shared SQLite file
 * and must be reproducible, and a retry that turns a real failure into a pass
 * would defeat the phase. Traces, screenshots and video are retained only on
 * failure, and the console log is attached by `e2e/fixtures/console.ts`.
 *
 * The web server is this suite's own: it resets the database, starts a loopback
 * mock chain and trusts a certificate generated for this run. It refuses a port
 * that already answers, so it cannot accidentally test somebody else's server.
 */
const outputDir = process.env.E2E_OUTPUT_DIR ?? join(tmpdir(), "veylora-e2e-results");

export default defineConfig({
  testDir: "./e2e",
  // Outside the repository on purpose: the dev server watches the project tree,
  // and a trace or video written mid-step would rebuild the page under the test.
  outputDir,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 120_000,
  expect: { timeout: 20_000 },
  globalTeardown: "./e2e/global-teardown.ts",
  reporter: [["list"]],
  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // The first cold request compiles the route and the fixture resets the
    // database, so a cold runner can take longer than a warm one. These are
    // bounded waits on observable state, not sleeps.
    actionTimeout: 60_000,
    navigationTimeout: 90_000,
    viewport: { width: 1440, height: 1000 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node_modules/.bin/tsx e2e/server.ts",
    url: `${E2E_BASE_URL}/api/auth/config`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
