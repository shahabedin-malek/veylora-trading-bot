/**
 * Leave the local database as the seed found it.
 *
 * The suite writes deposits, withdrawals, sessions and one risk-policy edit. A
 * re-run must start from the same state, so teardown performs the same reset the
 * server performed before the suite. `E2E_KEEP_DB=1` keeps the mutation for
 * debugging a failure and is the only way to skip this.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { e2eEnvironment } from "./config";

export default async function globalTeardown() {
  if (process.env.E2E_KEEP_DB === "1") {
    console.log("E2E: E2E_KEEP_DB=1, so the mutated database was kept for inspection.");
    return;
  }
  // Playwright loads this file through its CJS transform, where `import.meta`
  // is unavailable; the runner's working directory is the app directory.
  const appDir = process.cwd();
  const result = spawnSync(process.execPath, [join(appDir, "scripts", "dev-database.mjs"), "reset"], {
    cwd: appDir,
    env: e2eEnvironment(),
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    throw new Error("The e2e database could not be restored to its seeded state.");
  }
  console.log("E2E: database restored to the seeded state.");
}
