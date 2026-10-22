import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { describeDatabaseTarget, getDevelopmentDatabaseDescription } from "@/lib/dev-mode/database-target";
import { developmentDetail } from "@/lib/dev-mode/development-detail";
import {
  getDevelopmentDiagnosticsForMode,
  getDevelopmentEnvironmentDiagnostics,
  getMissingRequiredDevelopmentVariables,
} from "@/lib/dev-mode/env-diagnostics";
import { isDevelopmentMode } from "@/lib/dev-mode/mode";

test("development mode is the exact NODE_ENV value, not merely not-production", () => {
  assert.equal(isDevelopmentMode({ NODE_ENV: "development" } as NodeJS.ProcessEnv), true);
  for (const value of ["production", "test", undefined, "", "Development", "dev"]) {
    assert.equal(isDevelopmentMode({ NODE_ENV: value } as NodeJS.ProcessEnv), false, String(value));
  }
});

test("the database description never carries credentials or a connection string", () => {
  const secret = "super-secret-password";
  const described = describeDatabaseTarget(
    `postgresql://veylora:${secret}@ep-cool-name.eu-central-1.aws.neon.tech/neondb?sslmode=require`,
  );
  assert.equal(described.kind, "remote");
  assert.equal(described.label.includes(secret), false);
  assert.equal(described.label.includes("veylora:"), false);
  assert.equal(described.label.includes("sslmode"), false);
  assert.equal(described.label, "ep-cool-name.eu-central-1.aws.neon.tech / neondb");

  const unparseable = describeDatabaseTarget("not a url at all");
  assert.equal(unparseable.label.includes("not a url"), false);

  const local = describeDatabaseTarget("file:./dev.db");
  assert.equal(local.kind, "local-sqlite-file");
  assert.equal(local.label.startsWith("./dev.db"), true);
  assert.equal(describeDatabaseTarget(undefined).kind, "unconfigured");
  assert.equal(describeDatabaseTarget("   ").kind, "unconfigured");
  assert.equal(describeDatabaseTarget("file:").kind, "local-sqlite-file");
});

test("the banner gets no description outside development", () => {
  const url = "file:./dev.db";
  assert.equal(getDevelopmentDatabaseDescription({ NODE_ENV: "production", DATABASE_URL: url }), null);
  assert.equal(getDevelopmentDatabaseDescription({ DATABASE_URL: url }), null);

  const described = getDevelopmentDatabaseDescription({ NODE_ENV: "development", DATABASE_URL: url });
  assert.equal(described?.kind, "local-sqlite-file");
  assert.equal(described?.source, "DATABASE_URL");
});

test("the banner names the database the app actually reads, fallback included", () => {
  // Regression: development resolves the local file when no variable is set, so
  // the banner must report that file rather than "unconfigured".
  const byDefault = getDevelopmentDatabaseDescription({ NODE_ENV: "development" });
  assert.equal(byDefault?.kind, "local-sqlite-file");
  assert.equal(byDefault?.source, "development-default");
  assert.equal(byDefault?.label.includes("dev.db"), true);

  const aliased = getDevelopmentDatabaseDescription({ NODE_ENV: "development", veylora_DATABASE_URL: "file:./other.db" });
  assert.equal(aliased?.source, "veylora_DATABASE_URL");
  assert.equal(aliased?.label.includes("other.db"), true);

  const remote = getDevelopmentDatabaseDescription({ NODE_ENV: "development", DATABASE_URL: "postgresql://u:pw@host/db" });
  assert.equal(remote?.kind, "remote");
  assert.equal(remote?.label.includes("pw"), false);
});

test("development diagnostics name variables without exposing values", () => {
  const value = "value-that-must-not-be-rendered";
  const items = getDevelopmentEnvironmentDiagnostics({
    NODE_ENV: "development",
    DATABASE_URL: "file:./dev.db",
    SESSION_SECRET: value,
    ALCHEMY_BASE_MAINNET_RPC_URL: `https://base-mainnet.g.alchemy.com/v2/${value}`,
  } as NodeJS.ProcessEnv);

  const serialized = JSON.stringify(items);
  assert.equal(serialized.includes(value), false);
  assert.equal(serialized.includes("g.alchemy.com"), false);
  assert.equal(items.find((item) => item.name === "DATABASE_URL")?.present, true);
  assert.equal(items.find((item) => item.name === "APP_BASE_URL")?.present, false);
  const networks = items.find((item) => item.name === "ALCHEMY_*_RPC_URL");
  assert.equal(networks?.present, true);
  assert.equal(networks?.purpose.includes("1 configured"), true, "per-network names collapse into one counted row");
  assert.equal(items.some((item) => item.name === "ALCHEMY_BASE_MAINNET_RPC_URL"), false);
  // Variable-name shaped, plus the one documented aggregate label. The Neon alias
  // is deliberately lowercase-prefixed (`veylora_DATABASE_URL`).
  assert.equal(items.every((item) => /^[A-Za-z][A-Za-z0-9_]*$/.test(item.name) || item.name === "ALCHEMY_*_RPC_URL"), true);
  assert.equal(items.every((item) => !item.name.includes("://") && !item.name.includes(" ")), true);
  assert.equal(items.some((item) => item.name === "veylora_DATABASE_URL" && item.purpose.includes("alias")), true);
});

test("a resolved datasource counts as present, and a placeholder does not", () => {
  // Development resolves its local fallback, so DATABASE_URL is satisfied with no
  // variable set, and the banner must not warn about a required variable it is
  // not actually missing.
  const byDefault = getDevelopmentEnvironmentDiagnostics({ NODE_ENV: "development" });
  assert.equal(byDefault.find((item) => item.name === "DATABASE_URL")?.present, true);
  assert.deepEqual(getMissingRequiredDevelopmentVariables({ NODE_ENV: "development" }), []);

  // A placeholder is set but unusable, so it is reported as missing.
  const placeholder = getDevelopmentEnvironmentDiagnostics({
    NODE_ENV: "development",
    DATABASE_URL: "replace-with-a-real-url",
  });
  assert.equal(placeholder.find((item) => item.name === "DATABASE_URL")?.present, false);
  assert.deepEqual(
    getMissingRequiredDevelopmentVariables({ NODE_ENV: "development", DATABASE_URL: "replace-with-a-real-url" }),
    ["DATABASE_URL"],
  );

  // No fallback exists outside development.
  assert.equal(
    getDevelopmentEnvironmentDiagnostics({ NODE_ENV: "production" }).find((item) => item.name === "DATABASE_URL")?.present,
    false,
  );
  assert.equal(getDevelopmentDiagnosticsForMode({ NODE_ENV: "production" }), null);
});

test("raw error text is appended in development and withheld everywhere else", () => {
  const error = new Error("SQLITE_ERROR: no such table: main.RiskPolicySettings");
  assert.equal(developmentDetail(error, "Database unavailable", { NODE_ENV: "development" } as NodeJS.ProcessEnv),
    "Database unavailable — SQLITE_ERROR: no such table: main.RiskPolicySettings");
  assert.equal(developmentDetail(error, "Database unavailable", { NODE_ENV: "production" } as NodeJS.ProcessEnv),
    "Database unavailable");
  assert.equal(developmentDetail(error, "Database unavailable", { NODE_ENV: "test" } as NodeJS.ProcessEnv),
    "Database unavailable");
  assert.equal(developmentDetail(undefined, "Database unavailable", { NODE_ENV: "development" } as NodeJS.ProcessEnv),
    "Database unavailable");
  assert.equal(developmentDetail("", "Database unavailable", { NODE_ENV: "development" } as NodeJS.ProcessEnv),
    "Database unavailable");
});

test("the development paper seed is coherent, idempotent and inert outside development", async () => {
  const { InMemoryPaperTradingStore } = await import("@/lib/paper-trading/store");
  const { DEV_PAPER_INITIAL_CAPITAL_CENTS, DEV_PAPER_SESSION_ID, seedDevPaperSession } = await import(
    "@/lib/paper-trading/dev-seed"
  );

  const store = new InMemoryPaperTradingStore();
  const seeded = await seedDevPaperSession(store, { NODE_ENV: "development" });
  assert.equal(seeded.seeded, true);
  assert.deepEqual(
    seeded.strategies.map((strategy) => strategy.state).sort(),
    ["DRAFT", "KILLED", "PAPER"],
    "every strategy lifecycle state must be represented",
  );

  // Opening CASH entry plus three transactions of five legs each.
  assert.equal(seeded.ledgerEntries, 16);
  assert.equal(seeded.snapshot?.cashBalanceCents, DEV_PAPER_INITIAL_CAPITAL_CENTS + 1_100);
  assert.equal(seeded.snapshot?.pnlCents, 1_100);
  assert.equal(seeded.snapshot?.feesCents, 2_000);

  // The page shows P&L as equity - opening capital. With a flat position that is
  // cash - opening capital, and it must equal the ledger's realized P&L, or the
  // seeded account would display a number its own entries contradict.
  assert.equal(
    seeded.snapshot!.cashBalanceCents - DEV_PAPER_INITIAL_CAPITAL_CENTS,
    seeded.snapshot!.pnlCents,
  );

  const botsAfterFirstRun = await store.listPaperBots(DEV_PAPER_SESSION_ID);
  assert.equal(botsAfterFirstRun.length, 3);

  const again = await seedDevPaperSession(store, { NODE_ENV: "development" });
  assert.equal(again.seeded, false, "a second run must not seed twice");
  const botsAfterSecondRun = await store.listPaperBots(DEV_PAPER_SESSION_ID);
  assert.equal(botsAfterSecondRun.length, 3, "a second run must not duplicate strategies");
  assert.deepEqual(
    botsAfterSecondRun.map((bot) => bot.paperBotId),
    botsAfterFirstRun.map((bot) => bot.paperBotId),
  );
  const funded = botsAfterSecondRun.find((bot) => bot.paperState === "PAPER");
  assert.equal((await store.listLedgerEntries(funded!.paperBotId)).length, 16);

  for (const environment of [{ NODE_ENV: "production" }, { NODE_ENV: "test" }, {}]) {
    const untouched = new InMemoryPaperTradingStore();
    const result = await seedDevPaperSession(untouched, environment);
    assert.equal(result.seeded, false);
    assert.equal((await untouched.listPaperBots(DEV_PAPER_SESSION_ID)).length, 0);
  }
});

test("the env-file guard reads real files and refuses a remote datasource", async () => {
  const { inspectEnvFiles } = await import("../scripts/dev-database.mjs");
  const directory = mkdtempSync(join(tmpdir(), "veylora-env-guard-"));

  assert.equal(inspectEnvFiles(directory).blocked, false);

  writeFileSync(join(directory, ".env"), 'DATABASE_URL="postgresql://user:pw@neon.example/db"\n', "utf8");
  const remote = inspectEnvFiles(directory);
  assert.equal(remote.blocked, true);
  assert.equal(String(remote.reason).includes("pw"), false);

  writeFileSync(join(directory, ".env"), 'DATABASE_URL="file:./dev.db"\n', "utf8");
  assert.equal(inspectEnvFiles(directory).blocked, false);
});
