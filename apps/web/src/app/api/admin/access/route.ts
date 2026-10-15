import { NextRequest } from "next/server";
import { getAuthConfig, getAuthUnavailableReason, isSameOriginRequest } from "@/lib/auth/config";
import {
  AuthenticationRequiredError,
  AuthorizationRequiredError,
  requireAdmin,
} from "@/lib/auth/session-store";
import { isActiveSitePermissionKey, SITE_PERMISSION_CATALOG } from "@/lib/auth/access-control";
import {
  ASSIGNABLE_GLOBAL_ROLES,
  findActiveMainnetUser,
  getAdminAccessDirectory,
  normalizeMainnetAddress,
  teamSlugFromName,
} from "@/lib/auth/access-directory";
import { prisma } from "@/lib/db";

const MAX_BODY_BYTES = 16_384;
const TEAM_ROLES = new Set(["MEMBER", "LEAD"]);

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authErrorResponse(error: unknown) {
  if (error instanceof AuthenticationRequiredError) return json({ error: "Authentication required." }, 401);
  if (error instanceof AuthorizationRequiredError) return json({ error: "Administrator role required." }, 403);
  return null;
}

export async function GET() {
  try {
    await requireAdmin();
    return json(await getAdminAccessDirectory());
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "Access directory is unavailable." }, 503);
  }
}

export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return json({ error: getAuthUnavailableReason() ?? "Authentication is unavailable." }, 503);
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let admin;
  try {
    admin = await requireAdmin();
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "Administrator authorization is unavailable." }, 503);
  }

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413);

  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  if (!isRecord(body) || typeof body.action !== "string") return json({ error: "An access action is required." }, 400);

  try {
    if (body.action === "assign-role") {
      const address = normalizeMainnetAddress(body.address);
      if (!address || typeof body.role !== "string" || !ASSIGNABLE_GLOBAL_ROLES.includes(body.role as typeof ASSIGNABLE_GLOBAL_ROLES[number])) {
        return json({ error: "A mainnet wallet address and assignable role are required." }, 400);
      }
      const identity = await findActiveMainnetUser(address);
      if (!identity) return json({ error: "This wallet must sign in before it can be assigned a role." }, 404);

      const result = await prisma.$transaction(async (transaction) => {
        const ownerRole = await transaction.roleAssignment.findFirst({
          where: { userId: identity.userId, role: "OWNER", scope: "global", revokedAt: null },
        });
        if (ownerRole) return { protectedOwner: true as const };

        await transaction.roleAssignment.updateMany({
          where: { userId: identity.userId, scope: "global", revokedAt: null },
          data: { revokedAt: new Date() },
        });
        const assignment = await transaction.roleAssignment.create({
          data: { userId: identity.userId, role: body.role as string, scope: "global", assignedBy: admin.id },
        });
        await transaction.auditEvent.create({
          data: {
            actorUserId: admin.id,
            action: "ACCESS_ROLE_ASSIGNED",
            objectType: "RoleAssignment",
            objectId: assignment.id,
            outcome: "SUCCESS",
            redactedJson: JSON.stringify({ address: identity.addressDisplay, role: body.role }),
          },
        });
        return { protectedOwner: false as const, role: assignment.role };
      });
      if (result.protectedOwner) return json({ error: "The initial OWNER role cannot be reassigned here." }, 403);
      return json(result);
    }

    if (body.action === "create-team") {
      const team = teamSlugFromName(body.name);
      if (!team) return json({ error: "Team name must be 2–64 characters and include letters or numbers." }, 400);
      const created = await prisma.$transaction(async (transaction) => {
        const value = await transaction.departmentTeam.create({
          data: { ...team, createdByUserId: admin.id },
        });
        await transaction.auditEvent.create({
          data: {
            actorUserId: admin.id,
            action: "ACCESS_TEAM_CREATED",
            objectType: "DepartmentTeam",
            objectId: value.id,
            outcome: "SUCCESS",
            redactedJson: JSON.stringify({ name: value.name, slug: value.slug }),
          },
        });
        return value;
      });
      return json({ team: created }, 201);
    }

    if (body.action === "assign-team") {
      const address = normalizeMainnetAddress(body.address);
      if (!address || typeof body.teamSlug !== "string" || typeof body.teamRole !== "string" || !TEAM_ROLES.has(body.teamRole)) {
        return json({ error: "A mainnet wallet, team, and valid team role are required." }, 400);
      }
      const [identity, team] = await Promise.all([
        findActiveMainnetUser(address),
        prisma.departmentTeam.findUnique({ where: { slug: body.teamSlug } }),
      ]);
      if (!identity) return json({ error: "This wallet must sign in before it can join a team." }, 404);
      if (!team) return json({ error: "Department team was not found." }, 404);

      const membership = await prisma.$transaction(async (transaction) => {
        const value = await transaction.teamMembership.upsert({
          where: { teamId_userId: { teamId: team.id, userId: identity.userId } },
          create: { teamId: team.id, userId: identity.userId, teamRole: body.teamRole as string, assignedByUserId: admin.id },
          update: { teamRole: body.teamRole as string, assignedByUserId: admin.id, revokedAt: null },
        });
        await transaction.auditEvent.create({
          data: {
            actorUserId: admin.id,
            action: "ACCESS_TEAM_MEMBER_ASSIGNED",
            objectType: "TeamMembership",
            objectId: value.id,
            outcome: "SUCCESS",
            redactedJson: JSON.stringify({ address: identity.addressDisplay, team: team.slug, teamRole: body.teamRole }),
          },
        });
        return value;
      });
      return json({ membership });
    }

    if (body.action === "set-permissions") {
      const address = normalizeMainnetAddress(body.address);
      if (!address || !Array.isArray(body.permissionKeys) || body.permissionKeys.some((key) => !isActiveSitePermissionKey(key))) {
        return json({ error: "A mainnet wallet and only active site permissions are accepted." }, 400);
      }
      const permissionKeys = body.permissionKeys as string[];
      if (new Set(permissionKeys).size !== permissionKeys.length) return json({ error: "Permission keys must be unique." }, 400);
      const identity = await findActiveMainnetUser(address);
      if (!identity) return json({ error: "This wallet must sign in before permissions can be assigned." }, 404);

      const grants = await prisma.$transaction(async (transaction) => {
        const current = await transaction.userPermissionGrant.findMany({
          where: { userId: identity.userId, revokedAt: null },
          select: { permissionKey: true },
        });
        const activeKeys = SITE_PERMISSION_CATALOG.filter((permission) => permission.availability === "ACTIVE").map(({ key }) => key);
        for (const key of activeKeys) {
          if (permissionKeys.includes(key)) {
            await transaction.userPermissionGrant.upsert({
              where: { userId_permissionKey: { userId: identity.userId, permissionKey: key } },
              create: { userId: identity.userId, permissionKey: key, grantedByUserId: admin.id },
              update: { revokedAt: null, grantedByUserId: admin.id },
            });
          } else if (current.some((grant) => grant.permissionKey === key)) {
            await transaction.userPermissionGrant.update({
              where: { userId_permissionKey: { userId: identity.userId, permissionKey: key } },
              data: { revokedAt: new Date() },
            });
          }
        }
        await transaction.auditEvent.create({
          data: {
            actorUserId: admin.id,
            action: "ACCESS_PERMISSIONS_UPDATED",
            objectType: "UserPermissionGrant",
            objectId: identity.userId,
            outcome: "SUCCESS",
            redactedJson: JSON.stringify({ address: identity.addressDisplay, before: current.map(({ permissionKey }) => permissionKey), after: permissionKeys }),
          },
        });
        return permissionKeys;
      });
      return json({ address: identity.addressDisplay, permissions: grants });
    }

    return json({ error: "Unsupported access action." }, 400);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      return json({ error: "A record with those details already exists." }, 409);
    }
    return json({ error: "The audited access change could not be saved." }, 503);
  }
}