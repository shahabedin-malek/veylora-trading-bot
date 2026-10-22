import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DEV_DATABASE_URL,
  assertSqliteCompatible,
  deriveDevSchema,
  inspectDevDatabaseTarget,
  inspectEnvFiles,
  readEnvFileDatabaseUrl,
  redactDatabaseUrl,
  resolveDevDatabaseTarget,
} from "./dev-database.mjs";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("development resolves the local file when no database URL is set", () => {
  const target = resolveDevDatabaseTarget({});
  assert.equal(target.url, DEFAULT_DEV_DATABASE_URL);
  assert.equal(target.source, "default");
});

test("the standard Prisma variable wins over the Neon alias, matching the app resolver", () => {
  assert.deepEqual(
    resolveDevDatabaseTarget({ DATABASE_URL: "file:./dev.db", veylora_DATABASE_URL: "file:./other.db" }),
    { url: "file:./dev.db", source: "DATABASE_URL" },
  );
  assert.deepEqual(
    resolveDevDatabaseTarget({ DATABASE_URL: "  ", veylora_DATABASE_URL: "file:./other.db" }),
    { url: "file:./other.db", source: "veylora_DATABASE_URL" },
  );
});

test("a remote database URL is refused by both scripts", () => {
  for (const url of [
    "postgresql://veylora:secret@ep-cool-name.eu-central-1.aws.neon.tech/neondb",
    "postgres://user@db.example.com:5432/veylora",
    "mysql://user@db.example.com:3306/veylora",
    "https://db.example.com/veylora",
  ]) {
    const inspection = inspectDevDatabaseTarget(url);
    assert.equal(inspection.local, false, `${url} must not be accepted as a local development database`);
    assert.ok(inspection.reason.length > 0);
  }
});

test("a refusal never echoes connection credentials", () => {
  const inspection = inspectDevDatabaseTarget("postgresql://veylora:super-secret-password@example.com/neondb");
  assert.equal(inspection.local, false);
  assert.equal(inspection.reason.includes("super-secret-password"), false);
  assert.equal(inspection.reason.includes("veylora:"), false);
  assert.equal(redactDatabaseUrl("postgresql://user:pass@host:5432/db").includes("pass"), false);
});

test("the local SQLite file is accepted and must stay inside apps/web", () => {
  const accepted = inspectDevDatabaseTarget(DEFAULT_DEV_DATABASE_URL);
  assert.equal(accepted.local, true);
  assert.equal(accepted.displayPath, "prisma/dev.db");

  for (const url of [
    "file:./dev.db",
    "file:dev.db",
    "file:/tmp/elsewhere.db",
    "file:../../dev.db",
    "file:./dev.db?connection_limit=1",
    "file::memory:",
    "file:./dev.sqlite",
    "",
  ]) {
    const inspection = inspectDevDatabaseTarget(url);
    if (url === "file:./dev.db" || url === "file:dev.db") {
      assert.equal(inspection.local, true, url);
    } else {
      assert.equal(inspection.local, false, `${url} must be refused`);
    }
  }
});

test("an env file pointing development at a remote database blocks the scripts", () => {
  const remote = inspectEnvFiles(APP_DIR, () => 'DATABASE_URL="postgresql://user:pw@neon.example/db"\n');
  assert.equal(remote.blocked, true);
  assert.equal(remote.reason.includes("pw"), false);
  assert.equal(remote.reason.includes(".env"), true);

  const local = inspectEnvFiles(APP_DIR, () => 'DATABASE_URL="file:./dev.db"\n');
  assert.equal(local.blocked, false);

  const unrelated = inspectEnvFiles(APP_DIR, () => "ALCHEMY_API_KEY=whatever\n");
  assert.equal(unrelated.blocked, false);
});

test("env files are parsed for datasource names only", () => {
  assert.deepEqual(readEnvFileDatabaseUrl('export DATABASE_URL="file:./dev.db"\n'), {
    name: "DATABASE_URL",
    value: "file:./dev.db",
  });
  assert.deepEqual(readEnvFileDatabaseUrl("veylora_DATABASE_URL=postgresql://host/db\n"), {
    name: "veylora_DATABASE_URL",
    value: "postgresql://host/db",
  });
  assert.equal(readEnvFileDatabaseUrl("DATABASE_URL=\n"), null);
  assert.equal(readEnvFileDatabaseUrl("APP_BASE_URL=http://localhost:3000\n"), null);
  assert.equal(readEnvFileDatabaseUrl("# DATABASE_URL=commented\n"), null);
});

test("the derived development schema is the Postgres schema with a SQLite datasource", () => {
  const postgres = readFileSync(resolve(APP_DIR, "prisma/schema.prisma"), "utf8");
  const derived = deriveDevSchema(postgres);

  assert.equal(derived.includes('provider = "sqlite"'), true);
  assert.equal(derived.includes('provider  = "postgresql"'), false);
  assert.equal(derived.includes("directUrl"), false);
  assert.equal(derived.includes('provider = "prisma-client-js"'), true);
  assert.match(derived, /url\s+=\s+env\("DATABASE_URL"\)/);

  const stripper = (schema) =>
    schema
      .split("\n")
      .map((line) => line.replace(/"sqlite"|"postgresql"/g, '"provider"').replace(/\s+/g, " ").trim())
      .filter((line) => line && !line.startsWith("directUrl"))
      .join("\n");
  assert.equal(stripper(derived), stripper(postgres), "deriving must change only the datasource provider");
  assert.equal(derived.split("\n").length, postgres.split("\n").length - 1);
});

test("every model in the Postgres schema survives into the derived schema", () => {
  const postgres = readFileSync(resolve(APP_DIR, "prisma/schema.prisma"), "utf8");
  const derived = deriveDevSchema(postgres);
  const models = postgres.match(/^model \w+ \{/gm) ?? [];
  assert.equal(models.length > 0, true);
  for (const model of models) {
    assert.equal(derived.includes(model), true, `${model} is missing from the derived schema`);
  }
});

test("SQLite-incompatible model features fail loudly instead of generating a broken schema", () => {
  for (const snippet of [
    "model X {\n  id String @id @db.Uuid\n}",
    "enum Y {\n  A\n}",
    "model X {\n  payload Json\n}",
    "model X {\n  tags String[]\n}",
  ]) {
    assert.throws(() => assertSqliteCompatible(snippet), /cannot represent/);
  }
  assert.doesNotThrow(() => assertSqliteCompatible("model X {\n  id String @id\n  at DateTime\n}"));
});

test("deriving fails loudly when the Postgres schema loses its datasource contract", () => {
  assert.throws(() => deriveDevSchema("model X {\n  id String @id\n}"), /no datasource block/);
  assert.throws(
    () => deriveDevSchema("datasource db {\n  provider = \"mysql\"\n  url = env(\"DATABASE_URL\")\n}"),
    /Expected `provider = "postgresql"`/,
  );
  assert.throws(
    () => deriveDevSchema('datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n'),
    /not terminated/,
  );
});
