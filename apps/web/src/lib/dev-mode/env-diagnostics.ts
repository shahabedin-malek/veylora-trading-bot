import { resolveDatabaseUrl } from "@/lib/database-config";
import { isDevelopmentMode, type EnvironmentLike } from "@/lib/dev-mode/mode";

export type DevelopmentEnvironmentVariable = {
  /** Variable name only. Development diagnostics never read or show values. */
  name: string;
  purpose: string;
  /** True when development mode cannot do its job without this name set. */
  requiredInDevelopment: boolean;
  /**
   * True when a usable value is in effect — for a datasource name that includes
   * the development default, so a working fallback is not reported as missing.
   */
  present: boolean;
};

const PLACEHOLDER_PATTERN = /^(?:replace|change.?me|example|your.?)/i;

function hasUsableValue(value: string | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  return !PLACEHOLDER_PATTERN.test(trimmed);
}

const PER_NETWORK_RPC_NAME = /^ALCHEMY_[A-Z0-9_]+_RPC_URL$/;

/**
 * Whether a datasource is actually in effect. Development resolves its local
 * fallback, so this is true with no variable set at all — and false for a
 * placeholder, which is set but unusable.
 */
function datasourceIsInEffect(environment: EnvironmentLike): boolean {
  return hasUsableValue(resolveDatabaseUrl(environment));
}

/** Networks are discovered from the environment, so the list is whatever is set. */
function perNetworkRpcVariableNames(environment: EnvironmentLike): string[] {
  return Object.keys(environment)
    .filter((name) => PER_NETWORK_RPC_NAME.test(name))
    .sort();
}

/**
 * What the development app reads, reported by name with a present/missing flag.
 * This is the "which variable was missing" half of development diagnostics: a
 * value that could not be fetched says exactly which name would have supplied it.
 */
export function getDevelopmentEnvironmentDiagnostics(
  environment: EnvironmentLike = process.env,
): DevelopmentEnvironmentVariable[] {
  const items: Omit<DevelopmentEnvironmentVariable, "present">[] = [
    { name: "DATABASE_URL", purpose: "Local SQLite file the app reads; development defaults to file:./dev.db", requiredInDevelopment: true },
    { name: "veylora_DATABASE_URL", purpose: "Neon-style alias, used only when DATABASE_URL is empty", requiredInDevelopment: false },
    { name: "APP_BASE_URL", purpose: "Origin SIWE messages are bound to", requiredInDevelopment: false },
    { name: "AUTH_EVM_CHAIN_IDS", purpose: "EVM chain ids approved for wallet sign-in", requiredInDevelopment: false },
    { name: "INITIAL_ADMIN_EVM_ADDRESS", purpose: "Owner wallet the seed assigns the OWNER role to", requiredInDevelopment: false },
    { name: "SESSION_SECRET", purpose: "Session cookie signing secret (32+ bytes)", requiredInDevelopment: false },
    { name: "TRADING_CREDENTIAL_ENCRYPTION_KEY", purpose: "64 hex characters that encrypt venue keys", requiredInDevelopment: false },
    { name: "CRON_SECRET", purpose: "Shared secret for the market-alert cron route", requiredInDevelopment: false },
    { name: "NEXT_PUBLIC_REOWN_PROJECT_ID", purpose: "Reown project id for mobile wallet pairing (read first)", requiredInDevelopment: false },
    { name: "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID", purpose: "Pre-rebrand name for the same project id, read when the Reown one is unset", requiredInDevelopment: false },
    { name: "ALCHEMY_API_KEY", purpose: "Shared Alchemy key for RPC fallback hosts", requiredInDevelopment: false },
    { name: "ALCHEMY_ETHEREUM_MAINNET_API_KEY", purpose: "Legacy shared Alchemy key name", requiredInDevelopment: false },
    { name: "AI_GATEWAY_API_KEY", purpose: "Assistant model gateway key", requiredInDevelopment: false },
    { name: "AI_GATEWAY_MODEL", purpose: "Assistant model id", requiredInDevelopment: false },
    { name: "DATABASE_URL_UNPOOLED", purpose: "Direct Postgres URL (production only; development is SQLite)", requiredInDevelopment: false },
    { name: "VERCEL_OIDC_TOKEN", purpose: "Vercel runtime identity (production only)", requiredInDevelopment: false },
  ];

  // Networks are discovered from the environment, so they are reported as one
  // counted row. Listing 150+ identical-purpose names would bury the entries that
  // actually differ, and the count is the part that matters (a network missing
  // from one scope silently loses RPC there).
  const networks = perNetworkRpcVariableNames(environment).filter((name) => hasUsableValue(environment[name]));

  return [
    ...items.map((item) => ({
      ...item,
      present: item.name === "DATABASE_URL"
        ? datasourceIsInEffect(environment)
        : hasUsableValue(environment[item.name]),
    })),
    {
      name: "ALCHEMY_*_RPC_URL",
      purpose: `Per-network Alchemy RPC endpoints · ${networks.length} configured`,
      requiredInDevelopment: false,
      present: networks.length > 0,
    },
  ];
}

/** Names, not values: safe to log or render. */
export function getMissingRequiredDevelopmentVariables(
  environment: EnvironmentLike = process.env,
): string[] {
  return getDevelopmentEnvironmentDiagnostics(environment)
    .filter((item) => item.requiredInDevelopment && !item.present)
    .map((item) => item.name);
}

/** Development-only: the diagnostics list is not assembled in any other mode. */
export function getDevelopmentDiagnosticsForMode(environment: EnvironmentLike = process.env) {
  if (!isDevelopmentMode(environment)) return null;
  return {
    variables: getDevelopmentEnvironmentDiagnostics(environment),
    missingRequired: getMissingRequiredDevelopmentVariables(environment),
  };
}
