import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The deploy procedure has one property worth a test: the migration runs *before* the build and a
 * failed migration stops the deploy. Everything else about publishing is the owner's judgement;
 * this is the part a careless edit to `package.json` would silently break.
 */
const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = JSON.parse(readFileSync(resolve(APP_DIR, "package.json"), "utf8")).scripts as Record<string, string>;

/** Split a shell script on the operators that decide short-circuiting, keeping them. */
function chain(script: string): string[] {
  return script
    .split(/(&&|\|\||;)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

test("the deploy runs the migration before the build, and stops if it fails", () => {
  const deploy = scripts["build:vercel"];
  assert.ok(deploy, "package.json must keep a `build:vercel` script — the host runs it");

  const parts = chain(deploy);
  const migrate = parts.findIndex((part) => part.includes("prisma migrate deploy"));
  const build = parts.findIndex((part) => part.includes("next build"));
  assert.ok(migrate >= 0, "the deploy must run `prisma migrate deploy`");
  assert.ok(build >= 0, "the deploy must run `next build`");
  assert.ok(migrate < build, `the migration must run before the build, not after: ${deploy}`);
  assert.equal(parts.some((part) => part === "||" || part === ";"), false, `nothing may detach the build from the migration: ${deploy}`);
  assert.equal(parts[migrate + 1], "&&", `a failed migration must stop the build: ${deploy}`);
});

test("the migration runs through the wrapper that resolves the Neon aliases", () => {
  const deploy = scripts["build:vercel"];
  assert.match(deploy, /with-neon-env\.mjs\s+prisma migrate deploy/);
  // The named script the runbook calls must be the same command, so following the runbook cannot
  // run a different migration path from the one the host runs.
  assert.match(scripts["db:migrate:deploy"], /with-neon-env\.mjs\s+prisma migrate deploy/);
});

test("a failing migration really does stop a `&&` chain", () => {
  // The property asserted above, executed once rather than read: `false && echo build` exits 1 and
  // prints nothing. If a future edit traded `&&` for `;`, the second half would run anyway.
  const shortCircuited = spawnSync("bash", ["-c", "false && echo BUILD-RAN"], { encoding: "utf8" });
  assert.equal(shortCircuited.status, 1);
  assert.equal(shortCircuited.stdout.trim(), "");

  const sequenced = spawnSync("bash", ["-c", "false ; echo BUILD-RAN"], { encoding: "utf8" });
  assert.equal(sequenced.stdout.trim(), "BUILD-RAN");
});

test("the cron path in vercel.json is a route this app serves", () => {
  const config = JSON.parse(readFileSync(resolve(APP_DIR, "vercel.json"), "utf8")) as {
    crons?: { path: string; schedule: string }[];
  };
  assert.ok(config.crons?.length, "vercel.json must declare the schedule the runner depends on");
  for (const cron of config.crons) {
    const segments = cron.path.replace(/^\//, "").split("/");
    const literal = resolve(APP_DIR, "src/app", segments.join("/"), "route.ts");
    // `/api/cron/all` is served by the dynamic `[job]` route, so the last segment may be a slug.
    const dynamic = resolve(APP_DIR, "src/app", segments.slice(0, -1).join("/"), "[job]", "route.ts");
    const found = [literal, dynamic].find((path) => existsSync(path));
    assert.ok(found, `${cron.path} has no route file at ${literal} or ${dynamic}`);
    assert.ok(readFileSync(found, "utf8").length > 0, `${found} is empty`);
  }
});
