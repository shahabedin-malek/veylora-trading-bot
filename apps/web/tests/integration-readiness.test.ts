import assert from "node:assert/strict";
import { test } from "node:test";
import { getIntegrationReadiness } from "@/lib/integrations/readiness";

test("integration readiness reports missing config without exposing values", () => {
  const items = getIntegrationReadiness({} as NodeJS.ProcessEnv);
  assert.equal(items.every((item) => item.configured === false || item.id === "tavily-keyless"), true);
  const sharedKeyOnly = getIntegrationReadiness({ NODE_ENV: "test", ALCHEMY_API_KEY: "shared-test-placeholder" } as NodeJS.ProcessEnv);
  assert.equal(sharedKeyOnly.find((item) => item.id === "alchemy")?.configured, true);
  assert.equal(JSON.stringify(items).includes("DATABASE_URL"), false);
  assert.equal(JSON.stringify(items).includes("SECRET"), false);
});

test("integration readiness recognizes only configured names and valid auth material", () => {
  const items = getIntegrationReadiness({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://unit-test-only",
    DATABASE_URL_UNPOOLED: "postgresql://unit-test-direct-only",
    APP_BASE_URL: "https://veylora.example",
    AUTH_EVM_CHAIN_IDS: "1",
    INITIAL_ADMIN_EVM_ADDRESS: "0x1234567890123456789012345678901234567890",
    SESSION_SECRET: "s".repeat(40),
    TRADING_CREDENTIAL_ENCRYPTION_KEY: "ab".repeat(32),
    NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: "public-project-id-only",
    ALCHEMY_API_KEY: "unit-test-api-key-only",
    SANDBASE_API_KEY: "unit-test-sandbase-key-only",
  } as NodeJS.ProcessEnv);
  assert.equal(items.filter((item) => item.id !== "tavily-keyless").every((item) => item.configured), true);
  assert.equal(JSON.stringify(items).includes("unit-test-only"), false);
  assert.equal(JSON.stringify(items).includes("public-project-id-only"), false);
  assert.equal(JSON.stringify(items).includes("unit-test-sandbase-key-only"), false);
});