import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { SiweMessage } from "siwe";
import { prisma } from "@/lib/db";
import {
  AUTH_COOKIE_NAME,
  AUTH_SESSION_TTL_SECONDS,
  getAuthConfig,
  getAuthUnavailableReason,
  isSameOriginRequest,
  shouldBootstrapInitialAdmin,
} from "@/lib/auth/config";
import { hashAuthNonce } from "@/lib/auth/nonce";
import { SiweVerificationError, verifySiweMessage } from "@/lib/auth/siwe";
import { createSessionCookieValue } from "@/lib/auth/session-token";

class AuthFlowError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

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
  if (Buffer.byteLength(rawBody, "utf8") > 12_288) return jsonError("Request is too large.", 413);

  let body: { message?: unknown; signature?: unknown };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }
  if (typeof body.message !== "string" || typeof body.signature !== "string") {
    return jsonError("A SIWE message and signature are required.", 400);
  }

  let parsedMessage: SiweMessage;
  try {
    parsedMessage = new SiweMessage(body.message);
  } catch {
    return jsonError("SIWE message is malformed.", 401);
  }

  const nonceHash = hashAuthNonce(parsedMessage.nonce);
  const now = new Date();
  let nonceRecord;
  try {
    nonceRecord = await prisma.authNonce.findUnique({ where: { nonceHash } });
  } catch {
    return jsonError("Authentication storage is unavailable.", 503);
  }
  if (!nonceRecord || nonceRecord.consumedAt || nonceRecord.expiresAt.getTime() <= now.getTime()) {
    return jsonError("SIWE nonce is missing, expired, or already used.", 401);
  }

  let verified;
  try {
    verified = await verifySiweMessage({
      message: body.message,
      signature: body.signature,
      expectedNonce: parsedMessage.nonce,
      domain: config.domain,
      uri: config.loginUri,
      scheme: config.scheme,
      allowedChainIds: config.allowedChainIds,
      now,
    });
  } catch (error) {
    if (error instanceof SiweVerificationError) return jsonError("SIWE verification failed.", 401);
    return jsonError("SIWE verification failed.", 401);
  }

  if (
    nonceRecord.addressCanonical !== verified.addressCanonical ||
    nonceRecord.chainId !== verified.chainId ||
    nonceRecord.domain !== config.domain ||
    nonceRecord.uri !== config.loginUri
  ) {
    return jsonError("SIWE request does not match its issued nonce.", 401);
  }

  const sessionExpiresAt = new Date(now.getTime() + AUTH_SESSION_TTL_SECONDS * 1000);

  try {
    const sessionInfo = await prisma.$transaction(async (transaction) => {
      const consumed = await transaction.authNonce.updateMany({
        where: {
          nonceHash,
          addressCanonical: verified.addressCanonical,
          chainId: verified.chainId,
          domain: config.domain,
          uri: config.loginUri,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) throw new AuthFlowError(401, "SIWE nonce was already used.");

      const identityKey = {
        chainNamespace_chainReference_addressCanonical: {
          chainNamespace: "eip155",
          chainReference: String(verified.chainId),
          addressCanonical: verified.addressCanonical,
        },
      };
      let identity = await transaction.walletIdentity.findUnique({ where: identityKey });
      let user;

      if (identity) {
        if (identity.revokedAt) throw new AuthFlowError(403, "This wallet identity is revoked.");
        user = await transaction.user.findUnique({ where: { id: identity.userId } });
        if (!user || user.status !== "ACTIVE") throw new AuthFlowError(403, "This account is not active.");
      } else {
        user = await transaction.user.create({ data: { status: "ACTIVE" } });
        identity = await transaction.walletIdentity.create({
          data: {
            userId: user.id,
            chainNamespace: "eip155",
            chainReference: String(verified.chainId),
            addressCanonical: verified.addressCanonical,
            addressDisplay: verified.addressDisplay,
            proofType: "SIWE_EIP4361",
          },
        });
      }

      let role: Awaited<ReturnType<typeof transaction.roleAssignment.findFirst>>;
      const existingOwnerRole = await transaction.roleAssignment.findFirst({
        where: { userId: user.id, role: "OWNER", scope: "global", revokedAt: null },
      });
      const activeOwner = await transaction.roleAssignment.findFirst({
        where: { role: "OWNER", scope: "global", revokedAt: null },
        select: { id: true },
      });
      const shouldBootstrapOwner = shouldBootstrapInitialAdmin({
        addressCanonical: verified.addressCanonical,
        chainId: verified.chainId,
        activeOwnerExists: !!activeOwner,
      }) && !existingOwnerRole;

      if (shouldBootstrapOwner) {
        await transaction.roleAssignment.updateMany({
          where: { userId: user.id, scope: "global", revokedAt: null },
          data: { revokedAt: now },
        });
        role = await transaction.roleAssignment.create({
          data: { userId: user.id, role: "OWNER", scope: "global" },
        });
        await transaction.auditEvent.create({
          data: {
            actorUserId: user.id,
            action: "INITIAL_OWNER_BOOTSTRAP",
            objectType: "RoleAssignment",
            objectId: role.id,
            outcome: "SUCCESS",
            redactedJson: JSON.stringify({ chainNamespace: "eip155", chainReference: "1", proofType: "SIWE_EIP4361" }),
          },
        });
      } else {
        role = await transaction.roleAssignment.findFirst({
        where: { userId: user.id, scope: "global", revokedAt: null },
        orderBy: { createdAt: "desc" },
        });
        if (!role) {
          role = await transaction.roleAssignment.create({
            data: { userId: user.id, role: "VIEWER", scope: "global" },
          });
        }
      }

      await transaction.auditEvent.create({
        data: {
          actorUserId: user.id,
          action: "AUTH_SIGN_IN",
          objectType: "WalletIdentity",
          objectId: identity.id,
          outcome: "SUCCESS",
          redactedJson: JSON.stringify({ chainNamespace: "eip155", chainReference: String(verified.chainId) }),
        },
      });

      return {
        address: identity.addressDisplay,
        role: role.role,
        userId: user.id,
        walletIdentityId: identity.id,
        sessionVersion: user.sessionVersion,
      };
    });

    const cookieValue = createSessionCookieValue(
      {
        userId: sessionInfo.userId,
        walletIdentityId: sessionInfo.walletIdentityId,
        chainNamespace: "eip155",
        chainReference: String(verified.chainId),
        sessionVersion: sessionInfo.sessionVersion,
        issuedAt: Math.floor(now.getTime() / 1000),
        expiresAt: Math.floor(sessionExpiresAt.getTime() / 1000),
      },
      config.sessionSecret,
    );

    const cookieStore = await cookies();
    cookieStore.set(AUTH_COOKIE_NAME, cookieValue, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: "strict",
      path: "/",
      expires: sessionExpiresAt,
      maxAge: AUTH_SESSION_TTL_SECONDS,
    });

    return Response.json({ authenticated: true, ...sessionInfo }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthFlowError) return jsonError(error.message, error.status);
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      return jsonError("This wallet is already linked to another account.", 409);
    }
    return jsonError("Sign-in could not be completed.", 500);
  }
}