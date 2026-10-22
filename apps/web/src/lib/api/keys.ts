import { createHash, randomBytes } from "node:crypto";

/**
 * Public API credentials (phase 32).
 *
 * A key is a bearer secret, so the only durable copy of it is the SHA-256 held in `keyHash`.
 * The plaintext leaves the process exactly once, in the response to the creation request;
 * every read afterwards can only show `prefix`. That is why no helper here accepts a stored
 * row and returns a key — there is nothing to return.
 *
 * Scopes are data on the key, not a role: `read` can see the owner's account, `trade` can
 * place an order, and `agent` can read the dedicated account the key names. A trade or agent
 * scope is inseparable from an `agentAccountId`, because the alternative — falling back to the
 * owner's main account when no agent is named — is precisely the exposure this phase is
 * meant to prevent.
 */

export const API_KEY_SCOPES = ["read", "trade", "agent"] as const;
export type ApiScope = (typeof API_KEY_SCOPES)[number];

export const API_KEY_PREFIX = "vyl_";
export const API_KEY_BYTES = 32;
export const API_KEY_PREFIX_LENGTH = 12;

export const DEFAULT_API_RATE_LIMIT_PER_MINUTE = 60;
export const MIN_API_RATE_LIMIT_PER_MINUTE = 1;
export const MAX_API_RATE_LIMIT_PER_MINUTE = 600;

export const API_SCOPE_DETAIL: Record<ApiScope, string> = {
  read: "Read the owner's account, balances, portfolio, ledger, orders, strategies, alerts and market data.",
  trade: "Place paper orders in the key's dedicated agent account. Never the owner's main account.",
  agent: "Read the dedicated agent account, its balances, history and approval records.",
};

export type ApiKeyView = {
  id: string;
  label: string;
  prefix: string;
  scopes: ApiScope[];
  agentAccountId: string | null;
  rateLimitPerMinute: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type GeneratedApiKey = {
  /** Shown once. Never stored, logged or returned by a later read. */
  plaintext: string;
  hash: string;
  prefix: string;
};

export function isApiScope(value: unknown): value is ApiScope {
  return typeof value === "string" && (API_KEY_SCOPES as readonly string[]).includes(value);
}

export function generateApiKey(): GeneratedApiKey {
  const plaintext = `${API_KEY_PREFIX}${randomBytes(API_KEY_BYTES).toString("base64url")}`;
  return { plaintext, hash: hashApiKey(plaintext), prefix: apiKeyPrefix(plaintext) };
}

export function hashApiKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function apiKeyPrefix(value: string): string {
  return value.slice(0, API_KEY_PREFIX_LENGTH);
}

/** A stored `scopesJson` as scopes, or null when the row is not a document this code wrote. */
export function parseStoredScopes(value: string): ApiScope[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const scopes = [...new Set(parsed.filter(isApiScope))];
  if (scopes.length !== parsed.length) return null;
  return scopes;
}

export function serializeScopes(scopes: readonly ApiScope[]): string {
  return JSON.stringify([...new Set(scopes)]);
}

export type ScopeValidation =
  | { valid: true; scopes: ApiScope[] }
  | { valid: false; error: string };

/**
 * Validate the scopes a creation request asked for.
 *
 * Unknown names are refused rather than ignored: silently dropping `admin` would create a
 * key the owner believes is more powerful than it is. The agent rule is stated in the
 * refusal so the UI can point at the missing account rather than at a generic bad request.
 */
export function normalizeScopes(input: unknown, agentAccountId: string | null): ScopeValidation {
  if (!Array.isArray(input)) return { valid: false, error: "Scopes must be an array." };
  const unknown = input.filter((value) => !isApiScope(value));
  if (unknown.length > 0) {
    return { valid: false, error: `Unknown scope: ${unknown.map(String).join(", ")}. Choose read, trade or agent.` };
  }
  const scopes = [...new Set(input as ApiScope[])];
  if (scopes.length === 0) return { valid: false, error: "Choose at least one scope." };
  if ((scopes.includes("trade") || scopes.includes("agent")) && !agentAccountId) {
    return {
      valid: false,
      error: "The trade and agent scopes require a dedicated agent account; they never fall back to the owner's main account.",
    };
  }
  return { valid: true, scopes };
}

export function hasScope(scopes: readonly ApiScope[], required: ApiScope): boolean {
  return scopes.includes(required);
}

export function normalizeRateLimit(input: unknown): number | null {
  if (input === undefined || input === null) return DEFAULT_API_RATE_LIMIT_PER_MINUTE;
  if (typeof input !== "number" || !Number.isInteger(input)) return null;
  if (input < MIN_API_RATE_LIMIT_PER_MINUTE || input > MAX_API_RATE_LIMIT_PER_MINUTE) return null;
  return input;
}

export function validateKeyLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (label.length < 2 || label.length > 80) return null;
  return label;
}

/**
 * The only shape a key is ever read in after creation.
 *
 * It deliberately has no `keyHash` and no `plaintext` field: a serializer cannot leak what
 * its input type does not carry, and a test can assert the JSON string does not contain the
 * hash either.
 */
export function publicApiKeyView(row: {
  id: string;
  label: string;
  prefix: string;
  scopes: ApiScope[];
  agentAccountId: string | null;
  rateLimitPerMinute: number;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}): ApiKeyView {
  return {
    id: row.id,
    label: row.label,
    prefix: row.prefix,
    scopes: row.scopes,
    agentAccountId: row.agentAccountId,
    rateLimitPerMinute: row.rateLimitPerMinute,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
