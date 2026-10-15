import {
  getAllowedEvmMainnetChainIds,
  getInitialAdminEvmAddress,
  getSessionSigningSecret,
} from "@/lib/auth/config";
import { resolveDatabaseUrl } from "@/lib/database-config";
import { listRpcNetworkSlugs } from "@/lib/rpc/networks";

export type IntegrationReadinessItem = {
  id: string;
  label: string;
  owner: string;
  configured: boolean;
};

function hasValue(value: string | undefined): boolean {
  const normalized = value?.trim();
  return Boolean(normalized && !/^(?:replace|change.?me|example|your.?)/i.test(normalized));
}

export function getIntegrationReadiness(env: NodeJS.ProcessEnv = process.env): IntegrationReadinessItem[] {
  const databaseUrl = resolveDatabaseUrl(env);
  const directDatabaseUrl = env.DATABASE_URL_UNPOOLED?.trim() || env.veylora_DATABASE_URL_UNPOOLED?.trim();
  const walletConnectId = env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() || env.NEXT_PUBLIC_REOWN_PROJECT_ID?.trim();
  const encryptionKey = env.TRADING_CREDENTIAL_ENCRYPTION_KEY?.trim() ?? "";

  return [
    { id: "database-pooled", label: "PostgreSQL pooled URL", owner: "Deployment environment", configured: Boolean(databaseUrl) },
    { id: "database-direct", label: "PostgreSQL direct URL", owner: "Deployment environment", configured: Boolean(directDatabaseUrl) },
    { id: "app-origin", label: "Application origin", owner: "Deployment environment", configured: hasValue(env.APP_BASE_URL) },
    { id: "auth-chain", label: "EVM auth chain", owner: "Deployment environment", configured: getAllowedEvmMainnetChainIds(env.AUTH_EVM_CHAIN_IDS).size > 0 },
    { id: "initial-admin", label: "Initial owner wallet", owner: "Owner bootstrap environment", configured: getInitialAdminEvmAddress(env) !== null },
    { id: "session-secret", label: "Session signing secret", owner: "Deployment secret store", configured: getSessionSigningSecret(env) !== null },
    { id: "credential-encryption", label: "Credential encryption key", owner: "Deployment secret store", configured: /^[a-f0-9]{64}$/i.test(encryptionKey) },
    { id: "walletconnect", label: "WalletConnect project ID", owner: "Public deployment configuration", configured: hasValue(walletConnectId) },
    { id: "alchemy", label: "Alchemy multi-network RPC key", owner: "Deployment secret store", configured: hasValue(env.ALCHEMY_API_KEY) || listRpcNetworkSlugs(env).length > 0 },
    { id: "tavily-keyless", label: "Tavily Search and Extract", owner: "No API key required; admin switches control availability", configured: true },
  ];
}