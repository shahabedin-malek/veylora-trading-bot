import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { AUTH_COOKIE_NAME, getAuthConfig } from "@/lib/auth/config";
import { verifySessionCookieValue } from "@/lib/auth/session-token";
import type { SitePermissionKey } from "@/lib/auth/access-control";

export async function getCurrentSession() {
  const config = getAuthConfig();
  if (!config) return null;

  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  if (!cookieValue) return null;

  const claims = verifySessionCookieValue(cookieValue, config.sessionSecret);
  if (!claims || !config.allowedChainIds.has(Number(claims.chainReference))) return null;

  const user = await prisma.user.findUnique({
    where: { id: claims.userId },
    include: {
      roles: {
        where: { scope: "global", revokedAt: null },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });
  const walletIdentity = await prisma.walletIdentity.findUnique({ where: { id: claims.walletIdentityId } });

  if (!user || user.status !== "ACTIVE" || user.sessionVersion !== claims.sessionVersion) return null;
  if (!walletIdentity || walletIdentity.userId !== user.id || walletIdentity.revokedAt) return null;
  if (walletIdentity.chainNamespace !== claims.chainNamespace || walletIdentity.chainReference !== claims.chainReference) return null;

  return {
    claims,
    user,
    walletIdentity,
    role: user.roles[0]?.role ?? "VIEWER",
  };
}

export class AuthenticationRequiredError extends Error {
  readonly status = 401;

  constructor(message = "Authentication required") {
    super(message);
    this.name = "AuthenticationRequiredError";
  }
}

export class AuthorizationRequiredError extends Error {
  readonly status = 403;

  constructor(message = "Administrator role required") {
    super(message);
    this.name = "AuthorizationRequiredError";
  }
}

export async function getCurrentUser() {
  const current = await getCurrentSession();
  if (!current) return null;
  return {
    id: current.user.id,
    role: current.role,
    address: current.walletIdentity?.addressDisplay ?? null,
    chainNamespace: current.walletIdentity?.chainNamespace ?? null,
    chainReference: current.walletIdentity?.chainReference ?? null,
  };
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) throw new AuthenticationRequiredError();
  return user;
}

export async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== "ADMIN" && user.role !== "OWNER") throw new AuthorizationRequiredError();
  return user;
}

export async function requireSitePermission(permissionKey: SitePermissionKey) {
  const user = await requireUser();
  if (user.role === "ADMIN" || user.role === "OWNER") return user;

  const grant = await prisma.userPermissionGrant.findUnique({
    where: { userId_permissionKey: { userId: user.id, permissionKey } },
  });
  if (!grant || grant.revokedAt) throw new AuthorizationRequiredError("This site function is not assigned to your account.");
  return user;
}