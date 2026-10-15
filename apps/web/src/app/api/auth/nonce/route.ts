import { NextRequest } from "next/server";
import { getAddress } from "viem";
import { SiweMessage } from "siwe";
import { prisma } from "@/lib/db";
import { AUTH_NONCE_TTL_MS, getAuthConfig, getAuthUnavailableReason, isSameOriginRequest } from "@/lib/auth/config";
import { describeAcceptedChains } from "@/lib/auth/chain-labels";
import { createAuthNonce, hashAuthNonce } from "@/lib/auth/nonce";

function jsonError(error: string, status: number) {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return jsonError(getAuthUnavailableReason() ?? "Authentication is unavailable.", 503);
  if (!isSameOriginRequest(request, config)) return jsonError("Request origin is not allowed.", 403);

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return jsonError("Invalid request body.", 400);
  }
  if (Buffer.byteLength(rawBody, "utf8") > 4096) return jsonError("Request is too large.", 413);

  let body: { address?: unknown; chainId?: unknown };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  if (typeof body.address !== "string" || typeof body.chainId !== "number" || !Number.isSafeInteger(body.chainId)) {
    return jsonError("A wallet address and integer chain ID are required.", 400);
  }
  if (!config.allowedChainIds.has(body.chainId)) {
    return jsonError(`This chain is not available for sign-in. ${describeAcceptedChains([...config.allowedChainIds])}`, 403);
  }

  let addressDisplay: string;
  try {
    addressDisplay = getAddress(body.address);
  } catch {
    return jsonError("Wallet address is invalid.", 400);
  }

  const now = new Date();
  const recentCount = await prisma.authNonce.count({
    where: {
      addressCanonical: addressDisplay.toLowerCase(),
      issuedAt: { gt: new Date(now.getTime() - 60_000) },
    },
  }).catch(() => null);
  if (recentCount === null) return jsonError("Authentication storage is unavailable.", 503);
  if (recentCount >= 5) return jsonError("Too many sign-in requests. Try again shortly.", 429);

  const nonce = createAuthNonce();
  const expiresAt = new Date(now.getTime() + AUTH_NONCE_TTL_MS);
  const nonceHash = hashAuthNonce(nonce);
  const message = new SiweMessage({
    scheme: config.scheme,
    domain: config.domain,
    address: addressDisplay,
    statement: "Sign in to Veylora. This does not authorize a transaction.",
    uri: config.loginUri,
    version: "1",
    chainId: body.chainId,
    nonce,
    issuedAt: now.toISOString(),
    expirationTime: expiresAt.toISOString(),
  });

  try {
    await prisma.authNonce.deleteMany({ where: { expiresAt: { lte: now } } });
    await prisma.authNonce.create({
      data: {
        nonceHash,
        addressCanonical: addressDisplay.toLowerCase(),
        chainId: body.chainId,
        domain: config.domain,
        uri: config.loginUri,
        expiresAt,
      },
    });
  } catch {
    return jsonError("Authentication storage is unavailable.", 503);
  }

  return Response.json({ message: message.prepareMessage() }, { headers: { "Cache-Control": "no-store" } });
}