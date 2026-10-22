import { prisma } from "@/lib/db";
import { ApiProblem, isRecord } from "@/lib/api/problem";
import {
  generateApiKey,
  normalizeRateLimit,
  normalizeScopes,
  parseStoredScopes,
  publicApiKeyView,
  serializeScopes,
  validateKeyLabel,
  type ApiScope,
} from "@/lib/api/keys";
import { listAgentApprovals } from "@/lib/api/service";
import { auditCreate } from "@/lib/audit/record";

/**
 * Issuing and revoking keys, and creating the one account an agent key can trade.
 *
 * These functions are called only from the admin session route. The API itself has no
 * key-management surface: a key cannot mint another key, and an agent cannot widen its own
 * scope. The plaintext key is returned by {@link issueApiKey} and by nothing else.
 */

export type AgentAccountView = {
  id: string;
  name: string;
  status: string;
  approvalThresholdUsdCents: number | null;
  createdAt: string;
  keyCount: number;
};

function auditDetail(detail: Record<string, unknown>): string {
  return JSON.stringify(detail);
}

export async function getApiAccessDirectory(ownerUserId: string) {
  const [keys, agents, approvals] = await Promise.all([
    prisma.apiKey.findMany({
      where: { userId: ownerUserId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        label: true,
        prefix: true,
        scopesJson: true,
        agentAccountId: true,
        rateLimitPerMinute: true,
        expiresAt: true,
        lastUsedAt: true,
        revokedAt: true,
        createdAt: true,
      },
    }),
    prisma.agentAccount.findMany({
      where: { ownerUserId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        status: true,
        approvalThresholdUsdCents: true,
        createdAt: true,
        _count: { select: { apiKeys: true } },
      },
    }),
    listAgentApprovals(ownerUserId),
  ]);

  return {
    keys: keys.map((row) =>
      publicApiKeyView({
        ...row,
        scopes: parseStoredScopes(row.scopesJson) ?? [],
      }),
    ),
    agents: agents.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      approvalThresholdUsdCents: row.approvalThresholdUsdCents,
      createdAt: row.createdAt.toISOString(),
      keyCount: row._count.apiKeys,
    })),
    approvals,
    defaults: { rateLimitPerMinute: 60, approvalTtlMinutes: 30 },
    docs: "/docs/api",
  };
}

export async function createAgentAccount(input: {
  ownerUserId: string;
  body: unknown;
}): Promise<AgentAccountView> {
  if (!isRecord(input.body)) throw new ApiProblem(400, "AGENT_INVALID", "Send a JSON object.");
  const name = typeof input.body.name === "string" ? input.body.name.trim() : "";
  if (name.length < 2 || name.length > 60) {
    throw new ApiProblem(400, "AGENT_NAME_INVALID", "Give the agent account a name between 2 and 60 characters.");
  }

  let threshold: number | null = null;
  if (input.body.approvalThresholdUsdCents !== undefined && input.body.approvalThresholdUsdCents !== null) {
    const value = input.body.approvalThresholdUsdCents;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1_000_000_000) {
      throw new ApiProblem(400, "AGENT_THRESHOLD_INVALID", "The approval threshold must be whole US cents, or null for none.");
    }
    threshold = value;
  }

  const existing = await prisma.agentAccount.findUnique({
    where: { ownerUserId_name: { ownerUserId: input.ownerUserId, name } },
    select: { id: true },
  });
  if (existing) throw new ApiProblem(409, "AGENT_NAME_TAKEN", "An agent account with that name already exists.");

  const created = await prisma.$transaction(async (transaction) => {
    const ledgerUser = await transaction.user.create({
      data: { status: "AGENT" },
      select: { id: true },
    });
    const agent = await transaction.agentAccount.create({
      data: {
        ownerUserId: input.ownerUserId,
        ledgerUserId: ledgerUser.id,
        name,
        approvalThresholdUsdCents: threshold,
      },
      select: { id: true, name: true, status: true, approvalThresholdUsdCents: true, createdAt: true },
    });
    await auditCreate(transaction, {
      data: {
        actorUserId: input.ownerUserId,
        action: "API_AGENT_ACCOUNT_CREATED",
        objectType: "AgentAccount",
        objectId: agent.id,
        outcome: "SUCCESS",
        redactedJson: auditDetail({ name: agent.name, approvalThresholdUsdCents: threshold }),
      },
    });
    return agent;
  });

  return {
    id: created.id,
    name: created.name,
    status: created.status,
    approvalThresholdUsdCents: created.approvalThresholdUsdCents,
    createdAt: created.createdAt.toISOString(),
    keyCount: 0,
  };
}

export async function issueApiKey(input: {
  ownerUserId: string;
  body: unknown;
}): Promise<{ key: ReturnType<typeof publicApiKeyView>; secret: string }> {
  if (!isRecord(input.body)) throw new ApiProblem(400, "KEY_INVALID", "Send a JSON object.");
  const label = validateKeyLabel(input.body.label);
  if (!label) throw new ApiProblem(400, "KEY_LABEL_INVALID", "Give the key a label between 2 and 80 characters.");

  const agentAccountId = typeof input.body.agentAccountId === "string" ? input.body.agentAccountId.trim() : null;
  const scopesResult = normalizeScopes(input.body.scopes, agentAccountId);
  if (!scopesResult.valid) throw new ApiProblem(400, "KEY_SCOPES_INVALID", scopesResult.error);

  const rateLimitPerMinute = normalizeRateLimit(input.body.rateLimitPerMinute);
  if (rateLimitPerMinute === null) {
    throw new ApiProblem(400, "KEY_RATE_LIMIT_INVALID", "The rate limit must be a whole number between 1 and 600 per minute.");
  }

  if (agentAccountId) {
    const agent = await prisma.agentAccount.findFirst({
      where: { id: agentAccountId, ownerUserId: input.ownerUserId },
      select: { id: true, name: true, status: true },
    });
    if (!agent) throw new ApiProblem(404, "AGENT_ACCOUNT_NOT_FOUND", "That agent account does not belong to this owner.");
    if (agent.status !== "ACTIVE") {
      throw new ApiProblem(409, "AGENT_ACCOUNT_SUSPENDED", "That agent account is not active, so a key cannot be issued for it.");
    }
  }

  const expiresAt =
    input.body.expiresAt === undefined || input.body.expiresAt === null
      ? null
      : new Date(String(input.body.expiresAt));
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new ApiProblem(400, "KEY_EXPIRY_INVALID", "expiresAt must be an ISO date.");
  }
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new ApiProblem(400, "KEY_EXPIRY_INVALID", "expiresAt must be in the future.");
  }

  const generated = generateApiKey();
  const row = await prisma.$transaction(async (transaction) => {
    const created = await transaction.apiKey.create({
      data: {
        userId: input.ownerUserId,
        label,
        prefix: generated.prefix,
        keyHash: generated.hash,
        scopesJson: serializeScopes(scopesResult.scopes),
        agentAccountId,
        rateLimitPerMinute,
        expiresAt,
      },
      select: {
        id: true,
        label: true,
        prefix: true,
        agentAccountId: true,
        rateLimitPerMinute: true,
        expiresAt: true,
        lastUsedAt: true,
        revokedAt: true,
        createdAt: true,
      },
    });
    await auditCreate(transaction, {
      data: {
        actorUserId: input.ownerUserId,
        action: "API_KEY_CREATED",
        objectType: "ApiKey",
        objectId: created.id,
        outcome: "SUCCESS",
        // The prefix identifies the key; the hash and the key itself are never in the trail.
        redactedJson: auditDetail({
          label,
          prefix: generated.prefix,
          scopes: scopesResult.scopes,
          agentAccountId,
          rateLimitPerMinute,
        }),
      },
    });
    return created;
  });

  return {
    key: publicApiKeyView({ ...row, scopes: scopesResult.scopes }),
    secret: generated.plaintext,
  };
}

export async function revokeApiKey(input: {
  ownerUserId: string;
  keyId: string;
}): Promise<ReturnType<typeof publicApiKeyView>> {
  const row = await prisma.apiKey.findFirst({
    where: { id: input.keyId, userId: input.ownerUserId },
    select: {
      id: true,
      label: true,
      prefix: true,
      scopesJson: true,
      agentAccountId: true,
      rateLimitPerMinute: true,
      expiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });
  if (!row) throw new ApiProblem(404, "API_KEY_NOT_FOUND", "That key does not belong to this owner.");

  const revokedAt = row.revokedAt ?? new Date();
  if (!row.revokedAt) {
    await prisma.$transaction(async (transaction) => {
      await transaction.apiKey.update({ where: { id: row.id }, data: { revokedAt } });
      await auditCreate(transaction, {
        data: {
          actorUserId: input.ownerUserId,
          action: "API_KEY_REVOKED",
          objectType: "ApiKey",
          objectId: row.id,
          outcome: "SUCCESS",
          redactedJson: auditDetail({ prefix: row.prefix, label: row.label }),
        },
      });
    });
  }

  return publicApiKeyView({
    ...row,
    revokedAt,
    scopes: parseStoredScopes(row.scopesJson) ?? ([] as ApiScope[]),
  });
}
