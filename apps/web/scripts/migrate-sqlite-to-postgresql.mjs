import { PrismaClient } from "@prisma/client";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyNeonEnvironmentAliases } from "./with-neon-env.mjs";

applyNeonEnvironmentAliases(process.env);

if (process.env.CONFIRM_SQLITE_TO_POSTGRES_IMPORT !== "YES") {
  throw new Error("Set CONFIRM_SQLITE_TO_POSTGRES_IMPORT=YES to run this one-time import.");
}

if (!process.env.DATABASE_URL?.startsWith("postgresql://")) {
  throw new Error("Set DATABASE_URL from the linked Neon integration before importing.");
}

const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../prisma/dev.db");
const source = new DatabaseSync(sourcePath, { readOnly: true });
const prisma = new PrismaClient();

const tables = [
  { table: "User", delegate: "user", dates: ["createdAt", "updatedAt"] },
  {
    table: "WalletIdentity",
    delegate: "walletIdentity",
    dates: ["verifiedAt", "createdAt", "revokedAt"],
  },
  {
    table: "TradingVenueCredential",
    delegate: "tradingVenueCredential",
    dates: ["tradingApprovedAt", "verifiedAt", "revokedAt", "createdAt", "updatedAt"],
  },
  {
    table: "TradeOrder",
    delegate: "tradeOrder",
    dates: ["submittedAt", "createdAt", "updatedAt"],
  },
  { table: "AuthNonce", delegate: "authNonce", dates: ["issuedAt", "expiresAt", "consumedAt"] },
  { table: "RoleAssignment", delegate: "roleAssignment", dates: ["createdAt", "revokedAt"] },
  { table: "AuditEvent", delegate: "auditEvent", dates: ["occurredAt"] },
  {
    table: "RiskPolicySettings",
    delegate: "riskPolicySettings",
    dates: ["updatedAt"],
    booleans: ["killSwitchActive"],
  },
  {
    table: "ChainGPTFeatureSettings",
    delegate: "chainGPTFeatureSettings",
    dates: ["updatedAt"],
    optional: true,
  },
  {
    table: "WunderTradingFeatureSettings",
    delegate: "wunderTradingFeatureSettings",
    dates: ["updatedAt"],
    optional: true,
  },
  {
    table: "IntegrationFeatureSettings",
    delegate: "integrationFeatureSettings",
    dates: ["updatedAt"],
    booleans: ["alternativeMeSentimentEnabled", "alchemyRpcEnabled", "tavilySearchEnabled", "tavilyExtractEnabled"],
    optional: true,
  },
  { table: "DepartmentTeam", delegate: "departmentTeam", dates: ["createdAt"] },
  { table: "TeamMembership", delegate: "teamMembership", dates: ["createdAt", "revokedAt"] },
  {
    table: "UserPermissionGrant",
    delegate: "userPermissionGrant",
    dates: ["createdAt", "revokedAt"],
  },
  {
    table: "MarketCandleRecord",
    delegate: "marketCandleRecord",
    dates: ["openTime", "closeTime", "providerObservedAt", "fetchedAt"],
  },
  {
    table: "MarketNewsRecord",
    delegate: "marketNewsRecord",
    dates: ["publishedAt", "fetchedAt"],
  },
];

function normalizeRow(row, dateFields, booleanFields = []) {
  const normalized = { ...row };

  for (const field of dateFields) {
    if (normalized[field] !== null && normalized[field] !== undefined) {
      const value = normalized[field];
      const isoValue =
        typeof value === "string"
          ? value.replace(" ", "T").replace(/^(.*)(?<!Z|[+-]\d{2}:\d{2})$/, "$1Z")
          : value;
      const date = new Date(isoValue);
      if (!Number.isFinite(date.getTime())) {
        throw new Error(`Invalid SQLite date in ${field}; import aborted.`);
      }
      normalized[field] = date;
    }
  }

  for (const field of booleanFields) {
    normalized[field] = Boolean(normalized[field]);
  }

  return normalized;
}

try {
  const sourceTables = new Set(
    source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name),
  );
  const records = tables.map(({ table, optional, ...metadata }) => {
    if (!sourceTables.has(table)) {
      if (optional) return { ...metadata, records: [] };
      throw new Error(`Required SQLite table ${table} is missing; import aborted.`);
    }
    return { ...metadata, records: source.prepare(`SELECT * FROM "${table}"`).all() };
  });

  await prisma.$transaction(async (tx) => {
    const existingCounts = await Promise.all(
      records.map(({ delegate }) => tx[delegate].count()),
    );
    if (existingCounts.some((count) => count > 0)) {
      throw new Error("PostgreSQL target is not empty; refusing to import.");
    }

    for (const { delegate, dates, booleans, records: rows } of records) {
      for (let offset = 0; offset < rows.length; offset += 500) {
        const data = rows
          .slice(offset, offset + 500)
          .map((row) => normalizeRow(row, dates, booleans));
        if (data.length > 0) {
          await tx[delegate].createMany({ data });
        }
      }
    }
  });

  console.log(
    JSON.stringify(
      Object.fromEntries(records.map(({ delegate, records: rows }) => [delegate, rows.length])),
      null,
      2,
    ),
  );
} finally {
  source.close();
  await prisma.$disconnect();
}