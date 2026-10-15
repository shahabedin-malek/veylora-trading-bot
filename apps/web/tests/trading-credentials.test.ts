import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeSpotBalances } from "@/lib/trading/exchange-balances";
import {
  decryptVenueCredentials,
  encryptVenueCredentials,
  type EncryptedVenueCredentials,
} from "@/lib/trading/credential-vault";

test("venue credentials are encrypted, venue-bound, and authenticated", () => {
  const originalKey = process.env.TRADING_CREDENTIAL_ENCRYPTION_KEY;
  process.env.TRADING_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 0x42).toString("hex");

  try {
    const material = {
      apiKey: "test-api-key-not-a-real-credential",
      apiSecret: "test-api-secret-not-a-real-credential",
      passphrase: "test-passphrase",
    };
    const encrypted = encryptVenueCredentials("coinbase-advanced", material);

    assert.equal(encrypted.ciphertext.includes(material.apiKey), false);
    assert.notEqual(encrypted.fingerprint, encryptVenueCredentials("kraken", material).fingerprint);
    assert.deepEqual(decryptVenueCredentials("coinbase-advanced", encrypted), material);
    assert.throws(() => decryptVenueCredentials("kraken", encrypted));

    const tamperedBytes = Buffer.from(encrypted.ciphertext, "base64url");
    tamperedBytes[0] ^= 0x01;
    const tampered: EncryptedVenueCredentials = {
      ...encrypted,
      ciphertext: tamperedBytes.toString("base64url"),
    };
    assert.throws(() => decryptVenueCredentials("coinbase-advanced", tampered));
  } finally {
    if (originalKey === undefined) delete process.env.TRADING_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.TRADING_CREDENTIAL_ENCRYPTION_KEY = originalKey;
  }
});

test("venue credential encryption fails closed without a valid server key", () => {
  const originalKey = process.env.TRADING_CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.TRADING_CREDENTIAL_ENCRYPTION_KEY;
  try {
    assert.throws(
      () => encryptVenueCredentials("binance", { apiKey: "test", apiSecret: "test" }),
      /TRADING_CREDENTIAL_ENCRYPTION_KEY/,
    );
  } finally {
    if (originalKey !== undefined) process.env.TRADING_CREDENTIAL_ENCRYPTION_KEY = originalKey;
  }
});

const RETIRED_CREDENTIAL_FIELDS = ["permissionStatus", "tradingApprovedAt"];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(fullPath);
    if (!/\.(?:ts|tsx)$/.test(entry.name) || /\.(?:test|spec)\./.test(entry.name)) return [];
    return [fullPath];
  });
}

test("venue credential approval state is retired from the schema, migrations, and sources", () => {
  const schema = readFileSync(fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)), "utf8");
  const model = schema.match(/model TradingVenueCredential \{[\s\S]*?\n\}/)?.[0];
  assert.ok(model, "expected a TradingVenueCredential model in prisma/schema.prisma");

  const migrationsDirectory = fileURLToPath(new URL("../prisma/migrations", import.meta.url));
  const retirement = readdirSync(migrationsDirectory)
    .filter((entry) => entry.endsWith("_retire_credential_approval_state"))
    .map((entry) => readFileSync(`${migrationsDirectory}/${entry}/migration.sql`, "utf8"))
    .join("\n");
  assert.match(retirement, /DROP COLUMN "permissionStatus"/);
  assert.match(retirement, /DROP COLUMN "tradingApprovedAt"/);

  for (const field of RETIRED_CREDENTIAL_FIELDS) {
    assert.equal(model.includes(field), false, `${field} must stay retired from TradingVenueCredential`);
    const references = sourceFiles(fileURLToPath(new URL("../src", import.meta.url)))
      .filter((file) => readFileSync(file, "utf8").includes(field))
      .map((file) => file.slice(file.indexOf("/src/") + 1));
    assert.deepEqual(references, [], `${field} must not be read or written anywhere in src`);
  }
});

test("read-only balance normalization returns available amounts without inventing assets", () => {
  assert.deepEqual(
    normalizeSpotBalances({
      free: { BTC: 0.25, ETH: 0, USD: 120 },
      total: { BTC: 0.5, ETH: 0, USD: 120, XRP: null },
    }),
    [
      { asset: "BTC", available: "0.25", total: "0.5" },
      { asset: "USD", available: "120", total: "120" },
    ],
  );
  assert.throws(() => normalizeSpotBalances({ free: { BTC: "NaN" } }));
});