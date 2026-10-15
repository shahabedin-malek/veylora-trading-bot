import { prisma } from "@/lib/db";
import { SITE_PERMISSION_CATALOG } from "@/lib/auth/access-control";

export const ASSIGNABLE_GLOBAL_ROLES = ["ADMIN", "TRADER", "VIEWER"] as const;
export type AssignableGlobalRole = (typeof ASSIGNABLE_GLOBAL_ROLES)[number];

export function normalizeMainnetAddress(value: unknown): string | null {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

export function teamSlugFromName(value: unknown): { name: string; slug: string } | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 64) return null;
  const slug = name.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48).replace(/-$/g, "");
  return slug ? { name, slug } : null;
}

export async function findActiveMainnetUser(address: string) {
  const identity = await prisma.walletIdentity.findFirst({
    where: {
      chainNamespace: "eip155",
      chainReference: "1",
      addressCanonical: address,
      revokedAt: null,
      user: { status: "ACTIVE" },
    },
    select: { id: true, userId: true, addressDisplay: true },
  });
  return identity;
}

export async function getAdminAccessDirectory() {
  const [users, teams] = await Promise.all([
    prisma.user.findMany({
      where: { status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      take: 250,
      select: {
        id: true,
        walletIdentity: {
          where: { chainNamespace: "eip155", chainReference: "1", revokedAt: null },
          take: 1,
          select: { addressDisplay: true },
        },
        roles: {
          where: { scope: "global", revokedAt: null },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { role: true },
        },
        teamMemberships: {
          where: { revokedAt: null },
          select: { teamRole: true, team: { select: { id: true, name: true, slug: true } } },
        },
        permissionGrants: {
          where: { revokedAt: null },
          select: { permissionKey: true },
        },
      },
    }),
    prisma.departmentTeam.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        slug: true,
        memberships: {
          where: { revokedAt: null },
          select: {
            teamRole: true,
            user: {
              select: {
                walletIdentity: {
                  where: { chainNamespace: "eip155", chainReference: "1", revokedAt: null },
                  take: 1,
                  select: { addressDisplay: true },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  return {
    users: users.map((user) => ({
      id: user.id,
      address: user.walletIdentity[0]?.addressDisplay ?? null,
      role: user.roles[0]?.role ?? "VIEWER",
      teams: user.teamMemberships.map(({ team, teamRole }) => ({ ...team, role: teamRole })),
      permissions: user.permissionGrants.map(({ permissionKey }) => permissionKey),
    })),
    teams: teams.map(({ memberships, ...team }) => ({
      ...team,
      members: memberships.map(({ user, teamRole }) => ({
        address: user.walletIdentity[0]?.addressDisplay ?? null,
        role: teamRole,
      })),
    })),
    permissionCatalog: SITE_PERMISSION_CATALOG,
    assignableRoles: ASSIGNABLE_GLOBAL_ROLES,
  };
}