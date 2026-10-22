import { prisma } from "@/lib/db";
import {
  API_KEY_PREFIX,
  hashApiKey,
  parseStoredScopes,
  type ApiScope,
} from "@/lib/api/keys";

/**
 * Bearer authentication for the public API (phase 32).
 *
 * Every request is answered from the database, by hash: there is no session cache, no
 * process-local key map and no TTL. That is what makes "revocation takes effect
 * immediately" true — the next request either finds a `revokedAt` or it does not, and the
 * answer is not remembered anywhere.
 *
 * The refusals are specific on purpose. A missing header, a key that never existed, a
 * revoked key, an expired key and a key whose owner is no longer active are five different
 * things a caller can act on; collapsing them into "unauthorized" would leave an operator
 * re-issuing a key that was merely expired.
 */

export const API_AUTHORIZATION_PREFIX = "Bearer ";

export type ApiPrincipal = {
  keyId: string;
  ownerUserId: string;
  keyLabel: string;
  keyPrefix: string;
  scopes: ApiScope[];
  agentAccountId: string | null;
  agentAccountName: string | null;
  agentAccountStatus: string | null;
  agentLedgerUserId: string | null;
  rateLimitPerMinute: number;
};

export type ApiKeyLookupRow = {
  id: string;
  userId: string;
  label: string;
  prefix: string;
  scopesJson: string;
  agentAccountId: string | null;
  rateLimitPerMinute: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  user: { status: string };
  agentAccount: { id: string; name: string; status: string; ledgerUserId: string } | null;
};

export type ApiKeyAuthStore = {
  findByHash(hash: string): Promise<ApiKeyLookupRow | null>;
  touch(keyId: string, at: Date): Promise<void>;
};

export type ApiAuthFailure = {
  status: 401 | 403;
  code: string;
  message: string;
  requiredScope?: ApiScope;
};

export type ApiAuthOutcome =
  | { ok: true; principal: ApiPrincipal }
  | { ok: false; failure: ApiAuthFailure };

export function parseBearerHeader(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith(API_AUTHORIZATION_PREFIX.toLowerCase())) return null;
  const token = trimmed.slice(API_AUTHORIZATION_PREFIX.length).trim();
  return token || null;
}

export async function authenticateApiKeyValue(
  value: string,
  store: ApiKeyAuthStore,
  now: Date = new Date(),
): Promise<ApiAuthOutcome> {
  if (!value.startsWith(API_KEY_PREFIX)) {
    return {
      ok: false,
      failure: { status: 401, code: "API_KEY_INVALID", message: "That is not a Veylora API key." },
    };
  }

  let row: ApiKeyLookupRow | null;
  try {
    row = await store.findByHash(hashApiKey(value));
  } catch {
    return {
      ok: false,
      failure: { status: 401, code: "API_KEY_UNAVAILABLE", message: "API key lookup is unavailable, so the request was not authorized." },
    };
  }

  if (!row) {
    return {
      ok: false,
      failure: {
        status: 401,
        code: "API_KEY_INVALID",
        message: "This API key is not recognized. It may have been mistyped or issued by another deployment.",
      },
    };
  }
  if (row.revokedAt) {
    return {
      ok: false,
      failure: {
        status: 401,
        code: "API_KEY_REVOKED",
        message: `This API key was revoked at ${row.revokedAt.toISOString()}. Issue a new key; the old one cannot be restored.`,
      },
    };
  }
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
    return {
      ok: false,
      failure: {
        status: 401,
        code: "API_KEY_EXPIRED",
        message: `This API key expired at ${row.expiresAt.toISOString()}.`,
      },
    };
  }
  if (row.user.status !== "ACTIVE") {
    return {
      ok: false,
      failure: {
        status: 401,
        code: "API_KEY_OWNER_INACTIVE",
        message: "This API key belongs to an account that is not active.",
      },
    };
  }

  const scopes = parseStoredScopes(row.scopesJson);
  if (!scopes) {
    return {
      ok: false,
      failure: {
        status: 401,
        code: "API_KEY_INVALID",
        message: "This API key's scopes cannot be read, so it was not authorized.",
      },
    };
  }
  if ((scopes.includes("trade") || scopes.includes("agent")) && !row.agentAccountId) {
    return {
      ok: false,
      failure: {
        status: 401,
        code: "API_KEY_INVALID",
        message: "This API key names no dedicated agent account, so its trade and agent scopes cannot be used.",
      },
    };
  }

  return {
    ok: true,
    principal: {
      keyId: row.id,
      ownerUserId: row.userId,
      keyLabel: row.label,
      keyPrefix: row.prefix,
      scopes,
      agentAccountId: row.agentAccountId,
      agentAccountName: row.agentAccount?.name ?? null,
      agentAccountStatus: row.agentAccount?.status ?? null,
      agentLedgerUserId: row.agentAccount?.ledgerUserId ?? null,
      rateLimitPerMinute: row.rateLimitPerMinute,
    },
  };
}

export async function authenticateApiRequest(
  request: Request,
  store: ApiKeyAuthStore,
  now: Date = new Date(),
): Promise<ApiAuthOutcome> {
  const value = parseBearerHeader(request.headers.get("authorization"));
  if (!value) {
    return {
      ok: false,
      failure: {
        status: 401,
        code: "API_KEY_MISSING",
        message: "Send an API key as `Authorization: Bearer <key>`. Keys are issued at /admin/access.",
      },
    };
  }
  return authenticateApiKeyValue(value, store, now);
}

export function scopeRefusal(principal: ApiPrincipal, required: ApiScope): ApiAuthFailure | null {
  if (principal.scopes.includes(required)) return null;
  return {
    status: 403,
    code: "SCOPE_REQUIRED",
    requiredScope: required,
    message:
      `This key does not carry the ${required} scope. ` +
      `It has: ${principal.scopes.join(", ")}. ` +
      (required === "trade"
        ? "The trade scope is opt-in per key and applies only to the key's dedicated agent account."
        : `Ask the owner for a key with the ${required} scope.`),
  };
}

export function createPrismaApiKeyAuthStore(): ApiKeyAuthStore {
  return {
    findByHash(hash) {
      return prisma.apiKey.findUnique({
        where: { keyHash: hash },
        select: {
          id: true,
          userId: true,
          label: true,
          prefix: true,
          scopesJson: true,
          agentAccountId: true,
          rateLimitPerMinute: true,
          expiresAt: true,
          revokedAt: true,
          user: { select: { status: true } },
          agentAccount: { select: { id: true, name: true, status: true, ledgerUserId: true } },
        },
      });
    },
    async touch(keyId, at) {
      try {
        await prisma.apiKey.update({ where: { id: keyId }, data: { lastUsedAt: at } });
      } catch {
        // Last-used is an observation. A failure to write it must not fail the request.
      }
    },
  };
}
