import assert from "node:assert/strict";
import test from "node:test";
import { applyNeonEnvironmentAliases } from "./with-neon-env.mjs";

test("Neon aliases fill missing Prisma datasource variables", () => {
  const environment = {
    veylora_DATABASE_URL: "postgresql://pooled.example/db",
    veylora_DATABASE_URL_UNPOOLED: "postgresql://direct.example/db",
  };

  applyNeonEnvironmentAliases(environment);

  assert.equal(environment.DATABASE_URL, environment.veylora_DATABASE_URL);
  assert.equal(environment.DATABASE_URL_UNPOOLED, environment.veylora_DATABASE_URL_UNPOOLED);
});

test("explicit Prisma datasource variables take precedence", () => {
  const environment = {
    DATABASE_URL: "postgresql://explicit.example/db",
    DATABASE_URL_UNPOOLED: "postgresql://explicit-direct.example/db",
    veylora_DATABASE_URL: "postgresql://linked.example/db",
    veylora_DATABASE_URL_UNPOOLED: "postgresql://linked-direct.example/db",
  };

  applyNeonEnvironmentAliases(environment);

  assert.equal(environment.DATABASE_URL, "postgresql://explicit.example/db");
  assert.equal(environment.DATABASE_URL_UNPOOLED, "postgresql://explicit-direct.example/db");
});

test("missing Neon variables remain unset", () => {
  const environment = {};

  applyNeonEnvironmentAliases(environment);

  assert.deepEqual(environment, {});
});