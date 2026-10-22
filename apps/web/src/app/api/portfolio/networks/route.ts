import { Buffer } from "node:buffer";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { getAccessRefusal, authenticationGapResponse } from "@/lib/auth/access-gate";
import { requireUser } from "@/lib/auth/session-store";
import { prisma } from "@/lib/db";
import { networkHealthSnapshot } from "@/lib/rpc/health";
import { getNetworkRegistry } from "@/lib/rpc/networks";
import {
  DEFAULT_EVM_MAINNET_CHAIN_ID,
  getEvmMainnet,
  MAX_ADDITIONAL_EVM_MAINNETS,
} from "@/lib/portfolio/evm-mainnets";
import { auditCreate } from "@/lib/audit/record";

const MAX_BODY_BYTES = 1_024;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

async function authorizeMutation(request: Request) {
  const config = getAuthConfig();
  if (!config) return { response: authenticationGapResponse() };
  if (!isSameOriginRequest(request, config)) return { response: json({ error: "Request origin is not allowed." }, 403) };
  try {
    return { user: await requireUser() };
  } catch (error) {
    const refusal = getAccessRefusal(error);
    return { response: refusal ? json({ error: refusal.error }, refusal.status) : json({ error: "Authorization is unavailable." }, 503) };
  }
}

async function readChainId(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return { error: json({ error: "Content-Type must be application/json." }, 415) };
  }
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return { error: json({ error: "Invalid request body." }, 400) };
  }
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return { error: json({ error: "Request is too large." }, 413) };

  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    return { error: json({ error: "Invalid JSON body." }, 400) };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body) ||
    Object.keys(body).length !== 1 || !("chainId" in body)) {
    return { error: json({ error: "Only a supported mainnet chainId is accepted." }, 400) };
  }
  const chainId = (body as Record<string, unknown>).chainId;
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || !getEvmMainnet(chainId) || chainId === DEFAULT_EVM_MAINNET_CHAIN_ID) {
    return { error: json({ error: "Choose an additional supported EVM mainnet." }, 400) };
  }
  return { chainId };
}

/**
 * The registry as the switcher and the admin panel read it.
 *
 * Names, chain ids and reasons only: no endpoint, no key, no account data. The
 * list is whatever the environment configures, so adding a network variable is
 * the whole change.
 */
export async function GET() {
  try {
    await requireUser();
  } catch (error) {
    const refusal = getAccessRefusal(error);
    return refusal ? json({ error: refusal.error }, refusal.status) : json({ error: "Authorization is unavailable." }, 503);
  }

  const registry = getNetworkRegistry();
  return json({
    readAt: registry.readAt,
    networks: registry.entries,
    totals: registry.totals,
    ignoredVariables: registry.ignoredVariables,
    health: networkHealthSnapshot(),
  });
}

export async function POST(request: Request) {
  const authorized = await authorizeMutation(request);
  if ("response" in authorized) return authorized.response;
  const parsed = await readChainId(request);
  if ("error" in parsed) return parsed.error;

  try {
    const existing = await prisma.evmPortfolioNetwork.findUnique({
      where: { userId_chainId: { userId: authorized.user.id, chainId: parsed.chainId } },
    });
    if (existing) return json({ error: "Network is already enabled." }, 409);

    const count = await prisma.evmPortfolioNetwork.count({ where: { userId: authorized.user.id } });
    if (count >= MAX_ADDITIONAL_EVM_MAINNETS) {
      return json({ error: `A maximum of ${MAX_ADDITIONAL_EVM_MAINNETS} additional mainnets may be enabled.` }, 409);
    }

    const network = getEvmMainnet(parsed.chainId)!;
    await prisma.$transaction(async (transaction) => {
      await transaction.evmPortfolioNetwork.create({ data: { userId: authorized.user.id, chainId: parsed.chainId } });
      await auditCreate(transaction, {
        data: {
          actorUserId: authorized.user.id,
          action: "PORTFOLIO_NETWORK_ENABLED",
          objectType: "EvmPortfolioNetwork",
          objectId: String(parsed.chainId),
          outcome: "SUCCESS",
          redactedJson: JSON.stringify({ chainId: parsed.chainId, network: network.name }),
        },
      });
    });
    return json({ chainId: parsed.chainId, network: network.name }, 201);
  } catch {
    return json({ error: "Network selection could not be audited and saved." }, 503);
  }
}

export async function DELETE(request: Request) {
  const authorized = await authorizeMutation(request);
  if ("response" in authorized) return authorized.response;
  const parsed = await readChainId(request);
  if ("error" in parsed) return parsed.error;

  try {
    const existing = await prisma.evmPortfolioNetwork.findUnique({
      where: { userId_chainId: { userId: authorized.user.id, chainId: parsed.chainId } },
    });
    if (!existing) return json({ error: "Network is not enabled." }, 404);
    const network = getEvmMainnet(parsed.chainId)!;

    await prisma.$transaction(async (transaction) => {
      await transaction.evmPortfolioNetwork.delete({ where: { id: existing.id } });
      const removedTokens = await transaction.evmTokenAllowlistEntry.deleteMany({
        where: { userId: authorized.user.id, chainId: parsed.chainId },
      });
      await auditCreate(transaction, {
        data: {
          actorUserId: authorized.user.id,
          action: "PORTFOLIO_NETWORK_DISABLED",
          objectType: "EvmPortfolioNetwork",
          objectId: String(parsed.chainId),
          outcome: "SUCCESS",
          redactedJson: JSON.stringify({ chainId: parsed.chainId, network: network.name, removedTokenCount: removedTokens.count }),
        },
      });
    });
    return json({ chainId: parsed.chainId, removed: true });
  } catch {
    return json({ error: "Network selection could not be audited and removed." }, 503);
  }
}