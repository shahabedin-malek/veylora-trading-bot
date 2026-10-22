import { prisma } from "@/lib/db";
import { SITE_PERMISSION_CATALOG } from "@/lib/auth/access-control";
import { accountTypeLabel, isAccountType, type AccountType } from "@/lib/auth/contract-account";

export const ASSIGNABLE_GLOBAL_ROLES = ["ADMIN", "TRADER", "VIEWER"] as const;
export type AssignableGlobalRole = (typeof ASSIGNABLE_GLOBAL_ROLES)[number];

/** The permission that widens a scoped administrator to the whole directory. */
export const FULL_DIRECTORY_PERMISSION = "admin.access.read.all" as const;

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

/**
 * What one administrator is allowed to see in the directory.
 *
 * Team membership scopes the *view*, not the permission: an administrator is an
 * administrator, and what they see is the records of the teams they belong to —
 * unless they have been granted the widening permission, which is what the owner
 * gives someone who is meant to work across teams. The owner sees everything, by
 * definition: there is one owner wallet and it is the deployment's.
 *
 * Pure, and separate from the queries, because "who sees what" is the kind of
 * rule that must be checkable without a database.
 */
export type AccessScope =
  | { kind: "all" }
  | { kind: "teams"; teamIds: string[]; teamNames: string[] };

export function resolveAccessScope(input: {
  role: string;
  permissionKeys: readonly string[];
  teams: readonly { id: string; name: string }[];
}): AccessScope {
  if (input.role === "OWNER" || input.permissionKeys.includes(FULL_DIRECTORY_PERMISSION)) return { kind: "all" };
  return {
    kind: "teams",
    teamIds: input.teams.map(({ id }) => id),
    teamNames: input.teams.map(({ name }) => name),
  };
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

/**
 * The access directory, narrowed to what this viewer may see.
 *
 * The narrowing is done in the query rather than after it: a scoped
 * administrator's request never loads the rows they are not allowed to see, so
 * there is nothing to leak by forgetting to filter on the way out.
 */
export async function getAdminAccessDirectory(viewer: { id: string; role: string }) {
  const [grants, memberships] = await Promise.all([
    prisma.userPermissionGrant.findMany({
      where: { userId: viewer.id, revokedAt: null },
      select: { permissionKey: true },
    }),
    prisma.teamMembership.findMany({
      where: { userId: viewer.id, revokedAt: null },
      select: { teamId: true, team: { select: { id: true, name: true } } },
    }),
  ]);

  const scope = resolveAccessScope({
    role: viewer.role,
    permissionKeys: grants.map(({ permissionKey }) => permissionKey),
    teams: memberships.map(({ team }) => team),
  });

  // ``all`` is the owner path and the widened path; ``teams`` scopes to the
  // viewer's teams plus the viewer's own record, so a scoped administrator can
  // still see and edit their own membership.
  const userWhere = scope.kind === "all"
    ? { status: "ACTIVE" }
    : {
        status: "ACTIVE",
        OR: [
          { id: viewer.id },
          { teamMemberships: { some: { revokedAt: null, teamId: { in: scope.teamIds } } } },
        ],
      };
  const teamWhere = scope.kind === "all" ? {} : { id: { in: scope.teamIds } };

  const [users, teams] = await Promise.all([
    prisma.user.findMany({
      where: userWhere,
      orderBy: { createdAt: "asc" },
      take: 250,
      select: {
        id: true,
        lastSeenAt: true,
        walletIdentity: {
          where: { chainNamespace: "eip155", chainReference: "1", revokedAt: null },
          take: 1,
          select: { addressDisplay: true, accountType: true },
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
      where: teamWhere,
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
    // Why this administrator sees what they see, so the page can say it instead
    // of leaving them to wonder whether the directory is broken.
    scope:
      scope.kind === "all"
        ? { kind: "all" as const, teamNames: [] as string[] }
        : { kind: "teams" as const, teamNames: scope.teamNames },
    viewer: { id: viewer.id, role: viewer.role },
    users: users.map((user) => {
      const identity = user.walletIdentity[0];
      // Which kind of account the wallet is, recorded when it signed in — null
      // for a user with no active mainnet wallet, because "no wallet" is not an
      // account type. An unknown stored value reads as a key-based account
      // rather than being shown as something this build cannot interpret. The
      // label is built here, on the server, because the module that knows the
      // words also resolves RPC endpoints — and those carry the Alchemy key,
      // which must never reach a client bundle.
      const accountType = identity ? readAccountType(identity.accountType) : null;
      return {
        id: user.id,
        address: identity?.addressDisplay ?? null,
        accountType,
        accountTypeLabel: accountType ? accountTypeLabel(accountType) : null,
        role: user.roles[0]?.role ?? "VIEWER",
        // When this account last signed in. Null is honest for a row no sign-in
        // has ever touched — the local seed writes users, and they have not.
        lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
        teams: user.teamMemberships.map(({ team, teamRole }) => ({ ...team, role: teamRole })),
        permissions: user.permissionGrants.map(({ permissionKey }) => permissionKey),
      };
    }),
    teams: teams.map(({ memberships: teamMemberships, ...team }) => ({
      ...team,
      members: teamMemberships.map(({ user, teamRole }) => ({
        address: user.walletIdentity[0]?.addressDisplay ?? null,
        role: teamRole,
      })),
    })),
    permissionCatalog: SITE_PERMISSION_CATALOG,
    assignableRoles: ASSIGNABLE_GLOBAL_ROLES,
  };
}

/** A stored account type, or a key-based account when it is not one this build knows. */
function readAccountType(value: unknown): AccountType {
  return isAccountType(value) ? value : "EOA";
}
