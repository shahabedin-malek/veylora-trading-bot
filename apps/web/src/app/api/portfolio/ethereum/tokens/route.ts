import { Buffer } from "node:buffer";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { AuthenticationRequiredError, requireUser } from "@/lib/auth/session-store";
import { prisma } from "@/lib/db";
import {
  isChecksummedAddress,
  MAX_ETHEREUM_TOKEN_ALLOWLIST_SIZE,
  normalizeChecksummedAddress,
} from "@/lib/portfolio/ethereum-token-allowlist";
import { DEFAULT_EVM_MAINNET_CHAIN_ID, getEvmMainnet } from "@/lib/portfolio/evm-mainnets";

const MAX_BODY_BYTES = 1_024;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

async function authorizeMutation(request: Request) {
  const config = getAuthConfig();
  if (!config) return { response: json({ error: "Authentication is unavailable." }, 503) };
  if (!isSameOriginRequest(request, config)) return { response: json({ error: "Request origin is not allowed." }, 403) };

  try {
    return { user: await requireUser() };
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return { response: json({ error: "Authentication required." }, 401) };
    return { response: json({ error: "Authorization is unavailable." }, 503) };
  }
}

async function readAddress(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return { error: json({ error: "Content-Type must be application/json." }, 415) };
  }
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return { error: json({ error: "Invalid request body." }, 400) };
  }
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return { error: json({ error: "Request is too large." }, 413) };
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    return { error: json({ error: "Invalid JSON body." }, 400) };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: json({ error: "A checksum-formatted contract address is required." }, 400) };
  }
  if (Object.keys(body).length !== 2 || !("contractAddress" in body) || !("chainId" in body)) {
    return { error: json({ error: "Only chainId and contractAddress fields are accepted." }, 400) };
  }
  const record = body as Record<string, unknown>;
  const chainId = record.chainId;
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || !getEvmMainnet(chainId)) {
    return { error: json({ error: "Choose a supported EVM mainnet." }, 400) };
  }
  const value = record.contractAddress;
  const canonical = normalizeChecksummedAddress(value);
  if (!canonical || !isChecksummedAddress(value)) {
    return { error: json({ error: "Enter a valid checksummed EVM contract address." }, 400) };
  }
  return { address: canonical, chainId };
}

async function ensureNetworkEnabled(userId: string, chainId: number) {
  if (chainId === DEFAULT_EVM_MAINNET_CHAIN_ID) return true;
  return Boolean(await prisma.evmPortfolioNetwork.findUnique({
    where: { userId_chainId: { userId, chainId } },
    select: { id: true },
  }));
}

export async function POST(request: Request) {
  const authorized = await authorizeMutation(request);
  if ("response" in authorized) return authorized.response;
  const parsed = await readAddress(request);
  if ("error" in parsed) return parsed.error;
  if (!await ensureNetworkEnabled(authorized.user.id, parsed.chainId)) return json({ error: "Enable this mainnet before adding token contracts." }, 403);

  try {
    const existing = await prisma.evmTokenAllowlistEntry.findUnique({
      where: { userId_chainId_contractAddress: { userId: authorized.user.id, chainId: parsed.chainId, contractAddress: parsed.address } },
    });
    if (existing) return json({ error: "Contract is already allow-listed." }, 409);

    const count = await prisma.evmTokenAllowlistEntry.count({ where: { userId: authorized.user.id, chainId: parsed.chainId } });
    if (count >= MAX_ETHEREUM_TOKEN_ALLOWLIST_SIZE) {
      return json({ error: `The allow-list is limited to ${MAX_ETHEREUM_TOKEN_ALLOWLIST_SIZE} contracts.` }, 409);
    }

    await prisma.$transaction(async (transaction) => {
      await transaction.evmTokenAllowlistEntry.create({
        data: { userId: authorized.user.id, chainId: parsed.chainId, contractAddress: parsed.address },
      });
      await transaction.auditEvent.create({
        data: {
          actorUserId: authorized.user.id,
          action: "ETHEREUM_TOKEN_ALLOWLIST_ADDED",
          objectType: "EvmTokenAllowlistEntry",
          objectId: parsed.address,
          outcome: "SUCCESS",
          redactedJson: JSON.stringify({ contractAddress: parsed.address, chainId: parsed.chainId }),
        },
      });
    });
    return json({ chainId: parsed.chainId, contractAddress: parsed.address }, 201);
  } catch {
    return json({ error: "Token allow-list change could not be audited and saved." }, 503);
  }
}

export async function DELETE(request: Request) {
  const authorized = await authorizeMutation(request);
  if ("response" in authorized) return authorized.response;
  const parsed = await readAddress(request);
  if ("error" in parsed) return parsed.error;
  if (!await ensureNetworkEnabled(authorized.user.id, parsed.chainId)) return json({ error: "Network is not enabled." }, 403);

  try {
    const existing = await prisma.evmTokenAllowlistEntry.findUnique({
      where: { userId_chainId_contractAddress: { userId: authorized.user.id, chainId: parsed.chainId, contractAddress: parsed.address } },
    });
    if (!existing) return json({ error: "Contract is not in your allow-list." }, 404);

    await prisma.$transaction(async (transaction) => {
      await transaction.evmTokenAllowlistEntry.delete({ where: { id: existing.id } });
      await transaction.auditEvent.create({
        data: {
          actorUserId: authorized.user.id,
          action: "ETHEREUM_TOKEN_ALLOWLIST_REMOVED",
          objectType: "EvmTokenAllowlistEntry",
          objectId: parsed.address,
          outcome: "SUCCESS",
          redactedJson: JSON.stringify({ contractAddress: parsed.address, chainId: parsed.chainId }),
        },
      });
    });
    return json({ chainId: parsed.chainId, removed: parsed.address });
  } catch {
    return json({ error: "Token allow-list change could not be audited and saved." }, 503);
  }
}