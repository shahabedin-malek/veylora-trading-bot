import { isDevelopmentMode } from "@/lib/dev-mode/mode";

export const AUTH_COOKIE_NAME = "veylora_session";
export const AUTH_NONCE_TTL_MS = 5 * 60 * 1000;
export const AUTH_SESSION_TTL_SECONDS = 8 * 60 * 60;

const EVM_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;

/**
 * The owner wallet local development falls back to.
 *
 * Development needs *an* owner, or the first person to sign in has to discover
 * why the admin pages are empty. So the address is written down once, here, and
 * both halves of the rule read it: the sign-in bootstrap (`shouldBootstrapInitialAdmin`)
 * and the seed, which writes this address as the owner wallet when
 * `INITIAL_ADMIN_EVM_ADDRESS` is unset. Two constants would drift, and the
 * failure mode is confusing — a seeded owner nobody signs in as, or a sign-in as
 * the documented local address that is granted nothing.
 */
export const DEVELOPMENT_OWNER_EVM_ADDRESS = "0x1111111111111111111111111111111111111111";

/**
 * The wallet that is granted OWNER: the configured address, or the development
 * fallback in development mode, or null.
 *
 * Development is an explicit switch (`isDevelopmentMode`), not "not production",
 * and the fallback applies nowhere else: a test run or a deployment with nothing
 * configured grants nobody OWNER, exactly as before.
 */
export function getInitialAdminEvmAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  const address = env.INITIAL_ADMIN_EVM_ADDRESS?.trim();
  if (address && EVM_ADDRESS_PATTERN.test(address)) return address.toLowerCase();
  return isDevelopmentMode(env) ? DEVELOPMENT_OWNER_EVM_ADDRESS : null;
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

/**
 * Whether a page may start a mobile pairing, and the sentence to show when it
 * may not.
 *
 * A pairing advertises an origin: the wallet displays it as "this site wants to
 * connect", and the deep link that brings the user back from the wallet app
 * returns to it. Both must be the deployment's configured `APP_BASE_URL` — never
 * whatever Host a request arrived with, which a proxy or a rewrite can choose.
 * So the pairing is bound to the configured origin, and a page served anywhere
 * else refuses to start one instead of asking a phone to trust a site that is
 * not this deployment.
 */
export function pairingHostProblem(input: { configuredOrigin: string; requestHost: string | null | undefined }): string | null {
  const configured = input.configuredOrigin.trim();
  if (!configured) {
    return "APP_BASE_URL is not configured, so there is no origin a wallet could be sent back to.";
  }

  let configuredOrigin: string;
  try {
    configuredOrigin = new URL(configured).origin;
  } catch {
    return `"${configured}" is not a usable APP_BASE_URL, so a wallet cannot be sent a pairing for this deployment.`;
  }

  const requestHost = input.requestHost?.trim().toLowerCase();
  if (!requestHost) {
    return "This request carried no Host header, so it cannot be matched against APP_BASE_URL. Pairing is refused.";
  }

  if (new URL(configuredOrigin).host === requestHost) return null;
  return (
    `This page is served from ${requestHost}, but sign-in for this deployment is configured for ` +
    `${new URL(configuredOrigin).host}. A wallet would be asked to trust the wrong site, so pairing is refused. ` +
    "Open the application on its configured origin and pair there."
  );
}

/**
 * Why sign-in cannot work here, naming the value that is missing.
 *
 * Every refusal that follows from this sentence is a 503 naming a variable, not
 * a generic "authentication failed": a developer reading the response should
 * learn which name to set, and never a value.
 */
export function getAuthUnavailableReason(env: NodeJS.ProcessEnv = process.env): string | null {
  if (getAllowedEvmMainnetChainIds(env.AUTH_EVM_CHAIN_IDS).size === 0) {
    return "AUTH_EVM_CHAIN_IDS is not configured, so no EVM chain is approved for wallet sign-in.";
  }
  if (!env.APP_BASE_URL) return "APP_BASE_URL is not configured.";
  if (!getSessionSigningSecret(env)) {
    return "SESSION_SECRET is not configured; a unique signing secret of at least 32 bytes is required.";
  }
  return getAuthConfig(env) ? null : "APP_BASE_URL is not a usable origin for this environment.";
}