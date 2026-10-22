import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEED_SOURCE = readFileSync(resolve(APP_DIR, "prisma/seed.ts"), "utf8");
const SEED_CODE = SEED_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * The seed's idempotency is a property of how it writes, and this asserts that
 * property directly so it cannot regress silently. The end-to-end check is the
 * measured pair of `pnpm db:reset` runs recorded in README.md; this test runs
 * everywhere, including CI, where no local SQLite database exists.
 */
test("the seed only writes through upsert, so a second run cannot duplicate rows", () => {
  const upserts = SEED_CODE.match(/\.upsert\(/g) ?? [];
  assert.equal(upserts.length > 0, true, "the seed must write with upsert");

  assert.equal(/\.create\(/.test(SEED_CODE), false, "a bare .create() would duplicate on a second run");
  assert.equal(/\.createMany\(/.test(SEED_CODE), false);
  assert.equal(/\.update\(/.test(SEED_CODE), false);
  assert.equal(/\.updateMany\(/.test(SEED_CODE), false);
  assert.equal(/\.delete/.test(SEED_CODE), false);

  const creates = SEED_CODE.match(/\bcreate:\s*\{/g) ?? [];
  assert.equal(
    creates.length >= upserts.length,
    true,
    `every upsert needs a create payload (${upserts.length} upserts, ${creates.length} payloads)`,
  );
});

test("every seeded identity is a fixed literal, so two runs address the same rows", () => {
  assert.equal(/randomUUID/.test(SEED_CODE), false, "a random id makes the seed non-deterministic");
  assert.equal(/\bDate\.now\(\)/.test(SEED_CODE), false, "the wall clock makes a reseed differ");
  assert.equal(/new Date\(\s*\)/.test(SEED_CODE), false, "an empty Date() reads the wall clock");

  const ids = SEED_CODE.match(/"(?:dev|test)-[a-z0-9-]+"/g) ?? [];
  assert.equal(ids.length >= 20, true, `seeded rows should be addressed by dev-/test- literals (found ${ids.length})`);

  const idBlock = /const IDS = \{[\s\S]*?\} as const;/.exec(SEED_SOURCE);
  assert.ok(idBlock, "the seed declares its ids in one place");
  const declared = idBlock[0].match(/"[^"]+"/g) ?? [];
  assert.equal(declared.length > 0, true);
  for (const value of declared) {
    // "global" is the settings singleton id, shared with production by design.
    if (value === '"global"') continue;
    assert.match(value, /^"(?:dev|test)-/, `${value} is not marked as local development data`);
  }
});

test("the seed refuses to write anywhere but the local file and never records a credential", () => {
  assert.match(SEED_CODE, /startsWith\("file:"\)/, "the seed must refuse a non-file datasource");
  assert.equal(/ALCHEMY|apiKey|apiSecret|credentialCiphertext\s*:/.test(SEED_CODE), false);
  assert.equal(/process\.env\.[A-Z_]*SECRET/.test(SEED_CODE), false);
});

test("the derived development schema and its migrations stay out of git", () => {
  const gitignore = readFileSync(resolve(APP_DIR, ".gitignore"), "utf8");
  for (const entry of ["prisma/dev.db", "prisma/schema.dev.prisma"]) {
    assert.equal(gitignore.includes(entry), true, `${entry} must be ignored`);
  }
});
