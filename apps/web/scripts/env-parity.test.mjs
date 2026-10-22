import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_MANIFEST_PATH,
  KNOWN_DIFFERENCES,
  REQUIRED_NAMES,
  compareScopes,
  parseManifest,
} from "./env-parity.mjs";

const MANIFEST = `# Manifest

## Development (3 names, 3 entries)
ALCHEMY_BASE_MAINNET_RPC_URL
ALCHEMY_ARB_MAINNET_RPC_URL
DATABASE_URL

## Preview, Production (2 names, 2 entries)
ALCHEMY_BASE_MAINNET_RPC_URL
ALCHEMY_ARB_MAINNET_RPC_URL

## Production (1 names, 1 entries)
SOMETHING_PRODUCTION_ONLY

## Production, Preview (1 names, 1 entries)
SESSION_SECRET
`;

test("a merged heading declares its names in both scopes", () => {
  const { perScope, declared } = parseManifest(MANIFEST);
  assert.deepEqual([...perScope.Preview].sort(), ["ALCHEMY_ARB_MAINNET_RPC_URL", "ALCHEMY_BASE_MAINNET_RPC_URL", "SESSION_SECRET"]);
  assert.deepEqual([...perScope.Production].sort(), [
    "ALCHEMY_ARB_MAINNET_RPC_URL",
    "ALCHEMY_BASE_MAINNET_RPC_URL",
    "SESSION_SECRET",
    "SOMETHING_PRODUCTION_ONLY",
  ]);
  assert.deepEqual(declared, { names: 7, entries: 7 });
});

test("a Production-only name is a gap in both other scopes, and an undeclared one is reported", () => {
  const result = compareScopes(parseManifest(MANIFEST).perScope);
  const names = result.gaps.map((gap) => `${gap.name}|${gap.scope}`);
  assert.ok(names.includes("SOMETHING_PRODUCTION_ONLY|Development"));
  assert.ok(names.includes("SOMETHING_PRODUCTION_ONLY|Preview"));
  // DATABASE_URL exists in Development only, so it is not a gap: this check is one-directional.
  assert.ok(!names.includes("DATABASE_URL|Preview"));
  const undeclared = result.gaps.filter((gap) => !gap.declared);
  assert.deepEqual(undeclared.map((gap) => gap.name), ["SOMETHING_PRODUCTION_ONLY", "SOMETHING_PRODUCTION_ONLY"]);
  assert.deepEqual(result.developmentOnly, ["DATABASE_URL"]);
});

test("a gap with a declared reason is not counted as undeclared", () => {
  assert.ok(KNOWN_DIFFERENCES["CRON_SECRET|Preview"], "the real manifest declares CRON_SECRET as Production-only for Preview");
  const result = compareScopes(parseManifest(MANIFEST).perScope);
  assert.equal(result.gaps.filter((gap) => !gap.declared && gap.name === "SOMETHING_PRODUCTION_ONLY").length, 2);
  // SESSION_SECRET is in Preview and Production but not Development, and that gap is declared.
  const sessionGaps = result.gaps.filter((gap) => gap.name === "SESSION_SECRET");
  assert.deepEqual(sessionGaps.map((gap) => gap.scope), ["Development"]);
  assert.ok(sessionGaps.every((gap) => gap.declared));
});

test("a name the code requires but no scope records is unconfirmed, not a parity gap", () => {
  const result = compareScopes(parseManifest(MANIFEST).perScope);
  const unconfirmed = result.unconfirmed.map((entry) => `${entry.name}|${entry.scope}`);
  // SESSION_SECRET is recorded for Preview and Production, so its absence is not reported.
  assert.ok(!unconfirmed.includes("SESSION_SECRET|Production"));
  assert.ok(unconfirmed.includes("TRADING_CREDENTIAL_ENCRYPTION_KEY|Production"));
  assert.ok(unconfirmed.includes("APP_BASE_URL|Preview"));
  for (const entry of result.unconfirmed) {
    assert.ok(entry.purpose, `${entry.name} must say what breaks without it`);
  }
});

test("the committed manifest has no undeclared gap and no lost variable", () => {
  const { perScope, declared } = parseManifest(readFileSync(DEFAULT_MANIFEST_PATH, "utf8"));
  const result = compareScopes(perScope);
  const undeclared = result.gaps.filter((gap) => !gap.declared);
  assert.deepEqual(undeclared, [], "declare the difference in KNOWN_DIFFERENCES, or add the variable to the scope");
  assert.deepEqual(result.developmentOnly, []);
  assert.deepEqual(result.previewOnly, []);
  // A shrunken manifest would otherwise pass silently: 354 scope entries were read on 2026-10-15.
  assert.equal(declared.entries, 354);
  assert.equal(perScope.Production.size, 179);
});

test("every declared difference names a scope that genuinely lacks the variable", () => {
  const { perScope } = parseManifest(readFileSync(DEFAULT_MANIFEST_PATH, "utf8"));
  for (const key of Object.keys(KNOWN_DIFFERENCES)) {
    const [name, scope] = key.split("|");
    assert.ok(perScope[scope], `${key} is declared for an unknown scope ${scope}`);
    assert.ok(
      !perScope[scope].has(name),
      `${key} is declared as missing but ${scope} has it — delete the stale declaration`,
    );
  }
});

test("every required name says what breaks without it", () => {
  for (const [name, { scopes, purpose }] of Object.entries(REQUIRED_NAMES)) {
    assert.ok(scopes.length > 0, `${name} must name at least one scope`);
    assert.match(purpose, /\w/, `${name} must explain its absence`);
  }
});
