import type { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { getAccessRefusal, authenticationGapResponse } from "@/lib/auth/access-gate";
import { requireAdmin } from "@/lib/auth/session-store";
import {
  ACCESS_REASON_MAX_LENGTH,
  ACCESS_REASON_MIN_LENGTH,
  accessAuditPayload,
  isActiveSitePermissionKey,
  readAccessReason,
  SITE_PERMISSION_CATALOG,
} from "@/lib/auth/access-control";
import {
  ASSIGNABLE_GLOBAL_ROLES,
  findActiveMainnetUser,
  getAdminAccessDirectory,
  normalizeMainnetAddress,
  teamSlugFromName,
} from "@/lib/auth/access-directory";
import { prisma } from "@/lib/db";
import { auditCreate } from "@/lib/audit/record";

const MAX_BODY_BYTES = 16_384;
const TEAM_ROLES = new Set(["MEMBER", "LEAD"]);

/** The way every access write is recorded: who, what, and the reason why. */
type AccessTransaction = Pick<
  Prisma.TransactionClient,
  "auditEvent" | "roleAssignment" | "departmentTeam" | "teamMembership" | "userPermissionGrant"
>;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authErrorResponse(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal ? json({ error: refusal.error }, refusal.status) : null;
}

/**
 * One access change, written into the audit trail with its actor and its reason.
 *
 * The reason is not decoration: it is the only part of the row a human reader
 * cannot reconstruct afterwards, which is why the route refuses a change without
 * one instead of storing an empty string.
 */
async function writeAccessAudit(
  transaction: AccessTransaction,
  event: {
    actorUserId: string;
    action: string;
    objectType: string;
    objectId: string;
    reason: string;
    details?: Record<string, unknown>;
  },
) {
  await auditCreate(transaction, {
    data: {
      actorUserId: event.actorUserId,
      action: event.action,
      objectType: event.objectType,
      objectId: event.objectId,
      outcome: "SUCCESS",
      redactedJson: accessAuditPayload(event.reason, event.details ?? {}),
    },
  });
}

export async function GET() {
  try {
    const viewer = await requireAdmin();
    return json(await getAdminAccessDirectory({ id: viewer.id, role: viewer.role }));
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "Access directory is unavailable." }, 503);
  }
}

export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
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

  // Every action, including the revocations, needs a reason — checked once here
  // so no branch can forget it, and so the message says exactly what is missing.
  const reason = readAccessReason(body.reason);
  if (!reason) {
    return json({
      error: `Every access change needs a reason of ${ACCESS_REASON_MIN_LENGTH}–${ACCESS_REASON_MAX_LENGTH} characters, so the audit trail answers why and not only what.`,
    }, 400);
  }

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

        const previous = await transaction.roleAssignment.findMany({
          where: { userId: identity.userId, scope: "global", revokedAt: null },
          select: { role: true },
        });
        await transaction.roleAssignment.updateMany({
          where: { userId: identity.userId, scope: "global", revokedAt: null },
          data: { revokedAt: new Date() },
        });
        const assignment = await transaction.roleAssignment.create({
          data: { userId: identity.userId, role: body.role as string, scope: "global", assignedBy: admin.id },
        });
        await writeAccessAudit(transaction, {
          actorUserId: admin.id,
          action: "ACCESS_ROLE_ASSIGNED",
          objectType: "RoleAssignment",
          objectId: assignment.id,
          reason,
          details: { address: identity.addressDisplay, previousRoles: previous.map(({ role }) => role), role: body.role },
        });
        return { protectedOwner: false as const, role: assignment.role };
      });
      if (result.protectedOwner) return json({ error: "The owner role follows the configured owner address; this endpoint assigns the other global roles." }, 403);
      return json(result);
    }

    if (body.action === "revoke-role") {
      const address = normalizeMainnetAddress(body.address);
      if (!address) return json({ error: "A mainnet wallet address is required." }, 400);
      const identity = await findActiveMainnetUser(address);
      if (!identity) return json({ error: "This wallet must sign in before its role can be revoked." }, 404);

      const result = await prisma.$transaction(async (transaction) => {
        const active = await transaction.roleAssignment.findMany({
          where: { userId: identity.userId, scope: "global", revokedAt: null },
          select: { id: true, role: true },
        });
        if (active.some(({ role }) => role === "OWNER")) return { protectedOwner: true as const };
        if (active.length === 0) return { nothingToRevoke: true as const };

        for (const assignment of active) {
          await transaction.roleAssignment.update({ where: { id: assignment.id }, data: { revokedAt: new Date() } });
          await writeAccessAudit(transaction, {
            actorUserId: admin.id,
            action: "ACCESS_ROLE_REVOKED",
            objectType: "RoleAssignment",
            objectId: assignment.id,
            reason,
            details: { address: identity.addressDisplay, revokedRole: assignment.role },
          });
        }
        return { revokedRoles: active.map(({ role }) => role) };
      });
      if (result.protectedOwner) return json({ error: "The owner role follows the configured owner address and cannot be revoked here." }, 403);
      if (result.nothingToRevoke) return json({ error: "This account holds no active global role, so there is nothing to revoke." }, 409);
      return json({ address: identity.addressDisplay, ...result });
    }

    if (body.action === "create-team") {
      const team = teamSlugFromName(body.name);
      if (!team) return json({ error: "Team name must be 2–64 characters and include letters or numbers." }, 400);
      const created = await prisma.$transaction(async (transaction) => {
        const value = await transaction.departmentTeam.create({
          data: { ...team, createdByUserId: admin.id },
        });
        await writeAccessAudit(transaction, {
          actorUserId: admin.id,
          action: "ACCESS_TEAM_CREATED",
          objectType: "DepartmentTeam",
          objectId: value.id,
          reason,
          details: { name: value.name, slug: value.slug },
        });
        return value;
      });
      return json({ team: created }, 201);
    }

    if (body.action === "remove-team") {
      if (typeof body.teamSlug !== "string") return json({ error: "The team to remove is required." }, 400);
      const team = await prisma.departmentTeam.findUnique({ where: { slug: body.teamSlug } });
      if (!team) return json({ error: "Department team was not found." }, 404);

      const removed = await prisma.$transaction(async (transaction) => {
        const memberships = await transaction.teamMembership.findMany({
          where: { teamId: team.id, revokedAt: null },
          select: { id: true },
        });
        // Memberships are marked revoked before the team row goes, so the act is
        // legible while it happens; the team delete then cascades the rows away,
        // which is exactly why the audit event records the count it removed.
        await transaction.teamMembership.updateMany({
          where: { teamId: team.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await transaction.departmentTeam.delete({ where: { id: team.id } });
        await writeAccessAudit(transaction, {
          actorUserId: admin.id,
          action: "ACCESS_TEAM_REMOVED",
          objectType: "DepartmentTeam",
          objectId: team.id,
          reason,
          details: { name: team.name, slug: team.slug, membershipsRemoved: memberships.length },
        });
        return { name: team.name, slug: team.slug, membershipsRemoved: memberships.length };
      });
      return json(removed);
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
        await writeAccessAudit(transaction, {
          actorUserId: admin.id,
          action: "ACCESS_TEAM_MEMBER_ASSIGNED",
          objectType: "TeamMembership",
          objectId: value.id,
          reason,
          details: { address: identity.addressDisplay, team: team.slug, teamRole: body.teamRole },
        });
        return value;
      });
      return json({ membership });
    }

    if (body.action === "revoke-team-membership") {
      const address = normalizeMainnetAddress(body.address);
      if (!address || typeof body.teamSlug !== "string") {
        return json({ error: "A mainnet wallet and team are required." }, 400);
      }
      const [identity, team] = await Promise.all([
        findActiveMainnetUser(address),
        prisma.departmentTeam.findUnique({ where: { slug: body.teamSlug } }),
      ]);
      if (!identity) return json({ error: "This wallet must sign in before its team membership can be revoked." }, 404);
      if (!team) return json({ error: "Department team was not found." }, 404);

      const result = await prisma.$transaction(async (transaction) => {
        const membership = await transaction.teamMembership.findUnique({
          where: { teamId_userId: { teamId: team.id, userId: identity.userId } },
        });
        if (!membership || membership.revokedAt) return { nothingToRevoke: true as const };
        await transaction.teamMembership.update({
          where: { id: membership.id },
          data: { revokedAt: new Date() },
        });
        await writeAccessAudit(transaction, {
          actorUserId: admin.id,
          action: "ACCESS_TEAM_MEMBER_REVOKED",
          objectType: "TeamMembership",
          objectId: membership.id,
          reason,
          details: { address: identity.addressDisplay, team: team.slug, teamRole: membership.teamRole },
        });
        return { address: identity.addressDisplay, team: team.slug, revokedTeamRole: membership.teamRole };
      });
      if (result.nothingToRevoke) return json({ error: "This wallet is not an active member of that team." }, 409);
      return json(result);
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
        const granted: string[] = [];
        const revoked: string[] = [];
        for (const key of activeKeys) {
          if (permissionKeys.includes(key)) {
            await transaction.userPermissionGrant.upsert({
              where: { userId_permissionKey: { userId: identity.userId, permissionKey: key } },
              create: { userId: identity.userId, permissionKey: key, grantedByUserId: admin.id },
              update: { revokedAt: null, grantedByUserId: admin.id },
            });
            granted.push(key);
          } else if (current.some((grant) => grant.permissionKey === key)) {
            await transaction.userPermissionGrant.update({
              where: { userId_permissionKey: { userId: identity.userId, permissionKey: key } },
              data: { revokedAt: new Date() },
            });
            revoked.push(key);
          }
        }
        await writeAccessAudit(transaction, {
          actorUserId: admin.id,
          action: "ACCESS_PERMISSIONS_UPDATED",
          objectType: "UserPermissionGrant",
          objectId: identity.userId,
          reason,
          details: {
            address: identity.addressDisplay,
            before: current.map(({ permissionKey }) => permissionKey),
            after: permissionKeys,
            granted,
            revoked,
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
