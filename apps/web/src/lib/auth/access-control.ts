export const SITE_PERMISSION_CATALOG = [
  { key: "admin.console.read", label: "Read the admin console", availability: "ACTIVE" },
  { key: "admin.console.operate", label: "Run admin console actions", availability: "ACTIVE" },
  { key: "admin.data.read", label: "Read project data catalog", availability: "ACTIVE" },
  { key: "admin.access.read.all", label: "See every user and team in Access", availability: "ACTIVE" },
  { key: "risk.policy.manage", label: "Manage global risk policy", availability: "ACTIVE" },
  { key: "fees.manage", label: "Manage the fee table and pricing", availability: "ACTIVE" },
  { key: "security.policy.manage", label: "Manage account security policy and sessions", availability: "ACTIVE" },
  { key: "crm.support.read", label: "Read customer support records", availability: "ACTIVE" },
  { key: "crm.support.manage", label: "Manage customer support records", availability: "ACTIVE" },
  { key: "audit.read", label: "Read the audit trail", availability: "ACTIVE" },
  { key: "audit.manage", label: "Manage audit retention and verify the chain", availability: "ACTIVE" },
  { key: "payments.read", label: "Read payment operations", availability: "PLANNED" },
  { key: "payments.operate", label: "Operate payment workflows", availability: "PLANNED" },
] as const;

export type SitePermissionKey = (typeof SITE_PERMISSION_CATALOG)[number]["key"];
export type ActiveSitePermissionKey = Extract<(typeof SITE_PERMISSION_CATALOG)[number], { availability: "ACTIVE" }>["key"];

export function isSitePermissionKey(value: unknown): value is SitePermissionKey {
  return typeof value === "string" && SITE_PERMISSION_CATALOG.some((permission) => permission.key === value);
}

export function isActiveSitePermissionKey(value: unknown): value is ActiveSitePermissionKey {
  return typeof value === "string" && SITE_PERMISSION_CATALOG.some(
    (permission) => permission.key === value && permission.availability === "ACTIVE",
  );
}

/** What a permission is called in the catalog, or the key itself if it is not one. */
export function sitePermissionLabel(key: string): string {
  return SITE_PERMISSION_CATALOG.find((permission) => permission.key === key)?.label ?? key;
}

/**
 * The permission named the way an operator can act on it: the stable key they
 * would type into a grant, and the human label that key stands for.
 */
export function describePermission(key: string): string {
  return `${key} (${sitePermissionLabel(key)})`;
}

/**
 * The refusal a caller sees when a specific permission is missing.
 *
 * A generic "not assigned to your account" costs the reader a support round
 * trip: they cannot tell whether to ask for a grant, sign in again, or go
 * looking for a bug. Naming the permission tells them exactly what to ask for
 * and where it is granted, and it is the same sentence in the API body, the page
 * notice and the audit row.
 */
export function missingPermissionMessage(permissionKey: string): string {
  return `Missing permission ${describePermission(permissionKey)}. An administrator grants it in Access.`;
}

/** How long an access change's reason may be, and how short it may be. */
export const ACCESS_REASON_MIN_LENGTH = 3;
export const ACCESS_REASON_MAX_LENGTH = 200;

/**
 * The reason an administrator typed, normalised, or null when it is unusable.
 *
 * Every access change carries one, and it is required rather than optional: an
 * access log whose rows say only *what* changed answers the easy question and
 * none of the interesting ones. Whitespace is collapsed so the stored sentence
 * is a sentence, and the bounds keep the column, the audit payload and the page
 * predictable.
 */
export function readAccessReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reason = value.trim().replace(/\s+/g, " ");
  return reason.length >= ACCESS_REASON_MIN_LENGTH && reason.length <= ACCESS_REASON_MAX_LENGTH ? reason : null;
}

/**
 * The payload of one access audit row: the reason first, then what changed.
 *
 * One builder rather than a `JSON.stringify` per action, because "the reason is
 * recorded" is the requirement, and a rule with a name is one a test can check
 * on its own instead of by reading seven call sites.
 */
export function accessAuditPayload(reason: string, details: Record<string, unknown>): string {
  return JSON.stringify({ reason, ...details });
}
