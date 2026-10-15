export const AUTH_COOKIE_NAME = "veylora_session";
export const AUTH_NONCE_TTL_MS = 5 * 60 * 1000;
export const AUTH_SESSION_TTL_SECONDS = 8 * 60 * 60;

const EVM_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;

export function getInitialAdminEvmAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  const address = env.INITIAL_ADMIN_EVM_ADDRESS?.trim();
  return address && EVM_ADDRESS_PATTERN.test(address) ? address.toLowerCase() : null;
}

export function shouldBootstrapInitialAdmin(input: {
  addressCanonical: string;
  chainId: number;
  activeOwnerExists: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return !input.activeOwnerExists &&
    getInitialAdminEvmAddress(input.env) === input.addressCanonical.toLowerCase();
}

export type AuthConfig = {
  origin: string;
  domain: string;
  scheme: "http" | "https";
  loginUri: string;
  allowedChainIds: Set<number>;
  sessionSecret: string;
  secureCookies: boolean;
};

export function getSessionSigningSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = env.SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) return null;
  if (/replace|change.?me|example|your.?secret/i.test(secret)) return null;
  return secret;
}

export function isSameOriginRequest(request: Request, config: AuthConfig): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  try {
    return new URL(origin).origin === config.origin;
  } catch {
    return false;
  }
}

/**
 * Every EVM chain id configured in `AUTH_EVM_CHAIN_IDS` (comma-separated).
 * No hard-coded allow-list: any positive safe-integer chain id is accepted.
 * Returns an empty set when nothing is configured.
 */
export function getAllowedEvmMainnetChainIds(raw = process.env.AUTH_EVM_CHAIN_IDS): Set<number> {
  if (!raw?.trim()) return new Set();

  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  const chainIds = values.map(Number);
  if (chainIds.length === 0 || chainIds.some((chainId) => !Number.isSafeInteger(chainId) || chainId <= 0)) {
    return new Set();
  }

  return new Set(chainIds);
}

export function getAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig | null {
  const allowedChainIds = getAllowedEvmMainnetChainIds(env.AUTH_EVM_CHAIN_IDS);
  const secret = getSessionSigningSecret(env);
  const baseUrl = env.APP_BASE_URL;

  if (allowedChainIds.size === 0 || !secret) return null;
  if (!baseUrl) return null;

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }

  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;

  const secureCookies = env.NODE_ENV === "production";
  if (secureCookies && parsed.protocol !== "https:") return null;
  if (!secureCookies && parsed.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(parsed.hostname)) return null;

  return {
    origin: parsed.origin,
    domain: parsed.host,
    scheme: parsed.protocol.slice(0, -1) as "http" | "https",
    loginUri: new URL("/login", parsed).toString(),
    allowedChainIds,
    sessionSecret: secret,
    secureCookies,
  };
}

export function getAuthUnavailableReason(env: NodeJS.ProcessEnv = process.env): string | null {
  if (getAllowedEvmMainnetChainIds(env.AUTH_EVM_CHAIN_IDS).size === 0) {
    return "No EVM authentication chain is configured.";
  }
  if (!env.APP_BASE_URL) return "APP_BASE_URL is not configured.";
  if (!getSessionSigningSecret(env)) {
    return "A unique session signing secret of at least 32 bytes is not configured.";
  }
  return getAuthConfig(env) ? null : "Authentication configuration is invalid.";
}