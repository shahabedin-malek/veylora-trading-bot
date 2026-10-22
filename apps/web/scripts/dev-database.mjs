#!/usr/bin/env node
/**
 * Local development database pipeline.
 *
 * Development runs Prisma against a disposable SQLite file at
 * `apps/web/prisma/dev.db`, while production stays on the Postgres schema in
 * `prisma/schema.prisma` (see plan/PROJECT_TODO.md §1). Prisma cannot take its
 * datasource `provider` from an environment variable, so the SQLite schema is
 * derived from the Postgres one instead of being a second hand-maintained copy:
 * a derived file cannot drift out of step with the models, and nothing has to be
 * kept in sync by hand.
 *
 * Every command in here refuses a database that is not the local file. The
 * scripts must never be able to point at a remote database, so the guard runs
 * before anything is generated, pushed or written.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PRISMA_DIR = join(APP_DIR, "prisma");
export const POSTGRES_SCHEMA_PATH = join(PRISMA_DIR, "schema.prisma");
export const DEV_SCHEMA_PATH = join(PRISMA_DIR, "schema.dev.prisma");
export const DEV_DATABASE_FILE_PATH = join(PRISMA_DIR, "dev.db");

export const DEFAULT_DEV_DATABASE_URL = "file:./dev.db";

/** Names the application resolves a datasource URL from, most specific first. */
const DATABASE_URL_NAMES = ["DATABASE_URL", "veylora_DATABASE_URL"];

const SQLITE_FILE_PREFIX = "file:";

/** Env files Prisma's CLI and Next.js load, in the order they take precedence. */
const ENV_FILE_NAMES = [".env.local", ".env"];

/**
 * The variable name a child Prisma/tsx process must receive. `DATABASE_URL` is
 * written onto `DATABASE_URL_UNPOOLED` too so a stale pooled/direct pair from a
 * production shell cannot leak into a local run through the derived schema's
 * `url`/`directUrl` resolution.
 */
const CHILD_DATABASE_ENV_NAMES = ["DATABASE_URL", "DATABASE_URL_UNPOOLED", "veylora_DATABASE_URL"];

export function resolveDevDatabaseTarget(environment = process.env) {
  for (const name of DATABASE_URL_NAMES) {
    const value = environment[name]?.trim();
    if (value) return { url: value, source: name };
  }
  return { url: DEFAULT_DEV_DATABASE_URL, source: "default" };
}

/**
 * Strip anything credential-bearing out of a connection string so a refusal
 * message can name the rejected target without echoing a password.
 */
export function redactDatabaseUrl(url) {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return "<empty>";
  if (trimmed.startsWith(SQLITE_FILE_PREFIX)) return trimmed;
  try {
    const parsed = new URL(trimmed);
    const credentials = parsed.username || parsed.password ? "<redacted-credentials>@" : "";
    return `${parsed.protocol}//${credentials}${parsed.host}${parsed.pathname}`;
  } catch {
    return "<unparseable connection string>";
  }
}

/**
 * Decide whether a value is the local SQLite file this project's development
 * mode is allowed to use. Relative SQLite paths resolve against the Prisma
 * schema directory, and the result must stay inside `apps/web` so a stray
 * absolute path can never become the development database.
 */
export function inspectDevDatabaseTarget(url) {
  const trimmed = (url ?? "").trim();
  if (!trimmed) {
    return { local: false, reason: "No database URL was resolved for development mode." };
  }
  if (!trimmed.startsWith(SQLITE_FILE_PREFIX)) {
    return {
      local: false,
      reason:
        `${redactDatabaseUrl(trimmed)} is not a local SQLite file connection. ` +
        `Development mode only ever uses the local file ${redactDatabaseUrl(DEFAULT_DEV_DATABASE_URL)}.`,
    };
  }

  const rawPath = trimmed.slice(SQLITE_FILE_PREFIX.length);
  if (!rawPath || rawPath === ":memory:" || rawPath.startsWith("//")) {
    return {
      local: false,
      reason: `"${redactDatabaseUrl(trimmed)}" does not name a local SQLite database file.`,
    };
  }
  if (rawPath.includes("?")) {
    return {
      local: false,
      reason: `"${redactDatabaseUrl(trimmed)}" carries connection parameters, which the local development file does not accept.`,
    };
  }
  if (!/\.db$/i.test(rawPath)) {
    return {
      local: false,
      reason: `"${redactDatabaseUrl(trimmed)}" must name a ".db" file for local development.`,
    };
  }

  const absolutePath = isAbsolute(rawPath) ? rawPath : resolve(PRISMA_DIR, rawPath);
  const insideApp = relative(APP_DIR, absolutePath);
  if (!insideApp || insideApp.startsWith("..") || isAbsolute(insideApp)) {
    return {
      local: false,
      reason: `"${redactDatabaseUrl(trimmed)}" resolves outside apps/web, so it is not this project's local database.`,
    };
  }

  return { local: true, absolutePath, displayPath: insideApp };
}

/**
 * Read the first `DATABASE_URL`-shaped value out of an env file. Returns the
 * variable name and value only; callers redact before printing.
 */
export function readEnvFileDatabaseUrl(contents) {
  for (const line of contents.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, name, rawValue] = match;
    if (!DATABASE_URL_NAMES.includes(name)) continue;
    const value = rawValue.trim().replace(/^["']|["']$/g, "").trim();
    if (value) return { name, value };
  }
  return null;
}

/**
 * A remote URL sitting in `.env` is the trap this phase exists to remove: the
 * scripts would seed the local file while `next dev` reads the remote database.
 * Refuse instead of quietly doing the wrong thing.
 */
export function inspectEnvFiles(directory = APP_DIR, readFile = readFileSync) {
  for (const name of ENV_FILE_NAMES) {
    const path = join(directory, name);
    if (!existsSync(path)) continue;
    let contents;
    try {
      contents = String(readFile(path, "utf8"));
    } catch {
      continue;
    }
    const found = readEnvFileDatabaseUrl(contents);
    if (!found) continue;
    const inspection = inspectDevDatabaseTarget(found.value);
    if (!inspection.local) {
      return {
        blocked: true,
        reason:
          `${name} sets ${found.name} to ${redactDatabaseUrl(found.value)}, which is not the local development ` +
          `file. Remove it, or set ${found.name}="${DEFAULT_DEV_DATABASE_URL}" so the running app reads the same ` +
          `database these scripts seed.`,
      };
    }
  }
  return { blocked: false };
}

/** Prisma rejects these on SQLite; fail loudly instead of generating a broken schema. */
const SQLITE_INCOMPATIBLE_PATTERNS = [
  { pattern: /@db\./, feature: "native database type attribute (@db.*)" },
  { pattern: /^\s*enum\s+\w+\s*\{/m, feature: "enum" },
  { pattern: /\bJson\b/, feature: "Json" },
  { pattern: /\bBytes\b/, feature: "Bytes" },
  { pattern: /\bDecimal\b/, feature: "Decimal" },
  { pattern: /\bBigInt\b/, feature: "BigInt" },
  { pattern: /\bString\[\]/, feature: "scalar list" },
  { pattern: /\bUnsupported\(/, feature: "Unsupported()" },
];

/**
 * Derive the SQLite schema from the Postgres schema by narrowing the change to
 * the datasource block: swap the provider, drop `directUrl`, touch nothing else.
 */
export function deriveDevSchema(postgresSchema) {
  const lines = postgresSchema.split("\n");
  const start = lines.findIndex((line) => /^datasource\s+\w+\s*\{/.test(line));
  if (start === -1) {
    throw new Error("prisma/schema.prisma has no datasource block to derive the development schema from.");
  }
  let end = -1;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "}") {
      end = index;
      break;
    }
  }
  if (end === -1) {
    throw new Error("The datasource block in prisma/schema.prisma is not terminated.");
  }

  const block = lines.slice(start + 1, end).filter((line) => !/^\s*directUrl\s*=/.test(line));
  const providerIndex = block.findIndex((line) => /^\s*provider\s*=\s*"postgresql"\s*$/.test(line));
  if (providerIndex === -1) {
    throw new Error('Expected `provider = "postgresql"` in prisma/schema.prisma; the development schema cannot be derived.');
  }
  block[providerIndex] = '  provider = "sqlite"';

  const derived = [...lines.slice(0, start + 1), ...block, ...lines.slice(end)].join("\n");
  assertSqliteCompatible(derived);
  return derived;
}

export function assertSqliteCompatible(schemaText) {
  const offenders = [];
  for (const [index, line] of schemaText.split("\n").entries()) {
    for (const { pattern, feature } of SQLITE_INCOMPATIBLE_PATTERNS) {
      if (pattern.test(line)) offenders.push(`line ${index + 1}: ${feature} — ${line.trim()}`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `prisma/schema.prisma uses features the local SQLite database cannot represent:\n  ${offenders.join("\n  ")}\n` +
        "Either avoid them in the shared models or give development its own schema deliberately.",
    );
  }
}

function binary(name) {
  return join(APP_DIR, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
}

function childEnvironment(databaseUrl) {
  const environment = { ...process.env };
  for (const name of CHILD_DATABASE_ENV_NAMES) environment[name] = databaseUrl;
  return environment;
}

function runStep(label, command, args, databaseUrl) {
  const result = spawnSync(command, args, {
    cwd: APP_DIR,
    env: childEnvironment(databaseUrl),
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`${label} could not start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${label} exited ${result.status}.`);
    process.exit(result.status ?? 1);
  }
}

function guard(databaseUrl) {
  const inspection = inspectDevDatabaseTarget(databaseUrl);
  if (!inspection.local) {
    console.error(`Refusing to run against a non-local database.\n  ${inspection.reason}`);
    process.exit(2);
  }
  const envFiles = inspectEnvFiles();
  if (envFiles.blocked) {
    console.error(`Refusing to run while an env file points development at another database.\n  ${envFiles.reason}`);
    process.exit(2);
  }
  return inspection;
}

function writeDevSchema() {
  const derived = deriveDevSchema(readFileSync(POSTGRES_SCHEMA_PATH, "utf8"));
  writeFileSync(DEV_SCHEMA_PATH, derived, "utf8");
}

function generateDevClient(databaseUrl) {
  runStep("prisma generate (dev)", binary("prisma"), ["generate", "--schema", DEV_SCHEMA_PATH], databaseUrl);
}

function pushDevSchema(databaseUrl, { forceReset }) {
  const args = ["db", "push", "--schema", DEV_SCHEMA_PATH, "--skip-generate"];
  if (forceReset) args.push("--force-reset");
  runStep("prisma db push (dev)", binary("prisma"), args, databaseUrl);
}

function runSeed(databaseUrl) {
  runStep("prisma seed", binary("tsx"), [join(PRISMA_DIR, "seed.ts")], databaseUrl);
  if (!existsSync(DEV_DATABASE_FILE_PATH)) {
    console.error(
      `The seed finished but ${relative(APP_DIR, DEV_DATABASE_FILE_PATH)} does not exist. ` +
        `The resolved DATABASE_URL did not point at this project's local file.`,
    );
    process.exit(1);
  }
}

function removeDevDatabaseFiles() {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const path = `${DEV_DATABASE_FILE_PATH}${suffix}`;
    if (existsSync(path)) rmSync(path, { force: true });
  }
}

function ensureDevDatabaseFile(exists = existsSync) {
  if (!exists(DEV_DATABASE_FILE_PATH)) {
    console.error(
      `No local database at ${relative(APP_DIR, DEV_DATABASE_FILE_PATH)}. ` +
        "Run `pnpm db:setup` first; db:seed only seeds the database that already exists.",
    );
    process.exit(2);
  }
}

function report(action, source) {
  console.log(
    `\n${action} complete. Development database: ${relative(APP_DIR, DEV_DATABASE_FILE_PATH)} ` +
      `(resolved from ${source}).`,
  );
}

export function run(command, { environment = process.env } = {}) {
  const target = resolveDevDatabaseTarget(environment);
  guard(target.url);

  if (command === "setup" || command === "reset") {
    if (command === "reset") removeDevDatabaseFiles();
    writeDevSchema();
    generateDevClient(target.url);
    pushDevSchema(target.url, { forceReset: command === "reset" });
    runSeed(target.url);
    report(command === "reset" ? "Database reset" : "Database setup", target.source);
    return;
  }

  if (command === "seed") {
    ensureDevDatabaseFile();
    writeDevSchema();
    generateDevClient(target.url);
    runSeed(target.url);
    report("Seed", target.source);
    return;
  }

  console.error(`Unknown command "${command}". Expected setup, reset or seed.`);
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv[2], { environment: process.env });
}
