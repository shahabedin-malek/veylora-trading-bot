import { Prisma, PrismaClient } from "@prisma/client";
import { resolveDatabaseUrl } from "./database-config";
import { isDevelopmentMode } from "./dev-mode/mode";

const globalForPrisma = globalThis as typeof globalThis & {
  veyloraPrisma?: PrismaClient;
};

const currentModelDelegates = [
  "adminSavedView",
  "agentAccount",
  "agentApproval",
  "apiKey",
  "apiRateWindow",
  "authNonce",
  "auditEvent",
  "auditRetentionPolicy",
  "backtestRun",
  "strategyDefinition",
  "chainGPTFeatureSettings",
  "idempotencyRecord",
  "integrationFeatureSettings",
  "ledgerAccount",
  "ledgerEntry",
  "ledgerTransaction",
  "departmentTeam",
  "evmPortfolioNetwork",
  "evmTokenAllowlistEntry",
  "marketCandleRecord",
  "marketAlert",
  "marketAlertEvent",
  "notificationChannelSettings",
  "notificationDelivery",
  "marketNewsRecord",
  "providerCallRecord",
  "screener",
  "screenerResult",
  "tokenMetadata",
  "riskPolicySettings",
  "runnerInvocation",
  "runnerJob",
  "roleAssignment",
  "signalToken",
  "signalEvent",
  "webhookSubscription",
  "webhookDelivery",
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
/**
 * Query logging is a development affordance: in development every statement the
 * app issues is visible (which is how a wrong query gets found without a
 * debugger), and anywhere else only errors are reported. Development mode is the
 * explicit switch, not "not production", so a test run or a build stays quiet.
 *
 * `VEYLORA_PRISMA_QUIET=1` turns the query log off inside a development run. The MCP
 * server needs it: Prisma writes its log to stdout, and on a stdio JSON-RPC transport a
 * stray line is a protocol error rather than a noisy log. It is read from the
 * environment at import time, which is why the `mcp` script sets it in the shell.
 */
const databaseUrl = resolveDatabaseUrl();
const QUIET_PRISMA = process.env.VEYLORA_PRISMA_QUIET === "1";
const DEVELOPMENT_LOG_LEVELS: Prisma.LogLevel[] = QUIET_PRISMA ? ["error"] : ["query", "warn", "error"];
const PRODUCTION_LOG_LEVELS: Prisma.LogLevel[] = ["error"];

function clientOptions(databaseUrlValue: string | undefined) {
  return {
    ...(databaseUrlValue ? { datasourceUrl: databaseUrlValue } : {}),
    log: isDevelopmentMode() ? DEVELOPMENT_LOG_LEVELS : PRODUCTION_LOG_LEVELS,
  };
}

export const prisma = hasCurrentSchema
  ? cachedPrisma
  : new PrismaClient(clientOptions(databaseUrl));

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.veyloraPrisma = prisma;
}

/**
 * How the local SQLite file is opened (phase 38).
 *
 * The development database is one file with one writer, and the default rollback
 * journal makes every write take the whole file: a runner pass writing decisions
 * while a page reads balances waits for it, and the page's latency includes the
 * wait. Write-ahead logging lets the reader keep reading, and the busy timeout
 * turns a brief overlap into a short wait instead of an immediate `SQLITE_BUSY`.
 * `synchronous = NORMAL` is the setting WAL is designed for — a committed write can
 * still be lost on a power cut, never corrupted, which is the right trade for a
 * disposable development file.
 *
 * These are per-connection settings, so they are applied once when the client is
 * created. `journal_mode` is sticky in the file; the other two are not, which is
 * why all three are set here rather than in the setup script alone. A Postgres URL
 * tries none of them: the pool is the driver's and a `PRAGMA` is not SQL there.
 */
function configureSqliteConnections(client: PrismaClient): void {
  if (!databaseUrl?.startsWith("file:")) return;
  for (const pragma of ["PRAGMA journal_mode = WAL", "PRAGMA busy_timeout = 5000", "PRAGMA synchronous = NORMAL"]) {
    // Deliberately not awaited: a connection setting must not make importing the
    // client asynchronous, and a failure here leaves the previous (working)
    // settings in place rather than stopping the app from starting. `$queryRaw`
    // rather than `$executeRaw`: SQLite answers a setting with the value it took,
    // and an execute that returns a row is an error.
    void client.$queryRawUnsafe(pragma).catch(() => null);
  }
}

if (!hasCurrentSchema) configureSqliteConnections(prisma);