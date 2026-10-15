import { PrismaClient } from "@prisma/client";
import { resolveDatabaseUrl } from "./database-config";

const globalForPrisma = globalThis as typeof globalThis & {
  veyloraPrisma?: PrismaClient;
};

const currentModelDelegates = [
  "authNonce",
  "auditEvent",
  "chainGPTFeatureSettings",
  "integrationFeatureSettings",
  "departmentTeam",
  "evmPortfolioNetwork",
  "evmTokenAllowlistEntry",
  "marketCandleRecord",
  "marketAlert",
  "marketAlertEvent",
  "marketNewsRecord",
  "riskPolicySettings",
  "roleAssignment",
  "tradeOrder",
  "tradingVenueCredential",
  "teamMembership",
  "user",
  "userPermissionGrant",
  "walletIdentity",
  "wunderTradingFeatureSettings",
] as const;

const cachedPrisma = globalForPrisma.veyloraPrisma;
const hasCurrentSchema = cachedPrisma && currentModelDelegates.every(
  (delegate) => typeof (cachedPrisma as unknown as Record<string, unknown>)[delegate] !== "undefined",
);
const databaseUrl = resolveDatabaseUrl();

export const prisma = hasCurrentSchema
  ? cachedPrisma
  : new PrismaClient(databaseUrl ? { datasourceUrl: databaseUrl } : undefined);

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.veyloraPrisma = prisma;
}