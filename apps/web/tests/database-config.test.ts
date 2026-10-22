import assert from "node:assert/strict";
import test from "node:test";
import { DEVELOPMENT_DATABASE_URL, resolveDatabaseUrl } from "../src/lib/database-config";

test("standard Prisma datasource URL takes precedence over the Neon alias", () => {
  assert.equal(
    resolveDatabaseUrl({
      DATABASE_URL: "postgresql://explicit.example/db",
      veylora_DATABASE_URL: "postgresql://linked.example/db",
    }),
    "postgresql://explicit.example/db",
  );
});

test("Neon-prefixed datasource URL is used when the standard name is unset", () => {
  assert.equal(
    resolveDatabaseUrl({ veylora_DATABASE_URL: "postgresql://linked.example/db" }),
    "postgresql://linked.example/db",
  );
});

test("empty datasource variables do not override a configured Neon alias", () => {
  assert.equal(
    resolveDatabaseUrl({
      DATABASE_URL: " ",
      veylora_DATABASE_URL: "postgresql://linked.example/db",
    }),
    "postgresql://linked.example/db",
  );
});

test("development falls back to the local SQLite file so no env file is required", () => {
  assert.equal(resolveDatabaseUrl({ NODE_ENV: "development" }), DEVELOPMENT_DATABASE_URL);
  assert.equal(
    resolveDatabaseUrl({ NODE_ENV: "development", DATABASE_URL: "file:./custom.db" }),
    "file:./custom.db",
  );
});

test("only development has a fallback; production and tests stay unset", () => {
  assert.equal(resolveDatabaseUrl({ NODE_ENV: "production" }), undefined);
  assert.equal(resolveDatabaseUrl({ NODE_ENV: "test" }), undefined);
  assert.equal(resolveDatabaseUrl({}), undefined);
});